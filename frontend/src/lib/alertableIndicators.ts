// Which chart indicators an alert may watch, and the identity an alert stores.
// Mirror of backend/auto_trader/indicators/alertable.py: the backend validates
// on its own (the two deploy separately), and alertableParity.test.ts plus
// backend/tests/test_indicator_parity.py keep the two definitions identical.
import { normalizeMaKind } from "./mtf";
import { isNativeTf, parseTf, tfLabel } from "./timeframe";

// The default MA kind for a template that hasn't flipped maType: EMA -> ema,
// MA -> sma. Deliberately NOT imported from lib/indicators/ma.ts's own
// templateMaKind: that module (and everything it imports) pulls klinecharts
// in at the VALUE level (`import { type Indicator, ... } from "klinecharts"`,
// which stays a runtime import under verbatimModuleSyntax), which crashes at
// import time in vitest's node environment - and this file is imported by
// alertsApi.ts (Task 11), which plain node-env tests import. Inlined rather
// than moved (the alternative would be relocating templateMaKind out of
// ma.ts into mtf.ts and re-exporting it from ma.ts for existing callers).
function templateMaKind(type: string): "ema" | "sma" {
  return type === "EMA" ? "ema" : "sma";
}

export type AlertIndicator = "MA" | "RSI" | "ATR";

const SOURCES = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"];

export const ALERTABLE: Record<
  AlertIndicator,
  { lines: string[]; priceTarget: boolean; params: [number, number][]; config: Record<string, string[]> }
> = {
  MA: {
    lines: ["value"],
    priceTarget: true,
    params: [[1, 1000]],
    config: { maType: ["ema", "sma", "vwma", "evwma"], source: SOURCES },
  },
  RSI: {
    lines: ["value"],
    priceTarget: false,
    params: [[2, 1000]],
    config: { source: SOURCES },
  },
  ATR: {
    lines: ["value"],
    priceTarget: false,
    params: [[1, 1000]],
    config: { smoothing: ["rma", "sma", "ema", "wma"] },
  },
};

// The indicator result key that holds the alertable line, per indicator.
export const MAIN_LINE_KEY: Record<AlertIndicator, string> = { MA: "ma", RSI: "val", ATR: "atr" };

const DEFERRED = new Set(["AVWAP", "VWAP", "BOLL", "MACD"]);

export interface IndicatorIdentity {
  indicator: AlertIndicator;
  calcParams: number[];
  config: Record<string, string>;
  priceTarget: boolean;
}

export type AlertableCheck =
  | { ok: true; identity: IndicatorIdentity }
  | { ok: false; reason: string }
  | { ok: false; hidden: true };

const HIDDEN = { ok: false, hidden: true } as const;

function pick(options: string[], v: unknown): string {
  return typeof v === "string" && options.includes(v) ? v : options[0];
}

// `source` is unlike the other pick()-driven options (maType, smoothing): the
// chart offers sources the alertable registry does NOT support (e.g. hlcc4,
// mtf.ts:21 / indicatorMeta.ts:206). Silently falling back to "close" there
// would watch a different line than the one on screen without telling the
// user. Missing (undefined) still means "close", same as the chart's own
// default - only an explicit, UNRECOGNIZED source is refused.
function pickSource(v: unknown): string | undefined {
  if (v === undefined) return "close";
  return typeof v === "string" && SOURCES.includes(v) ? v : undefined;
}

// Mirror of alertable.py's MAX_WARMUP / _bars_to_decay / warmup: the server
// seeds at most SEED_CAP bars, so it refuses any line whose warm-up needs
// more. Kept identical so a settings edit past the cap is caught here, as a
// "delete or keep" prompt, rather than as a failed PATCH.
const MAX_WARMUP = 2000 - 50;

function barsToDecay(alpha: number): number {
  if (alpha >= 1) return 1;
  return Math.ceil(Math.log(1e-3) / Math.log(1 - alpha));
}

function warmup(indicator: AlertIndicator, n: number, config: Record<string, string>): number {
  if (indicator === "MA") {
    const kind = config.maType;
    if (kind === "sma" || kind === "vwma") return n;
    if (kind === "ema") return barsToDecay(2 / (n + 1));
    return n + barsToDecay(1 / n); // evwma
  }
  if (indicator === "RSI") return n + 1 + barsToDecay(1 / n);
  if (config.smoothing === "rma") return n + 1 + barsToDecay(1 / n);
  if (config.smoothing === "ema") return n + 1 + barsToDecay(2 / (n + 1));
  return n + 1;
}

export function checkAlertable(
  type: string,
  calcParams: unknown[] | undefined,
  ext: Record<string, unknown> | undefined,
  resolution: string,
  hasVolume: boolean,
): AlertableCheck {
  let tf;
  try {
    tf = parseTf(resolution);
  } catch {
    return HIDDEN;
  }
  if (tf.unit === "SECOND") return HIDDEN;
  if (DEFERRED.has(type)) return { ok: false, reason: `Alerts on ${type} are coming later` };
  const e = ext ?? {};
  let indicator: AlertIndicator;
  let config: Record<string, string>;
  if (type === "EMA" || type === "MA") {
    const mtf = e.mtf as { timeframe?: string } | undefined;
    if (mtf?.timeframe) return { ok: false, reason: "Alerts on higher-timeframe lines are coming later" };
    if (Number(e.offset ?? 0) !== 0) return { ok: false, reason: "Alerts need the line offset at 0" };
    const sm = e.smoothing as { type?: string } | undefined;
    if (sm?.type && sm.type !== "none") return { ok: false, reason: "Alerts on smoothed lines are coming later" };
    indicator = "MA";
    const maSource = pickSource(e.source);
    if (maSource === undefined) return { ok: false, reason: "Alerts on this source are coming later" };
    config = { maType: normalizeMaKind(e.maType, templateMaKind(type)), source: maSource };
    if ((config.maType === "vwma" || config.maType === "evwma") && !hasVolume)
      return { ok: false, reason: "This market has no volume data" };
  } else if (type === "RSI") {
    const rsiSource = pickSource(e.source);
    if (rsiSource === undefined) return { ok: false, reason: "Alerts on this source are coming later" };
    indicator = "RSI";
    config = { source: rsiSource };
  } else if (type === "ATR") {
    indicator = "ATR";
    config = { smoothing: pick(ALERTABLE.ATR.config.smoothing, e.smoothing) };
  } else {
    return HIDDEN;
  }
  if (!isNativeTf(resolution)) return { ok: false, reason: "Alerts on this timeframe are coming later" };
  const spec = ALERTABLE[indicator];
  const fallback = indicator === "MA" ? (type === "EMA" ? 9 : 20) : 14;
  const n = Math.trunc(Number(calcParams?.[0]) || fallback);
  const [lo, hi] = spec.params[0];
  if (n < lo || n > hi) return { ok: false, reason: `Alerts need a length from ${lo} to ${hi}` };
  if (warmup(indicator, n, config) > MAX_WARMUP) return { ok: false, reason: "Length too long for alerts" };
  return { ok: true, identity: { indicator, calcParams: [n], config, priceTarget: spec.priceTarget } };
}

export function indicatorLabel(id: IndicatorIdentity): string {
  const n = id.calcParams[0];
  if (id.indicator === "MA") {
    const base = `${id.config.maType.toUpperCase()} ${n}`;
    return id.config.source === "close" ? base : `${base} ${id.config.source}`;
  }
  if (id.indicator === "RSI") return id.config.source === "close" ? `RSI ${n}` : `RSI ${n} ${id.config.source}`;
  return id.config.smoothing === "rma" ? `ATR ${n}` : `ATR ${n} ${id.config.smoothing}`;
}

export function indicatorAlertLabel(id: IndicatorIdentity, timeframe: string): string {
  return `${indicatorLabel(id)} (${tfLabel(timeframe)})`;
}

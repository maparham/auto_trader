// The LR pane's rule/alert shape: output names, config parsing, warm-up and
// the ROLLING series the backend computes. A leaf with no klinecharts runtime
// import (lr.ts is the chart module), so exprInstances.ts can read it in node.
//
// The chart draws ONE fit over the newest `length` bars (lr.ts computeLr).
// Rules and alerts need a value at every bar, so they read TradingView's
// ta.linreg instead: at bar i, fit the `length` bars ending at i and take the
// fit's value AT i. up/dn add and subtract mult times that window's RMS
// residual. Mirrored operation for operation by Python indicators/lr.py; the
// parity fixture (lrParity.test.ts) pins the two together.
import type { KLineData } from "klinecharts"; // erased at build
import { priceOf, type PriceSource } from "../mtf";

export const LR_OUTPUTS = ["lr", "up", "dn"] as const;

export interface LrRefConfig {
  length: number;
  mult: number;
  source: PriceSource;
}

const SOURCES: readonly string[] = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"];

/** A calcParams entry as a finite number, or null for anything that is not
 * honestly numeric: a boolean (`Number(true) === 1` would otherwise parse as
 * a real length), or a non-finite result (`Number("Infinity")`, `NaN`).
 * Mirrors Python's `_num`. */
function num(v: unknown): number | null {
  if (typeof v === "boolean" || (typeof v !== "number" && typeof v !== "string")) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** calcParams = [length, mult] with the template's `|| default` fallbacks; a
 * fit needs two points, so length floors at 2. Only `source` is read from
 * extendData: lineHidden is display only. Mirrors parse_lr_config. */
export function parseLrConfig(calcParams: unknown, extendData: unknown): LrRefConfig {
  const p = Array.isArray(calcParams) ? calcParams : [];
  const len = num(p[0]) || 100;
  const mult = num(p[1]) || 2;
  const ext = (extendData && typeof extendData === "object" ? extendData : {}) as { source?: unknown };
  const source = (typeof ext.source === "string" && SOURCES.includes(ext.source) ? ext.source : "close") as PriceSource;
  return { length: Math.max(2, Math.floor(len)), mult, source };
}

/** First honest value needs `length` bars. Mirrors lr_warmup. */
export function lrWarmup(cfg: LrRefConfig, output: string): number {
  return (LR_OUTPUTS as readonly string[]).includes(output) ? cfg.length : 0;
}

/** The rolling series for one output; null before the first full window. */
export function lrSeries(bars: readonly KLineData[], cfg: LrRefConfig, output: string): (number | null)[] {
  const n = bars.length;
  const L = cfg.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (!(LR_OUTPUTS as readonly string[]).includes(output) || L > n) return out;
  const ys = bars.map((k) => priceOf(k, cfg.source));
  for (let i = L - 1; i < n; i++) {
    const start = i - L + 1;
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let k = 0; k < L; k++) {
      const y = ys[start + k];
      sx += k;
      sy += y;
      sxy += k * y;
      sxx += k * k;
    }
    const denom = L * sxx - sx * sx;
    const slope = denom !== 0 ? (L * sxy - sx * sy) / denom : 0;
    const intercept = (sy - slope * sx) / L;
    const end = intercept + slope * (L - 1);
    if (output === "lr") {
      out[i] = end;
      continue;
    }
    let sse = 0;
    for (let k = 0; k < L; k++) {
      const fit = intercept + slope * k;
      const d = ys[start + k] - fit;
      sse += d * d;
    }
    const width = cfg.mult * Math.sqrt(sse / L);
    out[i] = output === "up" ? end + width : end - width;
  }
  return out;
}

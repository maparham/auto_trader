// Pure math + label text for the Long/Short Position drawing tool: the trade a
// user sketches as three price levels (entry, target, stop) plus a time width.
// Side-agnostic like tradeZones.ts — every distance is an unsigned magnitude off
// the entry, so a short reads exactly like a long with the levels mirrored. That
// is why nothing here takes a direction: the points already say which side the
// reward is on, and long/short are two names over ONE behaviour.
//
// No klinecharts, no DOM, no fetching: the overlay's createPointFigures is a hot
// synchronous paint path, so everything it needs is computed here from values it
// already holds (the live account snapshot is passed in, never fetched).

import { formatDuration } from "./measureMetrics";

/** Per-drawing settings (DrawingExtra.trade). Every field optional on disk —
 *  drawings saved before a field existed read back as its default. */
export interface TradeConfig {
  // Label groups. R:R and % are always on; these are the extras.
  showPrice: boolean;
  showPoints: boolean;
  showMoney: boolean;
  showDuration: boolean;
  // Account overrides. null ⇒ take it from the connected dealing account.
  accountSize: number | null;
  riskPct: number;
  // Account currency gained (or lost) per one point of price movement, per unit
  // of position. 1 is right for a CFD quoted in the account currency; anything
  // else has to be told, because contract/point value isn't exposed to the
  // frontend (it lives in the MT5 broker adapter server-side).
  valuePerPoint: number;
  currency: string | null;
}

export const TRADE_DEFAULTS: TradeConfig = {
  showPrice: false,
  showPoints: false,
  showMoney: false,
  showDuration: false,
  accountSize: null,
  riskPct: 1,
  valuePerPoint: 1,
  currency: null,
};

/** Narrow unknown extendData.trade to a complete config (never throws). */
export function asTradeConfig(v: unknown): TradeConfig {
  const o = v && typeof v === "object" ? (v as Partial<TradeConfig>) : {};
  return {
    showPrice: o.showPrice ?? TRADE_DEFAULTS.showPrice,
    showPoints: o.showPoints ?? TRADE_DEFAULTS.showPoints,
    showMoney: o.showMoney ?? TRADE_DEFAULTS.showMoney,
    showDuration: o.showDuration ?? TRADE_DEFAULTS.showDuration,
    accountSize: o.accountSize ?? TRADE_DEFAULTS.accountSize,
    riskPct: o.riskPct ?? TRADE_DEFAULTS.riskPct,
    valuePerPoint: o.valuePerPoint ?? TRADE_DEFAULTS.valuePerPoint,
    currency: o.currency ?? TRADE_DEFAULTS.currency,
  };
}

/** The connected dealing account, as far as this drawing cares. */
export interface TradeAccount {
  balance: number;
  currency: string;
}

export interface TradePlanInput {
  entry: number;
  target: number;
  stop: number;
  precision: number; // price decimals (min tick = 10^-precision)
  bars: number;
  ms: number;
  account: TradeAccount | null;
  config: TradeConfig;
}

export interface TradePlanMetrics {
  rewardPoints: number;
  riskPoints: number;
  rewardPct: number;
  riskPct: number;
  rr: number | null;
  riskAmount: number | null;
  rewardAmount: number | null;
  size: number | null;
  currency: string | null;
  rrLabel: string;
  targetLines: string[];
  stopLines: string[];
  widthLine: string | null;
}

// TradingView renders a real minus sign (U+2212), matching measureMetrics.
const MINUS = "−";
// Two spaces read as a gap on canvas, where the pill has no styling to separate
// fields with.
const GAP = "  ";

// Trim a fixed-decimal number back to its shortest exact form: 100.00 → "100",
// 12.50 → "12.5". Position size spans orders of magnitude, so a fixed width
// either wastes pill space or loses precision.
function trim(n: number, decimals: number): string {
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

export function tradePlan(inp: TradePlanInput): TradePlanMetrics {
  const { entry, target, stop, precision, config: cfg } = inp;
  const rewardPoints = Math.abs(target - entry);
  const riskPoints = Math.abs(entry - stop);
  const rewardPct = entry !== 0 ? (rewardPoints / entry) * 100 : 0;
  const riskPct = entry !== 0 ? (riskPoints / entry) * 100 : 0;
  const rr = riskPoints > 0 ? rewardPoints / riskPoints : null;

  // Money. accountSize overrides the live balance; with neither there is nothing
  // to risk a percentage OF, so every money figure stays null and its labels
  // drop out rather than showing a confident zero.
  const balance = cfg.accountSize ?? inp.account?.balance ?? null;
  const riskAmount = balance != null ? (balance * cfg.riskPct) / 100 : null;
  const rewardAmount = riskAmount != null && rr != null ? riskAmount * rr : null;
  const perUnitRisk = riskPoints * cfg.valuePerPoint;
  const size = riskAmount != null && perUnitRisk > 0 ? riskAmount / perUnitRisk : null;
  const currency = cfg.currency ?? inp.account?.currency ?? null;

  // --- labels ---------------------------------------------------------------
  const money = cfg.showMoney && currency != null;
  const level = (price: number, pctv: number, pts: number, sign: string): string => {
    const parts: string[] = [];
    if (cfg.showPrice) parts.push(price.toFixed(Math.max(0, precision)));
    parts.push(`${sign}${pctv.toFixed(2)}%`);
    if (cfg.showPoints) parts.push(`${ticks(pts, precision)} pts`);
    return parts.join(GAP);
  };
  const targetLines = [level(target, rewardPct, rewardPoints, "+")];
  const stopLines = [level(stop, riskPct, riskPoints, MINUS)];
  if (money && rewardAmount != null) targetLines.push(`+${rewardAmount.toFixed(2)} ${currency}`);
  if (money && riskAmount != null) stopLines.push(`${MINUS}${riskAmount.toFixed(2)} ${currency}`);

  let rrLabel = rr != null ? `R:R 1:${rr.toFixed(2)}` : "R:R —";
  if (money && size != null) rrLabel += `${GAP}·${GAP}${trim(size, 2)} units`;

  const widthLine = cfg.showDuration
    ? `${inp.bars} ${inp.bars === 1 ? "bar" : "bars"}, ${formatDuration(inp.ms)}`
    : null;

  return {
    rewardPoints,
    riskPoints,
    rewardPct,
    riskPct,
    rr,
    riskAmount,
    rewardAmount,
    size,
    currency,
    rrLabel,
    targetLines,
    stopLines,
    widthLine,
  };
}

// A price distance in min-ticks ("points" in TV's sense), rounded to whole ticks.
function ticks(distance: number, precision: number): number {
  const minTick = 10 ** -Math.max(0, precision);
  return Math.round(distance / minTick);
}

/** Where a freshly drawn trade's stop goes: opposite the target, at half the
 *  reward — TradingView's 1:2 default. The user drags it from there. Stated as
 *  one formula for both directions: "opposite" is relative to the target the
 *  user just dragged out, so a long dragged downwards still gets a coherent
 *  (if inverted) trade rather than a stop on top of its target. */
export function defaultStopPrice(entry: number, target: number): number {
  return entry - (target - entry) / 2;
}

/** Dragging a level across the entry converts the trade in place (long ⇄
 *  short) — the promise tradeOverlay's header makes. klinecharts only moves the
 *  point under the cursor, so on its own a cross-drag piles both zones onto one
 *  side of the entry. Given the trade as it stood and the drag (which point,
 *  its new value), this returns the reflection that restores "target and stop
 *  on opposite sides": the OTHER leg jumps across the entry keeping its
 *  distance (so R:R survives the flip), or null when no side was crossed. For
 *  an entry drag the leg that moves is the one the entry did NOT cross — the
 *  crossed level and the dragged point both stay where the user can see them.
 *  A leg sitting exactly ON the entry has no side, so nothing flips. */
export function flipTradeLeg(
  prev: { entry: number; target: number; stop: number },
  draggedIdx: 0 | 1 | 2,
  value: number,
): { index: 1 | 2; value: number } | null {
  const entry = draggedIdx === 0 ? value : prev.entry;
  const target = draggedIdx === 1 ? value : prev.target;
  const stop = draggedIdx === 2 ? value : prev.stop;
  const targetSide = Math.sign(target - entry);
  if (targetSide === 0 || targetSide !== Math.sign(stop - entry)) return null;
  const reflectStop = draggedIdx === 0
    ? Math.sign(prev.target - prev.entry) !== targetSide // target crossed → stop moves
    : draggedIdx === 1;
  return reflectStop
    ? { index: 2, value: 2 * entry - stop }
    : { index: 1, value: 2 * entry - target };
}

/** One anchor of a trade drawing, in klinecharts' point shape. */
export interface TradePoint {
  timestamp: number;
  value: number;
}

// A trade's target and stop share the drawing's right edge, but klinecharts
// drags one point at a time — so after a horizontal drag the two disagree and
// the box is torn. Given the edge as it stood BEFORE the drag, whichever point
// left it is the one the user moved: adopt its timestamp for both. Returns null
// when there is nothing to fix (a vertical-only drag, or an incomplete trade),
// so the caller can skip the overlay rewrite entirely.
/** Restore a trade's two invariants after a NUMERIC edit (the Coordinates tab,
 *  or any write that isn't a drag): target and stop share one right edge, and
 *  sit on opposite sides of the entry. flipTradeLeg predicts cursor motion
 *  mid-drag; this one just repairs whatever was written, reflecting a stop
 *  found on the target's side back across the entry at its own distance.
 *  Returns corrected points, or null when nothing needs writing. */
export function normalizeTradePoints(points: TradePoint[]): TradePoint[] | null {
  if (points.length < 3) return null;
  const [entry, target, stop] = points;
  let changed = false;
  let stopTs = stop.timestamp;
  if (stopTs !== target.timestamp) {
    stopTs = target.timestamp;
    changed = true;
  }
  let stopVal = stop.value;
  const legs = (target.value - entry.value) * (stopVal - entry.value);
  if (legs > 0) {
    stopVal = entry.value - (stopVal - entry.value);
    changed = true;
  }
  if (!changed) return null;
  return [entry, target, { ...stop, timestamp: stopTs, value: stopVal }];
}

export function syncTradePoints(points: TradePoint[], prevEdge: number): TradePoint[] | null {
  if (points.length < 3) return null;
  const [entry, target, stop] = points;
  const edge = target.timestamp !== prevEdge
    ? target.timestamp
    : stop.timestamp !== prevEdge
      ? stop.timestamp
      : null;
  if (edge == null) return null;
  return [entry, { ...target, timestamp: edge }, { ...stop, timestamp: edge }];
}

// Magnet-snapped drawing points that keep their candle across timeframes.
//
// A point placed with the magnet lands on a candle's open, high, low or close,
// and that is what it MEANS: "this candle's low". Storage only keeps a time and
// a price, and the time is the open of the bar it was drawn on, so a line drawn
// through two daily lows put its ends on each day's FIRST 4H candle, hours off
// the candle that made the low. Here a snapped point also records its level and
// timeframe (DrawingExtra.snaps, one entry per point), and on a finer chart it
// is shown on the candle inside its original bar that traded that level: the
// extreme for high/low, the first for open, the last for close. The price never
// moves, so the line stays straight through its points on every timeframe,
// like a TradingView drawing, just through the right candles.
//
// The moved time is DISPLAY ONLY. Storage keeps the original bar's open
// (canonicalize), so a 1D point viewed on 4H and saved there still means the
// same day on 1W. Only line-like tools whose points are both a time and a price
// take part (SNAP_TOOLS); vertical lines and time ranges ignore price, so a
// snap there was an accident of where the cursor was.
import { barEndMs } from "../timeframe";
import { RESOLUTION_SECONDS } from "../feed/periods";

export type SnapKind = "high" | "low" | "open" | "close";

/** One snapped point: which level, on which timeframe's bar `t` (its open
 * time), at price `v`. `v` lets a stored point prove it is still the one that
 * was snapped: a clone moved elsewhere, or a point edited by hand, no longer
 * matches and is left alone. */
export interface PointSnap {
  k: SnapKind;
  tf: string;
  t: number;
  v: number;
}

export const SNAP_TOOLS: ReadonlySet<string> = new Set([
  "segment",
  "rayLine",
  "straightLine",
  "priceChannelLine",
  "fibonacciLine",
  "fibChannel",
  "priceLine",
  "rect",
  "tradeBox",
]);

/** A trade box's stop (point 2) shares the target's (point 1) time. */
const TRADE_BOX = "tradeBox";

type Bar = { timestamp: number; open: number; high: number; low: number; close: number };
type Pt = { timestamp?: number; dataIndex?: number; value?: number };

/** First index with timestamp >= ts. */
function lowerBound(bars: readonly Bar[], ts: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** When the snapped point's own bar closes. */
function spanEnd(s: PointSnap): number {
  const end = barEndMs(s.tf, s.t);
  if (end != null && end > s.t) return end;
  const secs = RESOLUTION_SECONDS[s.tf];
  return s.t + (secs ? secs * 1000 : 0);
}

/** The snap a freshly placed point carries, or null. Snapped means the value
 * is EXACTLY one of the OHLC prices of the candle it sits on, which is what
 * the magnet produces (a hand-placed point essentially never is). Extremes
 * win a tie: a candle whose low is also its close was snapped to its low. */
export function captureSnap(p: Pt, bars: readonly Bar[], tf: string): PointSnap | null {
  if (p.timestamp == null || p.value == null) return null;
  const i = lowerBound(bars, p.timestamp);
  const b = bars[i];
  if (!b || b.timestamp !== p.timestamp) return null;
  const v = p.value;
  const k: SnapKind | null =
    v === b.high ? "high" : v === b.low ? "low" : v === b.open ? "open" : v === b.close ? "close" : null;
  return k ? { k, tf, t: b.timestamp, v } : null;
}

/** True when the stored point is still the one `s` describes. */
function holds(s: PointSnap | null | undefined, p: Pt | undefined): s is PointSnap {
  return (
    !!s &&
    !!p &&
    p.value === s.v &&
    p.timestamp != null &&
    p.timestamp >= s.t &&
    p.timestamp < Math.max(spanEnd(s), s.t + 1)
  );
}

/** Where a snapped point shows on a chart of `bars` (bar width `chartMs`):
 * on a finer chart, the candle inside its bar that traded its level; on the
 * same or a coarser one, its own bar open. Falls back to the bar open when
 * the start of its bar is not loaded (the extreme may be in the unloaded
 * part). */
export function snapDisplayTs(s: PointSnap, bars: readonly Bar[], chartMs: number): number {
  const end = spanEnd(s);
  if (!(chartMs > 0) || !(end - s.t > chartMs) || bars.length === 0 || bars[0].timestamp > s.t) return s.t;
  let best: Bar | null = null;
  for (let i = lowerBound(bars, s.t); i < bars.length && bars[i].timestamp < end; i++) {
    const b = bars[i];
    if (
      !best ||
      (s.k === "low" && b.low < best.low) ||
      (s.k === "high" && b.high > best.high) ||
      s.k === "close"
    )
      best = b;
  }
  return best ? best.timestamp : s.t;
}

/** Storage → chart: each point that still holds its snap moves to its display
 * time. `display[i]` is that time (null for an unsnapped point), kept so the
 * next save can tell an untouched point from a dragged one. */
export function resolveDisplay(
  name: string,
  points: readonly Pt[],
  snaps: ReadonlyArray<PointSnap | null> | undefined,
  bars: readonly Bar[],
  chartMs: number,
): { points: Pt[]; display: Array<number | null> } {
  const display: Array<number | null> = points.map(() => null);
  const out = points.map((p, i) => {
    const s = snaps?.[i];
    if (!SNAP_TOOLS.has(name) || !holds(s, p)) return p;
    const ts = snapDisplayTs(s, bars, chartMs);
    display[i] = ts;
    return { ...p, timestamp: ts };
  });
  if (name === TRADE_BOX && out.length >= 3 && out[1].timestamp != null && out[2].timestamp != null) {
    out[2] = { ...out[2], timestamp: out[1].timestamp };
  }
  return { points: out, display };
}

/** Chart → storage. `live` are the overlay's points as they sit on the chart,
 * `stable` the same points in storage form. A point still at its display time
 * and price was not moved: it is written back at its bar open with its snap.
 * A point unchanged since `base` (the points as loaded or last saved) keeps
 * what it had. Any other point was placed or dragged on THIS chart, so its
 * snap (if any) is captured afresh at `tf`. */
export function canonicalize(
  name: string,
  live: readonly Pt[],
  stable: readonly Pt[],
  snaps: ReadonlyArray<PointSnap | null> | undefined,
  display: ReadonlyArray<number | null> | undefined,
  bars: readonly Bar[],
  tf: string,
  base?: readonly Pt[],
): { points: Pt[]; snaps: Array<PointSnap | null>; display: Array<number | null> } {
  const outSnaps: Array<PointSnap | null> = [];
  const outDisplay: Array<number | null> = [];
  const out = stable.map((p, i) => {
    const s = snaps?.[i];
    const d = display?.[i];
    const lp = live[i];
    if (s && d != null && lp && lp.value === s.v && lp.timestamp === d) {
      outSnaps.push(s);
      outDisplay.push(d);
      return { ...p, timestamp: s.t, value: s.v };
    }
    // Untouched since it was loaded (or last saved): keep whatever it had. A
    // point that merely sits on a level here was never snapped by the user.
    const b = base?.[i];
    if (b && lp && b.timestamp === lp.timestamp && b.dataIndex === lp.dataIndex && b.value === lp.value) {
      // (A snap that held would have been caught above; one that does not is stale.)
      outSnaps.push(null);
      outDisplay.push(null);
      return p;
    }
    const c = SNAP_TOOLS.has(name) && lp ? captureSnap(lp, bars, tf) : null;
    outSnaps.push(c);
    outDisplay.push(c ? c.t : null);
    return p;
  });
  if (name === TRADE_BOX && out.length >= 3) {
    // The stop is seeded, never snapped, and rides the target's time.
    outSnaps[2] = null;
    outDisplay[2] = null;
    if (out[1].timestamp != null) out[2] = { ...out[2], timestamp: out[1].timestamp };
  }
  return { points: out, snaps: outSnaps, display: outDisplay };
}

/** True when two snap lists differ (absent and all-null are the same). */
export function snapsDiffer(
  a: ReadonlyArray<PointSnap | null> | undefined,
  b: ReadonlyArray<PointSnap | null>,
): boolean {
  const n = Math.max(a?.length ?? 0, b.length);
  for (let i = 0; i < n; i++) {
    const x = a?.[i] ?? null;
    const y = b[i] ?? null;
    if (x === y) continue;
    if (!x || !y || x.k !== y.k || x.tf !== y.tf || x.t !== y.t || x.v !== y.v) return true;
  }
  return false;
}

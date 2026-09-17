// TRENDLINES: major sloping lines through confirmed fractal pivots of EITHER
// kind. A line is two significant swings, high or low in any mix, that later
// swings land on within one symmetric tolerance. Price may cross a line freely;
// crossings are COUNTED (a filter and a label), never a fault, so there is no
// pierce rule and no broken state.
//
// Causal by construction (backtest-safe): a strict fractal pivot at bar i only
// exists at its confirm bar i+N, every line is seeded at a confirm bar, and
// the touch and crossing passes at bar i only ever extend a line whose anchors
// precede i. So
// values at bar i depend only on bars [0..i].
//
// PARITY, and exactly where division is allowed. core.py's contract is that
// identical operation order is what makes the parity suite exact. Here validity
// is a BOOLEAN THAT GATES SET MEMBERSHIP: a 1-ULP disagreement does not drift a
// number, it deletes a line and changes the whole output set from that bar
// forward. So EVERY boolean gate multiplies through by the exact positive
// integer (i2 - i1) instead of computing a slope. That holds for touchWeight,
// sideSign, and the emit path's at-or-below-the-close side test alike.
//
// projectAt holds the only quotient, and it is NOT merely cosmetic. Besides
// producing the emitted price, it feeds the nearest-to-the-close comparison
// that decides WHICH line's value is emitted, so a 1-ULP disagreement there can
// swap two lines. That is a far narrower failure than deleting a line (the two
// candidates are within an ULP of each other for it to happen at all), but it
// is not nothing: it rests on projectAt being ported operation-for-operation,
// and the parity golden is what holds that.
//
// Ported operation-for-operation to
// backend/auto_trader/indicators/trendlines.py; keep the arithmetic order
// identical (see core.py's parity contract).

import type {
  Indicator,
  IndicatorDrawParams,
  IndicatorTemplate,
  KLineData,
} from "klinecharts";
import { isPivotAt } from "./pivots";
import { atrSeries, rmaNext, trueRangeAt } from "../atr";
import { alignHtfToChart, type MtfSeriesBase } from "../mtf";
import { minPositiveGap } from "../barInterval";
import { clipSegmentToRect, DRAW_CLIP_PAD } from "./shared";
import {
  MAX_LIVE_MULT,
  parseTrendlinesConfig,
  TL_ATR_LEN,
  TL_NEAR_PRICE_ATR,
  TL_NEAREST,
  tlOutputName,
  TRENDLINES_DEFAULTS,
  TRENDLINES_EXTEND_DEFAULTS,
  type TrendlinesConfig,
} from "./trendlinesOutputs";

export type PivotKind = "high" | "low";

export { TL_NEAR_PRICE_ATR };

/** The pivots that PASSED the pivot filter, ONE POOL for both kinds in confirm
 * order (high before low when one bar is both). `idxs[q]` is the bar,
 * `kinds[q]` says whether its price is that bar's high or low. `highs`/`lows`
 * are REFERENCES to the detector's per-bar arrays, so carrying the pool costs
 * no allocation; under a timeframe pin every index here is an HTF bar index. */
export interface TrendPivots {
  idxs: number[];
  kinds: PivotKind[];
  highs: number[];
  lows: number[];
}

/** The price pool entry q turned at. */
export function pivotPriceAt(pivots: TrendPivots, q: number): number {
  const idx = pivots.idxs[q];
  return pivots.kinds[q] === "high" ? pivots.highs[idx] : pivots.lows[idx];
}

/** A line is two anchor pivots and NEVER rotates once defined. Later touches
 * move lastTouchIdx (coverage), never i2/p2. `k1`/`k2` record which extreme
 * each anchor is; no gate reads them (draw and MTF snapping do). */
export interface TrendLine {
  i1: number;
  p1: number;
  k1: PivotKind;
  i2: number; // i2 > i1 strictly
  p2: number;
  k2: PivotKind;
  /** Weighted touch count: each anchor and each PIERCING pivot adds 1, each
   * pivot that stops SHORT of the line adds 0.5, so this is a half-step sum
   * (exact in binary floating point) rather than an integer. */
  touches: number;
  /** The bars that touched, INCLUDING the anchors. Insertion order, not bar
   * order, and NOT a count: a half touch occupies one slot here too, so
   * length >= touches. DRAW-ONLY: no gate reads it. */
  touchIdxs: number[];
  /** Parallel to touchIdxs: which extreme of that bar touched. DRAW-ONLY, for
   * the coarser-pin snap (which chart candle carries the HTF extreme). */
  touchKinds: PivotKind[];
  lastTouchIdx: number; // seeded to i2, only ever moves forward
  /** Times the close has changed side of the line since i1. Detector state
   * (a gate and a rank key read it), so it is ported and part of parity. */
  crossings: number;
  /** Last NON-ZERO side the close sat on: 1 above, -1 below, 0 none yet. A
   * close exactly on the line keeps the previous sign. */
  lastSign: number;
  maxTouchGap: number; // widest gap between consecutive touches; only grows
  minTouchGap: number; // narrowest; only shrinks
  maxTouchIdx: number; // running maximum of touchIdxs
}

/** The kind that touched at slot `t`, or null when the line carries no kinds.
 *
 * touchKinds is DRAW-ONLY and younger than the stashes it rides in: an MTF
 * stash persisted before it existed restores with touchIdxs and no touchKinds
 * at all. Reading the array directly threw there, and ONE throw inside the
 * draw loop aborts the whole pane's draw, so the chart stopped repainting
 * entirely (pan and zoom moved the time axis and nothing else) and a reload
 * restored the same stash. A missing kind only costs the extreme snap, so it
 * falls back to the plain time mapping rather than taking the pane down.
 */
function touchKindAt(line: TrendLine, t: number): PivotKind | null {
  return (line.touchKinds as PivotKind[] | undefined)?.[t] ?? null;
}

/** The line's price at bar j. The ONLY division in this module. */
export function projectAt(line: TrendLine, j: number): number {
  return line.p1 + ((line.p2 - line.p1) * (j - line.i1)) / (line.i2 - line.i1);
}

/** How much of a touch the pivot `(j, price)` of kind `kind` scores against
 * the line: 1 for a pierce, 0.5 for a gap, 0 for neither.
 *
 * The two tolerances are SEPARATE and pre-multiplied by ATR(14) at the pivot's
 * bar, the way the single tolerance used to be. Which way is "through" comes
 * from the PIVOT'S KIND, not the line's: a swing high tests the line from
 * below, so a high at or above the line has pierced it and a high below it
 * stopped short; a swing low tests from above and mirrors that exactly.
 *
 * A pierce is worth twice a gap because price cutting a line and turning there
 * is a stronger test of the line than price turning before it reaches it.
 *
 * Cross-multiplied by the positive integer span, no quotient, and written as
 * `lhs <= rhs + t` rather than on a difference so the band edges land on the
 * same bits the single-tolerance version produced. */
export function touchWeight(
  line: TrendLine,
  j: number,
  price: number,
  kind: PivotKind,
  gapTol: number,
  pierceTol: number,
): 0 | 0.5 | 1 {
  const span = line.i2 - line.i1;
  const lhs = (price - line.p1) * span;
  const rhs = (line.p2 - line.p1) * (j - line.i1);
  const through = kind === "high" ? lhs >= rhs : lhs <= rhs;
  if (through) {
    const t = pierceTol * span;
    return (kind === "high" ? lhs <= rhs + t : lhs >= rhs - t) ? 1 : 0;
  }
  const t = gapTol * span;
  return (kind === "high" ? lhs >= rhs - t : lhs <= rhs + t) ? 0.5 : 0;
}

/** Which side of the line the close sits on at bar j: 1 above, -1 below, 0
 * exactly on it. Same cross-multiplied form as touchWeight. */
export function sideSign(line: TrendLine, j: number, close: number): -1 | 0 | 1 {
  const span = line.i2 - line.i1;
  const lhs = (close - line.p1) * span;
  const rhs = (line.p2 - line.p1) * (j - line.i1);
  return lhs > rhs ? 1 : lhs < rhs ? -1 : 0;
}

/** Fold bar j's close into the line's crossing count. The first non-zero sign
 * is the baseline and does not count; a zero keeps the previous sign. */
export function stepCrossing(line: TrendLine, j: number, close: number): void {
  const s = sideSign(line, j, close);
  if (s === 0) return;
  if (line.lastSign !== 0 && s !== line.lastSign) line.crossings += 1;
  line.lastSign = s;
}

/** Min Back Clearance, sideless: over the `bars` closes before i1 the close
 * must not change side of the line's backward extension. A bar ON the line is
 * neutral, like stepCrossing. Bars below `startIdx` were never seen (the
 * compute floor), so a window reaching under it REJECTS, the same way a line
 * anchored fewer than `bars` from bar 0 does: the clearance has not been
 * demonstrated, and passing the short window would make the gate weakest
 * where the sample is thinnest. At most `bars` iterations, which is why it
 * is asked before the O(span) crossing walk. Python has_back_clearance. */
export function hasBackClearance(
  line: TrendLine,
  closes: ReadonlyArray<number>,
  startIdx: number,
  bars: number,
): boolean {
  if (bars <= 0) return true;
  if (line.i1 - bars < startIdx) return false;
  let last: -1 | 0 | 1 = 0;
  for (let j = line.i1 - 1; j >= line.i1 - bars; j--) {
    const s = sideSign(line, j, closes[j]);
    if (s === 0) continue;
    if (last !== 0 && s !== last) return false;
    last = s;
  }
  return true;
}

/** Full deterministic ordering (Python rank_key sorts identically): most
 * touches, longest span, FEWEST crossings, most recent, oldest origin, lowest
 * anchor price. p1 is a STORED price, so ranking cannot depend on the bar. */
export function rankLines(a: TrendLine, b: TrendLine): number {
  if (a.touches !== b.touches) return b.touches - a.touches;
  const spanA = a.lastTouchIdx - a.i1;
  const spanB = b.lastTouchIdx - b.i1;
  if (spanA !== spanB) return spanB - spanA;
  if (a.crossings !== b.crossings) return a.crossings - b.crossings;
  if (a.lastTouchIdx !== b.lastTouchIdx) return b.lastTouchIdx - a.lastTouchIdx;
  if (a.i1 !== b.i1) return a.i1 - b.i1;
  return a.p1 - b.p1;
}

/** THE LIVE-CAP SURVIVAL ORDER, which is NOT rankLines and must not become it.
 *
 * rankLines answers "which lines does the user read this bar" and leads with
 * touches, as the spec says. This answers a different question: of the lines
 * built so far, which ones are still worth carrying. A line is CONSTRUCTED
 * ONCE, at its second anchor's confirm bar, so losing the cap is permanent,
 * and at that moment it has only its seed-time touches while the crowd around
 * it has had years to collect theirs. Sorting survival by touches therefore
 * kills every long line at birth. Measured as the LIVE CAP each acceptance
 * line needs to reach the last bar: under the touches-first order, 400 lines
 * for the EURUSD weekly 2021-01 to 2025-11 line, 1000 for the DXY monthly
 * 2011-05 to 2021-01 line and 1600 for the TSLA daily 2025-11 to 2026-04
 * line, against the 12 to 36 a pane default gave. (Those three figures are the
 * original measurement and are kept for the contrast; the crossings-first
 * numbers below were re-measured after Max Pierce split off Max Touch Gap.)
 *
 * Crossings lead instead, because they are the one line property that is
 * already meaningful at birth (it is counted over the whole span between the
 * anchors) and that does not reward age. Price having never been on both
 * sides of a line is exactly what a trader means by a line price respects.
 * Under it the same three lines need caps of 64 / 224 / 128. The same numbers
 * are in the spec's "Survival vs rank" section; keep them in step.
 *
 * Five integer keys plus a stored price, and a total order, so the Python twin
 * (survival_key) can sort on the same tuple and the ports cannot disagree.
 * `touches` is a half-step sum rather than an integer since Max Pierce split
 * off Max Touch Gap; halves are exact in binary floating point and both ports
 * add them in the same order, so the compare stays bit-identical. */
export function compareSurvival(a: TrendLine, b: TrendLine): number {
  if (a.crossings !== b.crossings) return a.crossings - b.crossings;
  const spanA = a.lastTouchIdx - a.i1;
  const spanB = b.lastTouchIdx - b.i1;
  if (spanA !== spanB) return spanB - spanA;
  if (a.touches !== b.touches) return b.touches - a.touches;
  if (a.lastTouchIdx !== b.lastTouchIdx) return b.lastTouchIdx - a.lastTouchIdx;
  if (a.i1 !== b.i1) return a.i1 - b.i1;
  return a.p1 - b.p1;
}

/** One calc row: the ranked operands plus the nearest. The template-literal
 * index lets `point[tlOutputName(r)]` type-check while `lines`/`pivots` on the
 * calc row stay outside the pattern. */
export interface TrendlinesPoint {
  tl_nearest?: number;
  [rank: `tl_${number}`]: number | undefined;
}

/** Read one output off a row BY NAME, where the name came from a config-driven
 * list rather than from the literal type. `tl_nearest` is a named field and
 * `tl_1 .. tl_N` a template-literal index signature, so neither half accepts a
 * plain `string`: this switch is what tells them apart, in place of a cast that
 * would silently let `tl_nearest` be read through the ranked signature. */
export function readOutput(row: TrendlinesPoint, name: string): number | undefined {
  return name === TL_NEAREST ? row[TL_NEAREST] : row[name as `tl_${number}`];
}

/** The setter half of readOutput, on the same split. `undefined` is never
 * written: an absent output is an absent KEY (the emit path's own contract). */
export function writeOutput(row: TrendlinesPoint, name: string, v: number): void {
  if (name === TL_NEAREST) row[TL_NEAREST] = v;
  else row[name as `tl_${number}`] = v;
}

const KINDS: readonly PivotKind[] = ["high", "low"];

/** Live means not aged out past its projection horizon. */
function isLive(line: TrendLine, i: number, cfg: TrendlinesConfig): boolean {
  return i - line.lastTouchIdx <= cfg.maxProjBars;
}

/** True when a line has grown past one of the user's ceilings (Max Touches,
 * Max Span). 0 means no limit on either.
 *
 * SILENCES, it does not delete, and the two callers are why. touches and span
 * only ever grow, so a line that crossed a ceiling can never come back: the
 * operand path (isMajor) stops reading it and the draw path stops painting it,
 * but it stays in live state so the touch and crossing passes still see it.
 * Contrast the slope gates, which DELETE at seed time because a line's slope is
 * fixed the moment it is defined.
 *
 * It is also the tie-break the live cap sorts on first (step 3). Without that,
 * the ceilings starve their own side: rankLines' first two keys are touches and
 * span descending, which is EXACTLY what these ceilings disqualify, so the
 * rejects sorted to the front of the MAX_LIVE_MULT * maxLines slots and evicted
 * the lines still eligible to emit. Measured on the DXY monthly fixture at
 * maxTouches 2, the top-rank operand fired on 246 bars at maxLines 3 against
 * 442 at maxLines 12, the setting silently blanked an operand a strategy
 * reads. */
export function overCeilings(line: TrendLine, cfg: TrendlinesConfig): boolean {
  if (cfg.maxTouches > 0 && line.touches > cfg.maxTouches) return true;
  if (cfg.maxSpanBars > 0 && line.lastTouchIdx - line.i1 > cfg.maxSpanBars) return true;
  if (cfg.maxTouchSpacing > 0 && line.maxTouchGap > cfg.maxTouchSpacing) return true;
  if (cfg.minTouchSpacing > 0 && line.minTouchGap < cfg.minTouchSpacing) return true;
  if (cfg.maxCrossings > 0 && line.crossings > cfg.maxCrossings) return true;
  return false;
}

/** Widest and narrowest stretch between two consecutive touches, in bars.
 *
 * ONE HELPER, ONE SORT, for both ends of the Touch Spacing range: computing
 * them apart would be two walks that can drift, and the Python twin mirrors
 * this single function.
 *
 * SORTS A COPY, because `touchIdxs` is in insertion order and not bar order:
 * the retro-count pass appends pivots that sit BETWEEN the anchors, and the
 * mixed pass appends ones BEFORE the first anchor, both after i2 is already in
 * the array. Sorting in place would reorder the marks the chart paints.
 *
 * Seed-time only. Every touch added later lands to the right of all of them,
 * so the detector maintains both numbers with one subtraction from there on.
 *
 * THE TWO GUARDS ARE NOT THE SAME VALUE, and that asymmetry is the point.
 * With fewer than two touches there is no gap to measure, so `widest` is 0
 * ("no ceiling crossed") and `narrowest` is Infinity ("no floor crossed").
 * Zero for both would fail EVERY floor above zero and silence the line. A line
 * always carries its two anchors, so this is a guard rather than a case, but a
 * guard that silences everything is the kind that hides for a year. */
export function touchGaps(touchIdxs: readonly number[]): {
  widest: number;
  narrowest: number;
} {
  if (touchIdxs.length < 2) return { widest: 0, narrowest: Infinity };
  const sorted = [...touchIdxs].sort((a, b) => a - b);
  let widest = 0;
  let narrowest = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > widest) widest = gap;
    if (gap < narrowest) narrowest = gap;
  }
  return { widest, narrowest };
}

/** Major means: enough touches, enough span, enough crossings, and covering
 * this bar. The floors live here because a line can still grow into them. */
export function isMajor(line: TrendLine, i: number, cfg: TrendlinesConfig): boolean {
  if (line.touches < cfg.minTouches) return false;
  if (overCeilings(line, cfg)) return false;
  const span = line.lastTouchIdx - line.i1;
  if (span < cfg.minSpanBars) return false;
  if (line.crossings < cfg.minCrossings) return false;
  return i >= line.i1 && i <= line.lastTouchIdx + cfg.maxProjBars;
}

/** True when the pivot at bar `k` sits far enough from the swing before it.
 *
 * The fractal test only asks about SHAPE: bar k is the extreme of its window.
 * It says nothing about SIZE, so a one-tick wobble in a quiet stretch is as
 * much a pivot as the top of a real leg. This adds the size condition.
 *
 * MEASURED AS THE LEG, not against the window Pivot Length defines. An earlier
 * version compared the pivot to the AVERAGE of its own fractal window, which
 * coupled the two settings in a way nobody could predict: widening the window
 * pulls that average further from the pivot, so the measured size GROWS with
 * Pivot Length and raising Pivot Length could ADD lines. Measured on the DXY
 * fixture at 1 ATR, pivots passing went 11 of 123 at Pivot Length 2 to 25 of 51
 * at Pivot Length 5, and the drawn count went 3 to 12. The leg has no such
 * coupling: it is the distance from this pivot to the most recent pivot on the
 * OTHER side, which is what a trader means by the size of a swing.
 *
 * LEFT ONLY, and causal: that opposite pivot is at some h < k, so it confirmed
 * at h + pivotLen, strictly before this pivot's own confirm bar. A later
 * opposite pivot has not happened yet.
 *
 * No opposite pivot yet (the start of the series) is a REJECT, not a pass:
 * unmeasurable is not the same as big, and it only affects the first swing.
 *
 * A negative leg (the "high" sits below the earlier low, which a spike can do)
 * fails on the same comparison, no special case needed.
 *
 * PARITY: a boolean that gates SET MEMBERSHIP, so it carries no quotient, and
 * both operands are single stored prices. */
export function isSignificantSwing(
  highs: ReadonlyArray<number>,
  lows: ReadonlyArray<number>,
  oppositePool: ReadonlyArray<number>,
  k: number,
  kind: PivotKind,
  atrK: number,
  mult: number,
): boolean {
  if (mult <= 0) return true;
  // Most recent opposite pivot strictly before k. Strictly, because one bar can
  // be both a strict high pivot and a strict low pivot (a lone spike), and the
  // high pool is filled before the low pool within a confirm bar.
  let h = -1;
  for (let q = oppositePool.length - 1; q >= 0; q--) {
    if (oppositePool[q] < k) {
      h = oppositePool[q];
      break;
    }
  }
  if (h < 0) return false;
  const leg = kind === "high" ? highs[k] - lows[h] : highs[h] - lows[k];
  return leg >= mult * atrK;
}

/** True when the pivot at bar `k` dominates at least `bars` bars to its LEFT.
 *
 * Pivot Length thresholds strength and then throws the measurement away: at
 * length 5, a bar that beats 40 bars each side and one that just wins its 5
 * register identically. This reads the reach itself, so a long swing can be
 * asked for without also lengthening the confirm lag (which is what raising
 * Pivot Length would cost).
 *
 * LEFT ONLY, and that is not an approximation. Right reach keeps growing for
 * bars after the pivot confirms, so a line's strength would change under a bar
 * already emitted: repainting, which this indicator does not do. Left reach is
 * final the moment the pivot exists.
 *
 * Scans at most `bars` back rather than measuring the true reach, because the
 * answer is a yes or no: it stops at the first violation or at the count. Runs
 * off the start of the series the same way isPivotAt does, by rejecting.
 *
 * Anything <= pivotLen is a no-op: isPivotAt already proved those bars. */
export function hasSwingReach(
  vals: ReadonlyArray<number>,
  k: number,
  kind: PivotKind,
  bars: number,
): boolean {
  if (bars <= 0) return true;
  if (k - bars < 0) return false;
  for (let j = k - bars; j < k; j++) {
    if (kind === "high" ? vals[j] >= vals[k] : vals[j] <= vals[k])
      return false;
  }
  return true;
}

/** True when the line is no steeper than `mult` ATRs of price per bar.
 *
 * A line's slope is fixed the moment it is defined and never rotates, so this
 * is checked once at seed time rather than every bar: a candidate that fails
 * can never come to pass the test later, and one that passes can never come to
 * fail it. That is why this gate DELETES where the touch and span ceilings only
 * silence.
 *
 * What it is for: a steep line outruns price and is never touched again. A fan
 * off one sharp pivot throws off a whole family of them, each steeper than the
 * last, and they crowd out the shallow lines price actually respects. Measured
 * on a live US100 daily chart, the shallow fan members ran at 0.04 ATR per bar
 * and the useless steep one at 0.16.
 *
 * PARITY: a boolean that gates SET MEMBERSHIP, so no quotient. Rather than
 * comparing |p2 - p1| / span against the threshold, both sides multiply through
 * by span, an exact positive integer, which is the same inequality with one
 * rounding source removed. */
export function withinSlope(
  line: TrendLine,
  atrAt: number,
  mult: number,
): boolean {
  if (mult <= 0) return true;
  const span = line.i2 - line.i1;
  const rise = line.p2 - line.p1;
  return Math.abs(rise) <= mult * atrAt * span;
}

/** True when the line is at least `mult` ATRs of price per bar steep.
 *
 * The mirror of withinSlope, and asked at the same moment for the same reason.
 * A line flat enough to be a horizontal shelf is not a trendline: SR_LEVELS
 * already draws those, properly, as levels. Same cross-multiplied form. */
export function aboveSlope(
  line: TrendLine,
  atrAt: number,
  mult: number,
): boolean {
  if (mult <= 0) return true;
  const span = line.i2 - line.i1;
  const rise = line.p2 - line.p1;
  return Math.abs(rise) >= mult * atrAt * span;
}

/** Mutable detector state after some prefix of bars has been processed. The
 * detector is causal (see the file header), so state after bars [0..m-1] is a
 * pure function of those bars. That is what lets the calc session below cache
 * it and re-run only the forming bar per live tick instead of the whole
 * series (a from-scratch run costs ~30ms at BTCUSD 1m bar counts, on EVERY
 * tick, which was the pan/zoom jank). */
interface TlState {
  startIdx: number;
  atr: Array<number | null>;
  highs: number[];
  lows: number[];
  closes: number[];
  /** Filter-passing pivots of BOTH kinds, in confirm order (high before low
   * within a bar). What may seed or touch a line. */
  pool: { idxs: number[]; kinds: PivotKind[] };
  /** EVERY confirmed fractal pivot per kind, including the ones the size and
   * reach gates reject, because the Min Pivot Size leg runs to the previous
   * turn of the other kind whether or not that turn was big enough to trade. */
  turns: Record<PivotKind, number[]>;
  lines: TrendLine[];
  points: TrendlinesPoint[];
}

export function buildTlState(
  dataList: KLineData[],
  m: number,
  cfg: TrendlinesConfig,
  startIdx = 0,
): TlState {
  const prefix = m === dataList.length ? dataList : dataList.slice(0, m);
  const atr: Array<number | null> =
    startIdx > 0 ? new Array(m).fill(null) : atrSeries(prefix, TL_ATR_LEN);
  if (startIdx > 0) {
    const windowed = atrSeries(prefix.slice(startIdx), TL_ATR_LEN);
    for (let i = 0; i < windowed.length; i++) atr[startIdx + i] = windowed[i];
  }
  const st: TlState = {
    startIdx,
    atr,
    highs: prefix.map((d) => d.high),
    lows: prefix.map((d) => d.low),
    closes: prefix.map((d) => d.close),
    pool: { idxs: [], kinds: [] },
    turns: { high: [], low: [] },
    lines: [],
    points: Array.from({ length: m }, () => ({})),
  };
  for (let i = startIdx; i < m; i++) stepTrendlinesBar(st, i, cfg);
  return st;
}

export function computeTrendlines(
  dataList: KLineData[],
  cfg: TrendlinesConfig,
): { points: TrendlinesPoint[]; lines: TrendLine[]; atr: number[]; pivots: TrendPivots } {
  const n = dataList.length;
  if (n === 0)
    return { points: [], lines: [], atr: [], pivots: { idxs: [], kinds: [], highs: [], lows: [] } };
  const st = buildTlState(dataList, n, cfg);
  return { points: st.points, lines: st.lines, atr: st.atr as number[], pivots: pivotsOf(st) };
}

function pivotsOf(st: TlState): TrendPivots {
  return { idxs: st.pool.idxs, kinds: st.pool.kinds, highs: st.highs, lows: st.lows };
}

/** The price distance past which a line is too far from bar i's close, or
 * Infinity when neither Max Distance cut is on. The ATR cut and the percent
 * cut are applied on their own, so the tighter of the two is the band. The
 * ATR half needs a warmed ATR, which every caller here has (the confirm-bar
 * block runs only when atr[i] is non-null). Ported to Python as
 * max_distance_tol. */
export function maxDistanceTol(cfg: TrendlinesConfig, atrI: number, close: number): number {
  let tol = Infinity;
  if (cfg.maxDistAtr > 0) tol = cfg.maxDistAtr * atrI;
  if (cfg.maxDistPct > 0) {
    const pct = Math.abs(close) * (cfg.maxDistPct / 100);
    if (pct < tol) tol = pct;
  }
  return tol;
}

/** True when the line projects within `tol` of `close` at bar j. */
function withinDistance(line: TrendLine, j: number, close: number, tol: number): boolean {
  return Math.abs(projectAt(line, j) - close) <= tol;
}

/** One bar of the detector. Reads/writes state only at indices <= i (causal),
 * which the incremental session relies on. Ported line for line to Python. */
function stepTrendlinesBar(st: TlState, i: number, cfg: TrendlinesConfig): void {
  const { atr, highs, lows, closes, pool, turns, points } = st;
  let lines = st.lines;
  const a = atr[i];

  // 1. PER-BAR crossing step for every existing line. Every line here was
  //    seeded at an earlier confirm bar and has consumed closes through it, so
  //    this bar is the next one. Needs no ATR.
  for (const line of lines) stepCrossing(line, i, closes[i]);

  // 2. CONFIRM-BAR work for the pivot at bar k = i - pivotLen.
  const k = i - cfg.pivotLen;
  if (k >= 0 && a !== null) {
    // Max Distance, measured at THIS bar's close: the only price the calc can
    // see without lookahead. Infinity when both cuts are off.
    const distTol = maxDistanceTol(cfg, a, closes[i]);
    for (const kind of KINDS) {
      const vals = kind === "high" ? highs : lows;
      if (!isPivotAt(vals, k, cfg.pivotLen, cfg.pivotLen, kind, true)) continue;
      turns[kind].push(k);
      // Size gate first, so a rejected bar is not a pivot in any sense. atr[k],
      // not atr[i]: measured where the swing happened. Whole block behind
      // minSwingAtr > 0 so that off means untouched.
      if (cfg.minSwingAtr > 0) {
        const atrK = atr[k];
        if (atrK === null) continue;
        const opposite = turns[kind === "high" ? "low" : "high"];
        if (!isSignificantSwing(highs, lows, opposite, k, kind, atrK, cfg.minSwingAtr)) continue;
      }
      if (!hasSwingReach(vals, k, kind, cfg.minSwingReach)) continue;
      const price = vals[k];

      // 2a. Test the new pivot against every existing line, whatever kind
      //     either is. `k > line.i2` keeps the gap bookkeeping O(1): pivots
      //     confirm in bar order, so k is right of every recorded touch.
      const tolA = atr[k];
      if (tolA !== null) {
        for (const line of lines) {
          if (k <= line.i2) continue;
          const w = touchWeight(line, k, price, kind, cfg.touchMult * tolA, cfg.pierceMult * tolA);
          if (w > 0) {
            line.touches += w;
            line.touchIdxs.push(k);
            line.touchKinds.push(kind);
            const gap = k - line.maxTouchIdx;
            if (gap > line.maxTouchGap) line.maxTouchGap = gap;
            if (gap < line.minTouchGap) line.minTouchGap = gap;
            line.maxTouchIdx = k;
            line.lastTouchIdx = k;
          }
        }
      }

      // 2b. Seed candidates against the previous pairPivots pool entries, of
      //     either kind. The pool push happens AFTER this loop.
      const from = Math.max(0, pool.idxs.length - cfg.pairPivots);
      for (let q = from; q < pool.idxs.length; q++) {
        const i1 = pool.idxs[q];
        // A bar's own high and low confirm together and would give span 0.
        if (i1 >= k) continue;
        const k1 = pool.kinds[q];
        const p1 = k1 === "high" ? highs[i1] : lows[i1];
        const cand: TrendLine = {
          i1, p1, k1,
          i2: k, p2: price, k2: kind,
          touches: 2,
          touchIdxs: [i1, k],
          touchKinds: [k1, kind],
          lastTouchIdx: k,
          crossings: 0,
          lastSign: 0,
          maxTouchGap: k - i1,
          minTouchGap: k - i1,
          maxTouchIdx: k,
        };
        // Slope first: one comparison, asked once because the line never
        // rotates.
        if (cfg.maxSlopeAtr > 0 || cfg.minSlopeAtr > 0) {
          const atrK = atr[k];
          if (atrK === null) continue;
          if (!withinSlope(cand, atrK, cfg.maxSlopeAtr)) continue;
          if (!aboveSlope(cand, atrK, cfg.minSlopeAtr)) continue;
        }
        // Max Distance next, also one comparison, and BEFORE the two walks
        // below: a candidate too far from price on the day it would be born
        // is never built, so the O(span) work is not paid for a line the cut
        // would drop on this same bar anyway.
        if (distTol !== Infinity && !withinDistance(cand, i, closes[i], distTol)) continue;
        // Back clearance next, still before the crossing walk: bounded by
        // minBackBars where the walk is O(span). It reads ONLY bars before
        // i1, so it is fixed the moment the line is defined and cannot repaint.
        if (!hasBackClearance(cand, closes, st.startIdx, cfg.minBackBars)) continue;
        // Crossings over (i1, i]: the closes between the anchors and since the
        // second anchor, all of which have already happened.
        for (let j = i1 + 1; j <= i; j++) stepCrossing(cand, j, closes[j]);
        // Retro touches: pool entries strictly between the anchors, of either
        // kind. The pool is in bar order and i1 IS pool.idxs[q], so the window
        // starts at q + 1 and ends at the first entry reaching k. An entry AT
        // i1 (the other extreme of the anchor bar) is not a touch.
        for (let q2 = q + 1; q2 < pool.idxs.length; q2++) {
          const pj = pool.idxs[q2];
          if (pj >= k) break;
          if (pj === i1) continue;
          const tolP = atr[pj];
          if (tolP === null) continue;
          const kj = pool.kinds[q2];
          const pv = kj === "high" ? highs[pj] : lows[pj];
          const w = touchWeight(cand, pj, pv, kj, cfg.touchMult * tolP, cfg.pierceMult * tolP);
          if (w > 0) {
            cand.touches += w;
            cand.touchIdxs.push(pj);
            cand.touchKinds.push(kj);
          }
        }
        // Recomputed once every seed-time touch is in (touchIdxs is not in
        // bar order; touchGaps sorts a copy).
        const seedGaps = touchGaps(cand.touchIdxs);
        cand.maxTouchGap = seedGaps.widest;
        cand.minTouchGap = seedGaps.narrowest;
        cand.maxTouchIdx = cand.i2;
        lines.push(cand);
      }
      pool.idxs.push(k);
      pool.kinds.push(kind);
    }

    // 3. Prune the dead and the far (Max Distance: a line past the cut at
    //    this close leaves for good; it re-enters only if later pivots seed
    //    it again), then cap live state by the SURVIVAL order, IN TOTAL
    //    (compareSurvival, not rankLines: see its comment). Ceiling-failed
    //    lines still sort last: they can never re-qualify, and the survival
    //    order would otherwise hand them the front of the queue.
    const keep = (l: TrendLine) =>
      isLive(l, i, cfg) && (distTol === Infinity || withinDistance(l, i, closes[i], distTol));
    if (lines.some((l) => !keep(l))) lines = lines.filter(keep);
    const cap = MAX_LIVE_MULT * cfg.maxLines;
    if (lines.length > cap) {
      lines.sort(
        (x, y) => Number(overCeilings(x, cfg)) - Number(overCeilings(y, cfg)) || compareSurvival(x, y),
      );
      lines = lines.slice(0, cap);
    }
  }

  // 4. Emit: the live majors in rank order fill tl_1..tl_maxLines; the one
  //    nearest the close fills tl_nearest (ties to the better rank, since the
  //    walk is in rank order and only a STRICTLY nearer line displaces).
  const close = closes[i];
  const point: TrendlinesPoint = {};
  const majors = lines.filter((l) => isLive(l, i, cfg) && isMajor(l, i, cfg));
  majors.sort(rankLines);
  let nearestV = 0;
  let nearestD = Infinity;
  for (let r = 0; r < majors.length; r++) {
    const v = projectAt(majors[r], i);
    if (r < cfg.maxLines) point[tlOutputName(r + 1) as `tl_${number}`] = v;
    const d = Math.abs(v - close);
    if (d < nearestD) {
      nearestD = d;
      nearestV = v;
    }
  }
  if (majors.length) point.tl_nearest = nearestV;
  points[i] = point;
  st.lines = lines;
}

const cloneTrendLine = (l: TrendLine): TrendLine => ({
  ...l,
  touchIdxs: l.touchIdxs.slice(),
  touchKinds: l.touchKinds.slice(),
});

/** ATR(14) for bar j, incrementally: the exact value atrSeries would put at j
 * (same trueRangeAt / rmaNext operations — atrSeries itself runs them), given
 * the values before it. The seed bar (and the never-expected null-prev case)
 * fall back to a from-scratch prefix run, which is O(TL_ATR_LEN) there. */
function tlAtrAt(
  atr: Array<number | null>,
  dataList: KLineData[],
  j: number,
  startIdx = 0,
): number | null {
  if (j < startIdx + TL_ATR_LEN - 1) return null;
  const prev = j > 0 ? atr[j - 1] : null;
  if (j === startIdx + TL_ATR_LEN - 1 || prev === null)
    return atrSeries(dataList.slice(startIdx, j + 1), TL_ATR_LEN)[j - startIdx];
  return rmaNext(prev, trueRangeAt(dataList, j), TL_ATR_LEN);
}

/** Fold bar i into the state: fill its high/low/ATR slots, then run the
 * detector step. */
function advanceTlBar(
  st: TlState,
  dataList: KLineData[],
  i: number,
  cfg: TrendlinesConfig,
): void {
  st.highs[i] = dataList[i].high;
  st.lows[i] = dataList[i].low;
  st.closes[i] = dataList[i].close;
  st.atr[i] = tlAtrAt(st.atr, dataList, i, st.startIdx);
  stepTrendlinesBar(st, i, cfg);
}

export interface TrendlinesSession {
  compute(
    dataList: KLineData[],
    cfg: TrendlinesConfig,
    /** Compute floor (ms): the detector runs from the first bar at/after this
     * timestamp instead of bar 0 — the viewport-scoped path for
     * chart-timeframe instances. Absent or 0 = full run. */
    floorTs?: number,
  ): {
    points: TrendlinesPoint[];
    lines: TrendLine[];
    atr: number[];
    pivots: TrendPivots;
  };
}

/** First index with timestamp >= ts (dataList ascending); 0 for ts<=first. */
function floorIdxOf(dataList: KLineData[], ts: number | undefined): number {
  if (!ts || !dataList.length || ts <= dataList[0].timestamp) return 0;
  let lo = 0;
  let hi = dataList.length; // may return length: an all-older list gives an
  // empty window, which buildTlState handles as a no-op loop.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dataList[mid].timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Incremental twin of computeTrendlines, for the live calc path. klinecharts
 * re-runs calc synchronously on EVERY tick, over the full loaded series; this
 * session caches detector state through the CLOSED bars (which a tick cannot
 * change — the detector is causal) and re-runs only the forming bar, so a tick
 * costs O(live lines + pivot pool) instead of O(series).
 *
 * HOW A TICK STAYS ISOLATED: the forming bar's values change tick to tick, so
 * nothing it causes may leak into the cached base. The per-tick fork clones the
 * three structures the step MUTATES (pools, turns, lines) and shares the flat
 * per-bar arrays (atr/highs/lows/points), whose index n-1 is a scratch slot the
 * next tick deterministically overwrites — indices < n-1 belong to closed bars
 * and are never written again.
 *
 * INVALIDATION is by dataList ARRAY IDENTITY plus config equality: klinecharts
 * mutates one array in place for ticks and appends (the fast paths), and mints
 * a NEW array for init loads and history prepends (v10 _addData: forward is
 * `data.concat(this._dataList)`), which correctly forces the full rebuild —
 * bar indices shift on a prepend, so nothing cached survives it anyway.
 *
 * The returned prefix point rows are SHARED across ticks (that is the saving:
 * no per-tick clone of the whole series). Consumers of indicator.result must
 * treat rows as read-only, which the draw path already does. */
export function createTrendlinesSession(): TrendlinesSession {
  let ref: KLineData[] | null = null;
  let cfgKey = "";
  let base: TlState | null = null;
  let baseCount = 0;
  let lastBaseTs = 0;
  let lastFloorIdx = 0;

  return {
    compute(dataList, cfg, floorTs) {
      const n = dataList.length;
      if (n === 0) {
        base = null;
        ref = null;
        return {
          points: [],
          lines: [],
          atr: [],
          pivots: { idxs: [], kinds: [], highs: [], lows: [] },
        };
      }
      // parseTrendlinesConfig builds the object with a fixed key order, so the
      // JSON string is a stable equality key for its 16 numbers.
      const key = JSON.stringify(cfg);
      // A floor change in EITHER direction rebuilds: left extension needs the
      // detector re-run from the deeper start (left-to-right state), and a
      // right rebase deliberately drops deep-history cost. Appends never move
      // the index (the prefix under a fixed floorTs is untouched).
      const floorIdx = Math.min(floorIdxOf(dataList, floorTs), n - 1);
      const usable =
        base !== null &&
        dataList === ref &&
        key === cfgKey &&
        floorIdx === lastFloorIdx &&
        n >= baseCount + 1 &&
        (baseCount === 0 ||
          dataList[baseCount - 1]?.timestamp === lastBaseTs);
      if (!usable) {
        base = buildTlState(dataList, n - 1, cfg, floorIdx);
        baseCount = n - 1;
        ref = dataList;
        cfgKey = key;
        lastFloorIdx = floorIdx;
      } else if (baseCount < n - 1) {
        // Bars closed since the last compute (klinecharts appends in place):
        // fold their final values into the base. Their array slots may hold a
        // stale tick's scratch — advanceTlBar overwrites all of them.
        for (let j = baseCount; j < n - 1; j++)
          advanceTlBar(base as TlState, dataList, j, cfg);
        baseCount = n - 1;
      }
      lastBaseTs = baseCount > 0 ? dataList[baseCount - 1].timestamp : 0;
      const b = base as TlState;
      const fork: TlState = {
        startIdx: b.startIdx,
        atr: b.atr,
        highs: b.highs,
        lows: b.lows,
        closes: b.closes,
        points: b.points,
        pool: { idxs: b.pool.idxs.slice(), kinds: b.pool.kinds.slice() },
        turns: { high: b.turns.high.slice(), low: b.turns.low.slice() },
        lines: b.lines.map(cloneTrendLine),
      };
      advanceTlBar(fork, dataList, n - 1, cfg);
      // A fresh top-level array per call (callers replace the last row), with
      // the prefix rows shared — see the isolation note above.
      // Same atr cast as computeTrendlines: warm-up bars are null at runtime.
      // From the FORK, like the lines: the forming bar can confirm a pivot
      // (at n - 1 - pivotLen), and a mark that appeared only after the bar
      // closed would lag the line it just seeded by one bar.
      return {
        points: b.points.slice(0, n),
        lines: fork.lines,
        atr: b.atr as number[],
        pivots: pivotsOf(fork),
      };
    },
  };
}

/** Render-only options, on extendData rather than calcParams — the same seam
 * SR_LEVELS uses for showMidline. Because none of this changes a value, it
 * needs no Python port and no parity test. */
/** Everything the higher timeframe produced, written by the MTF coordinator
 * (applyTrendlinesTimeframe) and read by calc. Only `timeframe` is persisted
 * (see refreshMtfIndicators); the series are re-fetched per session.
 *
 * THE LINES ARE IN HTF BAR INDICES. Mapping them onto chart bars here would
 * quietly break three things that read those indices as identities rather than
 * as positions: sharesPivot's touch-index membership test (float equality on
 * interpolated indices), lineKey (a pin would rebind on every reload), and the
 * span ceilings (chart bars compared against an HTF-denominated setting). The
 * conversion happens once, at the last step, where an index becomes a pixel. */
export interface TrendlinesMtf extends MtfSeriesBase {
  htfStarts?: number[]; // HTF bar open timestamps (ms)
  htfMs?: number; // HTF bar duration (ms)
  htfOutputs?: string[]; // trendlinesOutputs(cfg) at build time
  htfPoints?: TrendlinesPoint[]; // one calc row per HTF bar
  htfLines?: TrendLine[]; // live lines at the last closed HTF bar
  htfPivots?: TrendPivots; // filter-passing pivots, in HTF bar indices
  /** ATR(14) on the HTF bars. The merge tolerance is ATR-denominated, so the
   * chart's own ATR would scale it by the ratio between the timeframes. */
  htfAtr?: number;
}

export interface TrendlinesExtend {
  /** Compute floor (ms) for CHART-TIMEFRAME instances: the detector runs from
   * the first bar at/after this timestamp instead of bar 0. Stamped by the
   * coordinator's viewport pass (stampTrendlinesFloors) — monotone-left while
   * the view explores, rebased right after a far jump back toward the
   * present. Session-only, never persisted; pinned instances (mtf.timeframe
   * set) ignore it, their windowing lives in the HTF stash interval. */
  tlFloorTs?: number;
  /** "ray" keeps going right (default), "segment" stops at the last touch,
   * "extended" also draws back before the first anchor. Backward extension is
   * never readable by an operand: a line emitting values before its first
   * anchor existed would be lookahead.
   *
   * "cross" is a ray that stops early, where this line first meets another
   * DRAWN one. When nothing is met it stops at the newest bar rather than
   * running the full horizon, or a line with no meeting shoots far past
   * neighbours that stopped near the last candle. "lastbar" ends every line
   * at the newest bar. Because a meeting depends on which lines are drawn, it
   * moves with maxLines and with proximity order. That is fine here and only
   * here: this is the draw path, and no operand reads it. */
  extend?: "ray" | "segment" | "extended" | "cross" | "lastbar";
  /** LEGACY off switch for the merge pass, read but no longer written: the
   * panel dropped the checkbox once it was clear that `dedupeAtr: 0` says the
   * same thing (dropDuplicates returns everything at tol 0). Kept as a reader
   * so a pane saved with the box unticked stays unmerged; the settings modal
   * opens such a pane on tolerance 0 and clears the flag. */
  dedupe?: boolean;
  /** How far apart two lines through the same pivot may project at the last bar
   * and still merge, in ATR(14). Absent takes TL_DEDUPE_ATR; 0 IS THE OFF
   * SWITCH, and is the only one the panel offers.
   *
   * A FIELD, after two rounds of arguing it should stay a constant. What
   * settled it was the two charts disagreeing: the DXY monthly fixture wants a
   * wider tolerance to collapse its fans, and a live US100 daily pane wants a
   * narrower one, because there every merge is between lines that begin months
   * apart and converge on one later pivot rather than a fan off a shared
   * origin. One number cannot be right for both, which is the case a setting
   * exists for. */
  dedupeAtr?: number;
  /** Which decluttering rule the pane runs. Defaults to "off".
   *
   * "near" is RETIRED, read but never written: it drew only the lines within
   * TL_NEAR_PRICE_ATR of the close at the last bar. That job moved into the
   * calc as the two Max Distance params (calcParams 19 and 20), and a pane
   * saved with "near" migrates onto Max Distance 5 ATR in
   * parseTrendlinesConfig; declutterMode reads it as "off".
   *
   * "pivot": keep ONE line where several run through the same pivot, the one
   * closest to price, however far apart they sit. This is the merge pass with
   * its tolerance removed rather than a new rule, so the two exemptions still
   * hold (a line an operand reads, a pinned line) — but unlike merging it does
   * NOT wait on a non-zero `dedupeAtr`, because picking it here is the explicit
   * instruction that a tolerance only implies. What it answers is the fan no
   * tolerance a pane can afford would collapse: three lines through one swing
   * low, 18 and 27 points apart at the last bar, need ~8.5 ATR to merge and
   * that number would swallow half the pane elsewhere. The cost belongs to
   * whoever picks it: a shared pivot sometimes joins two genuinely different
   * levels (a year-long support that happens to touch the same swing as a
   * three-week one), and this always keeps the nearer.
   *
   * Render-only like the rest of this block: a line hidden here still emits,
   * and selectDrawnLines draws it anyway if it does. */
  declutter?: "off" | "near" | "pivot";
  /** LEGACY spelling of `declutter`, from when near-price was a checkbox and
   * the only rule. Read only by the Max Distance migration (legacyNearPrice
   * in trendlinesOutputs) when `declutter` is absent. Never written. */
  nearPrice?: boolean;
  /** Mark every pivot that passed the PIVOT FILTER with a small caret just
   * outside its wick — the confirmed fractal turns that also cleared Min Pivot
   * Size and Min Pivot Reach, which is the set that may seed or touch a line.
   * OFF by default.
   *
   * DELIBERATELY OUTSIDE the "one gate for both surfaces" rule the drawn LINES
   * follow. maxLines, Declutter and the isMajor floors all choose
   * which lines survive; a mark is not a line and is not gated by any of them,
   * so a pivot that seeded nothing (or whose line lost its drawing slot) is
   * still marked. That is the point of the setting: it shows what the pivot
   * settings are actually admitting, which is otherwise only visible through
   * the lines they happen to produce. Do not "fix" it toward the lines' gate.
   *
   * Render-only, like everything else in this block. */
  showPivots?: boolean;
  /** Mark the pivots the DRAWN lines actually rest on — every anchor and every
   * counted touch — with a stemmed arrow, up under a low and down over a high.
   * ON by default.
   *
   * The complement of showPivots, not a variant of it. showPivots answers
   * "what is the pivot filter admitting"; this answers "which of those turns
   * built something you can see". A pane with a loose filter marks dozens of
   * swings and only a handful of them carry a line, and until now nothing on
   * the chart said which.
   *
   * GATED BY THE DRAWN SET, deliberately, and this is the one place the marks
   * DO follow the lines' gate: the mark exists to point at a line on screen,
   * so a mark for a line maxLines or Declutter threw away would point at
   * nothing. That is the opposite of showPivots' rule directly above, and the
   * difference is the whole reason both settings exist.
   *
   * A DISTINCT GLYPH, not a weight: the stem is what tells the two marks
   * apart at a glance. Dimming the unused ones instead was tried and read as
   * "disabled" rather than "admitted but unused". Where both settings are on,
   * a used pivot takes the stemmed arrow ONLY — it does not also get the plain
   * triangle, or the two would overdraw each other on the same swing.
   *
   * Render-only, like everything else in this block. */
  showLinePivots?: boolean;
  /** How faded a dimmed line paints, as a PERCENT of full opacity. Absent
   * takes TL_DIM_ALPHA. Governs every dim on the pane, whatever put a line
   * into it: "dimmed" is one visual state, and a second knob would only let a
   * pane say two shades of the same sentence.
   *
   * A FIELD rather than the constant it used to be because the right value
   * depends on the pane's theme and on how many lines are drawn: on a light
   * chart with four lines 60% is a clear step down, and on a dark one carrying
   * fifteen it is still too loud. The value is clamped, not honoured raw: a
   * line at 0 is not dim, it is missing, and Declutter is the control that
   * removes a line. */
  dimOpacity?: number;
  /** Dim a line once it has been touched this many times or more, in pivots.
   * 0 (or absent) is the off switch, the same idiom `maxTouches` uses.
   *
   * The complaint it answers: touch count is already painted (the ×N tag), but
   * reading a number off every line is work a glance should do. A line price
   * has leaned on many times is not the same object as a fresh one — whether
   * that makes it stronger or spent is the trader's call, and this only says
   * "this one has history", it does not rank them.
   *
   * NOT `maxTouches`, which DROPS such a line from the pane and from what an
   * operand may read. This is the softer statement, and it is render-only: a
   * dimmed line still emits, and every gate still sees it. Set both and the
   * drop wins, because isMajor runs first. */
  dimTouches?: number;
  /** Dim a line that has gone this many bars without a touch. 0 (or absent) is
   * off.
   *
   * MEASURED FROM `lastTouchIdx`, not from the first anchor, because staleness
   * is about how long ago price last agreed with the line, not how old the line
   * is: a decade-long support touched last week is live, and a three-week line
   * last touched at its second anchor is not. It is also the clock maxProjBars
   * already ages a line out on, so the two say the same kind of thing and a
   * user who has met one can predict the other.
   *
   * Render-only and softer than `maxSpanBars` in exactly the way `dimTouches`
   * is softer than `maxTouches`. */
  dimStaleBars?: number;
  /** Lines the user pinned open by clicking their end handle, as lineKey()
   * strings. A pinned line ignores `extend` and runs to the right edge of the
   * pane, re-measured every render so it stays "indefinite" through scroll and
   * zoom instead of baking in a bar count. SESSION-ONLY: never persisted, and
   * applyIndicator strips it off a saved snapshot / template / paste. */
  pinned?: string[];
  /** Multi-timeframe: lines and operand series detected on a higher timeframe
   * and aligned onto the chart bars inside calc (no lookahead). THE ONE KEY ON
   * THIS INTERFACE THAT CALC READS: everything else here is render-only, and a
   * timeframe is not a drawing choice but a statement of which candles the
   * indicator runs on, which is how the Python twin treats it too. */
  mtf?: TrendlinesMtf;
  /** Render-only override for TL_LINE_COLOR: every stroke and fill this
   * instance paints (lines, touch rings, pin handles, ×N tags, pivot marks)
   * uses this colour instead. Absent keeps TL_LINE_COLOR, the shared default.
   * Like the rest of this block it never reaches calc, so it has no Python
   * twin and no calcParams entry. */
  lineColor?: string;
}

/** Stable identity for a line across recomputes, for pinning.
 *
 * NOT the bar indices: those shift by the whole prepended length the moment
 * older history loads, which would silently move every pin onto a different
 * line. Anchor TIMESTAMPS are immutable, so a pin survives history loads,
 * timeframe reloads and a page refresh. */
export function lineKey(
  line: TrendLine,
  dataList: KLineData[],
  /** Bar-open timestamps of the space the line's indices live in, when that is
   * NOT the chart's own bars: under a timeframe pin i1/i2 are HTF indices, so
   * reading them out of `dataList` would key the pin off whatever chart bar
   * happens to sit at that index. */
  starts?: number[],
): string {
  const t1 = (starts ? starts[line.i1] : dataList[line.i1]?.timestamp) ?? line.i1;
  const t2 = (starts ? starts[line.i2] : dataList[line.i2]?.timestamp) ?? line.i2;
  return `${t1}:${t2}`;
}

/** calc result row. The full line list rides on the LAST row only (draw reads
 * it there), exactly as SR_LEVELS carries its levels. */
export type TrendlinesCalcPoint = TrendlinesPoint & {
  lines?: TrendLine[];
  atr?: number;
  /** Every pivot that passed the pivot filter, riding the last row like the
   * lines. Read only by the draw path (Show pivots) — no operand reads it, so
   * it needs no Python twin. */
  pivots?: TrendPivots;
  /** The bar index the last row's values were read at, IN THE LINES' OWN SPACE:
   * the last chart bar normally, and under a timeframe pin the last HTF bar
   * that had closed by then. The draw path measures everything at it, and its
   * projections must equal the emitted values bit for bit (selectDrawnLines
   * compares them with ===) or an operand's line loses its exemptions. */
  lineIdx?: number;
};

/** How far apart two lines THROUGH THE SAME PIVOT may project at the last bar
 * and still count as one line, in ATR(14).
 *
 * WAS 1 ATR, on the reasoning that a gap smaller than a typical bar's range is
 * not a level a trader can trade differently. True, and too tight: 1 ATR only
 * ever caught the tail of a fan. On a US100 4H chart a sheaf through one swing
 * high kept three members 1.1 to 2.1 ATR apart, which is the clutter this pass
 * exists to remove. Measured on the DXY monthly fixture over every bar from 100
 * on, the drawn near-twins (two drawn lines sharing a pivot and projecting
 * within 2.5 ATR of each other) run at 2.02 per bar at 1 ATR, 1.17 at 2 and
 * 0.76 at 2.5, and 3 and 4 ATR buy nothing further: what is left at 2.5 is only
 * the pairs merging is FORBIDDEN to touch (a line an operand reads, or a pinned
 * one). The knee is 2.5, so that is the value. It costs the drawn count almost
 * nothing (5.72 lines per bar to 5.46) because the freed slots refill.
 *
 * As generous as it is only because the shared-pivot requirement carries the
 * real weight (see dropDuplicates). A tolerance this wide applied to any two
 * lines would swallow unrelated levels.
 *
 * THAT REQUIREMENT HAS ITSELF LOOSENED, so the two changes compound and the
 * sentence above is a weaker guarantee than it was: sharing now counts a TOUCH
 * bar, not only an anchor. Measured on the DXY monthly fixture at the last bar,
 * of the 35 pairs close enough to merge, 27 share an anchor and 8 share only a
 * touch, and only 2 of those 8 sit wider than the old 1 ATR. So two pairs on
 * that chart exist purely because both changes landed, which is why neither is
 * worth walking back. Anyone loosening either half again should re-measure this
 * split rather than lean on the paragraph above.
 *
 * Half of TL_NEAR_PRICE_ATR is the ceiling this must not cross: at more than
 * that, a line at the close and a line at the far edge of the band that is
 * drawn at all could merge into each other.
 *
 * STILL A CONSTANT, not a panel field, and the new evidence does not touch that
 * argument: it says the VALUE was wrong, not that the answer belongs to the
 * user. Nor cfg.touchMult, though the argument for coupling them is a good one.
 * Touch Tolerance already earns its keep deciding what counts as a touch;
 * giving it a second, invisible job would mean loosening touches also quietly
 * thins the chart, which is the kind of double duty this file has documented at
 * length elsewhere (see maxLines) precisely because it keeps surprising people.
 * Merging stays predictable instead. */
export const TL_DEDUPE_ATR = 1;


/** The dedup pass's inputs. `tol` is a price distance (0 or NaN turns merging
 * off, which is what an unwarmed ATR gives on the first TL_ATR_LEN bars).
 * `keep` names lines that must survive merging whatever their twins look
 * like — the PINNED ones. A pin is stored by lineKey and its only control is
 * the handle painted at the line's end, so merging a pinned line away would
 * leave a pin with nothing to click, exactly the dead-state the `stops` gate
 * exists to prevent. */
export interface TrendlineDedupe {
  tol: number;
  keep: ReadonlySet<TrendLine>;
}

/** The dedup tolerance for a bar's ATR, or 0 when merging is off or the ATR
 * has not warmed up yet. */
/** The pane's decluttering rule, with the legacy `nearPrice` checkbox folded
 * in. ONE reader for the chart and the settings modal, so a pane that predates
 * the select cannot open on one rule and draw another. */
export function declutterMode(
  ext: Pick<TrendlinesExtend, "declutter" | "nearPrice"> | undefined,
): "off" | "pivot" {
  return ext?.declutter === "pivot" ? "pivot" : "off";
}

/** DEFAULT alpha a dimmed line paints at, and the floor the panel's percent is
 * read against.
 *
 * ONE DEPTH FOR EVERY DIM. There used to be two (0.45 and 0.6) back when a
 * line could be BROKEN and had to read as more than merely stale. The sideless
 * detector has no broken state at all: price crosses a line freely and the
 * count is a label, so every dim left on the pane means the same thing and a
 * pane that has asked for two of them is asking for one background, not a
 * ranking.
 *
 * 0.6 is far enough below 1 to register at a glance and far enough above
 * nothing to leave the line readable. */
export const TL_DIM_ALPHA = 0.6;

/** The alpha a dimmed line paints at, from the panel's percent.
 *
 * CLAMPED to [10%, 100%]: a line at 0 is not dim, it is gone, and hiding a
 * line is what Declutter is for — a fade that can reach invisible would hide
 * one with no row saying so. Anything not a finite number
 * (an older pane with no such key, a hand-written payload) takes the default,
 * the same fallback dedupeTolerance uses for its multiple. */
export function trendlineDimAlpha(
  ext: Pick<TrendlinesExtend, "dimOpacity"> | undefined,
): number {
  const pct = ext?.dimOpacity;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return TL_DIM_ALPHA;
  return Math.min(100, Math.max(10, pct)) / 100;
}

/** True when a line should paint faded: well touched, or long untouched.
 *
 * The two conditions OR together: they answer different questions (has price
 * leaned on this often, and has it forgotten about it), and a user who sets
 * both means either. Only positive finite thresholds count, so an absent key,
 * a 0 and a hand-written payload all read as off — the file's standing off
 * switch idiom.
 *
 * A PURE PREDICATE beside declutterMode, and for the same reason: the draw
 * path is canvas paint, so a rule buried in it cannot be tested, and any
 * second surface that wants to explain the fade must be able to ask. */
export function trendlineDimmed(
  line: Pick<TrendLine, "touches" | "lastTouchIdx">,
  /** The bar the whole draw path measures at, in the LINES' own space (an HTF
   * bar under a timeframe pin), so the stale count is in the bars the line was
   * detected on rather than the chart's. */
  atIdx: number,
  ext: Pick<TrendlinesExtend, "dimTouches" | "dimStaleBars"> | undefined,
): boolean {
  const t = ext?.dimTouches;
  if (typeof t === "number" && Number.isFinite(t) && t > 0 && line.touches >= t)
    return true;
  const b = ext?.dimStaleBars;
  return (
    typeof b === "number" &&
    Number.isFinite(b) &&
    b > 0 &&
    atIdx - line.lastTouchIdx >= b
  );
}

export function dedupeTolerance(
  atr: number | undefined,
  /** LEGACY `dedupe` flag — false only on a pane saved while the old checkbox
   * existed, and equivalent to a 0 tolerance. Nothing writes it any more. */
  on: boolean,
  /** ATR multiple from the panel, and the ONLY off switch it offers. Anything
   * not a finite number >= 0 (an older chart with no such key, a hand-written
   * payload) falls back to the default; an explicit 0 is honoured and turns
   * merging off. */
  mult: number | undefined = TL_DEDUPE_ATR,
): number {
  const m =
    typeof mult === "number" && Number.isFinite(mult) && mult >= 0
      ? mult
      : TL_DEDUPE_ATR;
  return on && Number.isFinite(atr) ? (atr as number) * m : 0;
}

interface DrawEntry {
  line: TrendLine;
  proj: number;
  dist: number;
}

/** Drops the near-duplicates from an already rank-sorted list, keeping the
 * first of each group.
 *
 * TWO LINES ARE ONE WHEN THEY RUN THROUGH THE SAME PIVOT and project within
 * `tol` of each other at `atIdx`. Both halves are load-bearing:
 *
 * The shared pivot is what makes this a FAN test rather than a "these two
 * levels look similar" test. A pivot is not consumed by the line that first
 * used it: the detector pairs it with every other pivot that yields an
 * line that passes the gates, so one strong swing emits a whole sheaf of lines
 * through the same point. That sheaf is the clutter. Two levels that merely happen to sit
 * close today came from different swings and are left alone, however close
 * they are. Sharing counts in all four combinations, because a fan can open
 * rightward from a common start, close leftward onto a common end, or chain
 * (one line's end is the next one's start).
 *
 * ONE SAMPLE IS ENOUGH, and that is exact rather than approximate. Lines
 * through the same pivot agree exactly there, and their difference is linear
 * in the bar index, so |difference| grows monotonically away from that pivot
 * and is maximised at the far end of the span: within tol at atIdx means
 * within tol everywhere between. RIGHT of atIdx it keeps growing, so a merged
 * pair does separate out in the projection — that is the deliberate trade, and
 * it is what makes the last bar the right place to measure. Whether two lines
 * are the same level is a question about where price is now, not about where
 * they will be 250 bars from now.
 *
 * NEVER drops a line an operand is reading. The guarantee upstream is exact
 * (the emitted number IS projectAt on that bar), and a near-duplicate is by
 * definition not exact, so a merged-away emitter would break it. Never drops a
 * PINNED line either: its handle is the only control that can release the pin. */
function sharesPivot(a: TrendLine, b: TrendLine): boolean {
  // Bar AND price, though in practice the bar decides it: an anchor's price is
  // that bar's high or low, so the same bar at the same kind is the same
  // price. The price check keeps a hand-built line from merging on a bar
  // number alone.
  if (
    (a.i1 === b.i1 && a.p1 === b.p1) ||
    (a.i2 === b.i2 && a.p2 === b.p2) ||
    (a.i1 === b.i2 && a.p1 === b.p2) ||
    (a.i2 === b.i1 && a.p2 === b.p1)
  )
    return true;
  // A TOUCH COUNTS AS SHARING, not only an anchor, and this is most of what
  // the pass catches on a real chart. A strong swing is the second anchor of
  // one line and a mid-line touch of four others; anchors alone see none of
  // that, so the five ran through the same pivot and none of them merged.
  // Measured on a live US100 4H pane, five drawn dashed resistances passed
  // through one 10/08 swing high and only one of them was anchored there.
  //
  // The bar is enough, with no price test. Both lines were within the touch
  // band of that bar's own high or low to be recorded at all, so they are
  // within two touch tolerances of each other there by construction — which is
  // the same "they agree at the shared bar" the anchor case gets exactly, only
  // to a tolerance rather than to the bit.
  //
  // The linearity argument survives that weakening. The difference between two
  // straight lines is itself straight, so on the span between the shared bar
  // and the bar this is measured at, its size is largest at one end or the
  // other: bounded there, bounded throughout. LEFT of the shared bar they may
  // still separate, which is what a fan does and is the same trade the
  // right-hand side already makes.
  return a.touchIdxs.some((i) => b.touchIdxs.includes(i));
}

function dropDuplicates(
  entries: DrawEntry[],
  dedupe: TrendlineDedupe,
): DrawEntry[] {
  const { tol, keep } = dedupe;
  if (!(tol > 0)) return entries;
  const out: DrawEntry[] = [];
  for (const e of entries) {
    // PINNED LINES ONLY are exempt. A pin is stored by lineKey and its only
    // control is the handle painted at the line's end, so merging a pinned line
    // away would leave a pin with nothing to click. Being an operand the emit
    // path reads is NOT an exemption: merging is a thing the user asked for.
    const twin =
      !keep.has(e.line) &&
      out.some(
        (k) => sharesPivot(k.line, e.line) && Math.abs(k.proj - e.proj) <= tol,
      );
    if (!twin) out.push(e);
  }
  return out;
}

/** The DRAWN set: the RANKED lines (rankLines order: most touches, then
 * longest span, then fewest crossings, ...), cut to `maxLines`, after merging
 * near-twins and dropping the ones far from price, PLUS the pinned ones
 * (`dedupe.keep`).
 *
 * RANK, not proximity. A budget ordered by distance to price would put a
 * fresh two-touch line ahead of a decade-old five-touch one merely because it
 * happens to sit half a point closer today; rank is what a trader means by
 * "the real lines" and is also what the detector itself already sorts by
 * (rankLines), so the pane and the emit path agree on which lines matter.
 *
 * SO THE DRAWN SET IS THE EMITTED SET, until the user says otherwise. Same
 * lines, same order, same cut: `maxLines` sizes both, and with Declutter off
 * and no merge tolerance every `tl_k` on that bar has its line on the chart.
 *
 * DECLUTTER AND MERGE ARE THE EXCEPTION, deliberately. Both act on the DRAWN
 * set only, and both can hide a line an operand is reading: that is what
 * asking for fewer lines means, and the user asked for it on this pane. The
 * operand still emits its value either way, so a rule never changes because
 * the chart got tidier. Only a PINNED line is exempt from the two cuts, and
 * only because a pin's sole control is the handle drawn at its end.
 *
 * The converse never held and still does not: the drawn set can contain lines
 * no operand reads (below minSpanBars, under minTouches), because the chart's
 * job is to show the geometry in play, not only the ranked numbers.
 *
 * The drawn set is INDEPENDENT OF THE EXTEND MODE on purpose: rank and the
 * merge pass never look at how far a line is drawn, only at its projection
 * at `atIdx`. Switching extend must change how far lines run and
 * nothing else, so which lines appear, like which values emit, must not move.
 *
 * Draw-time only, so the Python port has no counterpart. */
export function selectDrawnLines(
  lines: TrendLine[],
  atIdx: number,
  close: number,
  maxLines: number,
  dedupe: TrendlineDedupe | null,
): TrendLine[] {
  const ranked: DrawEntry[] = lines
    .map((l) => {
      const proj = projectAt(l, atIdx);
      return { line: l, proj, dist: Math.abs(proj - close) };
    })
    .sort((x, y) => rankLines(x.line, y.line));
  const kept = dedupe ? dropDuplicates(ranked, dedupe) : ranked;
  const out: TrendLine[] = [];
  kept.forEach((e, idx) => {
    if (idx < maxLines || dedupe?.keep.has(e.line)) out.push(e.line);
  });
  return out;
}

/** Drawn radius of the end handle. The click target is deliberately larger
 * (TL_HANDLE_HIT), because a 3px mark is not a mouse target. */
export const TL_HANDLE_RADIUS = 3;
/** The hollow ring at a touch: a touch is price respecting the line, and this
 * marks each bar that earned the ×N tag. */
export const TL_TOUCH_RADIUS = 2;
export const TL_HANDLE_HIT = 8;
/** The pivot mark: an arrow pointing AT price (UP under a low, DOWN over a
 * high), sitting this many pixels clear of the wick with arms this long. An
 * arrow rather than a circle, since the touch ring already owns that shape, and a
 * mark that belongs to no line must not read as one that does.
 *
 * FILLED and this size because a 1px open caret 6px wide is not legible where
 * it actually lands: a pivot mark sits on the swing extreme, which is exactly
 * where the pane is busiest — the built-in high/low price mark and its label,
 * an FVG band edge, the touch rings. A pale FVG band in the SAME hue swallowed
 * an open teal caret entirely. Solid saturated fill separates from those
 * washes; an outline cannot. */
export const TL_PIVOT_GAP = 5;
export const TL_PIVOT_ARM = 5;
/** The line-pivot arrow (showLinePivots) is the same head with a tail: this
 * much shaft, this half-wide, added beyond the head's base. Same tip, same
 * gap, so the two marks sit at the same distance from the wick and only the
 * stem tells them apart — which is what makes the difference readable when
 * both kinds are on one pane. */
export const TL_PIVOT_STEM = 5;
export const TL_PIVOT_STEM_HALF = 1;
/** The stemmed arrow's OWN gap, replacing TL_PIVOT_GAP for the line-pivot
 * marks only. Much wider, because that mark lands where the pane is busiest
 * and it lands there BY CONSTRUCTION: a pivot a line rests on always carries
 * the line's own anchor ring or touch ring, and the swing extreme is also
 * exactly where the chart paints its high/low price label. At TL_PIVOT_GAP
 * the arrow came out of the ring and ran its stem through the label's text.
 *
 * SIZED TO CLEAR THE LABEL, not the ring: the ring is 2px and was never the
 * hard part. klinecharts offsets that label 5px off the wick and sets it 10px,
 * so its band reaches roughly 15px out; starting past that puts the whole
 * arrow below it. The plain triangles keep TL_PIVOT_GAP — they mark pivots no
 * line rests on, so they carry no ring, and only one bar in view ever carries
 * the price label. */
export const TL_PIVOT_USED_GAP = 16;
/** Handles stroke heavier than the 1px line they cap, so a 3px mark reads at
 * all. It is also what tells a handle stroke from a line stroke. */
export const TL_HANDLE_STROKE = 1.5;

/** Where to centre the end ring: pushed one radius past the line's tip, along
 * the line's own direction, so the ring TOUCHES the tip instead of swallowing
 * it. Degenerate (zero-length) segments keep the tip itself. */
function ringCentre(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return [x1, y1];
  const out = TL_HANDLE_RADIUS + 0.5;
  return [x1 + (dx * out) / len, y1 + (dy * out) / len];
}


/** One colour for every line, whatever kind of pivot anchors it: a sideless
 * line has no support/resistance role to colour by, so painting one drops the
 * green/red split the old detector's two sides used to carry. */
export const TL_LINE_COLOR = "#3b82f6";

/** Where `line` first meets one of `others` strictly after `from`, or null if
 * none does inside `limit`.
 *
 * Both lines are straight in index space, so this is solved rather than
 * scanned: with value(j) = slope * j + intercept, they meet at one exact j.
 * Fractional is CORRECT to return, not a rounding bug to fix. klinecharts maps
 * a data index to a pixel with plain arithmetic (dataIndexToCoordinate floors
 * the pixel, never the index), so a fractional index lands on the true
 * meeting point instead of snapping to a bar edge.
 *
 * Parallel lines (equal slope) never meet, including the coincident case: two
 * lines lying on top of each other have no single crossing to stop at. */
export function meetsAt(
  line: TrendLine,
  others: TrendLine[],
  from: number,
  limit: number,
): number | null {
  const slope = (l: TrendLine): number => (l.p2 - l.p1) / (l.i2 - l.i1);
  const sA = slope(line);
  const cA = line.p1 - sA * line.i1;
  let best: number | null = null;
  for (const other of others) {
    const sB = slope(other);
    if (sA === sB) continue;
    const j = (other.p1 - sB * other.i1 - cA) / (sA - sB);
    // At least a full bar ahead. Two lines sharing an anchor meet exactly AT
    // it, and that crossing computes a hair past it (60.000000000000014), so a
    // bare j > from cuts such a line off at its own last touch.
    if (!Number.isFinite(j) || j < from + 1 || j > limit) continue;
    if (best === null || j < best) best = j;
  }
  return best;
}

/** Every extend mode lineExtent has a branch for. The draw path checks a
 * pane's saved value against this before using it, so a stored mode from an
 * older build cannot reach the function as an unhandled string. */
export const KNOWN_EXTEND_MODES: ReadonlySet<string> = new Set([
  "ray",
  "segment",
  "extended",
  "cross",
  "lastbar",
]);

/** The bar-index span a line is drawn across: the ONE source of truth for
 * where a line starts and ends.
 *
 * Extracted because the click hit-test has to land on the same right end the
 * draw path paints. Two copies of this arithmetic would drift the moment
 * either side changed, and the handle would stop matching its line. */
export function lineExtent(
  line: TrendLine,
  mode: NonNullable<TrendlinesExtend["extend"]>,
  cfg: TrendlinesConfig,
  drawn: TrendLine[],
  lastIdx: number,
  /** Bar index at the pane's right edge when this line is pinned, else null.
   * Passed in rather than derived: only the caller holds the axis, and pinning
   * means "to the edge", which is a viewport fact that changes with zoom. */
  pinnedEdge: number | null,
): { jLeft: number; jRight: number } {
  // The drawn segment starts at the line's own first anchor. "extended" runs
  // maxProjBars further back still.
  const jLeft = mode === "extended" ? line.i1 - cfg.maxProjBars : line.i1;
  const jEnd = line.lastTouchIdx;
  const horizon = line.lastTouchIdx + cfg.maxProjBars;
  // Pinned beats the mode: the user clicked THIS line open, so it runs to the
  // edge whatever the dropdown says.
  if (pinnedEdge !== null) return { jLeft, jRight: Math.max(jEnd, pinnedEdge) };
  if (mode === "segment") return { jLeft, jRight: jEnd };
  if (mode === "lastbar") {
    // Straight to "now" and no further. Max() so a line whose own end already
    // sits past the newest bar is never pulled backwards.
    return { jLeft, jRight: Math.max(jEnd, lastIdx) };
  }
  if (mode === "cross") {
    const others = drawn.filter((o) => o !== line);
    // Nothing to meet: stop at the newest bar, NOT the full projection
    // horizon. A line with no meeting would otherwise shoot 250 bars into
    // empty space beside neighbours that stopped within a few bars of the
    // last candle, which reads as a bug rather than as "this one never meets".
    return {
      jLeft,
      jRight: meetsAt(line, others, jEnd, horizon) ?? Math.max(jEnd, lastIdx),
    };
  }
  return { jLeft, jRight: horizon };
}

/** The right-edge bar the STOPPING extend modes measure against, in line
 * space. Waiting pins keep the last usable HTF bar. A FORMING pin's last entry
 * is a bucket that runs through "now", so its lines run to the newest chart
 * candle's fractional position inside it — otherwise "End at last bar" stops
 * at the bucket's open, up to a whole HTF period short of the newest candle.
 * Never pulls backwards (max), and only the drawn edge moves: isMajor and the
 * emitted-value match still measure at the integer lastIdx the values came
 * from. */
export function trendlineDrawEdge(
  formingIdx: number | undefined,
  lastIdx: number,
  toLine: (j: number) => number,
  nChart: number,
): number {
  if (formingIdx === undefined || !nChart) return lastIdx;
  return Math.max(lastIdx, toLine(nChart - 1));
}

export interface TrendlineHandle {
  key: string;
  x: number;
  y: number;
}

/** Handle pixels recorded BY THE DRAW, per indicator instance, for the click
 * hit-test to read back.
 *
 * Captured rather than recomputed on purpose. The alternative is a second copy
 * of the extent-to-pixel arithmetic (clamping, y interpolation, the y-axis
 * strip), which would drift from the paint the moment either side changed and
 * leave handles that do not sit where they are drawn. The canvas repaints on
 * every scroll and zoom, so these stay current. */
// Keyed by CHART FIRST: paneId+name alone collide across charts in a
// multi-chart layout, and pane-relative pixels from one chart would then answer
// hit-tests for another.
const HANDLES = new WeakMap<object, Map<string, TrendlineHandle[]>>();

export function getTrendlineHandles(
  chart: object,
  paneId: string,
  name: string,
): TrendlineHandle[] {
  return HANDLES.get(chart)?.get(`${paneId}:${name}`) ?? [];
}

/** Any handle on this chart under (px, py), across every pane and instance.
 * The cursor decision needs "is the pointer over one" without enumerating
 * indicators itself. */
export function hitAnyTrendlineHandle(
  chart: object,
  px: number,
  py: number,
): boolean {
  const byPane = HANDLES.get(chart);
  if (!byPane) return false;
  for (const handles of byPane.values()) {
    if (hitHandle(handles, px, py) !== null) return true;
  }
  return false;
}

/** Forget every pane's handles for one indicator instance, on removal.
 *
 * The draw path is the only thing that clears this map, and a removed
 * indicator never draws again, so its last painted handles would sit here for
 * the life of the chart: hitAnyTrendlineHandle kept flipping the cursor to a
 * pointer over dots that are no longer on screen. (Clicks were already inert,
 * since the pin hook walks live instances.) */
export function dropTrendlineHandles(chart: object, name: string): void {
  const byPane = HANDLES.get(chart);
  if (!byPane) return;
  for (const key of [...byPane.keys()])
    if (key.slice(key.indexOf(":") + 1) === name) byPane.delete(key);
}

function setTrendlineHandles(
  chart: object,
  paneId: string,
  name: string,
  handles: TrendlineHandle[] | null,
): void {
  let byPane = HANDLES.get(chart);
  if (!byPane) {
    if (handles === null) return;
    byPane = new Map();
    HANDLES.set(chart, byPane);
  }
  if (handles === null) byPane.delete(`${paneId}:${name}`);
  else byPane.set(`${paneId}:${name}`, handles);
}

/** Nearest handle to a point, or null when nothing is within TL_HANDLE_HIT.
 * `handles` come from the same lineExtent the draw path used. */
export function hitHandle(
  handles: Array<{ key: string; x: number; y: number }>,
  px: number,
  py: number,
): string | null {
  let best: { key: string; d: number } | null = null;
  for (const h of handles) {
    const d = Math.hypot(h.x - px, h.y - py);
    if (d > TL_HANDLE_HIT) continue;
    if (best === null || d < best.d) best = { key: h.key, d };
  }
  return best?.key ?? null;
}

/**
 * Multi-timeframe calc: the ranked operand series were computed on the HTF bars
 * by the coordinator, so all that is left is to hand each chart bar the value
 * of the most recent HTF bar that had CLOSED by then (waitClose, no lookahead:
 * the whole point of the alignment, and the same rule SR_LEVELS and Pivot Bands
 * follow).
 *
 * The line list rides the last row as usual, still in HTF bar indices — see
 * TrendlinesMtf for why they are not converted.
 */
export function alignMtfTrendlines(
  dataList: KLineData[],
  mtf: TrendlinesMtf,
): TrendlinesCalcPoint[] {
  const ts = dataList.map((k) => k.timestamp);
  const starts = mtf.htfStarts ?? [];
  const htfMs = mtf.htfMs ?? 0;
  const htfBars = starts.map((t) => ({ timestamp: t }) as KLineData);
  const outputs = mtf.htfOutputs ?? [];
  const rows = mtf.htfPoints ?? [];
  const aligned = outputs.map((name) =>
    alignHtfToChart(
      ts,
      htfBars,
      rows.map((p) => readOutput(p, name)),
      htfMs,
      true,
      mtf.formingIdx,
      mtf.chartMs,
    ),
  );
  const out: TrendlinesCalcPoint[] = ts.map((_, i) => {
    const row: TrendlinesPoint = {};
    outputs.forEach((name, o) => {
      const v = aligned[o][i];
      if (v !== undefined) writeOutput(row, name, v);
    });
    return row;
  });
  if (!out.length) return out;
  // The HTF bar the LAST chart bar reads, by the same rule alignHtfToChart
  // used above. The draw path measures every line at it, and selectDrawnLines
  // matches an emitted value with === against projectAt at that index, so this
  // must be the index those values came from and not simply the newest bar.
  let j = -1;
  const t = ts[ts.length - 1];
  // Same-timeframe pin: alignHtfToChart above bypasses the closed-bar gate
  // when the chart's own interval equals htfMs (see its sameTf detection) —
  // this loop must apply the IDENTICAL rule, or on a same-TF pin the values
  // come from HTF bar j+1 while lineIdx says j and the === match breaks.
  const sameTf = (mtf.chartMs ?? minPositiveGap(ts)) === htfMs;
  while (
    j + 1 < starts.length &&
    // The flagged forming entry is usable from its OPEN, exactly as the
    // alignment above admitted it — lineIdx must be the index those values
    // came from, or selectDrawnLines' === match against projectAt breaks.
    (sameTf || j + 1 === mtf.formingIdx ? starts[j + 1] : starts[j + 1] + htfMs) <= t
  )
    j++;
  out[out.length - 1] = {
    ...out[out.length - 1],
    lines: mtf.htfLines ?? [],
    atr: mtf.htfAtr,
    // HTF bar indices, like the lines, and the draw path maps them the same
    // way. Their prices came from the HTF bars, which is why a pivot carries
    // one instead of being looked up in the chart's dataList.
    pivots: mtf.htfPivots,
    lineIdx: j,
  };
  return out;
}

/** The chart's own bar duration in ms: the MEDIAN of the last few gaps, so a
 * weekend or a session break cannot stretch it. Used only to extrapolate off
 * the ends of the loaded data, where there are no bars to interpolate between. */
function chartBarMs(dataList: KLineData[]): number {
  const diffs: number[] = [];
  for (let i = Math.max(1, dataList.length - 20); i < dataList.length; i++)
    diffs.push(dataList[i].timestamp - dataList[i - 1].timestamp);
  if (!diffs.length) return 0;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1];
}

/** Fractional index of time `t` among `len` ascending bar-open timestamps read
 * through `at`, extrapolating linearly off both ends at `barMs` (so a ray
 * projecting past the newest bar, or an anchor older than the loaded history,
 * still lands somewhere real rather than being clamped onto the edge —
 * clamping a SLOPED line would visibly rotate it).
 *
 * An ACCESSOR rather than an array, so the chart side needs no per-draw copy of
 * its timestamps: draw runs on every crosshair move, and a pane holding
 * thousands of bars would allocate that array thousands of times a minute for
 * nothing. */
function idxAtTime(
  len: number,
  at: (i: number) => number,
  t: number,
  barMs: number,
): number {
  if (!len) return 0;
  if (t <= at(0)) return barMs > 0 ? (t - at(0)) / barMs : 0;
  if (t >= at(len - 1)) return len - 1 + (barMs > 0 ? (t - at(len - 1)) / barMs : 0);
  let lo = 0;
  let hi = len - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at(mid) <= t) lo = mid;
    else hi = mid;
  }
  const span = at(hi) - at(lo);
  return span > 0 ? lo + (t - at(lo)) / span : lo;
}

/** Time at a fractional index, the inverse of {@link idxAtTime}. */
function timeAtIdx(
  len: number,
  at: (i: number) => number,
  j: number,
  barMs: number,
): number {
  if (!len) return 0;
  if (j <= 0) return at(0) + j * barMs;
  if (j >= len - 1) return at(len - 1) + (j - (len - 1)) * barMs;
  const k = Math.floor(j);
  return at(k) + (j - k) * (at(k + 1) - at(k));
}

/** The two index conversions the draw path needs when the lines were detected
 * on another timeframe: HTF index -> chart index (for pixels) and back (for the
 * pane's right edge, which is a pixel the pin logic needs as a bar). Identity
 * on the chart timeframe, which is what keeps the draw path single-pathed. */
function trendlineIdxMap(
  dataList: KLineData[],
  mtf: TrendlinesMtf | undefined,
): { toChart: (j: number) => number; toLine: (j: number) => number } {
  const starts = mtf?.htfStarts;
  const htfMs = mtf?.htfMs ?? 0;
  if (!starts?.length || !(htfMs > 0) || !dataList.length)
    return { toChart: (j) => j, toLine: (j) => j };
  const barMs = chartBarMs(dataList) || htfMs;
  const htfAt = (i: number) => starts[i];
  const chartAt = (i: number) => dataList[i].timestamp;
  const nHtf = starts.length;
  const nChart = dataList.length;
  return {
    toChart: (j) => {
      const idx = idxAtTime(nChart, chartAt, timeAtIdx(nHtf, htfAt, j, htfMs), barMs);
      // A pin FINER than the chart puts a line-space bar INSIDE a chart bar,
      // so the fractional index lands between two candles and an anchor's
      // ring hangs in the gap off the candle's wick. Snap down to the candle
      // that contains the time — but only over loaded history plus the
      // forming bar: a ray's far edge extrapolates past the data on purpose
      // (clamping a sloped line rotates it), and flooring there would pile
      // it onto the last candle.
      if (htfMs < barMs && idx >= 0 && idx < nChart) return Math.floor(idx);
      return idx;
    },
    toLine: (j) =>
      idxAtTime(nHtf, htfAt, timeAtIdx(nChart, chartAt, j, barMs), htfMs),
  };
}

/** Chart index of the candle that traded an HTF bar's extreme — where a pivot
 * caret (and a line anchor) belongs when the pin is COARSER than the chart. An
 * HTF bar's high or low usually trades hours after the bar OPENS, and mapping
 * the bar's index to its start time hung the mark on the open's candle, far
 * off any price that traded there (a 1D pivot on a 1H chart floated ~900
 * points below the 00:00 candle). A low pivot snaps to the span's lowest low,
 * a high to its highest high; ties keep the first bar, so a flat span
 * degrades to exactly the old start mapping. Falls back to `toChart` when the
 * span is not fully loaded (the true extreme may be in the unloaded part), the
 * index is fractional (a projection, not a bar), or the pin is not coarser
 * than the chart. */
function htfExtremeSnap(
  dataList: KLineData[],
  mtf: TrendlinesMtf,
  toChart: (j: number) => number,
): (j: number, kind: PivotKind) => number {
  const starts = mtf.htfStarts;
  const htfMs = mtf.htfMs ?? 0;
  const barMs = chartBarMs(dataList);
  if (!starts?.length || !(htfMs > barMs) || !(barMs > 0)) return toChart;
  const n = dataList.length;
  // Per-frame memo: the same pivot bar is looked up once as a caret and again
  // as an anchor/touch of every line that uses it.
  const memo = new Map<number, number>();
  return (j, kind) => {
    if (!Number.isInteger(j) || j < 0 || j >= starts.length) return toChart(j);
    const key = j * 2 + (kind === "low" ? 0 : 1);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const t0 = starts[j];
    const t1 = t0 + htfMs;
    let out = toChart(j);
    if (dataList[0].timestamp <= t0 && dataList[n - 1].timestamp >= t1 - barMs) {
      // First chart bar at/after the HTF bar's open (timestamps ascending).
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dataList[mid].timestamp < t0) lo = mid + 1;
        else hi = mid;
      }
      let best = -1;
      let bestV = kind === "low" ? Infinity : -Infinity;
      for (let i = lo; i < n && dataList[i].timestamp < t1; i++) {
        const v = kind === "low" ? dataList[i].low : dataList[i].high;
        if (kind === "low" ? v < bestV : v > bestV) {
          bestV = v;
          best = i;
        }
      }
      if (best >= 0) out = best;
    }
    memo.set(key, out);
    return out;
  };
}

/** Liang-Barsky clip of the segment (x0,y0)-(x1,y1) to the rectangle
 * [xMin,xMax]x[yMin,yMax]; null when they don't intersect.
 *
 * The draw path MUST clip its strokes to the pane. A ray's end sits
 * maxProjBars past the last touch IN THE LINE'S OWN TIMEFRAME, so under a
 * timeframe pin far above the chart (1D lines on a 1m chart) that endpoint
 * converts to MILLIONS of pixels off-canvas — and for a sloped line the y
 * coordinate runs off just as far. Handing Skia those giant antialiased paths
 * on every frame is what dropped pan/zoom to ~20fps (all the time sat in
 * compositor Commit, invisible to JS profiles). The line is straight, so
 * clipping is visually exact. */
export { clipSegmentToRect } from "./shared";

/** Bar indices any DRAWN line rests on — its anchors and all of its touches.
 *
 * ONE FLAT SET, not one per kind, because a touch is not always the same kind
 * as the line's own anchors: the detector is sideless, so a line counts a
 * touch at a pivot of either kind. Splitting by kind would then leave a
 * pivot a drawn line is visibly resting on marked as unused, the exact
 * opposite of what the mark is for. The cost of the flat set is the
 * lone-spike bar that is BOTH a strict high and a strict low pivot: one line
 * resting on its high marks its low as used too. That bar is rare and it does
 * carry a line, so the flat set is the better error.
 *
 * touchIdxs carries the anchors too (a line's touch list opens with i1 and
 * i2), so the anchors are in by construction; they are added anyway rather
 * than relying on that invariant from another module. */
export function drawnPivotIdxs(lines: readonly TrendLine[]): Set<number> {
  const used = new Set<number>();
  for (const line of lines) {
    used.add(line.i1);
    used.add(line.i2);
    for (const idx of line.touchIdxs) used.add(idx);
  }
  return used;
}

/** Paint one arrow per marked pivot, clipped to the pane.
 *
 * TWO KINDS, and a pivot gets exactly one of them. `showLineUsed` puts a
 * STEMMED arrow on every pivot a drawn line rests on; `showAll` puts a plain
 * triangle on the rest. A used pivot never takes both — the plain head would
 * sit under the stemmed one and only thicken it.
 *
 * The plain triangles are NOT GATED by anything that selects lines (see
 * TrendlinesExtend.showPivots): they answer "what is the pivot filter
 * admitting", which the lines only answer indirectly. The stemmed ones ARE
 * gated by the drawn set, and only them (see showLinePivots). Full opacity for
 * both — there is no line whose dim state a mark could inherit, and dimming
 * the unused ones was tried and reads as "disabled" rather than "unused".
 *
 * ONE FILL PER KIND: fillStyle and the path are context state, so batching
 * keeps the whole pane at two fills however many pivots are on screen.
 *
 * The pool is in confirm order (increasing bar index), so the walk stops at
 * the right edge instead of running the whole series: on a zoomed-in pane of
 * a long history that is the difference between a handful of carets and
 * thousands of off-pane transforms per frame. */
function paintPivotMarks(
  ctx: CanvasRenderingContext2D,
  pivots: TrendPivots,
  xAt: (j: number, kind: PivotKind) => number,
  yOf: (price: number) => number,
  right: number,
  height: number,
  used: ReadonlySet<number>,
  showAll: boolean,
  showLineUsed: boolean,
  lineColor: string,
): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  // CLIP instead of clipSegmentToRect: the glyphs are filled now, and clipping
  // a fill edge-by-edge would need polygon clipping, not the segment clip the
  // line strokes use. Same outcome — the part that fits is painted, nothing
  // bleeds into the neighbouring pane.
  ctx.beginPath();
  ctx.rect(0, 0, right, height);
  ctx.clip();
  ctx.fillStyle = lineColor;
  // Stemmed first, so the plain batch below can be the complement of it with
  // one test rather than two flags per pivot.
  for (const stemmed of [true, false]) {
    if (stemmed ? !showLineUsed : !showAll) continue;
    ctx.beginPath();
    for (let q = 0; q < pivots.idxs.length; q++) {
      const idx = pivots.idxs[q];
      const kind = pivots.kinds[q];
      // Which side of the wick the mark sits on: under a low, over a high.
      // The arrow then points back INTO the wick.
      const dir = kind === "low" ? 1 : -1;
      // The used pivots take the stemmed arrow and NOTHING ELSE: a plain
      // head under a stemmed one is invisible and only thickens it. When
      // Show pivots is off, the unused ones simply go unmarked.
      if ((showLineUsed && used.has(idx)) !== stemmed) continue;
      const x = xAt(idx, kind);
      // The arms reach TL_PIVOT_ARM either way, so the window is widened by
      // one arm rather than testing the tip alone: otherwise a caret at the
      // very edge is dropped whole when only half of it is off-pane.
      if (x < -TL_PIVOT_ARM) continue;
      if (x > right + TL_PIVOT_ARM) break;
      const y = yOf(pivotPriceAt(pivots, q));
      // The PIVOT's own y decides whether its mark exists at all: the mark
      // belongs to a swing, and a swing scrolled out of the pane's price
      // range has nothing to mark. The GLYPH is then clipped rather than
      // dropped: on a live pane the y-axis autoscales to the visible
      // extremes, so the highest swing high sits at the top edge and its
      // caret hangs just over it. Dropping there would hide the mark on
      // exactly the pivot the eye is on. Clipping (the same treatment the
      // line strokes get) keeps the part that fits and lets nothing bleed
      // into the neighbouring pane.
      if (y < 0 || y > height) continue;
      // Tip TOWARDS price, base away from it: an arrow pointing AT the swing
      // it marks: up at a low, down at a high. The mark sits entirely clear
      // of the wick, so it never overdraws the candle it points at, and the
      // stemmed one stands further out still (see TL_PIVOT_USED_GAP) to get
      // out from under the ring and the price label that share its bar.
      const gap = stemmed ? TL_PIVOT_USED_GAP : TL_PIVOT_GAP;
      const yTip = y + dir * gap;
      const yBase = y + dir * (gap + TL_PIVOT_ARM);
      ctx.moveTo(x, yTip);
      ctx.lineTo(x - TL_PIVOT_ARM, yBase);
      if (stemmed) {
        // Round the head's base back to the shaft and out along it, so the
        // whole arrow is ONE closed polygon. A separate rectangle for the
        // shaft would be a second subpath, and a second subpath abutting the
        // first seams visibly under antialiasing.
        const yEnd = yBase + dir * TL_PIVOT_STEM;
        ctx.lineTo(x - TL_PIVOT_STEM_HALF, yBase);
        ctx.lineTo(x - TL_PIVOT_STEM_HALF, yEnd);
        ctx.lineTo(x + TL_PIVOT_STEM_HALF, yEnd);
        ctx.lineTo(x + TL_PIVOT_STEM_HALF, yBase);
      }
      ctx.lineTo(x + TL_PIVOT_ARM, yBase);
      ctx.closePath();
    }
    // One path per kind: the marks in a batch share a colour, so each is a
    // single fill call however many pivots are on screen.
    ctx.fill();
  }
  ctx.restore();
}

function drawTrendlines(
  params: IndicatorDrawParams<TrendlinesCalcPoint, unknown, unknown>,
): boolean {
  const { ctx, chart, indicator, bounding, xAxis, yAxis } = params;
  const result = (indicator.result ?? []) as TrendlinesCalcPoint[];
  const last = result[result.length - 1];
  const dataList = chart.getDataList();
  // Clear on the empty paths too, or the last frame's handles stay clickable
  // over a chart that no longer draws them.
  if (dataList.length === 0) {
    setTrendlineHandles(chart, indicator.paneId, indicator.name, null);
    return true;
  }
  const cfg = parseTrendlinesConfig(indicator.calcParams, indicator.extendData);
  const ext = indicator.extendData as TrendlinesExtend | undefined;
  // Resolved ONCE per draw: every stroke and fill below (lines, rings,
  // handles, tags, pivot marks) reads this instead of the shared default, so
  // one pane's colour choice never bleeds into another's.
  const lineColor = ext?.lineColor || TL_LINE_COLOR;
  // NORMALISED, not merely defaulted. A pane saved under a spelling this pane
  // no longer offers ("apex") would otherwise reach lineExtent as an unknown
  // string, fall through every branch and draw the full projection horizon
  // while `stops` below read it as a stopping mode and painted end handles on
  // rays. An unknown mode is a ray, which is the file's standing default.
  const mode = KNOWN_EXTEND_MODES.has(ext?.extend as string) ? ext!.extend! : "ray";
  // MULTI-TIMEFRAME: the lines carry HTF bar indices, so every bar-denominated
  // measurement below (isMajor's spans, lineExtent's projection horizon, the
  // touch rings) stays in THAT space and only the index-to-pixel step crosses
  // over. `lastIdx` is therefore the last HTF bar the chart can see, not the
  // last chart bar; calc recorded it, having applied the closed-bar rule.
  const mtf =
    ext?.mtf?.timeframe && ext.mtf.htfStarts?.length && ext.mtf.htfMs
      ? ext.mtf
      : undefined;
  const starts = mtf?.htfStarts;
  const { toChart, toLine } = trendlineIdxMap(dataList, mtf);
  // bounding.width spans the whole pane INCLUDING the y-axis strip on the
  // right; nothing drawn may run under it (the ×N tags below share this).
  const axisWidth = chart.getSize(indicator.paneId, "yAxis")?.width ?? 0;
  const tagRight = bounding.width - axisWidth - 4;
  const xAt = (j: number) => xAxis.convertToPixel(toChart(j));
  // Coarser-pin snap: a bar index that IS a pivot/touch maps to the chart
  // candle that traded the extreme, not the HTF bar's opening candle.
  const snap = mtf ? htfExtremeSnap(dataList, mtf, toChart) : null;
  const xAtPivot = (j: number, kind: PivotKind) =>
    snap ? xAxis.convertToPixel(snap(j, kind)) : xAt(j);
  // A CLOSURE called on every exit, not a call in one place, and that is the
  // point twice over:
  //
  //  - it has to run even when no line survived. The pivot filter can admit
  //    plenty of pivots on a pane where every line was gated away (strict Min
  //    Touches, a short series, an HTF pin with nothing closed yet), and a
  //    mark that vanished there would read as the setting being broken. Those
  //    paths pass an EMPTY used set: no line is drawn, so no pivot is used,
  //    so every mark is a plain triangle — which is what that pane means.
  //  - the stemmed marks can only be chosen once `drawn` exists, and `drawn`
  //    is selected far below. Painting after the strokes also puts the marks
  //    ON TOP of the lines rather than under them, which is the right order
  //    for a glyph whose whole job is to be seen at the swing.
  const showAll = ext?.showPivots ?? TRENDLINES_EXTEND_DEFAULTS.showPivots;
  const showLineUsed = ext?.showLinePivots ?? TRENDLINES_EXTEND_DEFAULTS.showLinePivots;
  const paintMarks = (used: ReadonlySet<number>): void => {
    if ((showAll || showLineUsed) && last?.pivots)
      paintPivotMarks(
        ctx,
        last.pivots,
        xAtPivot,
        (price) => yAxis.convertToPixel(price),
        tagRight,
        bounding.height,
        used,
        showAll,
        showLineUsed,
        lineColor,
      );
  };
  const NO_PIVOTS_USED: ReadonlySet<number> = new Set<number>();
  if (!last?.lines?.length) {
    paintMarks(NO_PIVOTS_USED);
    setTrendlineHandles(chart, indicator.paneId, indicator.name, null);
    return true;
  }
  const lastIdx = mtf ? (last.lineIdx ?? -1) : dataList.length - 1;
  // Under a pin, no HTF bar has closed inside the loaded window yet: there is
  // nothing to measure the lines at, so draw none rather than measure at -1.
  if (lastIdx < 0) {
    paintMarks(NO_PIVOTS_USED);
    setTrendlineHandles(chart, indicator.paneId, indicator.name, null);
    return true;
  }
  // The CHART's newest close either way: it is the current price, and the price
  // is the price whatever timeframe the lines were found on.
  const lastClose = dataList[dataList.length - 1].close;
  // Forming pin: stopping modes draw through "now" (see trendlineDrawEdge).
  const drawEdge = trendlineDrawEdge(
    mtf?.formingIdx,
    lastIdx,
    toLine,
    dataList.length,
  );
  // A pin means "run past where you stopped", so it is only meaningful in the
  // modes that STOP a line. "ray" and "extended" already run to the horizon:
  // there is nothing to release, and their end sits ~maxProjBars into the
  // future, off the pane, where the handle was being culled and left nothing to
  // click. No handle, and stored pins stay dormant rather than silently
  // extending a line with no control to undo it.
  const stops = mode !== "ray" && mode !== "extended";
  const pins = new Set(stops ? (ext?.pinned ?? []) : []);
  // ONE GATE FOR BOTH SURFACES: the chart draws exactly what an operand could
  // read. Every bound in the panel therefore means the same thing wherever the
  // user meets it, which is what the tips promise ("counts as a real
  // trendline") and what the settings did not do.
  //
  // The floors used to be draw-through, on the reasoning that a line under Min
  // Touches or Min Span is still geometry in play. That reasoning collapses
  // once maxLines is set high: with no drawing budget the floors are the only
  // filter left, and they were inert, so a pane could carry 15 lines of which 0
  // qualified. A user who asks for 7 touches and gets a 2-touch line has been
  // told the setting does nothing.
  //
  // Safe for the "every emitted value has a line drawn at it" guarantee below:
  // emission needs isLive && isMajor, so an emitting line passes this by
  // construction. `lastIdx` is the bar the whole draw path measures at (the
  // same one selectDrawnLines projects to), not a per-line bar.
  const eligible = last.lines.filter((l) => isMajor(l, lastIdx, cfg));
  if (!eligible.length) {
    paintMarks(NO_PIVOTS_USED);
    setTrendlineHandles(chart, indicator.paneId, indicator.name, null);
    return true;
  }
  // Resolved to line objects BEFORE selection, because the dedup pass has to
  // know which lines are pinned in order to spare them.
  const pinnedLines = new Set(
    pins.size ? eligible.filter((l) => pins.has(lineKey(l, dataList, starts))) : [],
  );
  // "One line per pivot" is the merge pass with no tolerance at all: sharing a
  // pivot alone decides it. dropDuplicates walks RANK order, so the survivor
  // among twins is the better-ranked one, and it needs no ATR to say so, which
  // is why this branch does not go through dedupeTolerance and its
  // unwarmed-ATR off switch.
  const declutter = declutterMode(ext);
  const dedupeTol =
    declutter === "pivot"
      ? Infinity
      : dedupeTolerance(last.atr, ext?.dedupe ?? true, ext?.dedupeAtr);
  const drawn = selectDrawnLines(eligible, lastIdx, lastClose, cfg.maxLines, {
    tol: dedupeTol,
    keep: pinnedLines,
  });
  const handles: TrendlineHandle[] = [];
  // The bar index sitting at the pane's right edge, so a pinned line reaches it
  // at any zoom. The index-to-pixel map is linear (klinecharts multiplies by a
  // constant bar space), so one bar's width inverts it exactly.
  const barPx = xAxis.convertToPixel(1) - xAxis.convertToPixel(0);
  const lastChartIdx = dataList.length - 1;
  const edgeChartIdx =
    barPx > 0
      ? lastChartIdx + (tagRight - xAxis.convertToPixel(lastChartIdx)) / barPx
      : lastChartIdx;
  // Back into the lines' own space: lineExtent runs the pinned line out to a
  // BAR, and under a pin that bar is an HTF one.
  const edgeIdx = toLine(edgeChartIdx);

  ctx.save();
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  // The shared canvas context arrives with whatever dash pattern the previous
  // drawer left behind (price lines and alert lines are dashed), so every
  // trendline stroke, ring, handle and tag below needs a solid line reset
  // explicitly rather than inheriting it.
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  for (const line of drawn) {
    // ONE alpha for the whole line, computed before the stroke and reused at
    // every site that restores it below (the pin handle paints at full
    // opacity and hands it back). Recomputing the dim test at those sites is
    // how the touch rings and the ×N tag snapped back to full opacity while
    // the stroke itself faded correctly.
    const alpha = trendlineDimmed(line, lastIdx, ext) ? trendlineDimAlpha(ext) : 1;
    const isPinned = pins.has(lineKey(line, dataList, starts));
    // The line's end under the MODE alone: what the stroke reverts to when a
    // pin is released. (The handle no longer rides it — see below — it sits at
    // the newest bar, which likewise never travels to the pane edge with a
    // pinned line, so there is always something to click to undo the pin.)
    const natural = lineExtent(line, mode, cfg, drawn, drawEdge, null);
    const { jLeft, jRight } = isPinned
      ? lineExtent(line, mode, cfg, drawn, drawEdge, edgeIdx)
      : natural;
    // A line endpoint that is one of the line's own touch bars (the anchors
    // always are) snaps to the extreme's candle; a projected end (a ray's
    // horizon, a meeting) keeps the plain time mapping. Snapped by whatever
    // kind of pivot touched there.
    const kindAt = (j: number): PivotKind | null => {
      const t = line.touchIdxs.indexOf(j);
      return t >= 0 ? touchKindAt(line, t) : null;
    };
    const xAtLine = (j: number): number => {
      const kd = kindAt(j);
      return kd ? xAtPivot(j, kd) : xAt(j);
    };
    const x0 = xAtLine(jLeft);
    const x1 = xAtLine(jRight);
    if (x1 <= 0 || x0 >= bounding.width) continue;
    const y0 = yAxis.convertToPixel(projectAt(line, jLeft));
    const y1 = yAxis.convertToPixel(projectAt(line, jRight));
    // Marks (the touch rings) ride the SEGMENT AS DRAWN rather
    // than projecting themselves: under a timeframe pin the index map is only
    // piecewise linear (a weekend compresses on the chart but not in time), so
    // a mark placed by its own projection can sit a bar off the line it
    // belongs to. Interpolating at its own x is the idiom the ×N tag already
    // uses below, and on the chart timeframe it lands on the same pixel.
    const onSegment = (x: number): number =>
      x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    ctx.strokeStyle = lineColor;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1;
    // Stroke only the near-pane portion (see clipSegmentToRect: an unclipped
    // MTF ray is millions of pixels long and stalls the compositor). The pad
    // is deliberately GENEROUS: a chart-timeframe ray overshoots by a few
    // hundred pixels, which Skia eats for free, and clipping tight to the
    // pane would drop lines the identity-view draw tests legitimately place
    // outside their tiny fake pane. Only the
    // absurd overshoots — a 1D pin's 250-day horizon on a 1m chart — are cut.
    const seg = clipSegmentToRect(
      x0, y0, x1, y1,
      -DRAW_CLIP_PAD, -DRAW_CLIP_PAD,
      bounding.width + DRAW_CLIP_PAD, bounding.height + DRAW_CLIP_PAD,
    );
    if (seg) {
      ctx.beginPath();
      ctx.moveTo(seg[0], seg[1]);
      ctx.lineTo(seg[2], seg[3]);
      ctx.stroke();
    }
    // The touches themselves, one hollow ring each, so the ×N tag can be read
    // back against the bars that earned it: which swings agreed on this line is
    // the question the count only answers in aggregate.
    //
    // ON THE LINE, not at the candle's own extreme. A touch is a pivot whose
    // high or low came within tolerance of the line,
    // so the two differ by up to that tolerance; drawing on the line keeps the
    // marks reading as part of it rather than as a scatter beside it. The
    // anchors are included, so the ring count always equals the tag.
    //
    // Touches start at i1 === jLeft (the line's left anchor). In segment mode
    // a touch may lie beyond jRight, and its ring would land on the line's
    // invisible extension, so rings cull at the drawn end (x1) as well as the
    // pane edge. The y-clamp guards canvas bleeding into adjacent panes: this
    // canvas is shared with the other panes, and an unclamped y bleeds into
    // them.
    ctx.lineWidth = 1;
    for (let t = 0; t < line.touchIdxs.length; t++) {
      const idx = line.touchIdxs[t];
      const kd = touchKindAt(line, t);
      const xT = kd ? xAtPivot(idx, kd) : xAt(idx);
      const yT = onSegment(xT);
      if (xT < 0 || xT > Math.min(tagRight, x1) || yT < 0 || yT > bounding.height)
        continue;
      ctx.beginPath();
      ctx.arc(xT, yT, TL_TOUCH_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Touch count at the right end, the same ×N tag SR_LEVELS puts on a zone:
    // the drawn set is chosen by proximity, so this is how a user tells a
    // 5-touch line from a bare 2-anchor one at a glance.
    //
    // THE TAG'S Y MUST BE INTERPOLATED AT ITS CLAMPED X, and SR_LEVELS' idiom
    // cannot be copied here. There, yMid is the level's own price, on-pane by
    // construction because the level is HORIZONTAL. Here (x1, y1) is the line
    // 250 bars into the future: for any live line
    // lastTouchIdx + maxProjBars >= lastIdx, so x1 is ALWAYS past the right
    // edge, the x-clamp ALWAYS engages, and pinning y to y1 detaches the tag
    // from the segment it labels. Measured on the DXY fixture at a realistic
    // viewport (120 bars over a 900px pane, 400px tall), four of six tags
    // landed outside the pane entirely and the two that stayed sat ~75px off
    // their line. The segment is straight, so interpolating at xTag puts the
    // tag back on it.
    // The pin handle, AT THE NEWEST BAR always, on the line's projection
    // there — not at the line's natural end. The natural end moves with the
    // mode (last touch in segment, a meeting in cross), which scattered the
    // handles across the chart; the newest bar lines them up in one column
    // beside price where every line is being read anyway, and it is the same
    // spot whether or not the line is pinned, so the click that made the pin
    // is the click that undoes it. In segment mode the stroke can stop short
    // of it: the handle then sits on the line's invisible projection, which is
    // the price of "always". ABSOLUTE, unlike the tag: no clamp to the pane
    // edge, so panning back through history moves the handle off-screen with
    // its bar instead of leaving it clinging to the edge — the culling guard
    // below drops it (undrawn AND unclickable) until the newest bar scrolls
    // back into view, the same deal an off-pane-vertically handle gets.
    const xHandle = xAt(drawEdge);
    const yHandle = yAxis.convertToPixel(projectAt(line, drawEdge));
    // The ring sits just BEYOND the end, tangent to it, rather than centred on
    // it. Centred, a hollow ring has the line running through its middle, which
    // reads as a bead threaded on the line instead of a cap at its tip. Pushed
    // out by its own radius (plus half the 1px stroke) along the line's own
    // direction, it touches the tip and nothing more. A pinned line runs on past
    // it, so the offset dot still lands on the line there.
    const [xRing, yRing] = ringCentre(x0, y0, xHandle, yHandle);
    // Culled on the BAR's x, not the ring's: at the live edge the newest bar
    // sits flush against the axis strip and the ring pokes a radius past it —
    // dropping the handle there would hide it in exactly the resting state a
    // chart spends its life in. The ring overlapping the 4px axis gap by that
    // much is the lesser evil.
    if (
      stops &&
      xRing >= 0 &&
      xHandle <= tagRight &&
      yRing >= 0 &&
      yRing <= bounding.height
    ) {
      // Registered where it is DRAWN: the hit test and the ring must be the
      // same object or the click target drifts off the dot.
      handles.push({ key: lineKey(line, dataList, starts), x: xRing, y: yRing });
      // The two states are OPPOSITE ACTIONS, so they get opposite shapes rather
      // than two shades of one dot. Free: a chevron pointing the way the line
      // would run, "click to run me on". Pinned: a bar across the line, an end
      // stop the line has already passed, "click to cut me back".
      const ang = Math.atan2(yRing - y0, xRing - x0);
      ctx.globalAlpha = 1;
      ctx.lineWidth = TL_HANDLE_STROKE;
      ctx.beginPath();
      if (isPinned) {
        const nx = Math.sin(ang);
        const ny = -Math.cos(ang);
        ctx.moveTo(xRing - nx * TL_HANDLE_RADIUS, yRing - ny * TL_HANDLE_RADIUS);
        ctx.lineTo(xRing + nx * TL_HANDLE_RADIUS, yRing + ny * TL_HANDLE_RADIUS);
      } else {
        // Tip one radius ahead of centre, arms swept back 135 degrees, so the
        // chevron's mouth faces the line and its point faces the extension.
        const tx = xRing + Math.cos(ang) * TL_HANDLE_RADIUS;
        const ty = yRing + Math.sin(ang) * TL_HANDLE_RADIUS;
        const arm = TL_HANDLE_RADIUS * 1.6;
        const a1 = ang + Math.PI * 0.75;
        const a2 = ang - Math.PI * 0.75;
        ctx.moveTo(tx + Math.cos(a1) * arm, ty + Math.sin(a1) * arm);
        ctx.lineTo(tx, ty);
        ctx.lineTo(tx + Math.cos(a2) * arm, ty + Math.sin(a2) * arm);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = alpha;
    }
    const label =
      line.crossings > 0 ? `×${line.touches} ⇅${line.crossings}` : `×${line.touches}`;
    const xTag = Math.min(
      xRing + TL_HANDLE_RADIUS + 5,
      tagRight - ctx.measureText(label).width,
    );
    const yTag =
      xHandle === x0
        ? yHandle
        : y0 + ((yHandle - y0) * (xTag - x0)) / (xHandle - x0);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(label, xTag, yTag);
  }
  ctx.restore();
  // Last, so the marks sit over the strokes, and keyed on the set the pane
  // actually drew — not `eligible`, which still holds lines the dedupe and
  // proximity passes threw away.
  paintMarks(drawnPivotIdxs(drawn));
  setTrendlineHandles(chart, indicator.paneId, indicator.name, handles);
  return true;
}

const TL_CALC_SESSIONS = new WeakMap<Indicator, TrendlinesSession>();

export const TRENDLINES_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Trendlines",
  series: "price",
  precision: 2,
  calcParams: Object.values(TRENDLINES_DEFAULTS),
  // Empty figures + a draw that returns true (isCover) is the established way
  // to run calc but paint nothing of klinecharts' own — the mechanism
  // sessions.ts and proximityHeatmap.ts already use.
  figures: [],
  // READS calcParams, extendData.mtf AND extendData.tlFloorTs, NOTHING ELSE.
  // Every other key on extendData is a drawing option, and pulling one in here
  // would make a chart setting change an emitted value. `mtf` and `tlFloorTs`
  // are not drawing options: they say which CANDLES the indicator runs on, so
  // they belong to the calculation — the higher timeframe is computed outside,
  // by the coordinator, and only aligned here; the floor is stamped by the
  // coordinator's viewport pass (stampTrendlinesFloors).
  calc: (dataList: KLineData[], ind: Indicator) => {
    // No visibility check here: a hidden instance never reaches this function at
    // all, because registration wraps every custom template in hiddenAware (see
    // indicators/hiddenCalc.ts). The session cache below survives that in its
    // WeakMap, so the catch-up after an unhide is incremental.
    const ext = ind.extendData as TrendlinesExtend | undefined;
    const mtf = ext?.mtf;
    if (mtf?.timeframe && mtf.htfStarts?.length && mtf.htfMs)
      return alignMtfTrendlines(dataList, mtf);
    // One session per indicator instance (klinecharts passes the same object
    // to every calc), so per-tick recalcs re-run only the forming bar. The
    // WeakMap lets a removed indicator's cache be collected with it.
    let session = TL_CALC_SESSIONS.get(ind);
    if (!session) {
      session = createTrendlinesSession();
      TL_CALC_SESSIONS.set(ind, session);
    }
    const { points, lines, atr, pivots } = session.compute(
      dataList,
      parseTrendlinesConfig(ind.calcParams, ext),
      ext?.tlFloorTs,
    );
    // The session already returns a fresh top-level array (prefix rows shared,
    // read-only by contract — see createTrendlinesSession), so replacing the
    // last row here mutates nothing cached.
    const out = points as TrendlinesCalcPoint[];
    if (out.length)
      out[out.length - 1] = {
        ...out[out.length - 1],
        lines,
        atr: atr[atr.length - 1],
        pivots,
        lineIdx: out.length - 1,
      };
    return out;
  },
  draw: (params) =>
    drawTrendlines(
      params as IndicatorDrawParams<TrendlinesCalcPoint, unknown, unknown>,
    ),
};

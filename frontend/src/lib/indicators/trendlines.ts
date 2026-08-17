// TRENDLINES: major sloping support/resistance lines from confirmed fractal
// pivots.
//
// Causal by construction (backtest-safe): a strict fractal pivot at bar i only
// exists at its confirm bar i+N, every line is seeded at a confirm bar, and
// break detection at bar i only ever tests a line whose anchors precede i. So
// values at bar i depend only on bars [0..i].
//
// PARITY, and exactly where division is allowed. core.py's contract is that
// identical operation order is what makes the parity suite exact. Here validity
// is a BOOLEAN THAT GATES SET MEMBERSHIP: a 1-ULP disagreement does not drift a
// number, it deletes a line and changes the whole output set from that bar
// forward. So EVERY boolean gate multiplies through by the exact positive
// integer (i2 - i1) instead of computing a slope — pierces, inTouchBand, and
// the emit path's at-or-below-the-close side test alike.
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

import type { Indicator, IndicatorDrawParams, IndicatorTemplate, KLineData } from "klinecharts";
import { isPivotAt } from "./pivots";
import { atrSeries } from "../atr";
import {
  MAX_LIVE_MULT,
  MAX_PAIR_PIVOTS,
  parseTrendlinesConfig,
  TL_ATR_LEN,
  TRENDLINES_DEFAULTS,
  type TrendlinesConfig,
} from "./trendlinesOutputs";

export type TrendSide = "support" | "resistance";

/** A line is defined by two anchor pivots and NEVER rotates once defined.
 * Later touches move lastTouchIdx, which extends the line's coverage; they do
 * not move i2/p2, so the geometry a line was born with is the one it dies
 * with. */
export interface TrendLine {
  side: TrendSide;
  i1: number; // first anchor bar index
  p1: number; // first anchor price (high for resistance, low for support)
  i2: number; // second anchor bar index (i2 > i1)
  p2: number;
  touches: number;
  lastTouchIdx: number; // seeded to i2, only ever moves forward
  brokenIdx: number | null; // bar that pierced it, once one has
}

/** The line's price at bar j. The ONLY division in this module: its output is
 * a price that drifts harmlessly, not a gate. */
export function projectAt(line: TrendLine, j: number): number {
  return line.p1 + ((line.p2 - line.p1) * (j - line.i1)) / (line.i2 - line.i1);
}

/** True when bar j's extreme goes beyond the line by more than violTol.
 *
 * Cross-multiplied: with span = i2 - i1 an exact positive integer,
 *   (price - p1) * span  vs  (p2 - p1) * (j - i1) +/- violTol * span
 * is the same inequality as comparing price against the projected value, with
 * one rounding source removed. Multiplying by a positive integer preserves the
 * direction of the inequality. */
export function pierces(line: TrendLine, j: number, price: number, violTol: number): boolean {
  const span = line.i2 - line.i1;
  const lhs = (price - line.p1) * span;
  const rhs = (line.p2 - line.p1) * (j - line.i1);
  const tol = violTol * span;
  return line.side === "resistance" ? lhs > rhs + tol : lhs < rhs - tol;
}

/** True when bar j's extreme counts as a touch.
 *
 * The band is ASYMMETRIC on purpose. For resistance it is
 * [line - touchTol, line + violTol]: the far edge of the touch zone must not
 * reach into the pierce zone, which is exactly what a symmetric band with
 * touchTol > violTol would do. */
export function inTouchBand(
  line: TrendLine,
  j: number,
  price: number,
  violTol: number,
  touchTol: number,
): boolean {
  const span = line.i2 - line.i1;
  const lhs = (price - line.p1) * span;
  const rhs = (line.p2 - line.p1) * (j - line.i1);
  const out = violTol * span;
  const inn = touchTol * span;
  return line.side === "resistance" ? lhs >= rhs - inn && lhs <= rhs + out : lhs >= rhs - out && lhs <= rhs + inn;
}

/** Full deterministic ordering (no stability reliance — Python sorts
 * identically): strongest first, then longest, then most recent, then oldest
 * origin, then lowest anchor price. The last key is a STORED price, never a
 * projected one, so ranking cannot depend on which bar it runs at. */
export function rankLines(a: TrendLine, b: TrendLine): number {
  if (a.touches !== b.touches) return b.touches - a.touches;
  const spanA = a.lastTouchIdx - a.i1;
  const spanB = b.lastTouchIdx - b.i1;
  if (spanA !== spanB) return spanB - spanA;
  if (a.lastTouchIdx !== b.lastTouchIdx) return b.lastTouchIdx - a.lastTouchIdx;
  if (a.i1 !== b.i1) return a.i1 - b.i1;
  return a.p1 - b.p1;
}

export interface TrendlinesPoint {
  tl_support?: number;
  tl_resistance?: number;
  tl_broken_support?: number;
  tl_broken_resistance?: number;
}

const SIDES: readonly TrendSide[] = ["resistance", "support"];

/** Live means: not aged out past its projection horizon, and if broken, still
 * inside the hold window. */
function isLive(line: TrendLine, i: number, cfg: TrendlinesConfig): boolean {
  if (line.brokenIdx !== null) return i - line.brokenIdx <= cfg.breakHoldBars;
  return i - line.lastTouchIdx <= cfg.maxProjBars;
}

/** Major means: enough touches, enough span, and covering this bar. This is now
 * the ONLY gate on the operand path: the caller used to also cap by rank, and
 * step 4 explains at length why that cap had to go for sloping geometry.
 *
 * TWO INDEPENDENT CLOCKS, and they must NOT intersect. maxProjBars ages an
 * UNBROKEN line forward from lastTouchIdx; breakHoldBars holds a BROKEN one
 * forward from brokenIdx, and isLive owns that second clock ALONE. So once a
 * line is broken this function stops applying maxProjBars entirely.
 *
 * Applying both to a broken line truncates the retest window rather than
 * merely shortening it, because emission needs isLive && isMajor. At stock
 * maxProjBars 250 / breakHoldBars 30, a line last touched at bar 40 and broken
 * at bar 290 (= lastTouchIdx + maxProjBars) would emit on bar 290 only — 1 bar
 * of a 31-bar window. With maxProjBars below breakHoldBars it emits nothing at
 * all while still sitting in live state. Any break landing in the last
 * breakHoldBars of a line's horizon loses its window. Keep the branches split
 * in the Python port. */
function isMajor(line: TrendLine, i: number, cfg: TrendlinesConfig): boolean {
  if (line.touches < cfg.minTouches) return false;
  if (line.lastTouchIdx - line.i1 < cfg.minSpanBars) return false;
  if (line.brokenIdx !== null) return i >= line.i1;
  return i >= line.i1 && i <= line.lastTouchIdx + cfg.maxProjBars;
}

export function computeTrendlines(
  dataList: KLineData[],
  cfg: TrendlinesConfig,
): { points: TrendlinesPoint[]; lines: TrendLine[] } {
  const n = dataList.length;
  const points: TrendlinesPoint[] = Array.from({ length: n }, () => ({}));
  if (n === 0) return { points, lines: [] };

  const atr = atrSeries(dataList, TL_ATR_LEN);
  const highs = dataList.map((d) => d.high);
  const lows = dataList.map((d) => d.low);
  const pools: Record<TrendSide, number[]> = { resistance: [], support: [] };
  let lines: TrendLine[] = [];

  const extremeOf = (side: TrendSide, j: number): number =>
    side === "resistance" ? highs[j] : lows[j];

  for (let i = 0; i < n; i++) {
    const a = atr[i];

    // 1. PER-BAR break test. Runs every bar, not only at confirm bars: a line
    //    is almost always broken by an ordinary bar. Still causal — every
    //    anchor of every line tested here precedes i.
    if (a !== null) {
      for (const line of lines) {
        if (line.brokenIdx !== null) continue;
        // UNREACHABLE BY CONSTRUCTION, kept as a guard rail. A line is created
        // at its confirm bar c = i2 + pivotLen, and step 1 runs BEFORE step 2,
        // so this loop first sees the line at bar c + 1, already > i2. Bars in
        // (i1, c] were validated at seed time. A Python port should mirror the
        // line but must not treat it as load-bearing logic.
        if (i <= line.i2) continue;
        if (pierces(line, i, extremeOf(line.side, i), cfg.violMult * a)) line.brokenIdx = i;
      }
    }

    // 2. CONFIRM-BAR work for the pivot at bar k = i - pivotLen.
    const k = i - cfg.pivotLen;
    if (k >= 0 && a !== null) {
      for (const side of SIDES) {
        const vals = side === "resistance" ? highs : lows;
        const want = side === "resistance" ? "high" : "low";
        if (!isPivotAt(vals, k, cfg.pivotLen, cfg.pivotLen, want, true)) continue;
        const pool = pools[side];
        const price = vals[k];

        // 2a. Test the new pivot against every existing line on this side.
        for (const line of lines) {
          if (line.side !== side) continue;
          if (k <= line.i2) continue;
          if (line.brokenIdx !== null) continue;
          const tolA = atr[k];
          if (tolA === null) continue;
          if (inTouchBand(line, k, price, cfg.violMult * tolA, cfg.touchMult * tolA)) {
            line.touches += 1;
            line.lastTouchIdx = k;
          }
        }

        // 2b. Seed candidates against the previous MAX_PAIR_PIVOTS pivots.
        //     `pool.push(k)` happens AFTER this loop, so every i1 read here is
        //     strictly less than i2 = k: that is what keeps span positive, and
        //     both geometry gates silently invert if it ever stops being true.
        const from = Math.max(0, pool.length - MAX_PAIR_PIVOTS);
        for (let q = from; q < pool.length; q++) {
          const i1 = pool[q];
          // UNREACHABLE BY CONSTRUCTION, kept as a guard rail. Every existing
          // line was created at an earlier confirm bar, whose k was strictly
          // smaller, so no stored i2 can equal this k; and within this bar the
          // pool entries are distinct, so no two candidates share an i1. As
          // above: mirror it in the port, do not build on it.
          if (lines.some((l) => l.side === side && l.i1 === i1 && l.i2 === k)) continue;
          const cand: TrendLine = {
            side,
            i1,
            p1: vals[i1],
            i2: k,
            p2: price,
            touches: 2,
            lastTouchIdx: k,
            brokenIdx: null,
          };
          // Validate over (i1, c]: bars between the anchors AND the bars since
          // the second anchor, which are real bars that could already have
          // pierced it. Anchor bars themselves are excluded.
          let ok = true;
          for (let j = i1 + 1; j <= i; j++) {
            if (j === k) continue;
            const tolJ = atr[j];
            if (tolJ === null) continue;
            if (pierces(cand, j, extremeOf(side, j), cfg.violMult * tolJ)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          // Retro-count touches from pivots already in the pool between the
          // anchors. Not lookahead: every one of them confirmed before i.
          for (const pj of pool) {
            if (pj <= i1 || pj >= k) continue;
            const tolP = atr[pj];
            if (tolP === null) continue;
            if (inTouchBand(cand, pj, vals[pj], cfg.violMult * tolP, cfg.touchMult * tolP)) {
              cand.touches += 1;
            }
          }
          lines.push(cand);
        }
        pool.push(k);
      }

      // 3. Prune the dead, then cap live state by rank.
      //
      // Since the emit path stopped capping by rank (see step 4), this is
      // cfg.maxLines' only use INSIDE the detector: it sizes live state via
      // MAX_LIVE_MULT. The other half of its job lives in selectDrawnLines
      // below, where it is the per-side FLOOR for the drawn set (a line an
      // operand is reading is drawn on top of that budget, never instead of
      // it). Ranking is right here and wrong there; that function says why.
      lines = lines.filter((l) => isLive(l, i, cfg));
      for (const side of SIDES) {
        const mine = lines.filter((l) => l.side === side).sort(rankLines);
        const keep = new Set(mine.slice(0, MAX_LIVE_MULT * cfg.maxLines));
        lines = lines.filter((l) => l.side !== side || keep.has(l));
      }
    }

    // 4. Emit. Membership is gated (live + major); selection is nearest to the
    //    close, the same reading as SR_LEVELS.
    //
    //    NO CAP-BY-RANK HERE, and that is the whole point. This path used to
    //    take the top cfg.maxLines by rank and only then pick the nearest to
    //    the close. That ordering is borrowed from SR_LEVELS, where it is safe
    //    because a HORIZONTAL level 500 bars old still sits at the same price,
    //    so capping by rank cannot discard the nearest candidate by much. A
    //    SLOPING line projected 250 bars produces a number with no relationship
    //    to price, and rank (touches, then span) actively favours exactly those
    //    old lines. On DXY monthly the cap threw away the live post-2022
    //    downtrend at 106.6 and emitted a 2009->2017 artifact at 121.2 instead:
    //    the line nearest-selection would have chosen was deleted before
    //    selection ran. The pattern does not transfer to sloping geometry.
    //
    //    The sort is kept even though nothing is sliced: nearest-selection
    //    below resolves an exact tie by first-wins, so iterating in rank order
    //    keeps that tie-break defined by rankLines rather than by list order.
    //    Mirror the sort in the Python port for the same reason.
    const close = dataList[i].close;
    const point: TrendlinesPoint = {};
    for (const side of SIDES) {
      const majors = lines
        .filter((l) => l.side === side && isLive(l, i, cfg) && isMajor(l, i, cfg))
        .sort(rankLines);
      // The side test applies to UNBROKEN lines ONLY, and the two cases must
      // not be merged. An unbroken support sits at or below the close and an
      // unbroken resistance above it — that is what "nearest support" means.
      // A BROKEN line gets NO side test: once price has pierced a line it can
      // sit on EITHER side of the close during the hold window (a wick break
      // snaps back the next bar, leaving the broken support below the close
      // again), and the hold window exists precisely to keep that level
      // visible for a retest. Requiring broken support to sit above the close
      // silently blanks tl_broken_support for whole windows.
      const pick = (want: "unbroken" | "broken"): number | undefined => {
        let best: number | undefined;
        for (const line of majors) {
          if (want === "unbroken" ? line.brokenIdx !== null : line.brokenIdx === null) continue;
          const v = projectAt(line, i);
          if (want === "unbroken") {
            // CROSS-MULTIPLIED, exactly as pierces does, because this is a
            // boolean that gates whether an output fires at all. With
            // s = i2 - i1 an exact positive integer,
            //   projectAt(line, i) <= close
            // is the same inequality as
            //   (p2 - p1) * (i - i1) <= (close - p1) * s
            // with the quotient's rounding removed; multiplying through by a
            // positive integer preserves the direction.
            const s = line.i2 - line.i1;
            const below = (line.p2 - line.p1) * (i - line.i1) <= (close - line.p1) * s;
            if (below !== (side === "support")) continue;
          }
          if (best === undefined || Math.abs(v - close) < Math.abs(best - close)) best = v;
        }
        return best;
      };
      const unbroken = pick("unbroken");
      const broken = pick("broken");
      if (side === "support") {
        if (unbroken !== undefined) point.tl_support = unbroken;
        if (broken !== undefined) point.tl_broken_support = broken;
      } else {
        if (unbroken !== undefined) point.tl_resistance = unbroken;
        if (broken !== undefined) point.tl_broken_resistance = broken;
      }
    }
    points[i] = point;
  }

  return { points, lines };
}

/** Render-only options, on extendData rather than calcParams — the same seam
 * SR_LEVELS uses for showMidline. Because none of this changes a value, it
 * needs no Python port and no parity test. */
export interface TrendlinesExtend {
  /** "ray" keeps going right (default), "segment" stops at the last touch,
   * "extended" also draws back before the first anchor. Backward extension is
   * never readable by an operand: a line emitting values before its first
   * anchor existed would be lookahead.
   *
   * "apex" and "cross" are rays that stop early, where this line first meets
   * another DRAWN one: "apex" only counts the opposite side (the wedge or
   * triangle apex a trader reads), "cross" counts any line. When nothing is
   * met they stop at the newest bar rather than running the full horizon, or a
   * line with no apex shoots far past neighbours that stopped near the last
   * candle. "lastbar" ends every line at the newest bar. Because a meeting
   * depends on which lines are drawn, it moves with maxLines and with
   * proximity order. That is fine here and only here: this is the draw path,
   * and no operand reads it. */
  extend?: "ray" | "segment" | "extended" | "apex" | "cross" | "lastbar";
  /** Lines the user pinned open by clicking their end handle, as lineKey()
   * strings. A pinned line ignores `extend` and runs to the right edge of the
   * pane, re-measured every render so it stays "indefinite" through scroll and
   * zoom instead of baking in a bar count. */
  pinned?: string[];
}

/** Stable identity for a line across recomputes, for pinning.
 *
 * NOT the bar indices: those shift by the whole prepended length the moment
 * older history loads, which would silently move every pin onto a different
 * line. Anchor TIMESTAMPS are immutable, so a pin survives history loads,
 * timeframe reloads and a page refresh. */
export function lineKey(line: TrendLine, dataList: KLineData[]): string {
  const t1 = dataList[line.i1]?.timestamp ?? line.i1;
  const t2 = dataList[line.i2]?.timestamp ?? line.i2;
  return `${line.side}:${t1}:${t2}`;
}

/** calc result row. The full line list rides on the LAST row only (draw reads
 * it there), exactly as SR_LEVELS carries its levels. */
export type TrendlinesCalcPoint = TrendlinesPoint & { lines?: TrendLine[] };

/** The DRAWN set: the maxLines per side whose projection at `atIdx` sits
 * nearest to `close`, PLUS whichever lines the emit path is reading at that
 * bar. maxLines is a FLOOR for drawing, not a cap. This is cfg.maxLines' second
 * job (the first being the MAX_LIVE_MULT sizing of live state inside
 * computeTrendlines).
 *
 * NOT rankLines ORDER, and the disagreement is deliberate — a future reader
 * will notice that the detector ranks and the chart does not. Rank sorts by
 * touches, then span, which systematically favours ANCIENT geometry: an old
 * line has had decades to collect touches. computeTrendlines keeps
 * MAX_LIVE_MULT (4) x maxLines per side, so up to 24 lines reach the pane, and
 * on the DXY monthly fixture four of them are 1990s support lines projecting to
 * 10.99, 13.28, 31.83 and 57.36 against a close of 99.27. They are perfectly
 * valid lines whose projections left the chart years ago; by rank they draw
 * FIRST and bury the two lines a human actually reads.
 *
 * Rank is still the tie-break, so an exact distance tie resolves the same way
 * everywhere instead of by list order.
 *
 * WHY THE UNION, and why proximity alone was not enough. The chart is the only
 * surface on which a user can audit an operand, so a line a rule is reading
 * must never be off-screen. Proximity looks like it should give that for free
 * (the emit path also picks nearest-to-the-close), but it does not: emission
 * makes FOUR independent picks per bar, one per (side x broken-state), while
 * the budget is maxLines per SIDE. A broken line sits nearest to price by
 * construction — price has just pierced it — so during a break-hold window the
 * broken lines take every slot on a side and evict the unbroken line a rule is
 * actually reading. Measured on the DXY monthly fixture at stock defaults,
 * tl_resistance had no drawn line on 96 chart states, tl_support on 73,
 * tl_broken_resistance on 22, tl_broken_support on 2. Unioning the emitted
 * lines back in takes all four to zero, at a cost of 6.3 drawn lines on average
 * instead of 5.8. (An isMajor gate is NOT the alternative fix: measured, it
 * moves tl_resistance's 96 misses to 96. The cause is budget allocation, not
 * qualification.)
 *
 * So the guarantee is: EVERY emitted value has a line drawn at it. That
 * direction holds by construction, matching each emitted value against
 * projectAt on the same bar — the emitted number IS that expression's result,
 * so the comparison is exact, not toleranced. The CONVERSE does not hold and is
 * not meant to: the drawn set can contain lines no operand reads (below
 * minSpanBars, under minTouches, or on the far side of the close), because the
 * chart's job is to show the geometry in play, not only the four numbers.
 *
 * The drawn set is INDEPENDENT OF THE EXTEND MODE on purpose: proximity is
 * always measured at the last bar, even in "segment" mode where the line stops
 * drawing at its last touch. Switching extend must change how far lines run and
 * nothing else — which lines appear, like which values emit, must not move.
 *
 * `emitted` is the calc row for `atIdx` (pass `{}` to get proximity alone). It
 * is a REQUIRED argument so the draw path cannot quietly stop passing it and
 * lose the guarantee while the suite stays green.
 *
 * Draw-time only, so the Python port has no counterpart. */
export function selectDrawnLines(
  lines: TrendLine[],
  atIdx: number,
  close: number,
  maxLines: number,
  emitted: TrendlinesPoint,
): TrendLine[] {
  const out: TrendLine[] = [];
  for (const side of SIDES) {
    const wantUnbroken = side === "support" ? emitted.tl_support : emitted.tl_resistance;
    const wantBroken =
      side === "support" ? emitted.tl_broken_support : emitted.tl_broken_resistance;
    const mine = lines
      .filter((l) => l.side === side)
      .map((l) => {
        const proj = projectAt(l, atIdx);
        return { line: l, proj, dist: Math.abs(proj - close) };
      })
      .sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : rankLines(a.line, b.line)));
    // Proximity order throughout: the budgeted head, then any emitting line
    // that fell outside it, appended in the same order. Deterministic either
    // way, and the ×N tags keep pairing with the segments they label.
    mine.forEach((e, idx) => {
      if (idx < maxLines) {
        out.push(e.line);
        return;
      }
      const want = e.line.brokenIdx !== null ? wantBroken : wantUnbroken;
      if (want !== undefined && e.proj === want) out.push(e.line);
    });
  }
  return out;
}

// Hardcoded rather than themed, matching SR_LEVELS' SR_ZONE_STYLE_DEFAULTS:
// these are the same green/red the S/R zones paint, and the two overlays are
// read side by side.
/** Drawn radius of the end handle. The click target is deliberately larger
 * (TL_HANDLE_HIT), because a 3px dot is not a mouse target. */
export const TL_HANDLE_RADIUS = 3;
export const TL_HANDLE_HIT = 8;

const TL_SUPPORT_COLOR = "#26a69a";
const TL_RESISTANCE_COLOR = "#ef5350";

/** Where `line` first meets one of `others` strictly after `from`, or null if
 * none does inside `limit`.
 *
 * Both lines are straight in index space, so this is solved rather than
 * scanned: with value(j) = slope * j + intercept, they meet at one exact j.
 * Fractional is CORRECT to return, not a rounding bug to fix. klinecharts maps
 * a data index to a pixel with plain arithmetic (dataIndexToCoordinate floors
 * the pixel, never the index), so a fractional index lands on the true apex
 * instead of snapping to a bar edge.
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
  const broken = line.brokenIdx !== null;
  const jLeft = mode === "extended" ? line.i1 - cfg.maxProjBars : line.i1;
  // A broken line's own history runs to the break, which lands AFTER the last
  // touch by construction. Ending at lastTouchIdx would stop the line short of
  // the event that killed it, hiding the break marker on the one mode that
  // draws a finite line. Every mode reaches its break.
  const jEnd = broken ? Math.max(line.lastTouchIdx, line.brokenIdx as number) : line.lastTouchIdx;
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
  if (mode === "apex" || mode === "cross") {
    const others = drawn.filter(
      (o) => o !== line && (mode === "cross" || o.side !== line.side),
    );
    // Nothing to meet: stop at the newest bar, NOT the full projection
    // horizon. A line with no apex would otherwise shoot 250 bars into empty
    // space beside neighbours that stopped within a few bars of the last
    // candle, which reads as a bug rather than as "this one never meets".
    return { jLeft, jRight: meetsAt(line, others, jEnd, horizon) ?? Math.max(jEnd, lastIdx) };
  }
  return { jLeft, jRight: horizon };
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
export function hitAnyTrendlineHandle(chart: object, px: number, py: number): boolean {
  const byPane = HANDLES.get(chart);
  if (!byPane) return false;
  for (const handles of byPane.values()) {
    if (hitHandle(handles, px, py) !== null) return true;
  }
  return false;
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

function drawTrendlines(
  params: IndicatorDrawParams<TrendlinesCalcPoint, unknown, unknown>,
): boolean {
  const { ctx, chart, indicator, bounding, xAxis, yAxis } = params;
  const result = (indicator.result ?? []) as TrendlinesCalcPoint[];
  const last = result[result.length - 1];
  const dataList = chart.getDataList();
  // Clear on the empty paths too, or the last frame's handles stay clickable
  // over a chart that no longer draws them.
  if (!last?.lines?.length || dataList.length === 0) {
    setTrendlineHandles(chart, indicator.paneId, indicator.name, null);
    return true;
  }
  const cfg = parseTrendlinesConfig(indicator.calcParams);
  const ext = indicator.extendData as TrendlinesExtend | undefined;
  const mode = ext?.extend ?? "ray";
  const lastIdx = dataList.length - 1;
  const lastClose = dataList[lastIdx].close;
  // `last` carries BOTH the line list and the last bar's emitted values, so the
  // union that keeps every operand's line on screen needs no extra plumbing.
  const drawn = selectDrawnLines(last.lines, lastIdx, lastClose, cfg.maxLines, last);
  // bounding.width spans the whole pane INCLUDING the y-axis strip on the
  // right; the ×N tags must stop before it or the axis overlay hides them.
  const axisWidth = chart.getSize(indicator.paneId, "yAxis")?.width ?? 0;
  const tagRight = bounding.width - axisWidth - 4;
  // A pin means "run past where you stopped", so it is only meaningful in the
  // modes that STOP a line. "ray" and "extended" already run to the horizon:
  // there is nothing to release, and their end sits ~maxProjBars into the
  // future, off the pane, where the handle was being culled and left nothing to
  // click. No handle, and stored pins stay dormant rather than silently
  // extending a line with no control to undo it.
  const stops = mode !== "ray" && mode !== "extended";
  const pins = new Set(stops ? (ext?.pinned ?? []) : []);
  const handles: TrendlineHandle[] = [];
  // The bar index sitting at the pane's right edge, so a pinned line reaches it
  // at any zoom. The index-to-pixel map is linear (klinecharts multiplies by a
  // constant bar space), so one bar's width inverts it exactly.
  const barPx = xAxis.convertToPixel(1) - xAxis.convertToPixel(0);
  const edgeIdx =
    barPx > 0 ? lastIdx + (tagRight - xAxis.convertToPixel(lastIdx)) / barPx : lastIdx;

  ctx.save();
  ctx.font = "10px sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const line of drawn) {
    const broken = line.brokenIdx !== null;
    const isPinned = pins.has(lineKey(line, dataList));
    // The line's end under the MODE alone. The handle and the ×N tag ride here
    // whether or not the line is pinned: a pinned line runs to the pane edge,
    // and a handle that travelled with it would leave nothing to click to undo
    // the pin (and would sit under the y-axis besides).
    const natural = lineExtent(line, mode, cfg, drawn, lastIdx, null);
    const { jLeft, jRight } = isPinned
      ? lineExtent(line, mode, cfg, drawn, lastIdx, edgeIdx)
      : natural;
    const x0 = xAxis.convertToPixel(jLeft);
    const x1 = xAxis.convertToPixel(jRight);
    if (x1 <= 0 || x0 >= bounding.width) continue;
    const y0 = yAxis.convertToPixel(projectAt(line, jLeft));
    const y1 = yAxis.convertToPixel(projectAt(line, jRight));
    ctx.strokeStyle = line.side === "support" ? TL_SUPPORT_COLOR : TL_RESISTANCE_COLOR;
    ctx.globalAlpha = broken ? 0.45 : 1;
    ctx.lineWidth = 1;
    ctx.setLineDash(broken ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    // The break itself: dashing says a line is dead, but not where it died,
    // which is the half a retest actually turns on. Drawn at full opacity (the
    // line around it is faded) and guarded on BOTH axes, because this canvas is
    // shared with the other panes and an unclamped y bleeds into them, exactly
    // as the tag comment below records.
    if (broken) {
      const jBreak = line.brokenIdx as number;
      const xB = xAxis.convertToPixel(jBreak);
      const yB = yAxis.convertToPixel(projectAt(line, jBreak));
      if (xB >= 0 && xB <= tagRight && yB >= 0 && yB <= bounding.height) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.arc(xB, yB, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.45;
      }
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
    // The pin handle, on the line's right end wherever that end landed. Hollow
    // when free, filled when pinned, so the toggle's state is readable without
    // hovering. Clamped inside the pane like the tag, and its y interpolated at
    // the clamped x for the same reason the tag's is.
    const xNat = xAxis.convertToPixel(natural.jRight);
    const yNat = yAxis.convertToPixel(projectAt(line, natural.jRight));
    const xHandle = Math.min(xNat, tagRight);
    const yHandle = xNat === x0 ? yNat : y0 + ((yNat - y0) * (xHandle - x0)) / (xNat - x0);
    if (stops && xHandle >= 0 && yHandle >= 0 && yHandle <= bounding.height) {
      handles.push({ key: lineKey(line, dataList), x: xHandle, y: yHandle });
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(xHandle, yHandle, TL_HANDLE_RADIUS, 0, Math.PI * 2);
      if (isPinned) {
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      } else {
        ctx.stroke();
      }
      ctx.globalAlpha = broken ? 0.45 : 1;
    }
    const label = `×${line.touches}`;
    const xTag = Math.min(xHandle + TL_HANDLE_RADIUS + 5, tagRight - ctx.measureText(label).width);
    const yTag = xNat === x0 ? yNat : y0 + ((yNat - y0) * (xTag - x0)) / (xNat - x0);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(label, xTag, yTag);
  }
  ctx.restore();
  setTrendlineHandles(chart, indicator.paneId, indicator.name, handles);
  return true;
}

export const TRENDLINES_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Trendlines",
  series: "price",
  precision: 2,
  calcParams: [
    TRENDLINES_DEFAULTS.pivotLen,
    TRENDLINES_DEFAULTS.violMult,
    TRENDLINES_DEFAULTS.touchMult,
    TRENDLINES_DEFAULTS.minTouches,
    TRENDLINES_DEFAULTS.minSpanBars,
    TRENDLINES_DEFAULTS.maxProjBars,
    TRENDLINES_DEFAULTS.breakHoldBars,
    TRENDLINES_DEFAULTS.maxLines,
  ],
  // Empty figures + a draw that returns true (isCover) is the established way
  // to run calc but paint nothing of klinecharts' own — the mechanism
  // sessions.ts and proximityHeatmap.ts already use.
  figures: [],
  // READS calcParams ONLY. extendData carries render-only options, and pulling
  // any of them in here would make a chart setting change an emitted value.
  // SR_LEVELS' calc does pass its extendData into compute, so this is the one
  // place the neighbouring pattern must not be copied.
  calc: (dataList: KLineData[], ind: Indicator) => {
    const { points, lines } = computeTrendlines(dataList, parseTrendlinesConfig(ind.calcParams));
    const out = points.map((p) => ({ ...p })) as TrendlinesCalcPoint[];
    if (out.length) out[out.length - 1] = { ...out[out.length - 1], lines };
    return out;
  },
  draw: (params) =>
    drawTrendlines(params as IndicatorDrawParams<TrendlinesCalcPoint, unknown, unknown>),
};

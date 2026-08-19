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

import type {
  Indicator,
  IndicatorDrawParams,
  IndicatorTemplate,
  KLineData,
} from "klinecharts";
import { isPivotAt } from "./pivots";
import { atrSeries } from "../atr";
import { alignHtfToChart } from "../mtf";
import {
  MAX_LIVE_MULT,
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
  /** The bars that touched, INCLUDING the two anchors, so its length is always
   * `touches` and the ×N tag counts the marks the chart paints. Not in bar
   * order: the retro-count pass (2b) appends pivots that sit BETWEEN the
   * anchors after the anchors are already in. Nothing reads the order.
   *
   * DRAW-ONLY. No gate consults it, so it cannot move an emitted value, and
   * that is what keeps it out of the parity argument. Recorded rather than
   * recomputed at draw time because the touch test needs each bar's own ATR,
   * and only the detector has the series. */
  touchIdxs: number[];
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
export function pierces(
  line: TrendLine,
  j: number,
  price: number,
  violTol: number,
): boolean {
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
  return line.side === "resistance"
    ? lhs >= rhs - inn && lhs <= rhs + out
    : lhs >= rhs - out && lhs <= rhs + inn;
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

/** True when a line has grown past one of the user's ceilings (Max Touches,
 * Max Span). 0 means no limit on either.
 *
 * SILENCES, it does not delete, and the two callers are why. touches and span
 * only ever grow, so a line that crossed a ceiling can never come back: the
 * operand path (isMajor) stops reading it and the draw path stops painting it,
 * but it stays in live state so the pierce and touch passes still see it.
 * Contrast the slope gates, which DELETE at seed time because a line's slope is
 * fixed the moment it is defined.
 *
 * It is also the tie-break the live cap sorts on first (step 3). Without that,
 * the ceilings starve their own side: rankLines' first two keys are touches and
 * span descending, which is EXACTLY what these ceilings disqualify, so the
 * rejects sorted to the front of the MAX_LIVE_MULT * maxLines slots and evicted
 * the lines still eligible to emit. Measured on the DXY monthly fixture at
 * maxTouches 2, tl_resistance fired on 246 bars at maxLines 3 against 442 at
 * maxLines 12 — the setting silently blanked an operand a strategy reads. */
export function overCeilings(line: TrendLine, cfg: TrendlinesConfig): boolean {
  if (cfg.maxTouches > 0 && line.touches > cfg.maxTouches) return true;
  if (cfg.maxSpanBars > 0 && line.lastTouchIdx - line.i1 > cfg.maxSpanBars)
    return true;
  return false;
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
export function isMajor(line: TrendLine, i: number, cfg: TrendlinesConfig): boolean {
  if (line.touches < cfg.minTouches) return false;
  if (overCeilings(line, cfg)) return false;
  const span = line.lastTouchIdx - line.i1;
  if (span < cfg.minSpanBars) return false;
  if (line.brokenIdx !== null) return i >= line.i1;
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
  side: TrendSide,
  atrK: number,
  mult: number,
): boolean {
  if (mult <= 0) return true;
  // Most recent opposite pivot strictly before k. Strictly, because one bar can
  // be both a strict high pivot and a strict low pivot (a lone spike), and the
  // resistance pool is filled before the support pool within a confirm bar.
  let h = -1;
  for (let q = oppositePool.length - 1; q >= 0; q--) {
    if (oppositePool[q] < k) {
      h = oppositePool[q];
      break;
    }
  }
  if (h < 0) return false;
  const leg = side === "resistance" ? highs[k] - lows[h] : highs[h] - lows[k];
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
  side: TrendSide,
  bars: number,
): boolean {
  if (bars <= 0) return true;
  if (k - bars < 0) return false;
  for (let j = k - bars; j < k; j++) {
    if (side === "resistance" ? vals[j] >= vals[k] : vals[j] <= vals[k])
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

/** True when the `bars` bars immediately before i1 all sit on the line's own
 * side of it, within the same Max Pierce tolerance the forward pass uses.
 *
 * WHY IT EXISTS. Seeding validates a candidate over (i1, i]: no bar between the
 * anchors or since may pierce it. Nothing ever looked BEFORE i1, so a pair
 * whose angle has nothing to do with the trend passes as long as its wrong side
 * is in the past. Measured on a live US100 weekly chart, the worst survivor was
 * a resistance line spanning 572 bars on 2 touches whose angle was nowhere near
 * the trend: zero bars of clearance behind its first anchor.
 *
 * It does not merely delete. The freed pairing slots refill, so the detector
 * picks a BETTER FIRST ANCHOR for the same trend: on that chart the 572-bar
 * line became a 2021-anchored line with 151 bars of clearance, ending at the
 * same pivot.
 *
 * A FLAT BAR COUNT, not a fraction of the span. The ratio version rejected a
 * 3-touch line with 14 bars of clearance purely for being long.
 *
 * Runs off the start of the series by REJECTING, the same way isPivotAt and
 * hasSwingReach do: a line anchored fewer than `bars` from bar 0 has not
 * demonstrated the clearance, and letting the short window pass would make the
 * gate weakest exactly where the sample is thinnest.
 *
 * A bar whose ATR has not warmed up cannot be tested, so it counts as
 * surviving, which is what the forward pass does with the same bar.
 *
 * Stops at the first pierce or at `bars`, since the answer is a yes or no: at
 * most `bars` iterations, which is why this is asked BEFORE the forward
 * validation walk (that one is O(span)). Reuses pierces(), so the whole gate
 * inherits its cross-multiplied form. */
export function hasBackClearance(
  line: TrendLine,
  vals: ReadonlyArray<number>,
  atr: ReadonlyArray<number | null>,
  violMult: number,
  bars: number,
): boolean {
  if (bars <= 0) return true;
  if (line.i1 - bars < 0) return false;
  for (let j = line.i1 - 1; j >= line.i1 - bars; j--) {
    const tolJ = atr[j];
    if (tolJ === null) continue;
    if (pierces(line, j, vals[j], violMult * tolJ)) return false;
  }
  return true;
}

export function computeTrendlines(
  dataList: KLineData[],
  cfg: TrendlinesConfig,
): { points: TrendlinesPoint[]; lines: TrendLine[]; atr: number[] } {
  const n = dataList.length;
  const points: TrendlinesPoint[] = Array.from({ length: n }, () => ({}));
  if (n === 0) return { points, lines: [], atr: [] };

  const atr = atrSeries(dataList, TL_ATR_LEN);
  const highs = dataList.map((d) => d.high);
  const lows = dataList.map((d) => d.low);
  const pools: Record<TrendSide, number[]> = { resistance: [], support: [] };
  // EVERY confirmed fractal pivot, including the ones the size and reach gates
  // reject. `pools` holds only survivors, because that is what may seed a line;
  // this holds the turning points themselves, because the leg Min Pivot Size
  // measures runs to the previous turn whether or not that turn was big enough
  // to trade. Using `pools` here DEADLOCKS the indicator: the first pivot has no
  // opposite pivot, so it is rejected, so it never enters the pool, so the next
  // one has no opposite either, forever. Nothing is ever drawn.
  const turns: Record<TrendSide, number[]> = { resistance: [], support: [] };
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
        if (pierces(line, i, extremeOf(line.side, i), cfg.violMult * a))
          line.brokenIdx = i;
      }
    }

    // 2. CONFIRM-BAR work for the pivot at bar k = i - pivotLen.
    const k = i - cfg.pivotLen;
    if (k >= 0 && a !== null) {
      for (const side of SIDES) {
        const vals = side === "resistance" ? highs : lows;
        const want = side === "resistance" ? "high" : "low";
        if (!isPivotAt(vals, k, cfg.pivotLen, cfg.pivotLen, want, true))
          continue;
        turns[side].push(k);
        // The size gate sits HERE, above everything else this bar does, so a
        // rejected bar is not a pivot in any sense: it seeds no line (2b), it
        // counts as no touch (2a), and it never enters the pool, so no LATER
        // pivot can pair with it either. Anything less than that would leave
        // half the detector still treating the wobble as a swing.
        //
        // Consequence worth knowing: touches is rankLines' primary key, so a
        // smaller pool reorders the live cap and moves the prices this
        // indicator reports. That is the point of the setting, not a leak.
        //
        // atr[k], not atr[i]: the swing is measured against volatility where it
        // happened. Those are NOT interchangeable here — atr[i] can be warm
        // while atr[k] is still null, for any k in the pivotLen bars before
        // warm-up ends, so a pivot there is unmeasurable and cannot pass a
        // gate it cannot be tested against.
        //
        // WHOLE BLOCK behind minSwingAtr > 0, including that null check. Off
        // has to mean untouched, and hoisting the check out would drop those
        // few early pivots even at 0 — which it did, and the parity golden
        // caught it: TL_RESISTANCE moved with the gate nominally off.
        if (cfg.minSwingAtr > 0) {
          const atrK = atr[k];
          if (atrK === null) continue;
          const opposite =
            turns[side === "resistance" ? "support" : "resistance"];
          if (
            !isSignificantSwing(
              highs,
              lows,
              opposite,
              k,
              side,
              atrK,
              cfg.minSwingAtr,
            )
          )
            continue;
        }
        // Duration, after size. Two independent gates: a swing can be deep and
        // brief (a spike) or long and shallow (a drift), and each setting
        // rejects one of them.
        if (!hasSwingReach(vals, k, side, cfg.minSwingReach)) continue;
        const pool = pools[side];
        const price = vals[k];

        // 2a. Test the new pivot against every existing line on this side.
        for (const line of lines) {
          if (line.side !== side) continue;
          if (k <= line.i2) continue;
          if (line.brokenIdx !== null) continue;
          const tolA = atr[k];
          if (tolA === null) continue;
          if (
            inTouchBand(
              line,
              k,
              price,
              cfg.violMult * tolA,
              cfg.touchMult * tolA,
            )
          ) {
            line.touches += 1;
            line.touchIdxs.push(k);
            line.lastTouchIdx = k;
          }
        }

        // 2b. Seed candidates against the previous MAX_PAIR_PIVOTS pivots.
        //     `pool.push(k)` happens AFTER this loop, so every i1 read here is
        //     strictly less than i2 = k: that is what keeps span positive, and
        //     both geometry gates silently invert if it ever stops being true.
        const from = Math.max(0, pool.length - cfg.pairPivots);
        for (let q = from; q < pool.length; q++) {
          const i1 = pool[q];
          // NO DUPLICATE CHECK HERE, and none is needed. Every line already in
          // the list was created at an earlier confirm bar, whose k was
          // strictly smaller, so no stored i2 can equal this one; and the pool
          // entries are distinct, so no two candidates of THIS bar share an
          // i1. A line is therefore identified by (side, i1, i2) and cannot be
          // built twice, which trendlines.test.ts asserts directly.
          //
          // There used to be a `lines.some(...)` scan here saying the same
          // thing defensively. It fired zero times and cost 132ms of a 523ms
          // run on 6333 bars: a linear scan of live state, per candidate, per
          // pivot. A guard rail that expensive has to be an assertion in the
          // suite instead, which is where it now lives.
          const cand: TrendLine = {
            side,
            i1,
            p1: vals[i1],
            i2: k,
            p2: price,
            touches: 2,
            touchIdxs: [i1, k],
            lastTouchIdx: k,
            brokenIdx: null,
          };
          // Slope first: it is one comparison, where the validation below walks
          // every bar back to i1. Seed time is the only time it needs asking,
          // since the line never rotates.
          if (cfg.maxSlopeAtr > 0 || cfg.minSlopeAtr > 0) {
            const atrK = atr[k];
            if (atrK === null) continue;
            if (!withinSlope(cand, atrK, cfg.maxSlopeAtr)) continue;
            if (!aboveSlope(cand, atrK, cfg.minSlopeAtr)) continue;
          }
          // Then the backward clearance, still before the forward walk: it is
          // bounded by minBackBars where the walk below is O(span). Seed time
          // is the only time either needs asking, and this one reads ONLY bars
          // before i1, so it is fixed the moment the line is defined and cannot
          // repaint.
          if (!hasBackClearance(cand, vals, atr, cfg.violMult, cfg.minBackBars))
            continue;
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
          // The pool is in strictly increasing bar order and i1 IS pool[q], so
          // the window (i1, k) starts at q + 1 and ends at the first entry
          // that reaches k. Walking the whole pool and skipping meant a scan
          // that grew for the length of the series, on every candidate. Same
          // entries, same order, same arithmetic.
          for (let q2 = q + 1; q2 < pool.length; q2++) {
            const pj = pool[q2];
            if (pj >= k) break;
            const tolP = atr[pj];
            if (tolP === null) continue;
            if (
              inTouchBand(
                cand,
                pj,
                vals[pj],
                cfg.violMult * tolP,
                cfg.touchMult * tolP,
              )
            ) {
              cand.touches += 1;
              cand.touchIdxs.push(pj);
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
      // Rebuilt only when something actually died: this runs at every confirm
      // bar and the list is usually untouched, so the common case is one pass
      // and no allocation instead of one pass and a new array.
      if (lines.some((l) => !isLive(l, i, cfg)))
        lines = lines.filter((l) => isLive(l, i, cfg));
      const cap = MAX_LIVE_MULT * cfg.maxLines;
      for (const side of SIDES) {
        // CEILING-FAILED LINES SORT LAST, ahead of every rankLines key. They
        // can never re-qualify (touches and span only grow), so letting them
        // hold slots evicts lines that CAN still emit — and rankLines would
        // hand them the front of the queue, since its first two keys are the
        // very quantities the ceilings reject. They are kept rather than
        // dropped so the pierce and touch passes still see them.
        const mine = lines.filter((l) => l.side === side);
        // Under the cap there is nothing to drop, so the sort cannot change
        // which lines survive and is pure cost. It is the sort that dominates
        // this block, and on most bars this is the branch taken.
        if (mine.length <= cap) continue;
        mine.sort(
          (a, b) =>
            Number(overCeilings(a, cfg)) - Number(overCeilings(b, cfg)) ||
            rankLines(a, b),
        );
        const keep = new Set(mine.slice(0, cap));
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
      // ONE PASS, NO SORT, and it is the same choice the sort used to express.
      // This used to build a rank-sorted array of the majors and walk it
      // taking the first STRICTLY nearer line, so the winner was the
      // rank-minimum among the distance-minimums; tracking that pair directly
      // says the same thing without an array and a sort on every bar of the
      // series. Ties resolve identically: rankLines is a total order, and a
      // candidate that ranks equal does not displace the one already held,
      // which is what a stable sort plus first-wins gave.
      //
      // The side test applies to UNBROKEN lines ONLY, and the two cases must
      // not be merged. An unbroken support sits at or below the close and an
      // unbroken resistance above it — that is what "nearest support" means.
      // A BROKEN line gets NO side test: once price has pierced a line it can
      // sit on EITHER side of the close during the hold window (a wick break
      // snaps back the next bar, leaving the broken support below the close
      // again), and the hold window exists precisely to keep that level
      // visible for a retest. Requiring broken support to sit above the close
      // silently blanks tl_broken_support for whole windows.
      let uLine: TrendLine | null = null;
      let uVal = 0;
      let uDist = 0;
      let bLine: TrendLine | null = null;
      let bVal = 0;
      let bDist = 0;
      for (const line of lines) {
        if (line.side !== side) continue;
        if (!isLive(line, i, cfg) || !isMajor(line, i, cfg)) continue;
        const v = projectAt(line, i);
        const d = Math.abs(v - close);
        if (line.brokenIdx !== null) {
          if (bLine === null || d < bDist || (d === bDist && rankLines(line, bLine) < 0)) {
            bLine = line;
            bVal = v;
            bDist = d;
          }
          continue;
        }
        // CROSS-MULTIPLIED, exactly as pierces does, because this is a
        // boolean that gates whether an output fires at all. With
        // s = i2 - i1 an exact positive integer,
        //   projectAt(line, i) <= close
        // is the same inequality as
        //   (p2 - p1) * (i - i1) <= (close - p1) * s
        // with the quotient's rounding removed; multiplying through by a
        // positive integer preserves the direction.
        const s = line.i2 - line.i1;
        const below =
          (line.p2 - line.p1) * (i - line.i1) <= (close - line.p1) * s;
        if (below !== (side === "support")) continue;
        if (uLine === null || d < uDist || (d === uDist && rankLines(line, uLine) < 0)) {
          uLine = line;
          uVal = v;
          uDist = d;
        }
      }
      if (side === "support") {
        if (uLine !== null) point.tl_support = uVal;
        if (bLine !== null) point.tl_broken_support = bVal;
      } else {
        if (uLine !== null) point.tl_resistance = uVal;
        if (bLine !== null) point.tl_broken_resistance = bVal;
      }
    }
    points[i] = point;
  }

  return { points, lines, atr };
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
export interface TrendlinesMtf {
  timeframe: string | null;
  htfStarts?: number[]; // HTF bar open timestamps (ms)
  htfMs?: number; // HTF bar duration (ms)
  htfSupport?: Array<number | undefined>; // per-HTF-bar operand values
  htfResistance?: Array<number | undefined>;
  htfBrokenSupport?: Array<number | undefined>;
  htfBrokenResistance?: Array<number | undefined>;
  htfLines?: TrendLine[]; // live lines at the last closed HTF bar
  /** ATR(14) on the HTF bars. The merge and near-price tolerances are
   * ATR-denominated, so the chart's own ATR would scale both by the ratio
   * between the timeframes. */
  htfAtr?: number;
}

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
  /** Merge near-duplicate lines before the maxLines budget is applied, so a
   * slot spent on a line's own shadow goes to a genuinely different line
   * instead. Defaults to ON: a pivot seeds a FAN (it pairs with every later
   * pivot that yields an unpierced line), and the members of a fan that share
   * an anchor differ by a few points over the whole pane. See selectDrawnLines
   * for what "near-duplicate" means and what is exempt. Render-only, like
   * everything else here: merging never changes an emitted value, and the
   * merged-away line stays live and can emit. */
  dedupe?: boolean;
  /** How far apart two lines through the same pivot may project at the last bar
   * and still merge, in ATR(14). Absent takes TL_DEDUPE_ATR.
   *
   * A FIELD, after two rounds of arguing it should stay a constant. What
   * settled it was the two charts disagreeing: the DXY monthly fixture wants a
   * wider tolerance to collapse its fans, and a live US100 daily pane wants a
   * narrower one, because there every merge is between lines that begin months
   * apart and converge on one later pivot rather than a fan off a shared
   * origin. One number cannot be right for both, which is the case a setting
   * exists for. */
  dedupeAtr?: number;
  /** Draw only the lines projecting within TL_NEAR_PRICE_ATR of the close at
   * the last bar (plus the nearest on each side, whatever its distance, and
   * the lines an operand reads or a pin holds). Defaults to ON.
   *
   * The complaint this answers: a pivot seeds lines in every direction, and the
   * ones that missed run away from price for as long as maxProjBars keeps them
   * alive, filling the pane with geometry that has nothing to do with where
   * price is. Render-only like the rest of this block: a line hidden here still
   * emits, and selectDrawnLines draws it anyway if it does. */
  nearPrice?: boolean;
  /** Drop the broken lines from the chart entirely. Defaults to OFF, because a
   * broken line is where a retest happens and the break-hold window exists to
   * keep it visible for exactly that.
   *
   * NO EXEMPTION for the lines tl_broken_support and tl_broken_resistance are
   * reading, unlike merging and the near-price cut. Those two hide a line as a
   * side effect of tidying, so they must not hide one a rule is auditing; this
   * option IS the request to hide them, and sparing the emitting ones would
   * leave broken lines on a pane that was asked to have none. The cost is real
   * and belongs to whoever ticks it: the broken outputs keep emitting with
   * nothing drawn at them. */
  hideBroken?: boolean;
  /** Lines the user pinned open by clicking their end handle, as lineKey()
   * strings. A pinned line ignores `extend` and runs to the right edge of the
   * pane, re-measured every render so it stays "indefinite" through scroll and
   * zoom instead of baking in a bar count. */
  pinned?: string[];
  /** Multi-timeframe: lines and operand series detected on a higher timeframe
   * and aligned onto the chart bars inside calc (no lookahead). THE ONE KEY ON
   * THIS INTERFACE THAT CALC READS: everything else here is render-only, and a
   * timeframe is not a drawing choice but a statement of which candles the
   * indicator runs on, which is how the Python twin treats it too. */
  mtf?: TrendlinesMtf;
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
  return `${line.side}:${t1}:${t2}`;
}

/** calc result row. The full line list rides on the LAST row only (draw reads
 * it there), exactly as SR_LEVELS carries its levels. */
export type TrendlinesCalcPoint = TrendlinesPoint & {
  lines?: TrendLine[];
  atr?: number;
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

/** How far from the close a line may project at the last bar and still be
 * drawn, in ATR(14), when the near-price filter is on.
 *
 * A CONSTANT, exactly like TL_DEDUPE_ATR and for the same reason: "near price"
 * is a yes-or-no a user should not have to tune, and a second numeric field
 * that quietly empties the pane when set wrong is worse than a fixed answer.
 * Five ATR is roughly where a level stops being reachable inside the horizon a
 * trader is looking at.
 *
 * Measured on a US100 daily chart at stock defaults, 20 drawn lines projected
 * between 0.01 and 31 ATR from the close; five keeps the four a human would
 * point at. */
export const TL_NEAR_PRICE_ATR = 5;

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
export function dedupeTolerance(
  atr: number | undefined,
  on: boolean,
  /** ATR multiple from the panel. Anything not a finite number >= 0 (an older
   * chart with no such key, a hand-written payload) falls back to the default;
   * an explicit 0 is honoured and turns merging off, the same as the switch. */
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

/** Drops the near-duplicates from an already proximity-sorted side, keeping the
 * first of each group.
 *
 * TWO LINES ARE ONE WHEN THEY RUN THROUGH THE SAME PIVOT and project within
 * `tol` of each other at `atIdx`. Both halves are load-bearing:
 *
 * The shared pivot is what makes this a FAN test rather than a "these two
 * levels look similar" test. A pivot is not consumed by the line that first
 * used it: the detector pairs it with every other pivot that yields an
 * unpierced line, so one strong swing emits a whole sheaf of lines through the
 * same point. That sheaf is the clutter. Two levels that merely happen to sit
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
 * PINNED line either: its handle is the only control that can release the pin.
 *
 * Sides never merge into each other — support and resistance are read as
 * opposites even where they cross, and this runs per side anyway. */
function sharesPivot(a: TrendLine, b: TrendLine): boolean {
  // Bar AND price, though in practice the bar decides it: an anchor's price is
  // that bar's high or low, so the same bar on the same side is the same
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
  wantUnbroken: number | undefined,
  wantBroken: number | undefined,
): DrawEntry[] {
  const { tol, keep } = dedupe;
  if (!(tol > 0)) return entries;
  const out: DrawEntry[] = [];
  for (const e of entries) {
    const want = e.line.brokenIdx !== null ? wantBroken : wantUnbroken;
    const exempt = (want !== undefined && e.proj === want) || keep.has(e.line);
    const twin =
      !exempt &&
      out.some(
        (k) => sharesPivot(k.line, e.line) && Math.abs(k.proj - e.proj) <= tol,
      );
    if (!twin) out.push(e);
  }
  return out;
}

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
  dedupe: TrendlineDedupe | null,
  /** Price distance beyond which a line is too far from the close to draw.
   * 0 turns the filter off, which is also what an unwarmed ATR gives.
   *
   * Defaults to off, unlike `emitted`, which is required so the draw path
   * cannot quietly stop passing it. The equivalent guard here is a draw test
   * rather than an arity: the many selection tests below are about proximity
   * ORDER and budget, and threading a tolerance through each of them would
   * bury what they check. */
  nearTol = 0,
): TrendLine[] {
  const out: TrendLine[] = [];
  for (const side of SIDES) {
    const wantUnbroken =
      side === "support" ? emitted.tl_support : emitted.tl_resistance;
    const wantBroken =
      side === "support"
        ? emitted.tl_broken_support
        : emitted.tl_broken_resistance;
    const mine = lines
      .filter((l) => l.side === side)
      .map((l) => {
        const proj = projectAt(l, atIdx);
        return { line: l, proj, dist: Math.abs(proj - close) };
      })
      .sort((a, b) =>
        a.dist !== b.dist ? a.dist - b.dist : rankLines(a.line, b.line),
      );
    // Near-duplicates come out BEFORE the budget, never after. Skipping them
    // inside the loop below would leave the index counting the lines it
    // skipped, so no slot would be freed and the whole feature would be a
    // no-op that still passed a "the twin is gone" test.
    const kept = dedupe
      ? dropDuplicates(mine, dedupe, wantUnbroken, wantBroken)
      : mine;
    // A DISTANCE cut, which maxLines is not: maxLines keeps a fixed COUNT per
    // side however far away they all are, so a chart whose lines have all run
    // off into the distance still draws its budget of them. This drops the ones
    // that are simply nowhere near price.
    //
    // Runs after dedupe and before the budget, in the same slot and for the
    // same reason: filtering inside the loop below would leave the index
    // counting lines it skipped, so no slot would be freed.
    //
    // ALWAYS KEEPS THE NEAREST on each side (idx 0 of a distance-sorted list),
    // so the pane can never go blank while the indicator is on. "The lines
    // closest to price" with nothing at all in it reads as a broken indicator,
    // not as an answer.
    //
    // Emitting and pinned lines are exempt, exactly as they are from merging:
    // the chart is the only surface on which an operand can be audited, and a
    // pin's own handle is the only control that releases it.
    const near =
      nearTol > 0
        ? kept.filter((e, idx) => {
            if (idx === 0 || e.dist <= nearTol) return true;
            if (dedupe?.keep.has(e.line)) return true;
            const want = e.line.brokenIdx !== null ? wantBroken : wantUnbroken;
            return want !== undefined && e.proj === want;
          })
        : kept;
    // Proximity order throughout: the budgeted head, then any emitting line
    // that fell outside it, appended in the same order. Deterministic either
    // way, and the ×N tags keep pairing with the segments they label.
    near.forEach((e, idx) => {
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
 * (TL_HANDLE_HIT), because a 3px mark is not a mouse target. */
export const TL_HANDLE_RADIUS = 3;
/** The filled dot at a break, and the hollow ring at a touch. Different sizes
 * as well as different fills, because the two say opposite things about the
 * same line and are read at a glance: a touch is price respecting the line, a
 * break is price ending it. */
export const TL_BREAK_RADIUS = 2.5;
export const TL_TOUCH_RADIUS = 2;
export const TL_HANDLE_HIT = 8;
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
  const jEnd = broken
    ? Math.max(line.lastTouchIdx, line.brokenIdx as number)
    : line.lastTouchIdx;
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
    return {
      jLeft,
      jRight: meetsAt(line, others, jEnd, horizon) ?? Math.max(jEnd, lastIdx),
    };
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
 * Multi-timeframe calc: the four operand series were computed on the HTF bars
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
  const at = (v?: Array<number | undefined>): Array<number | undefined> =>
    v ? alignHtfToChart(ts, htfBars, v, htfMs, true) : [];
  const sup = at(mtf.htfSupport);
  const res = at(mtf.htfResistance);
  const bSup = at(mtf.htfBrokenSupport);
  const bRes = at(mtf.htfBrokenResistance);
  const out: TrendlinesCalcPoint[] = ts.map((_, i) => ({
    tl_support: sup[i],
    tl_resistance: res[i],
    tl_broken_support: bSup[i],
    tl_broken_resistance: bRes[i],
  }));
  if (!out.length) return out;
  // The HTF bar the LAST chart bar reads, by the same rule alignHtfToChart
  // used above. The draw path measures every line at it, and selectDrawnLines
  // matches an emitted value with === against projectAt at that index, so this
  // must be the index those values came from and not simply the newest bar.
  let j = -1;
  const t = ts[ts.length - 1];
  while (j + 1 < starts.length && starts[j + 1] + htfMs <= t) j++;
  out[out.length - 1] = {
    ...out[out.length - 1],
    lines: mtf.htfLines ?? [],
    atr: mtf.htfAtr,
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

/** Fractional index of time `t` in a sorted array of bar-open timestamps,
 * extrapolating linearly off both ends at `barMs` (so a ray projecting past the
 * newest bar, or an anchor older than the loaded history, still lands
 * somewhere real rather than being clamped onto the edge — clamping a SLOPED
 * line would visibly rotate it). */
function idxAtTime(starts: number[], t: number, barMs: number): number {
  const n = starts.length;
  if (!n) return 0;
  if (t <= starts[0]) return barMs > 0 ? (t - starts[0]) / barMs : 0;
  if (t >= starts[n - 1])
    return n - 1 + (barMs > 0 ? (t - starts[n - 1]) / barMs : 0);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = starts[hi] - starts[lo];
  return span > 0 ? lo + (t - starts[lo]) / span : lo;
}

/** Time at a fractional index, the inverse of {@link idxAtTime}. */
function timeAtIdx(starts: number[], j: number, barMs: number): number {
  const n = starts.length;
  if (!n) return 0;
  if (j <= 0) return starts[0] + j * barMs;
  if (j >= n - 1) return starts[n - 1] + (j - (n - 1)) * barMs;
  const k = Math.floor(j);
  return starts[k] + (j - k) * (starts[k + 1] - starts[k]);
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
  const chartStarts = dataList.map((k) => k.timestamp);
  const barMs = chartBarMs(dataList) || htfMs;
  return {
    toChart: (j) => idxAtTime(chartStarts, timeAtIdx(starts, j, htfMs), barMs),
    toLine: (j) => idxAtTime(starts, timeAtIdx(chartStarts, j, barMs), htfMs),
  };
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
  const lastIdx = mtf ? (last.lineIdx ?? -1) : dataList.length - 1;
  // Under a pin, no HTF bar has closed inside the loaded window yet: there is
  // nothing to measure the lines at, so draw none rather than measure at -1.
  if (lastIdx < 0) {
    setTrendlineHandles(chart, indicator.paneId, indicator.name, null);
    return true;
  }
  // The CHART's newest close either way: it is the current price, and the price
  // is the price whatever timeframe the lines were found on.
  const lastClose = dataList[dataList.length - 1].close;
  const xAt = (j: number) => xAxis.convertToPixel(toChart(j));
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
  // Broken lines go before anything else looks at the list, so the slots they
  // were holding go to live ones rather than being spent and then skipped.
  const hideBroken = ext?.hideBroken ?? false;
  const eligible = last.lines.filter(
    (l) =>
      isMajor(l, lastIdx, cfg) && !(hideBroken && l.brokenIdx !== null),
  );
  if (!eligible.length) {
    setTrendlineHandles(chart, indicator.paneId, indicator.name, null);
    return true;
  }
  // Resolved to line objects BEFORE selection, because the dedup pass has to
  // know which lines are pinned in order to spare them.
  const pinnedLines = new Set(
    pins.size ? eligible.filter((l) => pins.has(lineKey(l, dataList, starts))) : [],
  );
  // `last` carries BOTH the line list and the last bar's emitted values, so the
  // union that keeps every operand's line on screen needs no extra plumbing.
  const dedupeTol = dedupeTolerance(
    last.atr,
    ext?.dedupe ?? true,
    ext?.dedupeAtr,
  );
  // Same shape as the dedup tolerance, and 0 on the same unwarmed-ATR path:
  // with no ATR there is no scale to call anything near, and the filter is off
  // rather than arbitrary.
  const nearTol = Number.isFinite(last.atr)
    ? (ext?.nearPrice ?? true)
      ? (last.atr as number) * TL_NEAR_PRICE_ATR
      : 0
    : 0;
  const drawn = selectDrawnLines(
    eligible,
    lastIdx,
    lastClose,
    cfg.maxLines,
    last,
    {
      tol: dedupeTol,
      keep: pinnedLines,
    },
    nearTol,
  );
  // bounding.width spans the whole pane INCLUDING the y-axis strip on the
  // right; the ×N tags must stop before it or the axis overlay hides them.
  const axisWidth = chart.getSize(indicator.paneId, "yAxis")?.width ?? 0;
  const tagRight = bounding.width - axisWidth - 4;
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
  for (const line of drawn) {
    const broken = line.brokenIdx !== null;
    const isPinned = pins.has(lineKey(line, dataList, starts));
    // The line's end under the MODE alone. The handle and the ×N tag ride here
    // whether or not the line is pinned: a pinned line runs to the pane edge,
    // and a handle that travelled with it would leave nothing to click to undo
    // the pin (and would sit under the y-axis besides).
    const natural = lineExtent(line, mode, cfg, drawn, lastIdx, null);
    const { jLeft, jRight } = isPinned
      ? lineExtent(line, mode, cfg, drawn, lastIdx, edgeIdx)
      : natural;
    const x0 = xAt(jLeft);
    const x1 = xAt(jRight);
    if (x1 <= 0 || x0 >= bounding.width) continue;
    const y0 = yAxis.convertToPixel(projectAt(line, jLeft));
    const y1 = yAxis.convertToPixel(projectAt(line, jRight));
    // Marks (the break dot, the touch rings) ride the SEGMENT AS DRAWN rather
    // than projecting themselves: under a timeframe pin the index map is only
    // piecewise linear (a weekend compresses on the chart but not in time), so
    // a mark placed by its own projection can sit a bar off the line it
    // belongs to. Interpolating at its own x is the idiom the ×N tag already
    // uses below, and on the chart timeframe it lands on the same pixel.
    const onSegment = (x: number): number =>
      x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    ctx.strokeStyle =
      line.side === "support" ? TL_SUPPORT_COLOR : TL_RESISTANCE_COLOR;
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
      const xB = xAt(jBreak);
      const yB = onSegment(xB);
      if (xB >= 0 && xB <= tagRight && yB >= 0 && yB <= bounding.height) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.arc(xB, yB, TL_BREAK_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.45;
      }
    }
    // The touches themselves, one hollow ring each, so the ×N tag can be read
    // back against the bars that earned it: which swings agreed on this line is
    // the question the count only answers in aggregate.
    //
    // ON THE LINE, not at the candle's own extreme, exactly as the break dot
    // is. A touch is a bar whose high or low came within tolerance of the line,
    // so the two differ by up to that tolerance; drawing on the line keeps the
    // marks reading as part of it rather than as a scatter beside it. The
    // anchors are included, so the ring count always equals the tag.
    //
    // Every touch is inside the drawn span by construction (i1 <= idx <=
    // lastTouchIdx <= jRight), so only the pane's own edges need guarding, the
    // same both-axes clamp the break dot uses: this canvas is shared with the
    // other panes and an unclamped y bleeds into them.
    ctx.lineWidth = 1;
    for (const idx of line.touchIdxs) {
      const xT = xAt(idx);
      const yT = onSegment(xT);
      if (xT < 0 || xT > tagRight || yT < 0 || yT > bounding.height) continue;
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
    // The pin handle, on the line's right end wherever that end landed. Hollow
    // when free, filled when pinned, so the toggle's state is readable without
    // hovering. Clamped inside the pane like the tag, and its y interpolated at
    // the clamped x for the same reason the tag's is.
    const xNat = xAt(natural.jRight);
    const yNat = yAxis.convertToPixel(projectAt(line, natural.jRight));
    const xHandle = Math.min(xNat, tagRight);
    const yHandle =
      xNat === x0 ? yNat : y0 + ((yNat - y0) * (xHandle - x0)) / (xNat - x0);
    // The ring sits just BEYOND the end, tangent to it, rather than centred on
    // it. Centred, a hollow ring has the line running through its middle, which
    // reads as a bead threaded on the line instead of a cap at its tip. Pushed
    // out by its own radius (plus half the 1px stroke) along the line's own
    // direction, it touches the tip and nothing more. A pinned line runs on past
    // it, so the offset dot still lands on the line there.
    const [xRing, yRing] = ringCentre(x0, y0, xHandle, yHandle);
    if (stops && xRing >= 0 && yRing >= 0 && yRing <= bounding.height) {
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
      ctx.globalAlpha = broken ? 0.45 : 1;
    }
    const label = `×${line.touches}`;
    const xTag = Math.min(
      xRing + TL_HANDLE_RADIUS + 5,
      tagRight - ctx.measureText(label).width,
    );
    const yTag =
      xNat === x0 ? yNat : y0 + ((yNat - y0) * (xTag - x0)) / (xNat - x0);
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
    TRENDLINES_DEFAULTS.minSwingAtr,
    TRENDLINES_DEFAULTS.minSwingReach,
    TRENDLINES_DEFAULTS.pairPivots,
    TRENDLINES_DEFAULTS.maxTouches,
    TRENDLINES_DEFAULTS.maxSpanBars,
    TRENDLINES_DEFAULTS.maxSlopeAtr,
    TRENDLINES_DEFAULTS.minSlopeAtr,
    TRENDLINES_DEFAULTS.minBackBars,
  ],
  // Empty figures + a draw that returns true (isCover) is the established way
  // to run calc but paint nothing of klinecharts' own — the mechanism
  // sessions.ts and proximityHeatmap.ts already use.
  figures: [],
  // READS calcParams AND extendData.mtf, NOTHING ELSE. Every other key on
  // extendData is a drawing option, and pulling one in here would make a chart
  // setting change an emitted value. `mtf` is not one of them: it says which
  // CANDLES the indicator runs on, so it belongs to the calculation on both
  // surfaces (parse_trendlines_config reads the same key), and the detector
  // itself still never sees it — the higher timeframe is computed outside, by
  // the coordinator, and only aligned here.
  calc: (dataList: KLineData[], ind: Indicator) => {
    const mtf = (ind.extendData as TrendlinesExtend | undefined)?.mtf;
    if (mtf?.timeframe && mtf.htfStarts?.length && mtf.htfMs)
      return alignMtfTrendlines(dataList, mtf);
    const { points, lines, atr } = computeTrendlines(
      dataList,
      parseTrendlinesConfig(ind.calcParams),
    );
    const out = points.map((p) => ({ ...p })) as TrendlinesCalcPoint[];
    if (out.length)
      out[out.length - 1] = {
        ...out[out.length - 1],
        lines,
        atr: atr[atr.length - 1],
        lineIdx: out.length - 1,
      };
    return out;
  },
  draw: (params) =>
    drawTrendlines(
      params as IndicatorDrawParams<TrendlinesCalcPoint, unknown, unknown>,
    ),
};

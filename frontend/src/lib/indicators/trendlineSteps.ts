// Steps for a trendline pinned to a COARSER timeframe, drawn on a finer chart.
//
// The line is straight in HTF bars and has one value per HTF bar
// (projectAt(line, j)), so on a finer chart it is drawn as one horizontal step
// across every chart candle of HTF bar j, rising at the next bar. That gives
// the same price at the same moment on every chart timeframe, which a straight
// stroke in chart bars cannot: HTF bars do not hold a constant number of chart
// candles. See docs/superpowers/specs/2026-11-11-pinned-trendline-steps-design.md.
//
// Positions here are CHART positions in candle-edge units: candle c spans
// [c - 0.5, c + 0.5], so a step's ends sit on candle edges and the caller
// turns a position into a pixel with the x axis (linear in the index).
//
// Chart-free and pure, apart from the per-frame memo in stepMapFor.

import type { KLineData } from "klinecharts";
import { htfBarEndMs } from "../mtfForming";
import type { StepPiece } from "./trendlineMarks";
import type { TrendlinesMtf } from "./trendlines";

export interface HtfStepMap {
  readonly nChart: number;
  /** Index of the forming HTF bar: starts.length. */
  readonly forming: number;
  /** Chart candles per HTF bar (median of up to 5 recent fully loaded bars), >= 1. */
  readonly perBar: number;
  /** HTF bar of chart candle c, 0 <= c < nChart. */
  barOf(c: number): number;
  /** Chart-position span of HTF bar j in candle-edge units. Projected by
   * perBar off either end of the data. Null for a bar inside loaded history
   * that holds no candle. */
  span(j: number): { from: number; to: number } | null;
  /** Chart position of fractional HTF index j: span(floor j) interpolated. */
  posOf(j: number): number;
  /** Fractional HTF index at chart position pos (inverse of posOf). */
  jAt(pos: number): number;
}

/** How many of the newest fully loaded HTF bars the perBar estimate reads. */
const PER_BAR_SAMPLE = 5;

/**
 * The candle to HTF bar map, from the data:
 *  - history: candle c is in bar j when starts[j] <= t_c < starts[j + 1], by
 *    its OPEN time (a candle straddling a boundary belongs to the bar it
 *    opens in);
 *  - candles at or after the last start's close belong to the forming bar,
 *    which runs one HTF period (htfBarEndMs) from its first candle; a candle
 *    past that opens the next bar (a stale stash), by TIME, not by counting
 *    perBar candles (a forming month can hold more sessions than the median);
 *  - candles before starts[0] count back from bar -1 the same way;
 *  - bars beyond either end are projected perBar candles wide.
 */
export function buildHtfStepMap(
  timeAt: (i: number) => number,
  nChart: number,
  starts: readonly number[],
  htfMs: number,
  timeframe?: string,
): HtfStepMap {
  const nS = starts.length;
  const lastEnd = nS ? htfBarEndMs(starts[nS - 1], htfMs, timeframe) : -Infinity;
  const bar = new Array<number>(nChart);
  // First pass: history bars; mark before (-Infinity) and after (+Infinity).
  let before = 0;
  let firstAfter = nChart;
  let j = 0;
  for (let c = 0; c < nChart; c++) {
    const t = timeAt(c);
    if (!nS || t >= lastEnd) {
      bar[c] = Infinity;
      if (firstAfter === nChart) firstAfter = c;
      continue;
    }
    if (t < starts[0]) {
      bar[c] = -Infinity;
      before++;
      continue;
    }
    while (j + 1 < nS && starts[j + 1] <= t) j++;
    bar[c] = j;
  }
  // Candle runs per history bar, for the perBar estimate.
  const first = new Map<number, number>();
  const count = new Map<number, number>();
  for (let c = 0; c < nChart; c++) {
    const b = bar[c];
    if (!Number.isFinite(b)) continue;
    if (!first.has(b)) first.set(b, c);
    count.set(b, (count.get(b) ?? 0) + 1);
  }
  const sample: number[] = [];
  for (let k = nS - 1; k >= 0 && sample.length < PER_BAR_SAMPLE; k--) {
    const f = first.get(k);
    // A bar whose first candle is the first loaded one may be cut short.
    if (f === undefined || f === 0) continue;
    sample.push(count.get(k)!);
  }
  let perBar: number;
  if (sample.length) {
    sample.sort((a, b) => a - b);
    perBar = sample[sample.length >> 1];
  } else {
    perBar = Math.max(1, Math.round(htfMs / medianGap(timeAt, nChart, htfMs)));
  }
  for (let c = 0; c < before; c++) bar[c] = -1 - Math.floor((before - 1 - c) / perBar);
  let g = nS - 1;
  let gEnd = -Infinity;
  for (let c = firstAfter; c < nChart; c++) {
    const t = timeAt(c);
    if (t >= gEnd) {
      g++;
      gEnd = htfBarEndMs(t, htfMs, timeframe);
    }
    bar[c] = g;
  }

  const firstBar = nChart ? bar[0] : nS;
  const lastBar = nChart ? bar[nChart - 1] : nS - 1;
  // Leftmost loaded candle edge of each bar in range, by binary search on the
  // non-decreasing bar array.
  const lowerBound = (want: number): number => {
    let lo = 0;
    let hi = nChart;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bar[mid] < want) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // A bar the data holds: its candles. The newest candle's bar, when it is
  // the forming one (or later), runs on at least perBar candles into the
  // future, since it has not finished.
  const loaded = (jj: number): { from: number; to: number } | null => {
    const a = lowerBound(jj);
    if (a >= nChart || bar[a] !== jj) return null;
    const b = lowerBound(jj + 1);
    const to = jj === lastBar && jj >= nS ? Math.max(b, a + perBar) : b;
    return { from: a - 0.5, to: to - 0.5 };
  };
  // Where the projected future starts: the end of the newest candle's bar.
  const lastTo = nChart ? loaded(lastBar)!.to : -0.5;
  const span = (jj: number): { from: number; to: number } | null => {
    if (jj > lastBar) {
      const from = lastTo + (jj - lastBar - 1) * perBar;
      return { from, to: from + perBar };
    }
    if (jj < firstBar) {
      const to = -0.5 - (firstBar - 1 - jj) * perBar;
      return { from: to - perBar, to };
    }
    return loaded(jj);
  };
  const nonNullFrom = (k: number): number => {
    for (let jj = k; jj < nS; jj++) {
      const s = span(jj);
      if (s) return s.from;
    }
    return lastTo;
  };
  return {
    nChart,
    forming: nS,
    perBar,
    barOf: (c) => bar[c],
    span,
    posOf: (jj) => {
      const k = Math.floor(jj);
      const s = span(k);
      if (!s) return nonNullFrom(k + 1);
      return s.from + (jj - k) * (s.to - s.from);
    },
    jAt: (pos) => {
      if (pos >= lastTo) return lastBar + 1 + (pos - lastTo) / perBar;
      if (pos < -0.5 || !nChart) return firstBar - (-0.5 - pos) / perBar;
      const c = Math.min(nChart - 1, Math.max(0, Math.round(pos)));
      const k = bar[c];
      const s = span(k)!;
      return k + (pos - s.from) / (s.to - s.from);
    },
  };
}

function medianGap(timeAt: (i: number) => number, n: number, fallback: number): number {
  const gaps: number[] = [];
  for (let i = Math.max(1, n - 20); i < n; i++) gaps.push(timeAt(i) - timeAt(i - 1));
  if (!gaps.length) return fallback;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] || fallback;
}

// Per frame: every line of an instance, its alert lines and its hit targets
// read one map, so it is built once per data list and pin.
const MAPS = new WeakMap<object, { n: number; newest: number; starts: readonly number[]; map: HtfStepMap }>();

/** The step map for a coarser pin, memoised on the data list (same length,
 * newest timestamp and starts array). Null without a usable pin. */
export function stepMapFor(dataList: readonly KLineData[], mtf: TrendlinesMtf): HtfStepMap | null {
  const starts = mtf.htfStarts;
  const htfMs = mtf.htfMs ?? 0;
  if (!starts?.length || !(htfMs > 0) || !dataList.length) return null;
  const n = dataList.length;
  const newest = dataList[n - 1].timestamp;
  const hit = MAPS.get(dataList);
  if (hit && hit.n === n && hit.newest === newest && hit.starts === starts) return hit.map;
  const map = buildHtfStepMap((i) => dataList[i].timestamp, n, starts, htfMs, mtf.timeframe ?? undefined);
  MAPS.set(dataList, { n, newest, starts, map });
  return map;
}

export type { StepPiece } from "./trendlineMarks";
export { distToSteps } from "./trendlineMarks";

/**
 * The step pieces of a line from HTF bar floor(jFrom) to jTo: an integer jTo
 * takes the whole of bar jTo, a fractional one ends at posOf(jTo). Only bars
 * meeting [posMin, posMax] are built; runs of pieces narrower than a pixel
 * are merged so a zoomed-out chart does not stroke thousands of them.
 */
export function buildSteps(
  map: HtfStepMap,
  valueAt: (j: number) => number,
  jFrom: number,
  jTo: number,
  opts: {
    xOf: (pos: number) => number;
    yOf: (price: number) => number;
    posMin: number;
    posMax: number;
    endPos?: number;
  },
): StepPiece[] {
  const jStart = Math.floor(jFrom);
  const lastBar = Number.isInteger(jTo) ? jTo : Math.floor(jTo);
  const lineEnd = Number.isInteger(jTo) ? (map.span(jTo)?.to ?? map.posOf(jTo + 1)) : map.posOf(jTo);
  const end = Math.min(lineEnd, opts.endPos ?? Infinity);
  const jMin = Math.max(jStart, Math.floor(map.jAt(opts.posMin)));
  const jMax = Math.min(lastBar, Math.floor(map.jAt(Math.min(opts.posMax, end))));
  const out: StepPiece[] = [];
  let run: StepPiece | null = null;
  let lastMerged = false;
  for (let j = jMin; j <= jMax; j++) {
    const s = map.span(j);
    if (!s) continue;
    const to = Math.min(s.to, end);
    if (!(to > s.from)) continue;
    const y = opts.yOf(valueAt(j));
    const p: StepPiece = { x0: opts.xOf(s.from), x1: opts.xOf(to), y0: y, y1: y };
    if (p.x1 - p.x0 >= 1) {
      if (run) {
        out.push(run);
        run = null;
      }
      out.push(p);
      lastMerged = false;
      continue;
    }
    run = run ? { x0: run.x0, x1: p.x1, y0: run.y0, y1: p.y1 } : p;
    if (run.x1 - run.x0 >= 1) {
      out.push(run);
      run = null;
      lastMerged = true;
    }
  }
  if (run) {
    const prev = out[out.length - 1];
    if (prev && lastMerged) {
      prev.x1 = run.x1;
      prev.y1 = run.y1;
    } else out.push(run);
  }
  return out;
}

/** Where a line's steps end. A line that reaches the last closed HTF bar
 * runs on through the forming bar and stops at the newest candle; any other
 * end is unchanged. */
export function stepRange(
  jRight: number,
  lastIdx: number,
  map: HtfStepMap,
): { jTo: number; endPos?: number } {
  if (Number.isInteger(jRight) && jRight === lastIdx)
    // Through the newest candle's bar: the forming one, or a later one when
    // a stale stash left the newest candles past it.
    return { jTo: Math.max(map.forming, map.nChart ? map.barOf(map.nChart - 1) : map.forming), endPos: map.nChart - 1 + 0.5 };
  return { jTo: jRight };
}

/** Stroke a staircase as ONE path, risers included. The caller sets the
 * style and calls ctx.stroke(). */
export function strokeSteps(ctx: CanvasRenderingContext2D, pieces: readonly StepPiece[]): void {
  if (!pieces.length) return;
  ctx.beginPath();
  ctx.moveTo(pieces[0].x0, pieces[0].y0);
  for (const p of pieces) {
    ctx.lineTo(p.x0, p.y0);
    ctx.lineTo(p.x1, p.y1);
  }
}

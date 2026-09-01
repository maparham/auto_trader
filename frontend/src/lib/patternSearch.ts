// Pattern search: the client for POST /api/patterns/search plus the pure
// shaping the results panel renders from. No React and no chart here, so the
// geometry can be tested without a DOM.
import { API_BASE as BASE, apiFetch, errorDetail } from "./http";

export interface PatternBar {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** One window's distance under every formula, present only in "all" mode.
 *  null where a formula could not score the window (flat under its
 *  transform): JSON has no Infinity. */
export interface PatternModeDistances {
  shape: number | null;
  ohlc: number | null;
  close: number | null;
  dtw: number | null;
}

export interface PatternMatch {
  ts: number;
  endTs: number;
  /** The mode's own distance — except in "all" mode, where no single distance
   *  exists and this carries the mean rank the row was ordered by. */
  distance: number;
  /** Every formula's distance, set only by "all" mode. */
  distances?: PatternModeDistances | null;
  bars: PatternBar[];
  forward: PatternBar[];
  forwardComplete: boolean;
  forwardPct: number | null;
  /** True on the window that is the user's own selection, scanned like every
   *  other and returned at distance ~0. */
  isSelection?: boolean;
}

/** What the distance is measured over. "shape" (the default) matches the
 *  smoothed close trajectory and re-ranks coarse-to-fine, so the overall
 *  shape counts most and bar noise counts least; "ohlc" compares whole
 *  candles (body, wick and colour), "close" the raw path of closing prices,
 *  and "dtw" re-ranks whole-candle matches with dynamic time warping, which
 *  forgives a recurrence that runs fast in one stretch and slow in another.
 *  None is more correct: each ranks real history differently. "all" runs
 *  every formula, folds overlapping windows into one event each, orders by
 *  mean rank across the formulas, and each match carries its per-formula
 *  distances. */
export type PatternMode = "shape" | "ohlc" | "close" | "dtw" | "all";

export interface PatternSearchRequest {
  epic: string;
  resolution: string;
  priceSide: string;
  broker: string;
  query: PatternBar[];
  queryFromTs: number;
  queryToTs: number;
  topK: number;
  forwardBars: number;
  mode: PatternMode;
}

export interface PatternSearchResult {
  matches: PatternMatch[];
  scanned: number;
  series: { oldestTs: number; newestTs: number; bars: number };
  elapsedMs: number;
  cold: boolean;
}

export async function searchPatterns(
  req: PatternSearchRequest,
  signal?: AbortSignal,
): Promise<PatternSearchResult> {
  const res = await apiFetch(`${BASE}/api/patterns/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) throw new Error(await errorDetail(res, `pattern search failed (${res.status})`));
  return res.json();
}

/** The loaded bars covered by a drag, in unix seconds against a millisecond
 *  range. Ordered, so a right-to-left drag selects the same window. */
export function barsInRange(bars: PatternBar[], fromMs: number, toMs: number): PatternBar[] {
  const lo = Math.min(fromMs, toMs) / 1000;
  const hi = Math.max(fromMs, toMs) / 1000;
  return bars.filter((b) => b.ts >= lo && b.ts <= hi);
}

const VIEW_H = 100;
const MIN_BODY = 0.75;
/** Above this many candles a preview aggregates neighbours into one candle
 *  (first open, last close, extreme high/low): with the query cap at 1024, an
 *  unaggregated row would put thousands of sub-pixel rects in a 100-unit-wide
 *  SVG, and twenty rows of that stalls the panel. Aggregation is display-only
 *  and OHLC-faithful, the same reduction a coarser timeframe performs. */
const PREVIEW_MAX_CANDLES = 160;

function aggregate(bars: PatternBar[], groupSize: number): PatternBar[] {
  if (groupSize <= 1) return bars;
  const out: PatternBar[] = [];
  for (let i = 0; i < bars.length; i += groupSize) {
    const g = bars.slice(i, i + groupSize);
    out.push({
      ts: g[0].ts,
      o: g[0].o,
      c: g[g.length - 1].c,
      h: Math.max(...g.map((b) => b.h)),
      l: Math.min(...g.map((b) => b.l)),
    });
  }
  return out;
}

/** Lay a match and its aftermath out in a 0..100 box for the row preview.
 *  Both halves share one price scale: the whole point of the preview is the
 *  join between them, which a per-half scale would hide. */
export function previewGeometry(match: PatternMatch): {
  candles: {
    x: number; w: number;
    bodyTop: number; bodyH: number;
    wickTop: number; wickH: number;
    up: boolean; forward: boolean;
  }[];
  dividerX: number;
} {
  // One group size for both halves, so the divider stays at the true join.
  const groupSize = Math.ceil((match.bars.length + match.forward.length) / PREVIEW_MAX_CANDLES);
  const bars = aggregate(match.bars, groupSize);
  const forward = aggregate(match.forward, groupSize);
  const all = [...bars, ...forward];
  const n = all.length || 1;
  const hi = Math.max(...all.map((b) => b.h));
  const lo = Math.min(...all.map((b) => b.l));
  const span = hi - lo || 1;
  const y = (v: number) => ((hi - v) / span) * VIEW_H;
  const step = 100 / n;
  const w = step * 0.62;

  const candles = all.map((b, i) => {
    const up = b.c >= b.o;
    const top = y(Math.max(b.o, b.c));
    const bodyH = Math.max(MIN_BODY, y(Math.min(b.o, b.c)) - top);
    return {
      x: i * step + step / 2,
      w,
      bodyTop: top,
      bodyH,
      wickTop: y(b.h),
      wickH: y(b.l) - y(b.h),
      up,
      forward: i >= bars.length,
    };
  });
  return { candles, dividerX: bars.length * step };
}

export function formatForwardPct(pct: number | null): string {
  if (pct == null) return "no bars after";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Sorting the results table.
//
// The backend already returns matches closest-first, and that stays the
// default. Sorting is a reading aid on top of it, so it never touches the
// similarity rank: the pure function below pairs every match with the rank it
// arrived with (1 = closest) and reorders the pairs. Sorting by outcome and
// reading "7" in the rank column is the whole point, since it says the best
// analogue was only the seventh most similar.

/** Which column the results are ordered by. Rank and the candle preview are
 *  not sortable: rank IS the default order, and a picture has no order. The
 *  four formula keys exist only in "all" mode, where each per-formula
 *  distance column sorts on its own numbers. */
export type MatchSortKey =
  "when" | "dist" | "outcome" | "shape" | "ohlc" | "close" | "dtw" | "avg";
export type MatchSortDir = "asc" | "desc";
export interface MatchSort {
  key: MatchSortKey;
  dir: MatchSortDir;
}

/** A match plus the position it held in the backend's distance ranking. */
export interface RankedMatch {
  match: PatternMatch;
  rank: number;
}

/** What ships today, and what a user who never clicks a heading keeps seeing. */
export const DEFAULT_MATCH_SORT: MatchSort = { key: "dist", dir: "asc" };

/** The direction a column starts in when it first becomes the active one: the
 *  end of the column a reader actually wants first. */
export function defaultMatchSortDir(key: MatchSortKey): MatchSortDir {
  // Closest first, most recent first, best first.
  return key === "when" || key === "outcome" ? "desc" : "asc";
}

/** The next sort state after clicking `key`: the active column flips, any
 *  other column starts at its own most useful direction. */
export function nextMatchSort(sort: MatchSort, key: MatchSortKey): MatchSort {
  if (sort.key === key) return { key, dir: sort.dir === "asc" ? "desc" : "asc" };
  return { key, dir: defaultMatchSortDir(key) };
}

/** The plain average of a match's per-formula distances, over the formulas
 *  that could score it. A reading aid, not the ranking: the metrics are not
 *  calibrated against each other, so the All list stays ordered by mean
 *  rank. null outside "all" mode or when no formula scored the window. */
export function avgDistance(m: PatternMatch): number | null {
  if (!m.distances) return null;
  const vals = Object.values(m.distances).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function sortValue(m: PatternMatch, key: MatchSortKey): number | null {
  switch (key) {
    case "when":
      return m.ts;
    case "dist":
      return m.distance;
    case "outcome":
      return m.forwardPct;
    case "avg":
      return avgDistance(m);
    default:
      // A per-formula column in "all" mode; absent outside it.
      return m.distances?.[key] ?? null;
  }
}

/** Rank the matches as the backend sent them, then order those pairs.
 *
 *  Stable by construction: equal values fall back to the arrival rank rather
 *  than to the engine's sort, so the tie order is the same in both directions.
 *  A null value (no aftermath; a formula that could not score the window)
 *  sorts to the END either way, because a missing value is not a small one;
 *  those rows still sort normally by every other column. */
export function sortMatches(matches: PatternMatch[], sort: MatchSort): RankedMatch[] {
  const ranked: RankedMatch[] = matches.map((match, i) => ({ match, rank: i + 1 }));
  const sign = sort.dir === "asc" ? 1 : -1;
  return ranked.sort((a, b) => {
    const av = sortValue(a.match, sort.key);
    const bv = sortValue(b.match, sort.key);
    // Outside the direction sign on purpose: nulls go last in both.
    if (av == null || bv == null) {
      if (av == null && bv == null) return a.rank - b.rank;
      return av == null ? 1 : -1;
    }
    if (av !== bv) return (av - bv) * sign;
    // Also outside the sign: reversing ties would make "stable" mean nothing.
    return a.rank - b.rank;
  });
}

// ---------------------------------------------------------------------------
// The per-tab summary strip: one line of statistics over the visible matches.

/** Statistics over a result's matches, EXCLUDING the user's own selection row:
 *  it is a calibration check, not an analogue, and counting its distance ~0 or
 *  its known aftermath would flatter every number here. Outcome fields cover
 *  only the rows that have an aftermath; `withOutcome` is their honest
 *  denominator. null when a statistic has nothing to measure. */
export interface MatchSummary {
  count: number;
  withOutcome: number;
  /** Of `withOutcome`, how many moved up (>= 0, matching the row colouring). */
  up: number;
  medianPct: number | null;
  bestPct: number | null;
  worstPct: number | null;
  /** Median distance. null in "all" mode, where no single distance exists. */
  medianDist: number | null;
  minLen: number;
  maxLen: number;
  oldestTs: number;
  newestTs: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summarizeMatches(matches: PatternMatch[]): MatchSummary | null {
  const real = matches.filter((m) => !m.isSelection);
  if (real.length === 0) return null;
  const outcomes = real.map((m) => m.forwardPct).filter((p): p is number => p != null);
  const combined = real.some((m) => m.distances != null);
  return {
    count: real.length,
    withOutcome: outcomes.length,
    up: outcomes.filter((p) => p >= 0).length,
    medianPct: median(outcomes),
    bestPct: outcomes.length ? Math.max(...outcomes) : null,
    worstPct: outcomes.length ? Math.min(...outcomes) : null,
    medianDist: combined ? null : median(real.map((m) => m.distance)),
    minLen: Math.min(...real.map((m) => m.bars.length)),
    maxLen: Math.max(...real.map((m) => m.bars.length)),
    oldestTs: Math.min(...real.map((m) => m.ts)),
    newestTs: Math.max(...real.map((m) => m.ts)),
  };
}

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
  /** The chart the match was found in. Client-side tag set by
   *  mergePatternResults, absent on a single-series search. */
  source?: MatchSource;
}

/** The series identity a merged match carries: which open chart it came from. */
export interface MatchSource {
  cellId: string;
  /** The tab holding the cell — a jump to a chart on another tab needs to
   *  switch there first. Absent on results parked before this field existed. */
  tabId?: string;
  epic: string;
  resolution: string;
  /** The period's display label ("5m"), for compact row tags. */
  label: string;
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

/** One series' outcome inside a merged layout-wide search: its identity, the
 *  facts of its own scan for the footer, or the error that kept it out. */
export interface SourceOutcome extends MatchSource {
  scanned: number | null;
  series: PatternSearchResult["series"] | null;
  elapsedMs: number | null;
  cold: boolean;
  error: string | null;
}

/** A layout-wide search result: the single-series shape the panel already
 *  renders, plus the per-series outcomes behind it. */
export interface MergedPatternResult extends PatternSearchResult {
  sources: SourceOutcome[];
}

/** Fold per-series search outcomes into one ranked list. Matches are tagged
 *  with their series, ordered by distance ascending (ties toward the earlier
 *  outcome, so the origin series wins them) and capped at topK. Distances are
 *  scale-normalized so ordering across symbols is meaningful — EXCEPT in "all"
 *  mode, where `distance` is a mean rank within each series' own candidate
 *  pool: those are not comparable across series, so all-mode results are
 *  interleaved round-robin by per-series rank instead. Totals cover only the
 *  series that answered; a failed series rides along in `sources` with its
 *  message. Throws when EVERY series failed — the caller wants its error
 *  state, not an empty result.
 *
 *  The first outcome must be the ORIGIN series: only its matches may keep the
 *  backend's your-selection flag. Sibling requests reuse the origin's
 *  queryFromTs, so on a shared bar grid the backend flags a genuine sibling
 *  match at the same wall-clock bar as the selection, which would hide it
 *  from the outcome statistics. */
export function mergePatternResults(
  outcomes: { source: MatchSource; result?: PatternSearchResult; error?: string }[],
  topK: number,
): MergedPatternResult {
  const ok = outcomes.filter((o) => o.result);
  if (ok.length === 0) {
    throw new Error(outcomes[0]?.error ?? "pattern search failed");
  }
  const tagged = ok.flatMap((o, oi) =>
    o.result!.matches.map((m, mi) => ({
      match: {
        ...m,
        source: o.source,
        ...(oi > 0 && m.isSelection ? { isSelection: false } : null),
      },
      oi,
      mi,
    })),
  );
  // "all" mode is detected off the rows themselves (only it sets per-formula
  // distances), so parked results merge the same way live ones did.
  const allMode = tagged.some((t) => t.match.distances != null);
  tagged.sort((a, b) =>
    allMode
      ? a.mi - b.mi || a.oi - b.oi
      : a.match.distance - b.match.distance || a.oi - b.oi || a.mi - b.mi,
  );
  return {
    matches: tagged.slice(0, topK).map((t) => t.match),
    scanned: ok.reduce((n, o) => n + o.result!.scanned, 0),
    series: ok[0].result!.series,
    elapsedMs: Math.max(...ok.map((o) => o.result!.elapsedMs)),
    cold: ok.some((o) => o.result!.cold),
    sources: outcomes.map((o) => ({
      ...o.source,
      scanned: o.result?.scanned ?? null,
      series: o.result?.series ?? null,
      elapsedMs: o.result?.elapsedMs ?? null,
      cold: o.result?.cold ?? false,
      error: o.result ? null : (o.error ?? "pattern search failed"),
    })),
  };
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

// ---------------------------------------------------------------------------
// The outcome verdict: does this history actually lean anywhere, or is the
// win-rate on the strip a coin flip dressed as a statistic?

/** At least this many decisive (non-zero) outcomes before judging at all. */
const VERDICT_MIN_N = 8;
/** Two-sided sign-test p-value a lean must clear. 0.1, not 0.05: the chip
 *  says "lean", deliberately short of "significant" — matches overlap in
 *  regime and are correlated, so the test is indicative, never proof. */
const VERDICT_MAX_P = 0.1;

export interface OutcomeVerdict {
  kind: "small" | "mixed" | "up" | "down";
  /** Decisive outcomes judged: rows with aftermath, zeros excluded. */
  n: number;
  /** Of `n`, how many moved up. */
  up: number;
  /** Two-sided sign-test p-value. Absent below VERDICT_MIN_N, where no test
   *  was run. */
  p?: number;
}

/** P(X <= k) for X ~ Binomial(n, 1/2), exactly. n is at most a panel's worth
 *  of matches, so the direct sum is both exact and instant. */
function binomCdf(k: number, n: number): number {
  let coef = 1; // C(n, 0)
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += coef;
    coef = (coef * (n - i)) / (i + 1);
  }
  return sum / 2 ** n;
}

/** Judge the matches' aftermaths, in arrival (rank) order, excluding the
 *  selection row. A lean needs all three: enough decisive outcomes, an up/down
 *  split lopsided enough that a fair coin rarely produces it, and a closest
 *  half whose median moves the same way — so far, barely-similar matches
 *  cannot manufacture a signal the good matches do not support. null when no
 *  row has an aftermath at all. */
export function outcomeVerdict(matches: PatternMatch[]): OutcomeVerdict | null {
  const scored = matches.filter((m) => !m.isSelection && m.forwardPct != null);
  if (scored.length === 0) return null;
  const decisive = scored.filter((m) => m.forwardPct !== 0);
  const n = decisive.length;
  const up = decisive.filter((m) => (m.forwardPct as number) > 0).length;
  if (n < VERDICT_MIN_N) return { kind: "small", n, up };

  const k = Math.min(up, n - up);
  const p = Math.min(1, 2 * binomCdf(k, n));
  if (p > VERDICT_MAX_P) return { kind: "mixed", n, up, p };

  const lean = up > n - up ? 1 : -1;
  // Closest half by arrival order: the backend already ranks by distance
  // (mean rank in "all" mode), and re-sorting the table must not move the
  // verdict.
  const closest = scored.slice(0, Math.ceil(scored.length / 2));
  const closestMedian = median(closest.map((m) => m.forwardPct as number));
  if (closestMedian == null || Math.sign(closestMedian) !== lean) {
    return { kind: "mixed", n, up, p };
  }
  return { kind: lean > 0 ? "up" : "down", n, up, p };
}

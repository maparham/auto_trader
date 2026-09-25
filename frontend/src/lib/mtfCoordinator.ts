// Multi-timeframe coordinator for the TV-style EMA/MA. klinecharts' indicator
// `calc` is synchronous and only sees the chart's bars, so the higher-timeframe
// (HTF) series is fetched + computed here and stashed on the indicator's
// extendData; the alignment onto chart bars happens inside calc (see
// customIndicators.computeMa), which keeps scroll-back correct.
//
// Backend note: /api/candles serves any resolution, so this needs no new
// endpoint (see [[capital-com-api]] / charting-stack memory).

import type { Chart, KLineData } from "klinecharts";
// RESOLUTION_SECONDS deliberately NOT imported: the HTF width comes from
// nominalBarHours so a pin ALIAS ("1H") resolves the same as its canonical
// resolution (see fetchHtfBars below).
import { fetchRangeStrict, nominalBarHours } from "./feed";
import { loadSettings } from "../theme";
import {
  maSeries,
  htfCoverageStartMs,
  normalizeMaKind,
  type MaKind,
  type MtfSeriesBase,
} from "./mtf";
import { fetchHtfInterval, htfIntervalKey } from "./htfBarCache";
import { foldFormingBar, formingOpenMs, htfBarEndMs } from "./mtfForming";
import { fetchSpanParallel } from "./historyPaging";
import { barCloseMs } from "./replayBars";
import { bucketOpenMs } from "./timeframe";
import { declaredBarMs, setDeclaredBarMs } from "./barInterval";
import { indTypeOf, templateMaKind, type MaExtend } from "./customIndicators";
import { computePivotBarsSince } from "./indicators/pivotBarsSince";
import {
  computePivotBands,
  type PivotBandsExtend,
  type PivotBandsMode,
  type PivotBandsSource,
} from "./indicators/pivotBands";
import {
  computeSrLevels,
  parseSrConfig,
  SR_ATR_LEN,
  type SrLevelsConfig,
  type SrLevelsExtend,
} from "./indicators/srLevels";
import { computeAutoFibPairs, type AutoFibExtend } from "./indicators/autoFib";
import {
  autoFibWarmup,
  parseAutoFibConfig,
  type AutoFibConfig,
} from "./indicators/autoFibOutputs";
import {
  computeTrendlines,
  setTrendlinesHtfBars,
  type TrendlinesExtend,
} from "./indicators/trendlines";
import {
  parseTrendlinesConfig,
  trendlinesOutputs,
  MAX_PAIR_PIVOTS,
  TL_ATR_LEN,
  type TrendlinesConfig,
} from "./indicators/trendlinesOutputs";
import {
  computeFvg,
  parseFvgConfig,
  FVG_ATR_LEN,
  type FvgConfig,
  type FvgExtend,
} from "./indicators/fvg";
import {
  slopeLineSeries,
  accelLineSeries,
  smoothSeries,
  inferBarHours,
  slopeLengths,
  normalizeSlopeUnit,
  slopePeriodOf,
  type SlopeUnit,
  type SlopeExtend,
  type SlopeSmoothing,
} from "./indicators/slope";
import {
  syncAccelCompanion,
  syncPivotBarsSinceCompanion,
  getIndicator,
  getIndicatorsByPane,
} from "./indicators";
import { overrideExtend } from "./overrideExtend";

// Bars per HTF page. The backend caps a single /api/candles fetch (bars le=1000),
// so a wide asked span needs several windows — kept under the cap.
const HTF_PAGE_BARS = 900;
// Bound the span so a pathological ask can't spin forever; 40 windows of 900
// bars (36k HTF bars) covers any realistic covered interval.
const HTF_MAX_PAGES = 40;
// Parallel window lanes per span load. Both endpoints are known up front (the
// same precondition that let coverBacktestTradeTo go parallel), so the walk
// is round-trip-bound, not data-bound; 6 mirrors the candle jump's lanes.
const HTF_FETCH_LANES = 6;

// --- fetch-failure retry -------------------------------------------------
// A failed HTF fetch (broker briefly down or reconnecting — e.g. the backend's
// 503 while MT5 rebuilds a wedged connection) must not leave the curve blank
// until the user re-touches the indicator: the failing apply schedules itself
// again with backoff. State is PER CHART (a WeakMap, so a disposed chart's
// entries free with it) because instance names repeat across cells — the first
// instance of a type keeps the bare name ("EMA") in every cell, on the same
// pane id. Any newer apply for the same indicator supersedes the pending retry
// (cancelled at apply start), and the fired retry re-checks that the indicator
// still wants the retried timeframe, so a stale epic/config captured by a
// timer can never stomp fresh state.
const RETRY_BASE_MS = 4_000;
const RETRY_MAX_MS = 60_000;
interface MtfRetryEntry {
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
}
const mtfRetries = new WeakMap<Chart, Map<string, MtfRetryEntry>>();

const mtfRetryKey = (paneId: string, name: string) => `${paneId}:${name}`;

function chartRetries(chart: Chart): Map<string, MtfRetryEntry> {
  let m = mtfRetries.get(chart);
  if (!m) {
    m = new Map();
    mtfRetries.set(chart, m);
  }
  return m;
}

/** Stop a pending retry but keep the attempt count — a retry-initiated apply
 * runs through the same apply function, and must not reset its own backoff. */
function cancelMtfRetry(chart: Chart, paneId: string, name: string): void {
  const e = mtfRetries.get(chart)?.get(mtfRetryKey(paneId, name));
  if (e?.timer) {
    clearTimeout(e.timer);
    e.timer = null;
  }
}

/** A successful apply (or a switch back to the chart timeframe): retry state
 * is finished with, including the backoff counter. */
function clearMtfRetry(chart: Chart, paneId: string, name: string): void {
  cancelMtfRetry(chart, paneId, name);
  mtfRetries.get(chart)?.delete(mtfRetryKey(paneId, name));
}

function scheduleMtfRetry(
  chart: Chart,
  paneId: string,
  name: string,
  timeframe: string,
  run: () => Promise<void>,
): void {
  const retries = chartRetries(chart);
  const key = mtfRetryKey(paneId, name);
  const e = retries.get(key) ?? { timer: null, attempt: 0 };
  retries.set(key, e);
  if (e.timer) clearTimeout(e.timer);
  const delay = Math.min(RETRY_BASE_MS * 2 ** e.attempt, RETRY_MAX_MS);
  e.attempt += 1;
  e.timer = setTimeout(() => {
    e.timer = null;
    void (async () => {
      // Drop the chain unless this indicator still wants the retried timeframe.
      // Covers removal, chart disposal, AND removed-then-re-added: a fresh
      // first instance re-mints the same bare name but has no mtf set, and the
      // stale closure must not convert it back to the old configuration.
      const ind = getIndicator(chart, paneId, name) as {
        extendData?: { mtf?: { timeframe?: string | null } };
      } | null;
      if (ind?.extendData?.mtf?.timeframe !== timeframe) {
        retries.delete(key);
        return;
      }
      await run();
    })().catch(() => {
      retries.delete(key); // disposed chart mid-flight — stop retrying
    });
  }, delay);
}

// --- replay cursor clamp ----------------------------------------------------
//
// A replaying cell must not let a higher-timeframe series look ahead: the
// backend serves the bucket CONTAINING the cursor fully aggregated (it is in the
// past as far as the API is concerned), so an EMA pinned to 1H on a 15m replay
// would read an hour the user has not reached. Same no-lookahead rule the
// backtester enforces. The reader returns 0 when the cell is not replaying.
//
// Per chart (a WeakMap, like mtfRetries above) because a tab holds several
// cells and only some of them replay; a disposed chart's entry frees with it.
const htfCursors = new WeakMap<Chart, () => number>();

// The chart's DECLARED bar interval (ms), registered by ChartCore on every
// resolution change. Stamped into each stash as mtf.chartMs so calc — which
// never sees the chart or its resolution string — can hand alignHtfToChart
// the real interval instead of a gap-inferred guess (mirror of the backend's
// base_interval_ms fix; see the nominalBarHours doc note on why gaps lie).
// Same WeakMap idiom as htfCursors: nothing to leak on chart disposal.
// The map itself lives in barInterval.ts so the backtest overlays and painters
// read the same declared width.
export function setChartIntervalMs(chart: Chart, ms: number | null): void {
  setDeclaredBarMs(chart, ms);
}

function chartIntervalOf(chart: Chart): number | undefined {
  return declaredBarMs(chart);
}

export function setHtfCursorClamp(
  chart: Chart,
  read: (() => number) | null,
): void {
  if (read) htfCursors.set(chart, read);
  else htfCursors.delete(chart);
}

// --- viewport-scoped coverage ------------------------------------------------
//
// The stash contract: cover ONE contiguous interval [coveredFromMs,
// coveredToMs] containing the VISIBLE range plus warmup and a prefetch margin,
// not the chart's whole loaded history. Loaded depth stopped being a
// slow-moving number the day the pattern jump could move it a decade per
// click; the visible range is what the user actually pays attention to, and
// candles already stream in on scroll, so indicators doing the same is the
// consistent behavior. See
// docs/superpowers/specs/2026-09-09-viewport-scoped-indicator-coverage-design.md.

export interface NeededInterval {
  fromMs: number;
  toMs: number;
}

/** Reads the interval the chart currently NEEDS covered: visible range plus
 * one screenful each side, right end clamped to now. Registered by ChartCore
 * (same WeakMap idiom as htfCursors); absent in tests and headless callers,
 * where the fallback below reproduces the old full-span behavior. */
const viewportReaders = new WeakMap<Chart, () => NeededInterval>();

export function setViewportReader(
  chart: Chart,
  read: (() => NeededInterval) | null,
): void {
  if (read) viewportReaders.set(chart, read);
  else viewportReaders.delete(chart);
}

function neededOf(chart: Chart): NeededInterval {
  const read = viewportReaders.get(chart);
  if (read) return read();
  // No reader: reproduce the old full-span contract, endpoints from the
  // chart's own bars (the newest LOADED bar, not the wall clock: a replaying
  // or historical chart's data can sit far from now, and the old walk always
  // ended at the newest fetched bar).
  const d = chart.getDataList();
  const now = Date.now();
  return {
    fromMs: d.length ? d[0].timestamp : now,
    toMs: d.length ? d[d.length - 1].timestamp : now,
  };
}

/** Whether an interval whose ask reaches `askToMs` is DOCKED at the live edge
 * of this chart (reaches its newest bar, with one HTF bucket of slack: live
 * ticks advance the chart past the stashed ask inside the still-forming
 * bucket, and the bucket-crossing refresh re-asks). Detached stashes skip the
 * forming fold and the live-tick refresh: the live edge is off screen and its
 * bars are not in the interval. */
function dockedAt(chart: Chart, askToMs: number, htfMs: number): boolean {
  const d = chart.getDataList();
  const newest = d.length ? d[d.length - 1].timestamp : 0;
  return !newest || askToMs >= newest - (htfMs > 0 ? htfMs : 0);
}

// How many view-widths to the RIGHT the wanted floor may drift from the
// stamped one before the floor rebases forward. Left moves always stamp
// (coverage must lead the view); right moves only rebase past this slack, so
// ordinary scrolling near the floor never churns recalcs, while returning to
// the live edge after a deep jump drops the deep-history compute cost.
const FLOOR_REBASE_SCREENS = 4;

/**
 * Stamp the viewport-derived compute floor onto every CHART-TIMEFRAME
 * Trendlines instance (pinned ones are windowed by their HTF stash interval
 * instead). Called from ChartCore's debounced visible-range settle, next to
 * the coverage refresh. The floor is the view's left end minus the type's
 * warmup in chart bars; a changed stamp triggers the instance's recalc, which
 * rebuilds the detector from the new floor (see createTrendlinesSession).
 *
 * This is lazy loading of history, BY DESIGN, and it shows on the chart: a
 * swing older than the floor is in no pool, so a line that would rest on it
 * (a major swing pairing especially, since pairing with old swings is the
 * tier's whole point) appears only once the user has scrolled far enough
 * left to pull the floor past that swing. Scrolling back right keeps it (the
 * floor never moves right for an ordinary scroll), and only a far jump toward
 * the present drops it again along with the deep-history compute cost. The
 * warmup deliberately leaves Major Length out: the margin is the price of
 * every recalc, and a major just off screen is a scroll away, not a bug.
 */
export function stampTrendlinesFloors(chart: Chart): void {
  const read = viewportReaders.get(chart);
  const byPane = getIndicatorsByPane(chart);
  if (!read || !byPane) return;
  const view = read();
  const chartMs = chartIntervalOf(chart) ?? 60_000;
  const viewSpanMs = Math.max(1, view.toMs - view.fromMs);
  byPane.forEach((nameMap, paneId) => {
    nameMap.forEach((indUnknown, id) => {
      const ind = indUnknown as {
        visible?: boolean;
        calcParams?: unknown[];
        extendData?: TrendlinesExtend & { mtf?: MtfSeriesBase };
      };
      if (indTypeOf({ name: id, extendData: ind.extendData }) !== "TRENDLINES")
        return;
      if (ind.extendData?.mtf?.timeframe) return;
      // A hidden instance computes nothing (see TRENDLINES_TEMPLATE.calc), so a
      // floor stamp would only churn overrides. refreshMtfOnVisibilityChange
      // re-stamps on unhide, before the view's next settle.
      if (ind.visible === false) return;
      const cfg = parseTrendlinesConfig(ind.calcParams, ind.extendData);
      const wantedFloor = view.fromMs - tlWarmup(cfg) * chartMs;
      const cur = ind.extendData?.tlFloorTs;
      const move =
        cur == null ||
        wantedFloor < cur ||
        wantedFloor > cur + FLOOR_REBASE_SCREENS * viewSpanMs;
      if (!move) return;
      overrideExtend(
        chart,
        paneId,
        id,
        { ...(ind.extendData ?? {}), tlFloorTs: wantedFloor },
        ind.calcParams ?? [],
      );
    });
  });
}

/**
 * The interval a fresh walk should ASK for, given what the stash already
 * covers. Overlapping or touching (within one HTF bucket) intervals UNION, so
 * coverage grows monotonically and never goes sparse; a disjoint need REBASES
 * (returns just the need), so a years-deep jump costs the landing window
 * instead of dragging the whole in-between span in. The needed interval always
 * carries a screenful margin, which is why plain disjointness is the whole
 * rebase rule. Exported for tests.
 */
export function resolveAskInterval(
  prev:
    | Pick<MtfSeriesBase, "coveredFromMs" | "coveredToMs" | "htfStarts" | "htfMs">
    | undefined,
  needed: NeededInterval,
  htfMs: number,
): NeededInterval {
  const width = htfMs > 0 ? htfMs : 3_600_000;
  const starts = prev?.htfStarts;
  const prevFrom =
    prev?.coveredFromMs ?? (starts?.length ? starts[0] : undefined);
  const prevTo =
    prev?.coveredToMs ??
    (starts?.length
      ? starts[starts.length - 1] + (prev?.htfMs ?? width)
      : undefined);
  if (prevFrom == null || prevTo == null) return needed;
  if (needed.toMs < prevFrom - width || needed.fromMs > prevTo + width)
    return needed; // disjoint: rebase
  return {
    fromMs: Math.min(needed.fromMs, prevFrom),
    toMs: Math.max(needed.toMs, prevTo),
  };
}

/** Keep only HTF bars fully CLOSED at the cursor. `cursorMs` 0 = not replaying.
 *
 * Closes come from barCloseMs — the NEXT bar's timestamp, which is the truth for
 * the calendar-bucketed derived timeframes the backend folds. Only the newest
 * fetched bar (the one still forming, in the normal case) falls back to the
 * nominal width, and that fallback is what releases a bucket the instant the
 * cursor reaches its close. */
export function clampHtfBars(
  bars: KLineData[],
  cursorMs: number,
  nominalMs: number,
  resolution?: string,
): KLineData[] {
  if (!cursorMs) return bars;
  const out: KLineData[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (barCloseMs(bars, i, nominalMs, resolution) <= cursorMs) out.push(bars[i]);
    else break; // ascending: everything after this is later still
  }
  return out;
}

/** What a forming-mode apply/refresh computes on and stashes: the closed HTF
 * bars plus (when one exists) ONE folded forming bar, and the extra mtf fields
 * that make the fold repeatable without a refetch. */
interface FormingPrep {
  bars: KLineData[];
  extra: Pick<
    MtfSeriesBase,
    "waitClose" | "formingIdx" | "htfClosed" | "htfSeed"
  >;
}

/** The forming-bar half of TV's "Wait for timeframe closes" (unchecked): cut
 * the fetched HTF series at the chart's newest bar, fold the chart's own
 * candles inside the still-open bucket into one synthetic bar (seeded by the
 * fetched partial when the fetch returned one), and append it. The chart's
 * candles are the pane's own price side, so the fold matches the fetch's side
 * by construction. Under replay the cursor clamps the fold — candles the user
 * has not reached do not exist yet (fetchHtfBars already clamped the fetched
 * bars the same way). */
function prepFormingBars(
  chart: Chart,
  htf: KLineData[],
  htfMs: number,
  timeframe: string,
): FormingPrep {
  const data = chart.getDataList();
  const newestMs = data.length ? data[data.length - 1].timestamp : 0;
  // Closed = ended by the chart's newest bar, where the grammar says the bar
  // ends (a custom 5H 20:00 bucket ends at midnight, not 01:00).
  const closed = newestMs
    ? htf.filter((b) => htfBarEndMs(b.timestamp, htfMs, timeframe) <= newestMs)
    : htf;
  // First fetched bar past the closed cut = the broker's own partial forming
  // bar. Its timestamp is the authoritative bucket open (calendar timeframes
  // have no nominal span); absent (e.g. under replay's clamp) the nominal
  // derivation stands in.
  const seed = htf[closed.length];
  const openMs = formingOpenMs(
    closed.map((b) => b.timestamp),
    htfMs,
    seed,
    timeframe,
  );
  const cursorMs = htfCursors.get(chart)?.() ?? 0;
  const forming =
    openMs != null
      ? foldFormingBar(data, openMs, htfMs, seed, cursorMs || undefined, timeframe)
      : null;
  const bars = forming ? [...closed, forming] : closed;
  return {
    bars,
    extra: {
      waitClose: false,
      ...(forming ? { formingIdx: bars.length - 1 } : {}),
      htfClosed: closed,
      ...(seed ? { htfSeed: seed } : {}),
    },
  };
}

/** The pin's "Wait for timeframe closes" state, read off the indicator's live
 * extendData before an apply overwrites it. Only an explicit false opts into
 * the forming fold. */
function readWaitClose(ind: { extendData?: object } | null): boolean {
  const mtf = (ind?.extendData as { mtf?: MtfSeriesBase } | undefined)?.mtf;
  return mtf?.waitClose !== false;
}

/** The smallest higher-timeframe bucket any indicator on this chart is pinned
 * to, in ms (0 = nothing pinned). A replaying cell re-fetches its HTF series on
 * this grid: the set of bars CLOSED at the cursor can only change when the
 * cursor crosses a bucket boundary, so this is what turns "refresh as the cursor
 * advances" into one refresh per released HTF bar instead of one per step.
 *
 * Widths come from nominalBarHours, not RESOLUTION_SECONDS directly, for the
 * same reason the pinned-slope path does (see applySlopeTimeframe): a stashed
 * timeframe may be a pin ALIAS ("1H") rather than a canonical resolution, and a
 * bare table lookup would score it 0 — which, for the only pinned indicator on a
 * chart, would silently switch the cursor-advance refresh off for the session.
 *
 * Approximate for the derived widths (WEEK_2, the MONTH_N family and YEAR are
 * not fixed spans), which can make a refresh fire a little early (harmless —
 * clampHtfBars filters) or a little late (stale until the next crossing). Never
 * a correctness input: the clamp itself is applied at fetch time, whoever
 * triggered the fetch. */
export function mtfBucketMs(chart: Chart): number {
  return smallestPin(chart)?.ms ?? 0;
}

/** The smallest pinned width and the timeframe that has it. */
function smallestPin(chart: Chart): { ms: number; tf: string } | null {
  let best: { ms: number; tf: string } | null = null;
  for (const [, byName] of getIndicatorsByPane(chart)) {
    for (const [, ind] of byName) {
      const tf = (ind.extendData as { mtf?: MtfSeriesBase } | undefined)?.mtf
        ?.timeframe;
      if (!tf) continue;
      const ms = (nominalBarHours(tf) ?? 0) * 3_600_000;
      if (ms > 0 && (best === null || ms < best.ms)) best = { ms, tf };
    }
  }
  return best;
}

/** Key of the smallest pinned bucket containing `ts` (its open, in ms), or
 * null when nothing is pinned. A change of key between two cursor positions or
 * ticks is a bucket crossing. The open comes from the grammar (bucketOpenMs),
 * so a pin that does not divide the day (5H, 7m) crosses where its buckets
 * really reset at 00:00 UTC, not on an epoch grid. */
export function mtfBucketKey(chart: Chart, ts: number): number | null {
  const pin = smallestPin(chart);
  if (!pin) return null;
  return bucketOpenMs(pin.tf, ts) ?? Math.floor(ts / pin.ms) * pin.ms;
}

/**
 * Shared tail of every apply*Timeframe after its HTF fetch: decide whether the
 * caller stashes the fetched series. Returns true to continue (fetch succeeded,
 * or partial pages landed — render them; the retry extends). On a failure with
 * nothing usable it writes the indicator itself and returns false: an
 * already-stashed series for this timeframe is kept (stale beats blank),
 * otherwise the timeframe-only shape — the same one a persisted MTF indicator
 * reloads with — renders on the chart timeframe until a retry lands. Either
 * way the merged extendData/calcParams ARE written, so config edits made while
 * the broker is down still stick.
 */
function mtfFetchTail(
  chart: Chart,
  paneId: string,
  name: string,
  timeframe: string,
  failed: boolean,
  hasBars: boolean,
  prev: MtfSeriesBase | undefined,
  ext: object,
  calcParams: unknown[],
  retry: () => Promise<void>,
): boolean {
  if (!failed) {
    clearMtfRetry(chart, paneId, name);
    return true;
  }
  scheduleMtfRetry(chart, paneId, name, timeframe, retry);
  if (hasBars) return true;
  // The fallback shape must keep the pin's waitClose choice: the retry's apply
  // re-reads it off live extendData, so dropping it here would silently flip a
  // forming-mode pin back to waiting after one transient failure.
  const mtf =
    prev?.timeframe === timeframe && prev.htfStarts?.length
      ? prev
      : {
          timeframe,
          ...(prev?.waitClose === false ? { waitClose: false } : {}),
        };
  overrideExtend(chart, paneId, name, { ...ext, mtf }, calcParams);
  return false;
}

interface MaConfig {
  kind: MaKind;
  length: number;
  options: MaExtend; // source / offset / smoothing
}

/**
 * Fetch the higher-timeframe candles an MTF indicator needs to cover its
 * NEEDED interval (the visible range plus margins; see NeededInterval). Shared
 * by every MTF indicator — only the per-indicator series computation differs
 * afterwards.
 *
 * `warmupBars` is how many HTF bars of history the indicator needs *before* the
 * needed interval's left end so its left edge is populated (MA warmup for
 * EMA/MA; enough pivot history for Pivot Bands). `prev` is the instance's
 * current stash: the ask is the union with what it already covers (or a rebase
 * when disjoint — see resolveAskInterval). A failed fetch (broker
 * down/reconnecting) never throws — it returns whatever spans already landed
 * with `failed: true`, so the caller can render partial data and schedule a
 * retry, while the base indicator keeps working.
 */
async function fetchHtfBars(
  chart: Chart,
  epic: string,
  timeframe: string,
  warmupBars: number,
  brokerId: string | undefined,
  needed: NeededInterval,
  prev: MtfSeriesBase | undefined,
): Promise<{
  htf: KLineData[];
  htfMs: number;
  failed: boolean;
  askFromMs: number;
  askToMs: number;
}> {
  // nominalBarHours, not a bare RESOLUTION_SECONDS lookup, so a pin ALIAS ("1H")
  // scores the same width here as it does in mtfBucketMs — the two must agree, or
  // an alias would page at the 1h default with htfMs 0, which corrupts the
  // coverage start, the stashed htfMs the alignment reads, AND clampHtfBars'
  // newest-bar fallback (`timestamp + 0` admits the still-forming bucket).
  const htfSec = (nominalBarHours(timeframe) ?? 0) * 3600;
  const htfMs = htfSec * 1000;
  const fromMs = htfCoverageStartMs(needed.fromMs, htfMs, warmupBars);
  // No wall-clock clamp: the viewport reader already clamps a live chart's
  // right end to now, a replaying or synthetic chart legitimately asks around
  // its own bars, and a span past the broker's edge just comes back empty.
  const toMs = needed.toMs;
  const ask = resolveAskInterval(prev, { fromMs, toMs }, htfMs);

  // THE PANE'S OWN PRICE SIDE, not a hardcoded "mid". Read once here rather than
  // threaded through every apply*/refresh signature, the same way
  // useLiveMarketData's centre-pin reads it (App re-saves settings and fires
  // at:settings-saved; a side change reloads the series, which refreshes the
  // pins). One reader cannot drift from the chart's.
  //
  // It looked cosmetic while MTF meant moving averages: mid vs bid shifts a
  // curve by half a spread. It is not. Trendlines decide BOOLEANS against these
  // bars — measured on a DAL daily pane, a support line's break came to bid low
  // 84.52 against a threshold of 85.11 while the mid low was 85.13, so the mid
  // bars left the line unbroken, drawn solid, still emitting as live support on
  // a chart whose own candles had gone through it.
  //
  // Also identifies the bars for sharing: a bid walk and a mid walk are
  // different data and must not pool.
  const side = loadSettings().priceSide;
  const key = htfIntervalKey({ brokerId, epic, timeframe, priceSide: side });

  // One interval store per (broker, epic, timeframe, side), shared by every
  // indicator pinned to it; only missing spans are fetched — see htfBarCache.
  // The clamp below stays per-caller.
  const res = await fetchHtfInterval(
    key,
    ask.fromMs,
    ask.toMs,
    htfMs,
    (spanFromMs, spanToMs) =>
      fetchSpanParallel<KLineData>({
        fromMs: spanFromMs,
        toMs: spanToMs,
        resSec: htfSec || 3600,
        pageBars: HTF_PAGE_BARS,
        maxWindows: HTF_MAX_PAGES,
        concurrency: HTF_FETCH_LANES,
        fetchWindow: (fSec, tSec) =>
          fetchRangeStrict(epic, timeframe, fSec, tSec, side, brokerId),
      }),
  );

  // The no-lookahead clamp, applied HERE because every MTF indicator's apply*
  // funnels through this one fetch — patching each of them separately is how the
  // rule drifts. Read at the END, after the awaits, so a fetch already in flight
  // when a session starts is clamped on resolution too.
  //
  // PER-CALLER, deliberately: the shared store caches the raw bars, and two cells
  // riding the same store can sit at different replay cursors. Clamping before
  // the cache would leak one cell's cursor into another's series.
  const cursorMs = htfCursors.get(chart)?.() ?? 0;
  return {
    htf: clampHtfBars(res.bars, cursorMs, htfMs, timeframe),
    htfMs,
    failed: res.failed,
    // The interval this call ASKED for. On a successful walk the caller
    // stashes both ends — see MtfSeriesBase.coveredFromMs/coveredToMs for why
    // the ask, not the arrival, is what the coverage guard needs.
    askFromMs: res.askFromMs,
    askToMs: res.askToMs,
  };
}

/** What one indicator type plugs into applyHtfPin. */
interface HtfPinSpec<E> {
  /** The extendData to write: the live one plus this type's own config fields. */
  extend: (live: E) => E;
  calcParams: unknown[];
  /** HTF bars of history needed before the view's left edge. */
  warmup: (ext: E) => number;
  /** The stash on the bars the pin computes on (forming bar folded or not). */
  build: (bars: KLineData[], timeframe: string, htfMs: number, ext: E) => object | undefined;
  /** The bars to compute on when no forming bar is folded (default: all fetched). */
  closedBars?: (htf: KLineData[], htfMs: number, timeframe: string) => KLineData[];
  /** Runs after every write of the stash or of the cleared pin (companion panes). */
  after?: () => void;
}

/**
 * The body every apply*Timeframe shares: cancel a pending retry, fetch the HTF
 * candles, fold the forming bar when not waiting for closes, stash what `build`
 * computes on them, and stamp the covered interval. A null/"chart" timeframe
 * clears the pin instead. Config comes from the caller, not re-read from live
 * extendData, so a param change can't race the write.
 */
async function applyHtfPin<E extends { mtf?: unknown }>(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  timeframe: string | null,
  brokerId: string | undefined,
  needed: NeededInterval | undefined,
  spec: HtfPinSpec<E>,
): Promise<void> {
  cancelMtfRetry(chart, paneId, name); // this apply supersedes any pending retry
  const ind = getIndicator(chart, paneId, name) as { extendData?: E } | null;
  const waitClose = readWaitClose(ind);
  const ext = spec.extend((ind?.extendData ?? {}) as E);
  const prev = ind?.extendData?.mtf as MtfSeriesBase | undefined;
  const write = () => {
    overrideExtend(chart, paneId, name, ext as Record<string, unknown>, spec.calcParams);
    spec.after?.();
  };

  if (!timeframe || timeframe === "chart") {
    clearMtfRetry(chart, paneId, name);
    ext.mtf = { timeframe: null };
    write();
    return;
  }

  const need = needed ?? neededOf(chart);
  const { htf, htfMs, failed, askFromMs, askToMs } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    spec.warmup(ext),
    brokerId,
    need,
    prev,
  );
  const proceed = mtfFetchTail(
    chart,
    paneId,
    name,
    timeframe,
    failed,
    htf.length > 0,
    prev,
    ext,
    spec.calcParams,
    () => applyHtfPin(chart, epic, name, paneId, timeframe, brokerId, needed, spec),
  );
  if (!proceed) return;
  // The forming fold only exists DOCKED at the live edge: a detached interval
  // (deep-history jump) has no bucket adjoining the chart's newest candles to
  // fold. The pin's waitClose choice must survive the detached shape anyway.
  const fp =
    waitClose || !dockedAt(chart, askToMs, htfMs)
      ? null
      : prepFormingBars(chart, htf, htfMs, timeframe);
  const bars = fp ? fp.bars : (spec.closedBars?.(htf, htfMs, timeframe) ?? htf);
  ext.mtf = {
    chartMs: chartIntervalOf(chart),
    epic,
    ...spec.build(bars, timeframe, htfMs, ext),
    ...(fp?.extra ?? (waitClose ? {} : { waitClose: false })),
    // A completed walk is final for its ask: stamp how far back it ASKED so
    // the refresh pass can call this covered even when the bars stop short
    // (see MtfSeriesBase.coveredFromMs). Without it every deep history
    // extension re-walked and re-computed on EVERY refresh trigger, the
    // recurring multi-second freeze after a years-deep pattern jump. Never on
    // a failed walk: the retry path owns that, and a transient outage may
    // genuinely have more to give.
    ...(!failed ? { coveredFromMs: askFromMs, coveredToMs: askToMs } : {}),
  };
  write();
}

/**
 * Point an EMA/MA at a higher timeframe (or back to the chart timeframe when
 * `timeframe` is null/"chart"). Fetches the HTF candles, computes the MA on
 * them, and writes the result onto extendData; calc aligns it to the chart bars.
 * Returns once the override is applied (so callers can show pending state).
 */
export async function applyMaTimeframe(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  config: MaConfig,
  timeframe: string | null,
  // HTF candles are broker-specific (epics aren't portable); fetch from the chart's
  // active broker. Defaults to "capital" via fetchRange when omitted.
  brokerId?: string,
  // The interval the stash must cover (visible range plus margins). Omitted by
  // settings panels and headless callers: derived from the chart's registered
  // viewport reader, falling back to the full loaded span.
  needed?: NeededInterval,
): Promise<void> {
  return applyHtfPin<MaExtend>(chart, epic, name, paneId, timeframe, brokerId, needed, {
    extend: (live) => ({ ...live, ...config.options }),
    calcParams: [config.length],
    // Reach back the MA length + the smoothing window, so the smoothing MA's
    // own warmup never lands on the oldest visible bars.
    warmup: () => {
      const sm = config.options.smoothing;
      return config.length + (sm && sm.type !== "none" ? Number(sm.length) || 0 : 0);
    },
    build: (bars, tf, htfMs) => buildMaMtf(bars, config, tf, htfMs),
  });
}

/** Base + smoothing computed on the native HTF bars (smoothing before
 * alignment, so it never leaks across chart bars); calc aligns both. The
 * envelope stays chart-TF-only — see computeMa's MTF branch. Shared by the
 * apply above and refreshFormingBar's per-tick recompute. */
function buildMaMtf(
  bars: KLineData[],
  config: MaConfig,
  timeframe: string,
  htfMs: number,
): MaExtend["mtf"] {
  const { base, smoothing } = maSeries(
    bars,
    config.kind,
    config.length,
    config.options,
  );
  return {
    timeframe,
    htfStarts: bars.map((b) => b.timestamp),
    htfSeries: base,
    htfSmoothing: smoothing,
    htfMs,
  };
}

interface PivotBandsConfig {
  n: number; // strength (calcParams[0])
  k: number; // avg window (calcParams[1])
  mode: PivotBandsMode;
  source: PivotBandsSource; // price the swings are detected on ("hl" default)
}

// Pivot Bands need enough HTF history *before* the oldest visible bar to have a
// confirmed pivot to show. Unlike EMA/MA convergence this is best-effort (pivots
// are sparse — no fixed window guarantees one), so a blank left edge is possible
// and correct; 2·N (pivot + confirmation lag) plus K (avg window) is a sensible
// reach-back margin.
const pivotWarmup = (n: number, k: number) => 2 * n + k;

/**
 * Point Pivot Bands at a higher timeframe (or back to the chart timeframe when
 * `timeframe` is null/"chart"). Fetches the HTF candles, computes the two
 * step-lines on them, and writes BOTH series onto extendData; calc aligns them
 * onto the live chart bars (no lookahead). Mode/strength come from `config`, not
 * from re-reading live extendData, so a param change can't race the write.
 */
export async function applyPivotBandsTimeframe(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  config: PivotBandsConfig,
  timeframe: string | null,
  brokerId?: string,
  needed?: NeededInterval,
): Promise<void> {
  return applyHtfPin<PivotBandsExtend>(chart, epic, name, paneId, timeframe, brokerId, needed, {
    extend: (live) => ({ ...live, mode: config.mode, source: config.source }),
    calcParams: [config.n, config.k],
    warmup: () => pivotWarmup(config.n, config.k),
    // Reuse the exact chart-TF math on the HTF bars: computePivotBands already
    // carries each side's value forward (dense after the first pivot) and bakes
    // in the N-bar confirmation lag, so the aligned series stays gap-free and
    // honest.
    build: (bars, tf, htfMs) => buildPivotBandsMtf(bars, config, tf, htfMs),
    // The bars-since companion is derived from this extendData: re-sync so it
    // follows the new stash (or, unpinned, counts in chart bars again).
    after: () => syncPivotBarsSinceCompanion(chart, name),
  });
}

function buildPivotBandsMtf(
  bars: KLineData[],
  config: PivotBandsConfig,
  timeframe: string,
  htfMs: number,
): PivotBandsExtend["mtf"] {
  const pts = computePivotBands(bars, config.n, config.k, {
    mode: config.mode,
    source: config.source,
  });
  // Bars-since is counted on the SAME HTF bars (so its unit is HTF bars, which
  // is what the backend operand does too) and stashed alongside:
  // they are not derivable from the step-prices above, since two consecutive
  // pivots can print the same price. Computed unconditionally — cheap next to
  // the fetch, and it keeps the stash valid the instant the user ticks the box.
  const since = computePivotBarsSince(bars, config.n, { source: config.source });
  return {
    timeframe,
    htfStarts: bars.map((b) => b.timestamp),
    htfHigh: pts.map((p) => p.pivotHigh),
    htfLow: pts.map((p) => p.pivotLow),
    htfBarsSinceHigh: since.map((p) => p.barsSinceHigh),
    htfBarsSinceLow: since.map((p) => p.barsSinceLow),
    htfMs,
  };
}

// S/R levels accumulate over the staleness window rather than converging like a
// moving average, so the honest reach-back is the full window: ATR warm-up +
// one pivot span + maxBars. Best-effort like PivotBands — a shallow HTF history
// simply yields fewer levels.
const srWarmup = (cfg: SrLevelsConfig) =>
  SR_ATR_LEN + 2 * cfg.pivotLen + cfg.maxBars;

/**
 * Point S/R Levels at a higher timeframe (or back to the chart timeframe when
 * `timeframe` is null/"chart"). Fetches the HTF candles, computes the per-bar
 * nearest-support/resistance series AND the major-level list on them, and
 * stashes both on extendData (levels keyed by TIMESTAMP so calc can map them
 * onto whatever chart bars are loaded); calc aligns with waitClose semantics
 * (no lookahead). Config comes from the caller, not re-read from live
 * extendData, so a param change can't race the write.
 */
export async function applySrLevelsTimeframe(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  config: SrLevelsConfig,
  timeframe: string | null,
  brokerId?: string,
  needed?: NeededInterval,
): Promise<void> {
  return applyHtfPin<SrLevelsExtend>(chart, epic, name, paneId, timeframe, brokerId, needed, {
    extend: (live) => ({ ...live }),
    calcParams: [
      config.pivotLen,
      config.atrMult,
      config.minTouches,
      config.maxLevels,
      config.maxBars,
    ],
    warmup: () => srWarmup(config),
    // Reuse the exact chart-TF math on the HTF bars: clustering, touch gating
    // and the pivot-confirmation lag are all baked into the stashed
    // series/levels.
    build: (bars, tf, htfMs) => buildSrMtf(bars, config, tf, htfMs),
  });
}

function buildSrMtf(
  bars: KLineData[],
  config: SrLevelsConfig,
  timeframe: string,
  htfMs: number,
): SrLevelsExtend["mtf"] {
  const { points, levels } = computeSrLevels(bars, config);
  return {
    timeframe,
    htfStarts: bars.map((b) => b.timestamp),
    htfMs,
    htfSupport: points.map((p) => p.support),
    htfResistance: points.map((p) => p.resistance),
    htfLevels: levels.map((lv) => ({
      price: lv.price,
      halfWidth: lv.halfWidth,
      touches: lv.touches,
      firstTs: bars[lv.firstIdx].timestamp,
      lastTs: bars[lv.lastIdx].timestamp,
    })),
  };
}

/**
 * Point Auto Fib at a higher timeframe (or back to the chart timeframe when
 * `timeframe` is null/"chart"). Same shape as applySrLevelsTimeframe: fetch
 * the HTF candles, run the chart-TF pair detector on them, and stash the pair
 * current on each HTF bar plus the pairs (anchors keyed by TIMESTAMP); calc
 * aligns the index with waitClose semantics (no lookahead). The fetch reach is
 * the operand warm-up only: past fibs older than the fetched span are simply
 * not drawn, never fetched for (the Trendlines freeze lesson).
 */
export async function applyAutoFibTimeframe(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  config: AutoFibConfig,
  timeframe: string | null,
  brokerId?: string,
  needed?: NeededInterval,
): Promise<void> {
  return applyHtfPin<AutoFibExtend>(chart, epic, name, paneId, timeframe, brokerId, needed, {
    extend: (live) => ({ ...live }),
    calcParams: [config.pivotLen, config.minSwingAtr],
    warmup: () => autoFibWarmup(config),
    build: (bars, tf, htfMs) => buildAutoFibMtf(bars, config, tf, htfMs),
  });
}

function buildAutoFibMtf(
  bars: KLineData[],
  config: AutoFibConfig,
  timeframe: string,
  htfMs: number,
): AutoFibExtend["mtf"] {
  const { pairOf, pairs, pivots } = computeAutoFibPairs(bars, config);
  return {
    timeframe,
    htfStarts: bars.map((b) => b.timestamp),
    htfMs,
    htfFibPairIdx: pairOf,
    htfFibPairs: pairs.map((p) => ({
      hiTs: bars[p.hiIdx].timestamp,
      hiPrice: p.hiPrice,
      loTs: bars[p.loIdx].timestamp,
      loPrice: p.loPrice,
      dir: p.dir,
    })),
    // The counted pivots, for Show pivots. Stashed always (a setting flip must
    // not wait on a refetch); small next to the bars themselves.
    htfFibPivots: pivots.map((v) => ({
      ts: bars[v.idx].timestamp,
      kind: v.kind,
      price: v.kind === "high" ? bars[v.idx].high : bars[v.idx].low,
    })),
  };
}

// A trendline reaches back to its oldest anchor, and only Max Span bounds that
// — which is 0 = OFF by default, so the off state needs the LARGER reach, not a
// zero one. With no span ceiling the pairing width is the honest stand-in: a
// line's first anchor is at most `pairPivots` pivots before its second, and a
// pivot costs 2 * pivotLen + 1 bars at minimum. On top of that: the ATR warm-up,
// one pivot confirm, and the projection horizon a line stays live for after its
// last touch. Best-effort like S/R Levels — a shallow HTF history simply yields
// fewer lines.
// The pairing term is CAPPED at MAX_PAIR_PIVOTS even though the detector
// honors the configured width: pairPivots has no upper bound in the settings,
// and multiplied into a reach-back it turns a large value into a demand for
// more HTF history than any broker serves (2000 slots asked for ~22k daily
// bars), which the coverage guard then chased with a refetch + full recompute
// on every trigger, forever. Best-effort is the contract here, and the cap is
// what keeps the ASK inside what a walk can actually settle.
// Lookback bounds it outright: no line at bar i starts before i - Lookback,
// so the ATR warm-up and one pivot window on top of it are all a view needs.
const tlWarmup = (cfg: TrendlinesConfig): number => {
  const reach =
    TL_ATR_LEN +
    2 * cfg.pivotLen +
    cfg.maxProjBars +
    (cfg.maxSpanBars > 0
      ? cfg.maxSpanBars
      : Math.min(cfg.pairPivots, MAX_PAIR_PIVOTS) * (2 * cfg.pivotLen + 1));
  return cfg.lookbackBars > 0
    ? Math.min(reach, TL_ATR_LEN + 2 * cfg.pivotLen + cfg.lookbackBars)
    : reach;
};

/**
 * Point Trendlines at a higher timeframe (or back to the chart timeframe when
 * `timeframe` is null/"chart"). Fetches the HTF candles, runs the SAME detector
 * on them, and stashes both the four operand series and the live line list;
 * calc aligns the series onto the chart bars with waitClose semantics (no
 * lookahead) and the draw path converts the lines' HTF bar indices to pixels.
 * Config comes from the caller, not re-read from live extendData, so a param
 * change can't race the write.
 */
export async function applyTrendlinesTimeframe(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  config: TrendlinesConfig,
  timeframe: string | null,
  brokerId?: string,
  needed?: NeededInterval,
): Promise<void> {
  return applyHtfPin<TrendlinesExtend>(chart, epic, name, paneId, timeframe, brokerId, needed, {
    extend: (live) => ({ ...live }),
    // Object.values ORDER IS the calcParams order (TrendlinesConfig's key order
    // mirrors the slot order documented in trendlinesOutputs.ts), so a param
    // added to the interface reaches the pane with no line to update here.
    calcParams: Object.values(config),
    warmup: () => tlWarmup(config),
    // CLOSED HTF BARS ONLY unless the forming bucket is folded in. The forming
    // bar is never usable to a waitClose operand, so letting it seed or break a
    // line would put geometry on the chart that no rule can read, and repaint
    // it when the bar finishes.
    closedBars: (htf, htfMs, tf) => {
      const data = chart.getDataList();
      const newestMs = data.length ? data[data.length - 1].timestamp : 0;
      return newestMs
        ? htf.filter((b) => htfBarEndMs(b.timestamp, htfMs, tf) <= newestMs)
        : htf;
    },
    build: (bars, tf, htfMs) => {
      setTrendlinesHtfBars(chart, name, bars);
      return buildTrendlinesMtf(bars, config, tf, htfMs);
    },
  });
}

function buildTrendlinesMtf(
  bars: KLineData[],
  config: TrendlinesConfig,
  timeframe: string,
  htfMs: number,
): TrendlinesExtend["mtf"] {
  // The exact chart-TF detector on the HTF bars: pivots, touches, breaks and
  // the confirmation lag are all baked into the stashed series and lines.
  const { points, lines, atr, pivots } = computeTrendlines(bars, config);
  return {
    timeframe,
    htfStarts: bars.map((b) => b.timestamp),
    htfMs,
    htfOutputs: trendlinesOutputs(config),
    htfPoints: points,
    htfLines: lines,
    htfPivots: pivots,
    htfAtr: atr[atr.length - 1],
  };
}

// Gaps persist over the staleness window rather than converging like a moving
// average, so the honest reach-back is the full window: ATR warm-up + the two
// bars the pattern spans + maxBars. Best-effort like S/R Levels — a shallow HTF
// history simply yields fewer gaps.
const fvgReachBack = (cfg: FvgConfig) => FVG_ATR_LEN + 2 + cfg.maxBars;

/**
 * Point FVG at a higher timeframe (or back to the chart timeframe when
 * `timeframe` is null/"chart"). Fetches the HTF candles, computes the per-bar
 * nearest-gap series AND the live gap list on them, and stashes both on
 * extendData (gaps keyed by TIMESTAMP so calc can map them onto whatever chart
 * bars are loaded); calc aligns with waitClose semantics (no lookahead). Config
 * comes from the caller, not re-read from live extendData, so a param change
 * can't race the write. Mirrors applySrLevelsTimeframe above.
 */
export async function applyFvgTimeframe(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  config: FvgConfig,
  timeframe: string | null,
  brokerId?: string,
  needed?: NeededInterval,
): Promise<void> {
  return applyHtfPin<FvgExtend>(chart, epic, name, paneId, timeframe, brokerId, needed, {
    extend: (live) => ({ ...live }),
    calcParams: [config.minSize, config.maxBars, config.maxGaps],
    warmup: () => fvgReachBack(config),
    // Reuse the exact chart-TF math on the HTF bars: detection, the size filter
    // and wick-driven mitigation are all baked into the stashed series/gaps.
    build: (bars, tf, htfMs) => buildFvgMtf(bars, config, tf, htfMs),
  });
}

function buildFvgMtf(
  bars: KLineData[],
  config: FvgConfig,
  timeframe: string,
  htfMs: number,
): FvgExtend["mtf"] {
  const { points, gaps } = computeFvg(bars, config);
  return {
    timeframe,
    htfStarts: bars.map((b) => b.timestamp),
    htfMs,
    htfBullTop: points.map((p) => p.bullTop),
    htfBullBottom: points.map((p) => p.bullBottom),
    htfBearTop: points.map((p) => p.bearTop),
    htfBearBottom: points.map((p) => p.bearBottom),
    htfGaps: gaps.map((g) => ({
      side: g.side,
      top: g.top,
      bottom: g.bottom,
      createdTs: bars[g.createdIdx].timestamp,
    })),
  };
}

interface SlopeConfig {
  maType: MaKind;
  lengths: number[]; // calcParams — one MA length per line
  slopeN: number;
  units: SlopeUnit;
  smoothing?: SlopeSmoothing;
  options: MaExtend; // source/offset
}

/**
 * Point the Slope indicator at a higher timeframe (or back to the chart timeframe
 * when `timeframe` is null/"chart"). Slope is computed on the NATIVE HTF bars,
 * at the pinned timeframe's NOMINAL bar width, BEFORE alignment — step for step
 * what the rule path does for a pinned reference (the IndicatorRef branch of
 * strategy/expr/evaluate.py::series_of: `spec.series(..., tf_candles,
 * _tf_hours(tf_res))`, then align_htf_to_base), so a rule reading
 * `SLOPE.9` gets the line this draws. One slope series is computed per MA
 * length and stashed on
 * extendData.mtf.htfSeriesByLine (same length/order as calcParams) —
 * computeSlopeCalc's MTF branch assumes this.
 */
export async function applySlopeTimeframe(
  chart: Chart,
  epic: string,
  name: string,
  paneId: string,
  config: SlopeConfig,
  timeframe: string | null,
  brokerId?: string,
  needed?: NeededInterval,
): Promise<void> {
  return applyHtfPin<SlopeExtend>(chart, epic, name, paneId, timeframe, brokerId, needed, {
    extend: (live) => ({
      ...live,
      ...config.options,
      maType: config.maType,
      units: config.units,
    }),
    calcParams: config.lengths,
    // Reach back the longest MA length + slope period + accel period (+ both
    // smoothing windows) so the HTF left edge is populated for every line.
    warmup: (ext) => {
      const smLen =
        config.smoothing && config.smoothing.type !== "none"
          ? Number(config.smoothing.length) || 0
          : 0;
      const aSmLen =
        ext.accelSmoothing && ext.accelSmoothing.type !== "none"
          ? Number(ext.accelSmoothing.length) || 0
          : 0;
      const n2 = slopePeriodOf(ext.accelPeriod, 3);
      return (
        Math.max(...config.lengths) +
        config.slopeN +
        smLen +
        (ext.showAccel ? n2 + aSmLen : 0)
      );
    },
    // Slope computed on native HTF bars, BEFORE alignHtfToChart forward-fills.
    //
    // barHours is the PINNED timeframe's nominal width, not one measured off
    // the fetched HTF bars: the rule path has no bars to measure and computes
    // exactly this number (evaluate.py's pinned IndicatorRef branch passes
    // `_tf_hours(tf_res)`), so measuring here would make the plotted line and
    // the rule operand two different series. A MONTH pin's smallest gap is a
    // 28-day February: 672h against the nominal 720h, a ~7% silent divergence.
    // inferBarHours falls back to 1.0 when fewer than two HTF bars have loaded,
    // which for a DAY pin is a 24x error. `timeframe` is a canonical resolution
    // here, but nominalBarHours accepts a pin alias too, matching the backend's
    // `tf_resolution(pin) or pin`. The infer fallback covers only a resolution
    // name in neither table, which fetchHtfBars would already have paged at
    // its own 1h default, so there is nothing better to fall back to.
    build: (bars, tf, htfMs, ext) => buildSlopeMtf(bars, config, ext, tf, htfMs),
    // The companion mirrors the parent's extendData (including the MTF stash).
    after: () => syncAccelCompanion(chart, name),
  });
}

function buildSlopeMtf(
  bars: KLineData[],
  config: SlopeConfig,
  ext: SlopeExtend,
  timeframe: string,
  htfMs: number,
): SlopeExtend["mtf"] {
  const n2 = slopePeriodOf(ext.accelPeriod, 3);
  const barHours = nominalBarHours(timeframe) ?? inferBarHours(bars);
  const byLine = config.lengths.map((len) =>
    slopeLineSeries(
      bars,
      config.maType,
      len,
      config.slopeN,
      config.units,
      config.options.source,
      config.smoothing,
      barHours,
    ),
  );
  // Acceleration computed on NATIVE HTF bars too (same barHours), then aligned by
  // computeAccelCalc. Differentiating the ALIGNED slope would read zero inside each
  // HTF bucket and spike at the boundaries, and would diverge from the rule value.
  // Gated on showAccel, so it is undefined when the companion pane is off.
  const accelByLine = ext.showAccel
    ? config.lengths.map((len) =>
        accelLineSeries(
          bars,
          config.maType,
          len,
          config.slopeN,
          n2,
          config.units,
          config.options.source,
          config.smoothing,
          ext.accelSmoothing,
          barHours,
        ),
      )
    : undefined;
  // Same lengths/source HTF MA base for the on-chart MA curves, smoothed on the
  // HTF bars (before alignment, so smoothing never leaks across chart bars) to
  // follow the Slope's smoothing, stashed transiently alongside the slope
  // series, aligned in slopeMaLines. See SlopeExtend.mtf.htfMaBaseByLine.
  const maBaseByLine = config.lengths.map((len) =>
    smoothSeries(
      maSeries(bars, config.maType, len, { source: config.options.source }).base,
      config.smoothing,
    ),
  );
  return {
    timeframe,
    htfStarts: bars.map((b) => b.timestamp),
    htfSeriesByLine: byLine,
    htfMaBaseByLine: maBaseByLine,
    htfAccelByLine: accelByLine,
    htfMs,
  };
}

/**
 * Write the pin's "Wait for timeframe closes" choice onto the live indicator.
 * Only the flag moves — the stashed series stays, so the settings toggle can
 * flip it and then run the per-type apply to rebuild the stash in the new
 * mode without an intermediate blank. `true` REMOVES the flag (absent = wait,
 * the default), keeping every pre-feature persisted shape byte-identical.
 */
export function setMtfWaitClose(
  chart: Chart,
  paneId: string,
  name: string,
  waitClose: boolean,
): void {
  const ind = getIndicator(chart, paneId, name) as {
    extendData?: { mtf?: MtfSeriesBase };
  } | null;
  if (!ind) return;
  const ext = { ...(ind.extendData ?? {}) } as { mtf?: MtfSeriesBase };
  const mtf = { ...(ext.mtf ?? { timeframe: null }) };
  if (waitClose) delete mtf.waitClose;
  else mtf.waitClose = false;
  ext.mtf = mtf;
  overrideExtend(chart, paneId, name, ext);
}

// Tick-rate coalescing for refreshFormingBar: one full recompute per second
// per chart is plenty (the folded bar only matters at human reading speed) and
// keeps the per-tick cost flat however fast the stream runs. Leading-edge on
// purpose — the first tick after a quiet spell updates immediately; ticks are
// frequent enough that no trailing call is needed. Date.now(), not a timer:
// nothing to leak on chart disposal (WeakMap, like mtfRetries).
const FORMING_THROTTLE_MS = 1_000;
const formingLastRun = new WeakMap<Chart, number>();

export function refreshFormingBarThrottled(chart: Chart): void {
  const now = Date.now();
  const last = formingLastRun.get(chart) ?? 0;
  if (now - last < FORMING_THROTTLE_MS) return;
  formingLastRun.set(chart, now);
  refreshFormingBar(chart);
}

/**
 * Re-fold the forming HTF bar for every pin that opted out of waiting
 * ("Wait for timeframe closes" unchecked) and recompute its series — from the
 * STASHED closed bars, never a refetch, so it is cheap enough for the live
 * newest-candle update path (the caller throttles). Synchronous on purpose:
 * nothing here awaits, so a tick can never interleave with itself.
 *
 * Config derivation per type mirrors refreshMtfIndicators below (calcParams +
 * extendData are the on-chart source of truth for both). When the forming
 * bucket has CLOSED, the fold still covers it — candles past the bucket are
 * ignored — and the next full refresh (refreshMtfIndicators / the replay
 * bucket-crossing refetch) graduates it to a fetched closed bar.
 */
export function refreshFormingBar(chart: Chart): void {
  const byPane = getIndicatorsByPane(chart);
  if (!byPane) return;
  byPane.forEach((nameMap, paneId) => {
    nameMap.forEach((indUnknown, id) => {
      const ind = indUnknown as {
        visible?: boolean;
        calcParams?: unknown[];
        extendData?: MaExtend & PivotBandsExtend & SlopeExtend;
      };
      // Nothing on screen: skip the fold + recompute. The next refresh after
      // the indicator reappears rebuilds the series from fetched bars anyway.
      if (ind.visible === false) return;
      const mtf = ind.extendData?.mtf as MtfSeriesBase | undefined;
      if (!mtf?.timeframe || mtf.waitClose !== false) return;
      const { htfClosed: closed, htfSeed: seed, htfMs, timeframe } = mtf;
      if (!closed || !timeframe || !(htfMs && htfMs > 0)) return;
      // A DETACHED stash (deep-history view, interval not reaching the live
      // edge) has no forming bucket adjoining the chart's newest candles;
      // folding one would graft live bars onto years-old geometry.
      if (mtf.coveredToMs != null && !dockedAt(chart, mtf.coveredToMs, htfMs)) return;

      const data = chart.getDataList();
      const openMs = formingOpenMs(
        closed.map((b) => b.timestamp),
        htfMs,
        seed,
        timeframe,
      );
      const cursorMs = htfCursors.get(chart)?.() ?? 0;
      const forming =
        openMs != null
          ? foldFormingBar(data, openMs, htfMs, seed, cursorMs || undefined, timeframe)
          : null;
      const bars = forming ? [...closed, forming] : closed;
      const extra: Pick<
        MtfSeriesBase,
        | "waitClose"
        | "formingIdx"
        | "htfClosed"
        | "htfSeed"
        | "coveredFromMs"
        | "coveredToMs"
      > = {
        waitClose: false,
        ...(forming ? { formingIdx: bars.length - 1 } : {}),
        htfClosed: closed,
        ...(seed ? { htfSeed: seed } : {}),
        // Carry the coverage stamps forward: a re-fold recomputes from the
        // ALREADY-STASHED closed bars (no refetch), so the reach the last walk
        // asked for is unchanged. Dropping them let the coverage guard read a
        // stampless stash whose bars stop at the broker's history edge, so
        // every viewport settle refetched + recomputed the identical answer —
        // the freeze loop on a forming-mode pin (US100/OIL_CRUDE DAY).
        ...(mtf.coveredFromMs != null ? { coveredFromMs: mtf.coveredFromMs } : {}),
        ...(mtf.coveredToMs != null ? { coveredToMs: mtf.coveredToMs } : {}),
      };

      const type = indTypeOf({ name: id, extendData: ind.extendData });
      const ext = { ...(ind.extendData ?? {}) } as MaExtend &
        PivotBandsExtend &
        SlopeExtend;
      let built: object | null = null;
      if (type === "EMA" || type === "MA") {
        built = buildMaMtf(
          bars,
          {
            kind: normalizeMaKind(ext.maType, templateMaKind(type)),
            length: Number(ind.calcParams?.[0]) || (type === "EMA" ? 9 : 20),
            options: {
              source: ext.source,
              offset: ext.offset,
              smoothing: ext.smoothing,
              maType: ext.maType,
              envelope: ext.envelope,
            },
          },
          timeframe,
          htfMs,
        );
      } else if (type === "PIVOT_BANDS") {
        built = buildPivotBandsMtf(
          bars,
          {
            n: Number(ind.calcParams?.[0]) || 5,
            k: Number(ind.calcParams?.[1]) || 3,
            mode: ext.mode === "avg" ? "avg" : "last",
            source: ext.source ?? "hl",
          },
          timeframe,
          htfMs,
        );
      } else if (type === "SR_LEVELS") {
        built = buildSrMtf(bars, parseSrConfig(ind.calcParams), timeframe, htfMs);
      } else if (type === "AUTO_FIB") {
        built = buildAutoFibMtf(bars, parseAutoFibConfig(ind.calcParams), timeframe, htfMs);
      } else if (type === "TRENDLINES") {
        setTrendlinesHtfBars(chart, id, bars);
        built = buildTrendlinesMtf(
          bars,
          parseTrendlinesConfig(ind.calcParams, ind.extendData),
          timeframe,
          htfMs,
        );
      } else if (type === "FVG") {
        built = buildFvgMtf(bars, parseFvgConfig(ind.calcParams), timeframe, htfMs);
      } else if (type === "SLOPE") {
        built = buildSlopeMtf(
          bars,
          {
            maType: normalizeMaKind(ext.maType),
            lengths: slopeLengths(ind.calcParams),
            slopeN: slopePeriodOf(ext.slopePeriod, 3),
            units: normalizeSlopeUnit(ext.units),
            smoothing: ext.smoothing,
            options: { source: ext.source, offset: ext.offset },
          },
          ext,
          timeframe,
          htfMs,
        );
      }
      if (!built) return;
      ext.mtf = {
        chartMs: chartIntervalOf(chart),
        epic: mtf.epic, // a fold never changes whose bars these are
        ...built,
        ...extra,
      } as typeof ext.mtf;
      overrideExtend(chart, paneId, id, ext, ind.calcParams ?? []);
      // The companions mirror the parent's extendData, forming bar included.
      if (type === "PIVOT_BANDS") syncPivotBarsSinceCompanion(chart, id);
      if (type === "SLOPE") syncAccelCompanion(chart, id);
    });
  });
}

/**
 * Re-fetch HTF data for every MTF indicator (EMA/MA and Pivot Bands) already
 * configured for a timeframe — call after the symbol or chart timeframe changes,
 * since the stashed HTF series belongs to the previous epic/range. Also the
 * reload path: persistence saves only `mtf:{timeframe}` (no series), so a
 * reloaded MTF indicator renders on the chart timeframe until this refetches.
 * No-op for chart-timeframe indicators.
 *
 * The trigger is the viewport: `needed` is the interval the view requires
 * covered (visible range plus margins). Omitted, it is derived from the
 * chart's registered viewport reader, falling back to the full loaded span
 * (tests, headless callers). An indicator whose stashed interval already
 * covers the need on BOTH ends is skipped — no redundant refetch per settle.
 */
// One refresh in flight per (chart, epic, needed interval) at a time: the
// deep-cover path fires from more than one trigger for the same landing
// (measured: two identical 23s refreshes side by side after a years-deep
// pattern jump), and the second run's walks/computes are byte-identical work.
const refreshInFlight = new WeakMap<Chart, { key: string; done: Promise<void> }>();

// The symbol the last refresh ran for, per chart. refreshMtfOnVisibilityChange
// has no caller-supplied epic (a legend eye click knows nothing about the feed),
// and every path that puts MTF data on a chart comes through refreshMtfIndicators
// first, so recording it here is enough and costs ChartCore no plumbing.
const chartSymbols = new WeakMap<Chart, { epic: string; brokerId?: string }>();

export function refreshMtfIndicators(
  chart: Chart,
  epic: string,
  brokerId?: string,
  needed?: NeededInterval,
): Promise<void> {
  chartSymbols.set(chart, { epic, brokerId });
  const need = needed ?? neededOf(chart);
  const key = `${epic}|${brokerId ?? ""}|${need.fromMs}|${need.toMs}`;
  const inFlight = refreshInFlight.get(chart);
  if (inFlight && inFlight.key === key) return inFlight.done;
  const done = refreshMtfIndicatorsUncoalesced(chart, epic, brokerId, need).finally(
    () => {
      if (refreshInFlight.get(chart)?.done === done) refreshInFlight.delete(chart);
    },
  );
  refreshInFlight.set(chart, { key, done });
  return done;
}

// Coalesces the burst of calls a single gesture makes: the sidebar's master eye
// and a resolution switch sweep every indicator on the chart one by one.
const visibilityRefreshes = new WeakMap<Chart, Promise<void>>();

/**
 * Catch up the MTF work that was skipped while indicators were hidden. Call it
 * after ANY write to an indicator's `visible` flag (the legend eye, the settings
 * modal, the master-hide sweep) -- hiding is as fine a trigger as unhiding,
 * since the pass is coverage-guarded and no-ops when nothing needs fetching.
 *
 * Deliberately NOT coalesced against the viewport-settle refresh: an in-flight
 * pass skipped the instance that just reappeared, so this one has to run after
 * it rather than ride on it.
 */
export function refreshMtfOnVisibilityChange(chart: Chart): Promise<void> {
  // SYNCHRONOUSLY, before the caller's redraw: a chart-timeframe Trendlines needs
  // its compute floor back BEFORE the recalc that the caller's visible-write just
  // scheduled, or that recalc runs against the floor the view had when the
  // indicator was hidden. The stamp pass skips hidden instances and otherwise only
  // runs on a view settle, so this is the one chance to get there first.
  // Ahead of the coalescing check, not inside it: a sweep writes every visible
  // flag before its one call lands here, but two separate toggles inside the same
  // timer window each need their own stamp. Re-stamping is cheap -- an unmoved
  // floor writes nothing.
  stampTrendlinesFloors(chart);
  const pending = visibilityRefreshes.get(chart);
  if (pending) return pending;
  const done = new Promise<void>((resolve) => {
    setTimeout(() => {
      visibilityRefreshes.delete(chart);
      const sym = chartSymbols.get(chart);
      const run = (): Promise<void> =>
        sym
          ? refreshMtfIndicatorsUncoalesced(
              chart,
              sym.epic,
              sym.brokerId,
              neededOf(chart),
            )
          : Promise.resolve();
      const inFlight = refreshInFlight.get(chart)?.done;
      const chained = inFlight ? inFlight.then(run, run) : run();
      void chained
        .catch(() => {})
        .then(() => {
          // A stash that came back COVERED skipped the refetch, so its forming
          // bar is as old as the moment the indicator was hidden -- and on a
          // closed market no tick will ever fold it. Re-fold from the stashed
          // closed bars: no fetch, and a no-op for waitClose stashes.
          try {
            refreshFormingBar(chart);
          } catch {
            // torn down mid-flight
          }
          resolve();
        });
    }, 0);
  });
  visibilityRefreshes.set(chart, done);
  return done;
}

async function refreshMtfIndicatorsUncoalesced(
  chart: Chart,
  epic: string,
  brokerId: string | undefined,
  need: NeededInterval,
): Promise<void> {
  const byPane = getIndicatorsByPane(chart);
  if (!byPane) return;
  const jobs: Promise<void>[] = [];
  byPane.forEach((nameMap, paneId) => {
    nameMap.forEach((indUnknown, id) => {
      // `id` is the instance id (klinecharts name); branch on the real TYPE.
      const ind = indUnknown as {
        name?: string;
        visible?: boolean;
        calcParams?: unknown[];
        extendData?: MaExtend & PivotBandsExtend & SlopeExtend;
      };
      const type = indTypeOf({ name: id, extendData: ind.extendData });
      const stash = ind.extendData?.mtf as MtfSeriesBase | undefined;
      const tf = stash?.timeframe;
      if (!tf) return;

      // A HIDDEN instance fetches nothing: an HTF walk is the most expensive
      // thing this pass does and nothing is on screen to spend it on. The skip
      // is recorded on the stash because the bars it leaves behind may belong
      // to a different epic or chart timeframe by the time the indicator comes
      // back -- the coverage guard below refuses a flagged stash outright, and
      // refreshMtfOnVisibilityChange runs this pass again on unhide.
      if (ind.visible === false) {
        if (!stash.skippedHidden)
          overrideExtend(
            chart,
            paneId,
            id,
            { mtf: { ...stash, skippedHidden: true } },
            ind.calcParams ?? [],
          );
        return;
      }

      // Coverage guard shared by every MTF type: skip the refetch if the
      // stashed interval already covers the needed one on BOTH ends.
      // `warmup` is the type's reach-back margin (MA length; pivot 2N+K).
      const covered = (warmup: number): boolean => {
        if (!stash?.htfStarts?.length || !stash.htfMs) return false;
        // Left behind by a refresh that skipped this instance while it was
        // hidden. Those are the passes that would have replaced the bars, so the
        // interval alone proves nothing: accept the stash only while it is still
        // demonstrably THIS symbol's, on THIS chart timeframe. A pre-epic stash
        // (undefined) can't prove it and refetches once.
        if (
          stash.skippedHidden &&
          !(stash.epic === epic && stash.chartMs === chartIntervalOf(chart))
        )
          return false;
        const start = htfCoverageStartMs(need.fromMs, stash.htfMs, warmup);
        // Left end: the bars may stop short of the coverage start, but the
        // last successful walk already ASKED at least this deep — the broker
        // has nothing more to give for it, so refetching is the identical
        // answer at full cost (see MtfSeriesBase.coveredFromMs: the loop this
        // guard used to feed is what froze a chart whose config out-asked the
        // broker's history).
        const leftOk =
          stash.htfStarts[0] <= start ||
          (stash.coveredFromMs != null && stash.coveredFromMs <= start);
        // Right end: absent coveredToMs reads as "reaches the newest fetched
        // bar" (pre-field stashes were always walked from the live edge). One
        // bucket of slack, since the ask is clamped to now and the forming
        // bucket is never fetchable as closed.
        const lastStart = stash.htfStarts[stash.htfStarts.length - 1];
        const rightAsk = stash.coveredToMs ?? lastStart + stash.htfMs;
        const rightOk = rightAsk >= need.toMs - stash.htfMs;
        return leftOk && rightOk;
      };
      if (type === "EMA" || type === "MA") {
        const ext = ind.extendData ?? {};
        const length = Number(ind.calcParams?.[0]) || (type === "EMA" ? 9 : 20);
        if (covered(length)) return;
        jobs.push(
          applyMaTimeframe(
            chart,
            epic,
            id,
            paneId,
            {
              kind: normalizeMaKind(ext.maType, templateMaKind(type)),
              length,
              options: {
                source: ext.source,
                offset: ext.offset,
                smoothing: ext.smoothing,
                maType: ext.maType,
                envelope: ext.envelope,
              },
            },
            tf,
            brokerId,
            need,
          ),
        );
      } else if (type === "PIVOT_BANDS") {
        const n = Number(ind.calcParams?.[0]) || 5;
        const k = Number(ind.calcParams?.[1]) || 3;
        if (covered(pivotWarmup(n, k))) return;
        const mode: PivotBandsMode =
          ind.extendData?.mode === "avg" ? "avg" : "last";
        const source: PivotBandsSource = ind.extendData?.source ?? "hl";
        jobs.push(
          applyPivotBandsTimeframe(
            chart,
            epic,
            id,
            paneId,
            { n, k, mode, source },
            tf,
            brokerId,
            need,
          ),
        );
      } else if (type === "SR_LEVELS") {
        const cfg = parseSrConfig(ind.calcParams);
        if (covered(srWarmup(cfg))) return;
        jobs.push(
          applySrLevelsTimeframe(
            chart,
            epic,
            id,
            paneId,
            cfg,
            tf,
            brokerId,
            need,
          ),
        );
      } else if (type === "AUTO_FIB") {
        const cfg = parseAutoFibConfig(ind.calcParams);
        if (covered(autoFibWarmup(cfg))) return;
        jobs.push(applyAutoFibTimeframe(chart, epic, id, paneId, cfg, tf, brokerId, need));
      } else if (type === "TRENDLINES") {
        const cfg = parseTrendlinesConfig(ind.calcParams, ind.extendData);
        if (covered(tlWarmup(cfg))) return;
        jobs.push(
          applyTrendlinesTimeframe(
            chart,
            epic,
            id,
            paneId,
            cfg,
            tf,
            brokerId,
            need,
          ),
        );
      } else if (type === "FVG") {
        const cfg = parseFvgConfig(ind.calcParams);
        if (covered(fvgReachBack(cfg))) return;
        jobs.push(
          applyFvgTimeframe(
            chart,
            epic,
            id,
            paneId,
            cfg,
            tf,
            brokerId,
            need,
          ),
        );
      } else if (type === "SLOPE") {
        const ext = ind.extendData ?? {};
        const lengths = slopeLengths(ind.calcParams);
        const slopeN = slopePeriodOf(ext.slopePeriod, 3);
        const smLen =
          ext.smoothing && ext.smoothing.type !== "none"
            ? Number(ext.smoothing.length) || 0
            : 0;
        // Match applySlopeTimeframe's reach-back: when the accel companion is on,
        // the HTF series must warm the extra accel period + accel smoothing too, or
        // a scroll-back page can leave the accel line's left edge blank.
        const aSmLen =
          ext.accelSmoothing && ext.accelSmoothing.type !== "none"
            ? Number(ext.accelSmoothing.length) || 0
            : 0;
        const accelWarm = ext.showAccel
          ? slopePeriodOf(ext.accelPeriod, 3) + aSmLen
          : 0;
        if (covered(Math.max(...lengths) + slopeN + smLen + accelWarm)) return;
        jobs.push(
          applySlopeTimeframe(
            chart,
            epic,
            id,
            paneId,
            {
              maType: normalizeMaKind(ext.maType),
              lengths,
              slopeN,
              units: normalizeSlopeUnit(ext.units),
              smoothing: ext.smoothing,
              options: { source: ext.source, offset: ext.offset },
            },
            tf,
            brokerId,
            need,
          ),
        );
      }
    });
  });
  await Promise.all(jobs);
}

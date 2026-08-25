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
import { maSeries, htfCoverageStartMs, normalizeMaKind, type MaKind, type MtfSeriesBase } from "./mtf";
import { pageHistoryBack } from "./historyPaging";
import { barCloseMs } from "./replayBars";
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
import { computeTrendlines, type TrendlinesExtend } from "./indicators/trendlines";
import {
  parseTrendlinesConfig,
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
// so a wide loaded span needs several pages walked back — kept under the cap.
const HTF_PAGE_BARS = 900;
// Bound the walk-back so a pathological span can't spin forever; 40 pages of 900
// bars (36k HTF bars) covers any realistic loaded chart range.
const HTF_MAX_PAGES = 40;
const HTF_MAX_EMPTY = 3; // consecutive empty windows before declaring exhausted

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

export function setHtfCursorClamp(chart: Chart, read: (() => number) | null): void {
  if (read) htfCursors.set(chart, read);
  else htfCursors.delete(chart);
}

/** Keep only HTF bars fully CLOSED at the cursor. `cursorMs` 0 = not replaying.
 *
 * Closes come from barCloseMs — the NEXT bar's timestamp, which is the truth for
 * the calendar-bucketed derived timeframes the backend folds. Only the newest
 * fetched bar (the one still forming, in the normal case) falls back to the
 * nominal width, and that fallback is what releases a bucket the instant the
 * cursor reaches its close. */
export function clampHtfBars(bars: KLineData[], cursorMs: number, nominalMs: number): KLineData[] {
  if (!cursorMs) return bars;
  const out: KLineData[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (barCloseMs(bars, i, nominalMs) <= cursorMs) out.push(bars[i]);
    else break; // ascending: everything after this is later still
  }
  return out;
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
  let smallest = 0;
  for (const [, byName] of getIndicatorsByPane(chart)) {
    for (const [, ind] of byName) {
      const tf = (ind.extendData as { mtf?: MtfSeriesBase } | undefined)?.mtf?.timeframe;
      if (!tf) continue;
      const ms = (nominalBarHours(tf) ?? 0) * 3_600_000;
      if (ms > 0 && (smallest === 0 || ms < smallest)) smallest = ms;
    }
  }
  return smallest;
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
  const mtf =
    prev?.timeframe === timeframe && prev.htfStarts?.length ? prev : { timeframe };
  overrideExtend(chart, paneId, name, { ...ext, mtf }, calcParams);
  return false;
}

interface MaConfig {
  kind: MaKind;
  length: number;
  options: MaExtend; // source / offset / smoothing
}

/**
 * Fetch (and page back over) the higher-timeframe candles an MTF indicator needs
 * to cover the chart's whole loaded span. Shared by every MTF indicator — only
 * the per-indicator series computation differs afterwards.
 *
 * `warmupBars` is how many HTF bars of history the indicator needs *before* the
 * oldest visible bar so its left edge is populated (MA warmup for EMA/MA; enough
 * pivot history for Pivot Bands). A failed fetch (broker down/reconnecting)
 * never throws — it returns whatever pages already landed with `failed: true`,
 * so the caller can render partial data and schedule a retry, while the base
 * indicator keeps working.
 */
async function fetchHtfBars(
  chart: Chart,
  epic: string,
  timeframe: string,
  warmupBars: number,
  brokerId: string | undefined,
  oldestChartMs: number | undefined,
): Promise<{ htf: KLineData[]; htfMs: number; failed: boolean }> {
  // nominalBarHours, not a bare RESOLUTION_SECONDS lookup, so a pin ALIAS ("1H")
  // scores the same width here as it does in mtfBucketMs — the two must agree, or
  // an alias would page at the 1h default with htfMs 0, which corrupts the
  // coverage start, the stashed htfMs the alignment reads, AND clampHtfBars'
  // newest-bar fallback (`timestamp + 0` admits the still-forming bucket).
  const htfSec = (nominalBarHours(timeframe) ?? 0) * 3600;
  const htfMs = htfSec * 1000;
  // Cover the chart's whole loaded span, not just recent bars: reach back to the
  // oldest loaded bar (or the explicit scroll-back page's first bar) plus warmup.
  const data = chart.getDataList();
  const newestMs = data.length ? data[data.length - 1].timestamp : Date.now();
  const loadedOldest = data.length ? data[0].timestamp : newestMs;
  const oldest = Math.min(oldestChartMs ?? loadedOldest, loadedOldest);
  const fromMs = htfCoverageStartMs(oldest, htfMs, warmupBars);

  let htf: KLineData[] = [];
  let failed = false;
  try {
    await pageHistoryBack<KLineData>({
      fromTs: fromMs,
      toTs: newestMs,
      resSec: htfSec || 3600,
      pageBars: HTF_PAGE_BARS,
      maxPages: HTF_MAX_PAGES,
      maxEmpty: HTF_MAX_EMPTY,
      isStale: () => false,
      getData: () => htf,
      // A non-2xx page marks the whole fetch failed (the rethrow stops the
      // walk); pages that already landed are kept and rendered.
      fetchOlder: async (fSec, tSec) => {
        try {
          // THE PANE'S OWN PRICE SIDE, not a hardcoded "mid". Read here rather
          // than threaded through every apply*/refresh signature, the same way
          // useLiveMarketData's centre-pin reads it (App re-saves settings and
          // fires at:settings-saved; a side change reloads the series, which
          // refreshes the pins). One reader cannot drift from the chart's.
          //
          // It looked cosmetic while MTF meant moving averages: mid vs bid
          // shifts a curve by half a spread. It is not. Trendlines decide
          // BOOLEANS against these bars — measured on a DAL daily pane, a
          // support line's break came to bid low 84.52 against a threshold of
          // 85.11 while the mid low was 85.13, so the mid bars left the line
          // unbroken, drawn solid, still emitting as live support on a chart
          // whose own candles had gone through it.
          const side = loadSettings().priceSide;
          return await fetchRangeStrict(epic, timeframe, fSec, tSec, side, brokerId);
        } catch (e) {
          failed = true;
          throw e;
        }
      },
      applyData: (merged) => {
        htf = merged;
      },
    });
  } catch {
    failed = true;
  }
  // The no-lookahead clamp, applied HERE because every MTF indicator's apply*
  // funnels through this one fetch — patching each of them separately is how the
  // rule drifts. Read at the END, after the awaits, so a fetch already in flight
  // when a session starts is clamped on resolution too.
  const cursorMs = htfCursors.get(chart)?.() ?? 0;
  return { htf: clampHtfBars(htf, cursorMs, htfMs), htfMs, failed };
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
  // Oldest chart bar (ms) the HTF series must reach back to. Passed explicitly by
  // the scroll-back loader (the just-fetched older page's first bar); otherwise
  // read from the chart's current dataList. Drives how far back the HTF series is
  // paged so the overlay spans the whole loaded range, not just recent bars.
  oldestChartMs?: number,
): Promise<void> {
  cancelMtfRetry(chart, paneId, name); // this apply supersedes any pending retry
  const ind = getIndicator(chart, paneId, name) as { extendData?: MaExtend } | null;
  const ext: MaExtend = { ...(ind?.extendData ?? {}), ...config.options };

  if (!timeframe || timeframe === "chart") {
    clearMtfRetry(chart, paneId, name);
    ext.mtf = { timeframe: null };
    overrideExtend(chart, paneId, name, ext, [config.length]);
    return;
  }

  const { htf, htfMs, failed } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    config.length,
    brokerId,
    oldestChartMs,
  );
  const proceed = mtfFetchTail(
    chart,
    paneId,
    name,
    timeframe,
    failed,
    htf.length > 0,
    ind?.extendData?.mtf,
    ext,
    [config.length],
    () => applyMaTimeframe(chart, epic, name, paneId, config, timeframe, brokerId, oldestChartMs),
  );
  if (!proceed) return;
  // MTF carries the base line only (smoothing is not shown under MTF — see
  // computeMa's MTF branch), so take the base series here.
  const { base } = maSeries(htf, config.kind, config.length, config.options);
  ext.mtf = {
    timeframe,
    htfStarts: htf.map((b) => b.timestamp),
    htfSeries: base,
    htfMs,
  };
  overrideExtend(chart, paneId, name, ext, [config.length]);
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
  oldestChartMs?: number,
): Promise<void> {
  cancelMtfRetry(chart, paneId, name); // this apply supersedes any pending retry
  const ind = getIndicator(chart, paneId, name) as { extendData?: PivotBandsExtend } | null;
  const ext: PivotBandsExtend = { ...(ind?.extendData ?? {}), mode: config.mode, source: config.source };
  const calcParams = [config.n, config.k];

  if (!timeframe || timeframe === "chart") {
    clearMtfRetry(chart, paneId, name);
    ext.mtf = { timeframe: null };
    overrideExtend(chart, paneId, name, ext, calcParams);
    // The bars-since companion is derived from this extendData: re-sync so it
    // drops the stale HTF counts and counts in chart bars again.
    syncPivotBarsSinceCompanion(chart, name);
    return;
  }

  const { htf, htfMs, failed } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    pivotWarmup(config.n, config.k),
    brokerId,
    oldestChartMs,
  );
  const proceed = mtfFetchTail(
    chart,
    paneId,
    name,
    timeframe,
    failed,
    htf.length > 0,
    ind?.extendData?.mtf,
    ext,
    calcParams,
    () => applyPivotBandsTimeframe(chart, epic, name, paneId, config, timeframe, brokerId, oldestChartMs),
  );
  if (!proceed) return;
  // Reuse the exact chart-TF math on the HTF bars: computePivotBands already
  // carries each side's value forward (dense after the first pivot) and bakes in
  // the N-bar confirmation lag, so the aligned series stays gap-free and honest.
  const pts = computePivotBands(htf, config.n, config.k, { mode: config.mode, source: config.source });
  // Bars-since is counted on the SAME HTF bars (so its unit is HTF bars, which
  // is what the backend operand does too) and stashed alongside:
  // they are not derivable from the step-prices above, since two consecutive
  // pivots can print the same price. Computed unconditionally — cheap next to
  // the fetch, and it keeps the stash valid the instant the user ticks the box.
  const since = computePivotBarsSince(htf, config.n, { source: config.source });
  ext.mtf = {
    timeframe,
    htfStarts: htf.map((b) => b.timestamp),
    htfHigh: pts.map((p) => p.pivotHigh),
    htfLow: pts.map((p) => p.pivotLow),
    htfBarsSinceHigh: since.map((p) => p.barsSinceHigh),
    htfBarsSinceLow: since.map((p) => p.barsSinceLow),
    htfMs,
  };
  overrideExtend(chart, paneId, name, ext, calcParams);
  syncPivotBarsSinceCompanion(chart, name);
}

// S/R levels accumulate over the staleness window rather than converging like a
// moving average, so the honest reach-back is the full window: ATR warm-up +
// one pivot span + maxBars. Best-effort like PivotBands — a shallow HTF history
// simply yields fewer levels.
const srWarmup = (cfg: SrLevelsConfig) => SR_ATR_LEN + 2 * cfg.pivotLen + cfg.maxBars;

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
  oldestChartMs?: number,
): Promise<void> {
  cancelMtfRetry(chart, paneId, name); // this apply supersedes any pending retry
  const ind = getIndicator(chart, paneId, name) as { extendData?: SrLevelsExtend } | null;
  const ext: SrLevelsExtend = { ...(ind?.extendData ?? {}) };
  const calcParams = [config.pivotLen, config.atrMult, config.minTouches, config.maxLevels, config.maxBars];

  if (!timeframe || timeframe === "chart") {
    clearMtfRetry(chart, paneId, name);
    ext.mtf = { timeframe: null };
    overrideExtend(chart, paneId, name, ext, calcParams);
    return;
  }

  const { htf, htfMs, failed } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    srWarmup(config),
    brokerId,
    oldestChartMs,
  );
  const proceed = mtfFetchTail(
    chart,
    paneId,
    name,
    timeframe,
    failed,
    htf.length > 0,
    ind?.extendData?.mtf,
    ext,
    calcParams,
    () => applySrLevelsTimeframe(chart, epic, name, paneId, config, timeframe, brokerId, oldestChartMs),
  );
  if (!proceed) return;
  // Reuse the exact chart-TF math on the HTF bars: clustering, touch gating and
  // the pivot-confirmation lag are all baked into the stashed series/levels.
  const { points, levels } = computeSrLevels(htf, config);
  ext.mtf = {
    timeframe,
    htfStarts: htf.map((b) => b.timestamp),
    htfMs,
    htfSupport: points.map((p) => p.support),
    htfResistance: points.map((p) => p.resistance),
    htfLevels: levels.map((lv) => ({
      price: lv.price,
      halfWidth: lv.halfWidth,
      touches: lv.touches,
      firstTs: htf[lv.firstIdx].timestamp,
      lastTs: htf[lv.lastIdx].timestamp,
    })),
  };
  overrideExtend(chart, paneId, name, ext, calcParams);
}

// A trendline reaches back to its oldest anchor, and only Max Span bounds that
// — which is 0 = OFF by default, so the off state needs the LARGER reach, not a
// zero one. With no span ceiling the pairing width is the honest stand-in: a
// line's first anchor is at most `pairPivots` pivots before its second, and a
// pivot costs 2 * pivotLen + 1 bars at minimum. On top of that: the ATR warm-up,
// one pivot confirm, and the projection horizon a line stays live for after its
// last touch. Best-effort like S/R Levels — a shallow HTF history simply yields
// fewer lines.
const tlWarmup = (cfg: TrendlinesConfig): number =>
  TL_ATR_LEN +
  2 * cfg.pivotLen +
  cfg.maxProjBars +
  (cfg.maxSpanBars > 0 ? cfg.maxSpanBars : cfg.pairPivots * (2 * cfg.pivotLen + 1));

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
  oldestChartMs?: number,
): Promise<void> {
  cancelMtfRetry(chart, paneId, name); // this apply supersedes any pending retry
  const ind = getIndicator(chart, paneId, name) as { extendData?: TrendlinesExtend } | null;
  const ext: TrendlinesExtend = { ...(ind?.extendData ?? {}) };
  const calcParams = [
    config.pivotLen, config.violMult, config.touchMult, config.minTouches,
    config.minSpanBars, config.maxProjBars, config.breakHoldBars, config.maxLines,
    config.minSwingAtr, config.minSwingReach, config.pairPivots, config.maxTouches,
    config.maxSpanBars, config.maxSlopeAtr, config.minSlopeAtr, config.minBackBars,
  ];

  if (!timeframe || timeframe === "chart") {
    clearMtfRetry(chart, paneId, name);
    ext.mtf = { timeframe: null };
    overrideExtend(chart, paneId, name, ext, calcParams);
    return;
  }

  const { htf, htfMs, failed } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    tlWarmup(config),
    brokerId,
    oldestChartMs,
  );
  const proceed = mtfFetchTail(
    chart,
    paneId,
    name,
    timeframe,
    failed,
    htf.length > 0,
    ind?.extendData?.mtf,
    ext,
    calcParams,
    () => applyTrendlinesTimeframe(chart, epic, name, paneId, config, timeframe, brokerId, oldestChartMs),
  );
  if (!proceed) return;
  // CLOSED HTF BARS ONLY. The forming bar is never usable to an operand (calc
  // aligns with waitClose), so letting it seed or break a line would put
  // geometry on the chart that no rule can read, and repaint it when the bar
  // finishes.
  const data = chart.getDataList();
  const newestMs = data.length ? data[data.length - 1].timestamp : 0;
  const closed = newestMs
    ? htf.filter((b) => b.timestamp + htfMs <= newestMs)
    : htf;
  // The exact chart-TF detector on the HTF bars: pivots, touches, breaks and
  // the confirmation lag are all baked into the stashed series and lines.
  const { points, lines, atr } = computeTrendlines(closed, config);
  ext.mtf = {
    timeframe,
    htfStarts: closed.map((b) => b.timestamp),
    htfMs,
    htfSupport: points.map((p) => p.tl_support),
    htfResistance: points.map((p) => p.tl_resistance),
    htfBrokenSupport: points.map((p) => p.tl_broken_support),
    htfBrokenResistance: points.map((p) => p.tl_broken_resistance),
    htfLines: lines,
    htfAtr: atr[atr.length - 1],
  };
  overrideExtend(chart, paneId, name, ext, calcParams);
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
  oldestChartMs?: number,
): Promise<void> {
  cancelMtfRetry(chart, paneId, name); // this apply supersedes any pending retry
  const ind = getIndicator(chart, paneId, name) as { extendData?: FvgExtend } | null;
  const ext: FvgExtend = { ...(ind?.extendData ?? {}) };
  const calcParams = [config.minSize, config.maxBars, config.maxGaps];

  if (!timeframe || timeframe === "chart") {
    clearMtfRetry(chart, paneId, name);
    ext.mtf = { timeframe: null };
    overrideExtend(chart, paneId, name, ext, calcParams);
    return;
  }

  const { htf, htfMs, failed } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    fvgReachBack(config),
    brokerId,
    oldestChartMs,
  );
  const proceed = mtfFetchTail(
    chart,
    paneId,
    name,
    timeframe,
    failed,
    htf.length > 0,
    ind?.extendData?.mtf,
    ext,
    calcParams,
    () => applyFvgTimeframe(chart, epic, name, paneId, config, timeframe, brokerId, oldestChartMs),
  );
  if (!proceed) return;
  // Reuse the exact chart-TF math on the HTF bars: detection, the size filter and
  // wick-driven mitigation are all baked into the stashed series/gaps.
  const { points, gaps } = computeFvg(htf, config);
  ext.mtf = {
    timeframe,
    htfStarts: htf.map((b) => b.timestamp),
    htfMs,
    htfBullTop: points.map((p) => p.bullTop),
    htfBullBottom: points.map((p) => p.bullBottom),
    htfBearTop: points.map((p) => p.bearTop),
    htfBearBottom: points.map((p) => p.bearBottom),
    htfGaps: gaps.map((g) => ({
      side: g.side,
      top: g.top,
      bottom: g.bottom,
      createdTs: htf[g.createdIdx].timestamp,
    })),
  };
  overrideExtend(chart, paneId, name, ext, calcParams);
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
  oldestChartMs?: number,
): Promise<void> {
  cancelMtfRetry(chart, paneId, name); // this apply supersedes any pending retry
  const ind = getIndicator(chart, paneId, name) as { extendData?: SlopeExtend } | null;
  const ext: SlopeExtend = {
    ...(ind?.extendData ?? {}),
    ...config.options,
    maType: config.maType,
    units: config.units,
  };
  const calcParams = config.lengths;

  if (!timeframe || timeframe === "chart") {
    clearMtfRetry(chart, paneId, name);
    ext.mtf = { timeframe: null };
    overrideExtend(chart, paneId, name, ext, calcParams);
    // The companion mirrors the parent's extendData (here: the cleared MTF stash).
    syncAccelCompanion(chart, name);
    return;
  }

  // Reach back the longest MA length + slope period + accel period (+ both
  // smoothing windows) so the HTF left edge is populated for every line.
  const smLen = config.smoothing && config.smoothing.type !== "none" ? Number(config.smoothing.length) || 0 : 0;
  const aSmLen = ext.accelSmoothing && ext.accelSmoothing.type !== "none" ? Number(ext.accelSmoothing.length) || 0 : 0;
  const n2 = slopePeriodOf(ext.accelPeriod, 3);
  const { htf, htfMs, failed } = await fetchHtfBars(
    chart,
    epic,
    timeframe,
    Math.max(...config.lengths) + config.slopeN + smLen + (ext.showAccel ? n2 + aSmLen : 0),
    brokerId,
    oldestChartMs,
  );
  const proceed = mtfFetchTail(
    chart,
    paneId,
    name,
    timeframe,
    failed,
    htf.length > 0,
    ind?.extendData?.mtf,
    ext,
    calcParams,
    () => applySlopeTimeframe(chart, epic, name, paneId, config, timeframe, brokerId, oldestChartMs),
  );
  if (!proceed) return;
  // Slope computed on native HTF bars, BEFORE alignHtfToChart forward-fills.
  //
  // barHours is the PINNED timeframe's nominal width, not one measured off the
  // fetched HTF bars: the rule path has no bars to measure and computes exactly
  // this number (evaluate.py's pinned IndicatorRef branch passes
  // `_tf_hours(tf_res)`), so measuring here would make the plotted line and the
  // rule operand two different series. A MONTH pin's smallest gap is a 28-day
  // February — 672h against the nominal 720h, a ~7% silent divergence — and
  // inferBarHours falls back to 1.0 when fewer than two HTF bars have loaded,
  // which for a DAY pin is a 24x error. `timeframe` is a canonical resolution
  // here, but nominalBarHours accepts a pin alias too, matching the backend's
  // `tf_resolution(pin) or pin`. The infer fallback covers only a resolution
  // name in neither table — which fetchHtfBars above would already have paged
  // at its own 1h default, so there is nothing better to fall back to.
  const barHours = nominalBarHours(timeframe) ?? inferBarHours(htf);
  const byLine = config.lengths.map((len) =>
    slopeLineSeries(htf, config.maType, len, config.slopeN, config.units, config.options.source, config.smoothing, barHours),
  );
  // Acceleration computed on NATIVE HTF bars too (same barHours), then aligned by
  // computeAccelCalc. Differentiating the ALIGNED slope would read zero inside each
  // HTF bucket and spike at the boundaries, and would diverge from the rule value.
  // Gated on showAccel, so it is undefined when the companion pane is off.
  const accelByLine = ext.showAccel
    ? config.lengths.map((len) =>
        accelLineSeries(
          htf,
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
      maSeries(htf, config.maType, len, { source: config.options.source }).base,
      config.smoothing,
    ),
  );
  ext.mtf = {
    timeframe,
    htfStarts: htf.map((b) => b.timestamp),
    htfSeriesByLine: byLine,
    htfMaBaseByLine: maBaseByLine,
    htfAccelByLine: accelByLine,
    htfMs,
  };
  overrideExtend(chart, paneId, name, ext, calcParams);
  // The companion mirrors the parent's extendData (including the MTF stash).
  syncAccelCompanion(chart, name);
}

/**
 * Re-fetch HTF data for every MTF indicator (EMA/MA and Pivot Bands) already
 * configured for a timeframe — call after the symbol or chart timeframe changes,
 * since the stashed HTF series belongs to the previous epic/range. Also the
 * reload path: persistence saves only `mtf:{timeframe}` (no series), so a
 * reloaded MTF indicator renders on the chart timeframe until this refetches.
 * No-op for chart-timeframe indicators.
 *
 * Also called from the scroll-back loader, which passes `oldestChartMs` (the
 * just-loaded older page's first bar). In that mode the epic/config are
 * unchanged, so an indicator whose stashed series already reaches back past the
 * new oldest bar (plus its warmup) is skipped — no redundant refetch per page.
 */
export async function refreshMtfIndicators(
  chart: Chart,
  epic: string,
  brokerId?: string,
  oldestChartMs?: number,
): Promise<void> {
  const byPane = getIndicatorsByPane(chart);
  if (!byPane) return;
  const jobs: Promise<void>[] = [];
  byPane.forEach((nameMap, paneId) => {
    nameMap.forEach((indUnknown, id) => {
      // `id` is the instance id (klinecharts name); branch on the real TYPE.
      const ind = indUnknown as {
        name?: string;
        calcParams?: unknown[];
        extendData?: MaExtend & PivotBandsExtend & SlopeExtend;
      };
      const type = indTypeOf({ name: id, extendData: ind.extendData });
      const tf = (ind.extendData?.mtf as MtfSeriesBase | undefined)?.timeframe;
      if (!tf) return;

      // Scroll-back guard shared by every MTF type: skip the refetch if the
      // stashed series already reaches the coverage start for the new oldest bar.
      // `warmup` is the type's reach-back margin (MA length; pivot 2N+K).
      const stashed = ind.extendData?.mtf as MtfSeriesBase | undefined;
      const covered = (warmup: number): boolean => {
        if (oldestChartMs == null) return false;
        if (!stashed?.htfStarts?.length || !stashed.htfMs) return false;
        return stashed.htfStarts[0] <= htfCoverageStartMs(oldestChartMs, stashed.htfMs, warmup);
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
            oldestChartMs,
          ),
        );
      } else if (type === "PIVOT_BANDS") {
        const n = Number(ind.calcParams?.[0]) || 5;
        const k = Number(ind.calcParams?.[1]) || 3;
        if (covered(pivotWarmup(n, k))) return;
        const mode: PivotBandsMode = ind.extendData?.mode === "avg" ? "avg" : "last";
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
            oldestChartMs,
          ),
        );
      } else if (type === "SR_LEVELS") {
        const cfg = parseSrConfig(ind.calcParams);
        if (covered(srWarmup(cfg))) return;
        jobs.push(
          applySrLevelsTimeframe(chart, epic, id, paneId, cfg, tf, brokerId, oldestChartMs),
        );
      } else if (type === "TRENDLINES") {
        const cfg = parseTrendlinesConfig(ind.calcParams);
        if (covered(tlWarmup(cfg))) return;
        jobs.push(
          applyTrendlinesTimeframe(chart, epic, id, paneId, cfg, tf, brokerId, oldestChartMs),
        );
      } else if (type === "FVG") {
        const cfg = parseFvgConfig(ind.calcParams);
        if (covered(fvgReachBack(cfg))) return;
        jobs.push(applyFvgTimeframe(chart, epic, id, paneId, cfg, tf, brokerId, oldestChartMs));
      } else if (type === "SLOPE") {
        const ext = ind.extendData ?? {};
        const lengths = slopeLengths(ind.calcParams);
        const slopeN = slopePeriodOf(ext.slopePeriod, 3);
        const smLen = ext.smoothing && ext.smoothing.type !== "none" ? Number(ext.smoothing.length) || 0 : 0;
        // Match applySlopeTimeframe's reach-back: when the accel companion is on,
        // the HTF series must warm the extra accel period + accel smoothing too, or
        // a scroll-back page can leave the accel line's left edge blank.
        const aSmLen =
          ext.accelSmoothing && ext.accelSmoothing.type !== "none"
            ? Number(ext.accelSmoothing.length) || 0
            : 0;
        const accelWarm = ext.showAccel ? slopePeriodOf(ext.accelPeriod, 3) + aSmLen : 0;
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
            oldestChartMs,
          ),
        );
      }
    });
  });
  await Promise.all(jobs);
}

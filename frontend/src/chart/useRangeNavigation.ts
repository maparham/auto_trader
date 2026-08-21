// Range coverage/fit + quick-range/go-to-date navigation for a ChartCore cell,
// extracted verbatim from ChartCore. Owns the two coverage walks
// (ensureCoverageAndFit, ensureAnchorCoverage) and the two user-facing callbacks
// (onRangePick, onGoToDate). Behavior is identical to the in-component code —
// every value the originals read from ChartCore's closure is supplied here via
// `handle.*`, a module import, or an explicit `deps` field.
//
// The two coverage walks are also called by useLiveMarketData across the
// extraction boundary; this hook assigns them into `handle.ensureCoverageAndFitRef`
// / `handle.ensureAnchorCoverageRef` in render (before any effect runs), the same
// staleness-proof ref-bridge pattern as redrawRef. Both read only refs/imports,
// so the latest-render closure is equivalent to any captured one.
import { type KLineData } from "klinecharts";
import { maskedSessionNow } from "../lib/maskedReplay";
import {
  fetchRangeStrict, RESOLUTION_SECONDS, PERIODS, type Period, type FillProgress,
} from "../lib/feed";
import { rangeWindow, goToDateTs, type RangeKey } from "../lib/rangeWindow";
import {
  pageHistoryBack as pageHistoryBackImpl,
  DEEP_HISTORY_MESSAGE,
  DEEP_HISTORY_TOAST_KEY,
  FETCH_FAILED_MESSAGE,
  STILL_LOADING_TOAST_KEY,
  stillLoadingMessage,
  FETCH_FAILED_TOAST_KEY,
  type PageResult,
} from "../lib/historyPaging";
import { loadDrawings } from "../lib/persist";
import { getBacktestCoverageFromTs, reanchorBacktestMarkers } from "../lib/backtest";
import { toast } from "../lib/notify";
import { readVisibleRange, scrollTsToCenter as scrollTsToCenterImpl } from "../lib/chartSync";
import { browserTimezone } from "./chartPainters";
import type { Instrument } from "../lib/feed";
import type { PriceSide } from "../theme";
import type { Chart } from "klinecharts";
import type { ChartHandle, RangeReq } from "./chartHandle";

export interface RangeNavigationDeps {
  // Named in the plan's signature. Identical to the module import; passed here
  // so the plan's `useRangeNavigation(handle, { pageHistoryBack })` shape holds.
  pageHistoryBack?: typeof pageHistoryBackImpl;
  // Older-bars-per-page window (ChartCore module const, shared with the scroll-back loader).
  pageBars: number;
  // Coverage helpers that STAY in ChartCore (called by onBacktestDrillIn /
  // coverBacktestTradeTo / the init scroll-back loader too) — passed in so the
  // walks here call the SAME instances.
  fitVisibleRange: (chart: Chart, fromTs: number, toTs: number) => void;
  // Pan-only landing for a token asking for fit: "center". Identical to the
  // module import; injectable for tests, like pageHistoryBack above.
  scrollTsToCenter?: typeof scrollTsToCenterImpl;
  extendMtfCoverage: (explicitOldestMs?: number) => void;
  // ChartCore's parallel cover to a KNOWN timestamp (coverBacktestTradeTo).
  // goToRange lands on a match whose time is known up front, so it covers the
  // whole gap in concurrent windows instead of walking it a page at a time.
  coverHistoryTo: (
    fromTs: number,
    opts?: {
      owner?: RangeReq | null;
      maxWindows?: number;
      onWindowError?: () => void;
      onWindowPartial?: (progress: FillProgress) => void;
    },
  ) => Promise<boolean>;
  // Props / state the callbacks read.
  scope: string;
  symbol: Instrument;
  brokerId: string;
  priceSide: PriceSide;
  period: Period;
  timezone: string;
  cellId: string;
  onFocus?: (cellId: string) => void;
  onPeriod?: (cellId: string, p: Period) => void;
  setActiveRange: (k: RangeKey | null) => void;
}

/** A RangeReq centred on [fromTs, toTs] with room around it. The padding is a
 *  COVERAGE target, not a viewport hint: the token asks to be centred, not
 *  fitted, so the viewport keeps the user's zoom and the 6x window only says how
 *  far back the walk must reach for the match's bars to land with context around
 *  them already loaded on both sides. Padding symmetrically also keeps the
 *  padded midpoint equal to the match's own, so centring on it centres the
 *  match. Timestamps in, milliseconds out (RangeReq is ms). */
// The token carries NO page budget any more. It used to ask for 40 sequential
// pages (20,000 bars) because the walk was one broker request at a time and the
// budget was really a bound on how long the chart froze — which meant a match
// more than ~70 trading days back on 5m simply could not be reached, and the
// panel had to mark those matches unreachable before the click.
//
// goToRange now covers the gap the way the backtest trades panel does: the
// match's timestamp is known up front, so every window between it and the
// loaded left edge is computed and fetched CONCURRENTLY (coverHistoryTo ->
// coverHistoryRangeParallel). By the time this token's own walk runs, the bars
// are already there and it does nothing but land the viewport, so the default
// 16-page budget is ample.

// Window cap for the match jump's parallel cover: 800 windows x 500 bars is
// 400k bars, about nine years of 15m US100 bars (the deepest series the app
// stores) and the same ceiling the timeframe-switch center restore uses. Wider
// than jump-to-trade's 400 because a match can be from 2017 while a backtest's
// trades are inside its own run. Past it, the toast below says so rather than
// the view landing quietly in the wrong place.
const MATCH_JUMP_MAX_WINDOWS = 800;

// Bar timestamps for the DEBUG log. The devtools console is a smaller audience
// than the UI, but it is still a place a blind session's real dates can be read
// off, and these two lines print bar times as ISO. Redacted whenever ANY cell is
// masked — the any-cell read, deliberately: a debug line is not worth threading
// a cellId for, and over-redacting a log costs nothing.
function debugTs(ms: number): string {
  return maskedSessionNow() ? "<hidden: replay>" : new Date(ms).toISOString();
}

export function buildRangeToken(args: {
  fromTs: number;
  toTs: number;
  resolution: string;
  epic: string;
  broker: string;
  side: PriceSide;
}): RangeReq {
  const fromMs = args.fromTs * 1000;
  const toMs = args.toTs * 1000;
  const mid = (fromMs + toMs) / 2;
  const half = Math.max((toMs - fromMs) * 3, 60_000);
  return {
    resolution: args.resolution,
    fromTs: Math.round(mid - half),
    toTs: Math.round(mid + half),
    epic: args.epic,
    broker: args.broker,
    side: args.side,
    fit: "center",
  };
}

export function useRangeNavigation(handle: ChartHandle, deps: RangeNavigationDeps) {
  const {
    pageHistoryBack = pageHistoryBackImpl,
    pageBars: PAGE_BARS,
    fitVisibleRange,
    scrollTsToCenter = scrollTsToCenterImpl,
    extendMtfCoverage,
    coverHistoryTo,
    scope,
    symbol,
    brokerId,
    priceSide,
    period,
    timezone,
    cellId,
    onFocus,
    onPeriod,
    setActiveRange,
  } = deps;

  const { overlays } = handle;

  // Page older history back until the loaded data reaches `fromTs`, then fit
  // [fromTs, toTs]. The backend caps a single fetch at 1000 bars, so a calendar
  // window (e.g. a month of 30m bars ≈ 1400) won't fit in one request — we walk
  // back in PAGE_BARS windows (mirroring the scroll-back driver, gaps and all).
  // `token` is the pendingRangeRef object; we abort if a newer pick replaces it.
  //
  // DESIGN DEBT: this and the facade onLoadRequest scroll-back loader are TWO paging
  // paths coordinating through loose shared refs (cursorSecRef/exhaustedRef/
  // loadingRef/emptyStreakRef). We close the races here with the loadingRef mutex +
  // wait-out + identity guard, but a third consumer (chart replay) should collapse
  // both into one HistoryPager owner — see the "Known design debt" note in
  // docs/superpowers/plans/2026-06-30-visible-range-selector.md.
  const ensureCoverageAndFit = async (token: RangeReq): Promise<PageResult> => {
    // Re-entry guard: the data-load effect can re-run (priceSide/broker change)
    // and call this again with the SAME pending token while a walk is in flight.
    if (handle.launchedTokenRef.current === token) return "aborted";
    handle.launchedTokenRef.current = token;
    const { resolution } = token;
    // Quick-range windows end at "now" (rangeWindow), which on a closed market sits
    // hours-to-days past the last bar. applyVisibleRange renders that dead time as
    // whitespace bars (wall-clock, at this chart's interval — the date-range-link
    // semantics), which on a minute chart over a weekend would squeeze the actual
    // data off screen. The preset's intent is "this much time, up to the latest
    // data", so slide the window back to end at the latest bar, span preserved —
    // clamped BEFORE the coverage walk so the walk covers the window we'll fit.
    // A live market is unaffected (last bar ≈ now). The latest bar is already
    // loaded here: this runs from the data-load effect / an unchanged-resolution
    // pick, and the back-walk below only prepends OLDER bars.
    const dl = handle.chartRef.current?.getDataList();
    const lastTs = dl?.length ? dl[dl.length - 1].timestamp : token.toTs;
    const toTs = Math.min(token.toTs, lastTs);
    const fromTs = toTs - (token.toTs - token.fromTs);
    // Stale once a newer pick replaces the token, the chart is torn down, or the
    // series identity drifts from what this pick captured (epic/broker/side/
    // resolution) — the same defence the scroll-back loader applies.
    const isStale = () =>
      handle.pendingRangeRef.current !== token ||
      !handle.chartRef.current ||
      handle.epicRef.current !== token.epic ||
      handle.brokerIdRef.current !== token.broker ||
      handle.priceSideRef.current !== token.side ||
      handle.resRef.current !== token.resolution;
    // Take the scroll-back loader's mutex so klinecharts' own Forward-load (which
    // our setBars(forward=true) keeps arming) can't page concurrently and race us
    // over cursorSecRef/exhaustedRef. If a scroll-back page is ALREADY in flight,
    // wait it out first — otherwise its .finally would flip loadingRef false partway
    // through our walk and reopen the gate. (Bounded so active scrolling can't wedge
    // us; once we hold the mutex, further scroll-back loads bail.)
    for (let i = 0; handle.loadingRef.current && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (isStale()) return "aborted";
    }
    handle.loadingRef.current = true;
    try {
      const result = await pageHistoryBack<KLineData>({
        fromTs,
        toTs,
        resSec: RESOLUTION_SECONDS[resolution] ?? 60,
        pageBars: PAGE_BARS,
        // Default 16 pages (~8k bars) is the quick-range budget: those windows are
        // days-to-months and start from a live-edge load. A token can ask for more
        // (goToRange, landing on a match well behind the loaded window).
        maxPages: token.maxPages ?? 16,
        maxEmpty: 4,
        isStale,
        getData: () => handle.chartRef.current?.getDataList(),
        // fetchRangeStrict: a transient 5xx (broker breaker / slow source) throws,
        // which pageHistoryBack treats as "stop the walk, fit what we have" rather
        // than an empty page that trips maxEmpty and latches exhaustedRef for the
        // session. A genuine empty 200 still returns [] and counts toward exhaustion.
        fetchOlder: (fromSec, toSec) =>
          fetchRangeStrict(token.epic, resolution, fromSec, toSec, token.side, token.broker),
        // Prepend through the overlay manager so beyond-data (dataIndex-only)
        // anchors shift BEFORE the data lands (see OverlayManager.applyOlderBars).
        applyData: (merged) => overlays.applyOlderBars(merged),
        onCursor: (sec) => {
          handle.cursorSecRef.current = sec;
        },
        onProgress: () => {
          handle.exhaustedRef.current = false;
        },
        onExhausted: () => {
          handle.exhaustedRef.current = true;
        },
      });
      if (result !== "aborted" && handle.chartRef.current && handle.pendingRangeRef.current === token) {
        // Land the viewport. "center" preserves the user's zoom and only
        // scrolls (a jump between matches must not re-zoom the chart on every
        // click); the default fits the covered window, which is what the
        // quick-range picker and the timeframe-switch park have always done.
        //
        // The two arms read DIFFERENT windows, deliberately. The fit reads the
        // clamped fromTs/toTs, because you fit what you actually covered. The
        // centre reads the token's UNCLAMPED range, because the clamp slides the
        // window back to end at the last bar, and buildRangeToken pads by 3x the
        // match span each side: for any match ending within 3x its span of the
        // live edge that would drag the centre up to 3x the span earlier than
        // the match (about 60 bars on a 20-bar match). Fitting hid that, since
        // the match stayed inside the fitted window either way, but the zoom is
        // now the user's own, so a tight viewport would show no match at all
        // while the bands sat off screen. The padding is symmetric, so the
        // unclamped midpoint IS the match's own midpoint. scrollTsToCenter
        // clamps to the nearest edge bar itself if that midpoint is past the
        // loaded data.
        if (token.fit === "center") {
          scrollTsToCenter(handle.chartRef.current, Math.round((token.fromTs + token.toTs) / 2));
        } else {
          fitVisibleRange(handle.chartRef.current, fromTs, toTs);
        }
        handle.pendingRangeRef.current = null;
        extendMtfCoverage(); // history just grew — re-cover any HTF EMA/MA
      }
      return result;
    } finally {
      // Release the mutex only if a newer pick hasn't taken ownership (it holds the
      // mutex for its own walk); the current owner — or a settled idle state —
      // releases it.
      if (handle.pendingRangeRef.current === token || handle.pendingRangeRef.current === null) {
        handle.loadingRef.current = false;
      }
    }
  };

  // Drawings anchor by timestamp, and klinecharts snaps a timestamp to the NEAREST
  // LOADED bar — an anchor older than the initial 500-bar window clamps to the left
  // edge of the loaded data, pivoting the drawing to a wrong slope until the user
  // happens to scroll back far enough (paint-time re-resolution self-heals once the
  // bars exist). After a load, silently page history back until the oldest saved
  // drawing anchor is covered — bounded like a quick-range walk, and with NO fit:
  // the view stays parked at the live edge. Alerts are horizontal (no timestamp),
  // so only drawings matter here.
  // Anchors the walk below already gave up on (budget hit before reaching the
  // target): series key -> the target it failed to reach + how deep it got.
  // Without this, EVERY later trigger (each backtest run, template apply, range
  // pick) re-walks a full 16-page budget toward the same unreachable anchor,
  // prepending ~8k more bars each time — and each prepend is a full-array
  // setBars re-init, so back-to-back runs slow down quadratically (measured
  // 1.9s → 6.9s → 31.4s walks). Retry only when the oldest anchor got NEWER
  // (e.g. the old drawing was deleted) or something else loaded history deeper
  // than the failed walk reached (the remaining gap shrank).
  const ensureAnchorCoverage = async () => {
    const chart = handle.chartRef.current;
    if (!chart) return;
    const epic = handle.epicRef.current;
    const resolution = handle.resRef.current;
    const broker = handle.brokerIdRef.current;
    const side = handle.priceSideRef.current;
    const anchors = loadDrawings(scope, epic)
      .flatMap((d) => d.points ?? [])
      .map((p) => p.timestamp)
      .filter((t): t is number => t != null);
    // Backtest fills have the SAME clamp problem as drawing anchors: on a finer
    // timeframe the initial recent-only load starts after the run, so renderArtifacts
    // culled every fill (drawing them would pile at the left edge). Fold the oldest
    // fill into the walk so it pages back far enough, then reanchor the markers below.
    const backtestFromMs = getBacktestCoverageFromTs(chart);
    if (backtestFromMs != null) anchors.push(backtestFromMs);
    if (!anchors.length) return;
    const first = chart.getDataList()[0];
    if (!first) return;
    const cappedKey = `${broker}|${epic}|${resolution}|${side}`;
    const capped = handle.cappedAnchorRef.current.get(cappedKey);
    // Drop anchors a prior walk already burned its budget failing to reach —
    // but ONLY those. The rest (e.g. a backtest's fills, which the TF-switch
    // rehydrate + selected-trade restore rely on getting covered) still get
    // their walk; skipping wholesale would starve them whenever one ancient
    // drawing anchor exists. Hopeless anchors get retried only when something
    // else has since loaded history deeper than the failed walk reached (the
    // remaining gap shrank, so a fresh budget might close it).
    const fullFromTs = Math.min(...anchors);
    const targets =
      capped && first.timestamp >= capped.reached
        ? anchors.filter((t) => t > capped.target)
        : anchors;
    if (!targets.length) return;
    const fromTs = Math.min(...targets);
    if (fromTs >= first.timestamp) return; // already covered (or nothing to extend)
    // A quick-range pick owns paging (it covers + fits its own window) — stay out of
    // its way now, and abort via isStale if one starts mid-walk.
    if (handle.pendingRangeRef.current) return;
    const isStale = () =>
      !handle.chartRef.current ||
      handle.pendingRangeRef.current !== null ||
      handle.epicRef.current !== epic ||
      handle.brokerIdRef.current !== broker ||
      handle.priceSideRef.current !== side ||
      handle.resRef.current !== resolution;
    // Same mutex dance as ensureCoverageAndFit: wait out an in-flight scroll-back
    // page (bounded), then hold the mutex so the two pagers can't interleave.
    for (let i = 0; handle.loadingRef.current && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (isStale()) return;
    }
    if (isStale()) return;
    handle.loadingRef.current = true;
    try {
      const walk = await pageHistoryBack<KLineData>({
        fromTs,
        toTs: first.timestamp,
        resSec: RESOLUTION_SECONDS[resolution] ?? 60,
        pageBars: PAGE_BARS,
        maxPages: 16,
        maxEmpty: 4,
        isStale,
        getData: () => handle.chartRef.current?.getDataList(),
        // fetchRangeStrict: see ensureCoverageAndFit — a transient 5xx stops the
        // walk without latching exhaustedRef; only a real empty 200 counts as a gap.
        fetchOlder: (fromSec, toSec) => fetchRangeStrict(epic, resolution, fromSec, toSec, side, broker),
        applyData: (merged) => overlays.applyOlderBars(merged),
        onCursor: (sec) => {
          handle.cursorSecRef.current = sec;
        },
        onProgress: () => {
          handle.exhaustedRef.current = false;
        },
        onExhausted: () => {
          handle.exhaustedRef.current = true;
        },
      });
      // Redraw backtest markers against the now-extended history. renderArtifacts
      // culled the fills the recent-only initial load didn't cover, and paging back
      // does NOT move existing overlays — so recreate them here, now that their bars
      // exist. Guard on !isStale() so a symbol/TF switch that raced in (its own
      // rehydrate will redraw) doesn't double-draw; gate on the backtest actually
      // needing coverage so a drawing-only walk doesn't churn the markers. Fills
      // still older than the broker's finest history stay culled, not piled.
      if (!isStale() && backtestFromMs != null && backtestFromMs < first.timestamp) {
        reanchorBacktestMarkers(chart);
      }
      // History just extended back to the oldest anchor — re-cover any HTF EMA/MA
      // so its curve reaches the newly-loaded bars (no-op if already covered).
      if (!isStale()) extendMtfCoverage();
      // Bounded walk: a very old anchor on a very fine interval can exceed the page
      // budget — the drawing/marker then still clamps. Say so instead of failing
      // silently, and remember the failure so later triggers don't re-walk a full
      // budget toward the same unreachable anchor (see cappedAnchorRef). An
      // ABORTED walk spent no budget and applied nothing (a range pick or series
      // switch preempted it) — latching "hopeless" off it would permanently
      // filter an anchor a full walk might well reach, so skip the bookkeeping.
      if (walk === "aborted") return;
      const oldest = handle.chartRef.current?.getDataList()[0];
      if (oldest && oldest.timestamp > fromTs) {
        // Failed even the filtered (newest hopeless) target — record IT, so the
        // hopeless set only ever grows toward newer anchors, never re-deepens.
        handle.cappedAnchorRef.current.set(cappedKey, { target: fromTs, reached: oldest.timestamp });
        console.debug(
          `[chart] anchor coverage capped for ${epic}@${resolution}: oldest anchor ${debugTs(fromTs)} predates loaded history (won't retry until the anchor set or loaded depth changes)`,
        );
      } else if (oldest && oldest.timestamp <= fullFromTs) {
        // EVERY anchor (including previously-hopeless ones) is now covered —
        // e.g. a quick-range pick loaded far deeper history. Clear the record.
        handle.cappedAnchorRef.current.delete(cappedKey);
      }
      // Covered the filtered target but older hopeless anchors remain: keep the
      // record so they stay filtered on the next trigger.
    } finally {
      // Release only if a quick-range pick hasn't taken the mutex for its own walk.
      if (handle.pendingRangeRef.current === null) {
        handle.loadingRef.current = false;
      }
    }
  };

  // Assign the bridge refs in render so useLiveMarketData (and any other
  // cross-boundary caller) invokes the current-render instances. Staleness-proof:
  // both walks read only refs/imports, so the latest closure ≡ any captured one.
  handle.ensureCoverageAndFitRef.current = ensureCoverageAndFit;
  handle.ensureAnchorCoverageRef.current = ensureAnchorCoverage;

  // A quick-range button: switch interval if needed (the data-load effect then
  // covers + fits once bars land), else cover + fit over the current interval now.
  const onRangePick = (key: RangeKey) => {
    const chart = handle.chartRef.current;
    if (!chart) return;
    // Keyboard activation (Enter/Space) fires no pointer-down, so focus this cell
    // explicitly — otherwise an interval switch would target whatever cell was
    // focused before (the period setter is cell-scoped, so this also makes the
    // marker/pill land on the cell the user actually clicked).
    onFocus?.(cellId);
    const { resolution, fromTs, toTs } = rangeWindow(
      key,
      Date.now(),
      timezone || browserTimezone(),
    );
    setActiveRange(key);
    // Mark the period start for the on-chart separator (fromTs=0 for "All" sits
    // off the left edge, so paintSeparator just won't draw it — intended).
    handle.separatorTsRef.current = fromTs;
    const token: RangeReq = {
      resolution,
      fromTs,
      toTs,
      epic: symbol.epic,
      broker: brokerId,
      side: priceSide,
    };
    handle.pendingRangeRef.current = token;
    if (resolution !== period.resolution) {
      const target = PERIODS.find((p) => p.resolution === resolution);
      if (target) onPeriod?.(cellId, target);
      return;
    }
    // Chain the anchor-coverage walk behind the fit: the picked window may still
    // not reach the oldest drawing anchor, and coverage would otherwise stay
    // gated on pendingRangeRef for the walk's whole duration.
    void ensureCoverageAndFit(token).then(() => {
      if (!period.liveOnly) void ensureAnchorCoverage();
    });
  };

  // Land on an arbitrary historical window, paging older history in first if the
  // chart has not loaded that far back.
  const goToRange = (fromTs: number, toTs: number) => {
    const chart = handle.chartRef.current;
    if (!chart) return;
    onFocus?.(cellId);
    const token = buildRangeToken({
      fromTs,
      toTs,
      resolution: period.resolution,
      epic: symbol.epic,
      broker: brokerId,
      side: priceSide,
    });
    setActiveRange(null);
    handle.separatorTsRef.current = null;
    // Park the token BEFORE the cover, not after: the token is what makes the
    // cover preemptible. coverHistoryTo stands down for whoever owns
    // pendingRangeRef, so clicking the next match down the list makes this
    // cover stale instead of racing it — two several-hundred-window fetch
    // storms at once, on a panel built for clicking through results.
    handle.pendingRangeRef.current = token;
    void (async () => {
      // Cover to the token's PADDED left edge, not the match's own first bar:
      // anything the parallel cover leaves uncovered, the sequential walk in
      // ensureCoverageAndFit pages one broker request at a time.
      // Did any window fetch fail? It decides which of the two dead ends the
      // user is told about below.
      let fetchFailed = false;
      // The FURTHEST any window got, not the last one to answer. The cover runs
      // six lanes against one series, and the backend's fill budget starts
      // before its per-series lock: five of them queue behind the lane that is
      // doing the work and come back reporting nothing done. Taking the last
      // would show 0 of 96 while a lane was most of the way through.
      const filling: { best: FillProgress | null } = { best: null };
      await coverHistoryTo(token.fromTs, {
        owner: token,
        maxWindows: MATCH_JUMP_MAX_WINDOWS,
        onWindowError: () => {
          fetchFailed = true;
        },
        onWindowPartial: (p) => {
          if (!filling.best || p.done > filling.best.done) filling.best = p;
        },
      });
      if (handle.pendingRangeRef.current !== token) return; // a newer click owns the chart
      const result = await ensureCoverageAndFit(token);
      // "aborted" means a newer pick owns the chart; it lands its own view.
      if (result === "aborted") return;
      // Landing short is no longer a statement about a page budget: the cover
      // asked for every window down to the target. Which of the two reasons it
      // was depends on whether a window FAILED. All fetches fine and still
      // short means the broker's series starts after the match (or the 400k-bar
      // cap was hit, which in practice means the same), so the answer is a
      // coarser timeframe — the same answer the backtest trades panel gives for
      // a trade older than its timeframe's history. A failed window instead
      // means a timeout or a 5xx on history that may well exist (a cold span
      // the broker serves slower than the client's 10s deadline), and there the
      // answer is to try again. Either way, say something: whitespace where the
      // match should be reads as a broken jump.
      //
      // The target is the MATCH, not token.fromTs. buildRangeToken pads the
      // window by 3x the match span each side, and that padding is context, not
      // the destination: warning on it called a jump broken whenever the match
      // sat within 3 spans of the oldest bar the broker will serve. Warn only
      // when a bar of the match ITSELF is missing.
      //
      // `key` coalesces repeat clicks on unreachable matches into one toast
      // with a xN badge instead of stacking against the 5-toast cap. Not
      // sticky: it is informational. PatternMatchesPanel's error slot is
      // deliberately NOT used — it is owned by usePatternSearch and would
      // clobber the results the user is reading.
      const oldest = handle.chartRef.current?.getDataList()[0];
      const wantedMs = fromTs * 1000; // the match's own first bar (seconds in)
      if (oldest && oldest.timestamp > wantedMs) {
        // Three dead ends, three answers. A failed window is "try again"; a
        // still-running download is "try again in a moment, here is how far it
        // got"; only when neither happened is the history genuinely absent and
        // a coarser timeframe the way out.
        //
        // Read after the cover resolves, so every lane that reported has
        // reported: coverHistoryRangeParallel awaits all its lanes, and a lane
        // publishes its marker inside the fetch it is awaiting. Held in an
        // object rather than a bare `let` because the closure above is the only
        // writer, which narrows a `let` to its initial null and would otherwise
        // need a cast to read — a cast that would hide exactly this question.
        const still = filling.best;
        if (fetchFailed) toast(FETCH_FAILED_MESSAGE, { key: FETCH_FAILED_TOAST_KEY });
        else if (still)
          // Keyed, and notify.ts rewrites a keyed toast's text in place, so
          // clicking again while the download runs advances the count the user
          // is reading rather than stacking a second toast.
          toast(stillLoadingMessage(still.done, still.total), { key: STILL_LOADING_TOAST_KEY });
        else toast(DEEP_HISTORY_MESSAGE, { key: DEEP_HISTORY_TOAST_KEY });
        console.debug(
          `[chart] go-to-range covered only back to ${debugTs(oldest.timestamp)}, short of ${debugTs(wantedMs)}${fetchFailed ? " (a window fetch failed)" : ""}`,
        );
      }
    })();
  };

  // Calendar "go to date": land on the chosen date (or datetime) at the current
  // zoom, keeping the interval. Rides goToRange, so a date behind the loaded
  // history is covered by the parallel cover up front — it used to only fit the
  // loaded extent, which left the scroll-back pager to fill a years-deep gap
  // one 500-bar request at a time (~10 minutes for a 2.5-year jump on 5m).
  const onGoToDate = (dateStr: string) => {
    const chart = handle.chartRef.current;
    if (!chart) return;
    // Resolve the picked instant in the chart timezone (consistent with the
    // range buttons / separator), not UTC.
    const dateMs = goToDateTs(dateStr, timezone || browserTimezone());
    const cur = readVisibleRange(chart);
    const span = cur ? cur.toTs - cur.fromTs : 30 * 86_400_000;
    // The current viewport span around the date: buildRangeToken pads it 3x
    // each side (context), centres on its midpoint = the date, and the token's
    // fit:"center" keeps the user's zoom.
    goToRange((dateMs - span / 2) / 1000, (dateMs + span / 2) / 1000);
  };

  return { onRangePick, onGoToDate, goToRange };
}

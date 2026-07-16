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
import { fetchRangeStrict, RESOLUTION_SECONDS, PERIODS, type Period } from "../lib/feed";
import { rangeWindow, goToDateTs, type RangeKey } from "../lib/rangeWindow";
import { pageHistoryBack as pageHistoryBackImpl } from "../lib/historyPaging";
import { loadDrawings } from "../lib/persist";
import { getBacktestCoverageFromTs, reanchorBacktestMarkers } from "../lib/backtest";
import { readVisibleRange } from "../lib/chartSync";
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
  extendMtfCoverage: (explicitOldestMs?: number) => void;
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

export function useRangeNavigation(handle: ChartHandle, deps: RangeNavigationDeps) {
  const {
    pageHistoryBack = pageHistoryBackImpl,
    pageBars: PAGE_BARS,
    fitVisibleRange,
    extendMtfCoverage,
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
  const ensureCoverageAndFit = async (token: RangeReq) => {
    // Re-entry guard: the data-load effect can re-run (priceSide/broker change)
    // and call this again with the SAME pending token while a walk is in flight.
    if (handle.launchedTokenRef.current === token) return;
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
      if (isStale()) return;
    }
    handle.loadingRef.current = true;
    try {
      const result = await pageHistoryBack<KLineData>({
        fromTs,
        toTs,
        resSec: RESOLUTION_SECONDS[resolution] ?? 60,
        pageBars: PAGE_BARS,
        maxPages: 16,
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
        fitVisibleRange(handle.chartRef.current, fromTs, toTs);
        handle.pendingRangeRef.current = null;
        extendMtfCoverage(); // history just grew — re-cover any HTF EMA/MA
      }
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
          `[chart] anchor coverage capped for ${epic}@${resolution}: oldest anchor ${new Date(fromTs).toISOString()} predates loaded history (won't retry until the anchor set or loaded depth changes)`,
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

  // Calendar "go to date": center the chosen date in the current window, keeping
  // the interval. Degrades to the loaded extent if the date predates history.
  const onGoToDate = (dateStr: string) => {
    const chart = handle.chartRef.current;
    if (!chart) return;
    // Resolve the picked day in the chart timezone (consistent with the range
    // buttons / separator), not UTC midnight.
    const dateMs = goToDateTs(dateStr, timezone || browserTimezone());
    const cur = readVisibleRange(chart);
    const span = cur ? cur.toTs - cur.fromTs : 30 * 86_400_000;
    setActiveRange(null);
    handle.separatorTsRef.current = null;
    fitVisibleRange(chart, dateMs - span / 2, dateMs + span / 2);
  };

  return { onRangePick, onGoToDate };
}

// Data-load + live-stream effect for a ChartCore cell, extracted verbatim from
// ChartCore. On a symbol/period/side/broker change it: reloads recent history,
// rehydrates the epic's overlays/backtest/AVWAP anchors, kicks the coverage
// walks (through handle bridge refs), and opens the live stream that applies
// per-tick candles + drives the pills. Behavior is identical to the in-component
// effect — every value the original read from ChartCore's closure is supplied
// here via `handle.*`, a module import, or an explicit `deps` field.
import { useEffect, useRef, useState } from "react";
import { type KLineData } from "klinecharts";
import {
  fetchRecentWithStatus,
  fetchRange,
  openLive,
  RESOLUTION_SECONDS,
  type Instrument,
  type Period,
} from "../lib/feed";
import { coverHistoryRangeParallel } from "../lib/historyPaging";
import { PERF_DIAG_ON, recordTick } from "../lib/perfDiag";
import { detachedWindows, type DetachedTarget } from "./detachedView";
import { jumpToLive } from "../lib/liveEdge";
import type { PriceSide } from "../theme";
import { synthPrecision } from "./chartPainters";
import { nextHistoryRetryDelayMs, shouldKeepPaintedBars, shouldRetryHistory } from "./noDataPolicy";
import { periodFromTf } from "./chartDataFacade";
import {
  teardownArtifacts,
  rehydrateBacktest,
  backtestPanelActionForReplay,
  ownsBacktestPanel,
  selectedTradeForChart,
  restoreTradeSelection,
} from "../lib/backtest";
import { backtestResultSignal } from "../lib/signals";
import { toast } from "../lib/notify";
import { loadAvwapAnchor, loadViewPos, saveViewPos } from "../lib/persist";
import { loadSnapshotMeta, saveSnapshotMeta, type SnapshotMeta } from "../lib/persist";
import { renderSnapshotMarker } from "../lib/snapshotMarker";
import {
  applyIndicatorVisibility,
  applySlopeBarHours,
  forceCollapseSubPanes,
  getIndicatorsByPane,
} from "../lib/indicators";
import { applyLookOnOpen } from "../lib/templates";
import { flushTemplateCapture } from "../lib/templateAutosave";
import { loadSettings } from "../theme";
import { indTypeOf } from "../lib/customIndicators";
import { applyVisibleRange, scrollTsToCenter } from "../lib/chartSync";
import {
  mtfBucketMs,
  refreshFormingBarThrottled,
  refreshMtfIndicators,
} from "../lib/mtfCoordinator";
import { setLivePrice } from "../lib/trading";
import { isSynthetic, setSyntheticPrecision } from "../lib/syntheticRegistry";
import type { LiveStatus } from "../lib/feed";
import type { ChartHandle, RangeReq } from "./chartHandle";

export interface LiveMarketDataDeps {
  symbol: Instrument;
  brokerId: string;
  priceSide: PriceSide;
  period: Period;
  scope: string;
  effPrecision: number;
  // Bumped by useReplay when the SERIES must be reloaded (replay start / exit).
  // In the load effect's dep array, so entering or leaving replay re-runs the
  // whole load path — rehydrate, indicator visibility, MTF refresh, template —
  // instead of forking a second one.
  replayEpoch: number;
  // Detached view: a Go-to-date target too deep to reach by extending history.
  // Non-null makes the load effect a THIRD bars source — just the window around
  // the target, with no live stream — and it sits in the effect's dep array, so
  // entering, re-targeting or leaving reloads the whole series (the same idiom
  // as replayEpoch). Each enter/re-target is a fresh object, so a repeat jump to
  // the same date still reloads.
  detached: DetachedTarget | null;
  // State setters (identity-stable across renders).
  setStatus: (s: LiveStatus) => void;
  setLastPrice: (p: number | null) => void;
  setHasData: (v: boolean) => void;
  setLoadError: (v: string | null) => void;
  // The last load's degraded-serve marker (broker unreachable, cached bars
  // served — see feed.CandlesResult); null = healthy/complete.
  setDegraded: (v: string | null) => void;
  setErrorOpen: (v: boolean) => void;
  setFetchedPrecision: (p: number | null) => void;
  setSnapView: (m: SnapshotMeta | null) => void;
  setActiveRange: (k: import("../lib/rangeWindow").RangeKey | null) => void;
  setMarketClosed: (v: boolean) => void;
  // Refs shared with paint/status code that stays in ChartCore (not on the handle).
  sepCacheRef: React.MutableRefObject<{ ts: number; tz: string; theme: string; label: string; accent: string } | null>;
  lastCandleAtRef: React.MutableRefObject<number>;
  marketClosedRef: React.MutableRefObject<boolean>;
  // Callbacks that stay in ChartCore (called across the extraction boundary).
  unlockSnapshotView: () => void;
  // `owner` is the parked range token a deepCover consumption runs FOR — the
  // cover stands down for any OTHER owner of pendingRangeRef (see ChartCore).
  coverBacktestTradeTo: (fromTs: number, opts?: { owner?: RangeReq | null }) => Promise<boolean>;
}

// Center-preserve cover budget: how much history a TF switch / reload restore
// may fetch to reach the preserved center before it declares the target too
// deep (toast + latest instead). 800 windows x 500 bars = 400k bars — ~7.5
// years of 15m; chart pan/zoom stays responsive at this size (visible-range
// rendering), the cost is the one-off parallel fetch (~tens of seconds cold,
// fast once the backend candle cache holds the span). Wider than
// jump-to-trade's 400 because a TF switch preserves work the user is looking
// at right now.
const COVER_PAGE_BARS = 500;
const COVER_MAX_WINDOWS = 800;

// Bar time at the horizontal CENTER PIXEL of the main pane, clamped to the
// last real bar (a center pixel in right-edge whitespace extrapolates into the
// future). null when the chart lacks usable data/geometry. The visible index
// midpoint is NOT equivalent: getVisibleRange().to clamps at the last bar
// whenever the view extends into whitespace, biasing a midpoint left of the
// bar actually at screen center.
function readCenterBarTs(chart: NonNullable<ChartHandle["chartRef"]["current"]>): number | null {
  const data = chart.getDataList();
  if (!data || data.length < 2) return null;
  const w = chart.getSize("candle_pane", "main")?.width ?? 0;
  if (w <= 1) return null;
  const pt = chart.convertFromPixel({ x: Math.round(w / 2), y: 1 }, { paneId: "candle_pane" }) as
    | { timestamp?: number }
    | null
    | undefined;
  return pt?.timestamp != null ? Math.min(pt.timestamp, data[data.length - 1].timestamp) : null;
}

// Persist the current view position (center bar time + zoom) for the reload
// restore. Called from the scroll/zoom subscription (debounced) and once at
// each load's settle — programmatic TF-switch positioning fires no scroll
// action, so without the settle save a reload right after a TF change would
// find a stale resolution and skip the restore.
function captureViewPos(
  chart: NonNullable<ChartHandle["chartRef"]["current"]>,
  scope: string,
  epic: string,
  resolution: string,
  // A center to persist INSTEAD of the on-screen one — a too-deep switch shows
  // the latest candles but must keep the chosen (unreached) center saved.
  overrideCenterTs?: number,
): void {
  const ts = overrideCenterTs ?? readCenterBarTs(chart);
  if (ts == null) return;
  saveViewPos(scope, {
    epic,
    resolution,
    centerTs: ts,
    barSpace: chart.getBarSpace().bar,
    savedAt: Date.now(),
  });
}

export function useLiveMarketData(handle: ChartHandle, deps: LiveMarketDataDeps) {
  const {
    symbol,
    brokerId,
    priceSide,
    period,
    scope,
    effPrecision,
    replayEpoch,
    detached,
    setStatus,
    setLastPrice,
    setHasData,
    setLoadError,
    setDegraded,
    setErrorOpen,
    setFetchedPrecision,
    setSnapView,
    setActiveRange,
    setMarketClosed,
    sepCacheRef,
    lastCandleAtRef,
    marketClosedRef,
    unlockSnapshotView,
    coverBacktestTradeTo,
  } = deps;

  const { controller, overlays } = handle;
  const { measureArmed, slopeArmed, rangePickArmed } = controller;

  // Effect-local state (only this effect reads/writes these), previously
  // ChartCore locals. Not shared → private refs here.
  const prevEpicRef = useRef(symbol.epic);
  const prevResRef = useRef(period.resolution);
  // Epic whose look (template) this cell last applied — gates replace-on-open to
  // actual symbol opens: a TF-only effect re-run must NOT re-apply the template
  // (it would revert the last <800ms of not-yet-autosaved edits).
  const lookEpicRef = useRef<string | null>(null);
  // False only on the effect's very first run (page reload / cell mount) —
  // prevEpicRef/prevResRef can't tell a mount apart (they seed from the current
  // props), and only a mount restores the saved view position.
  const didInitRef = useRef(false);
  // Live twin of useReplay's mtfBucketRef: the epoch-grid HTF bucket index the
  // last tick landed in. A tick crossing into a NEW bucket means the stashed
  // forming fold's bucket just closed — refreshFormingBar alone cannot
  // graduate it (it re-derives the SAME open from the stashed closed bars and
  // ignores candles past it), so the crossing triggers the full refetch that
  // folds the closed bar in and opens the next bucket. Reset on each load
  // refresh so a symbol/timeframe switch re-records rather than "crosses".
  const liveMtfBucketRef = useRef<number | null>(null);
  const liveMtfRefreshingRef = useRef(false);
  // A preserved center a too-deep switch could NOT reach (it toasted and
  // showed the latest candles instead). The chosen center must survive that
  // failure: the next timeframe change re-targets it — but only while the
  // view still sits parked at the live edge where the failed switch left it.
  // Cleared by a user pan/zoom (the gesture subscription below; programmatic
  // positioning fires no scroll action), by an epic change, and by any switch
  // that actually lands on its target.
  const intendedCenterRef = useRef<number | null>(null);
  // Repositions the time-axis center pin (set by the pin effect at the bottom).
  // Called from the load effect's settle points, where the view moves without
  // any scroll/zoom action firing.
  const repositionPinRef = useRef<(() => void) | null>(null);
  // History-load retry: a load that settles with ZERO bars (broker maintenance,
  // backend reload, transient network failure) re-runs the whole load effect on
  // a backoff — this is what makes the no-data banner's "Retrying automatically…"
  // true. Recovery used to rely solely on a live tick arriving (line ~800), which
  // never happens while the market is closed, so one transient failure latched
  // the banner until a manual page reload. Bumping the nonce re-enters the effect
  // below (it's in the deps), reusing the full load path — view restore, overlay
  // rehydrate, live re-subscribe — with no duplicated logic.
  const [retryNonce, setRetryNonce] = useState(0);
  const retryAttemptRef = useRef(0);
  const retrySeriesRef = useRef("");
  // Nonce value the previous effect run saw: lets a run tell "I was triggered
  // by the retry backoff" apart from an epic/TF/side change, so retry re-runs
  // can hold the user's view steady (see keepCenter below).
  const lastRetryNonceRef = useRef(0);
  // Detached state for the gesture effect below, whose dep array is
  // [epic, resolution, scope] and so cannot see the prop directly — the same
  // reason replay is read there through handle.replayRef.
  // Written from the load effect below (which has `detached` in its deps), not
  // in render: the gesture effect only ever reads it from a user event, long
  // after that effect has run for the commit that changed it.
  const detachedRef = useRef<DetachedTarget | null>(detached);

  // Symbol / period changes -> reload history, (re)subscribe live, set scroll-back.
  useEffect(() => {
    detachedRef.current = detached;
    const chart = handle.chartRef.current;
    const dataFacade = handle.dataFacadeRef.current;
    if (!chart || !dataFacade) return;
    let cancelled = false;
    let retryTimer: number | null = null;
    // A series switch starts the backoff over; a retry re-run (same series)
    // keeps escalating it. sameSeriesRerun also gates keep-painted-on-empty
    // below: only a re-run of the identical series may leave old bars on screen.
    const seriesKey = `${brokerId}|${symbol.epic}|${period.resolution}|${priceSide}`;
    const sameSeriesRerun = retrySeriesRef.current === seriesKey;
    if (!sameSeriesRerun) {
      retrySeriesRef.current = seriesKey;
      retryAttemptRef.current = 0;
    }
    // Detached: this run paints ONLY the window around a deep Go-to-date target,
    // with no live stream behind it. Replay wins if both are somehow on (a
    // session owns the bars outright), so every guard below can read this one
    // flag. It is decided synchronously here because the view/center decisions
    // it gates are made before the async load starts.
    const detachedMode = !!detached && !(handle.replayRef.current?.isActive() ?? false);

    // Center-preservation across a timeframe change: capture the bar at the
    // horizontal center of the view now, from the OLD (about-to-be-replaced)
    // bars, before setBars below resets the view to the live edge. Restored
    // after the new bars load when the user opted into preserve-center
    // (see below). Same center-pixel read as the persisted view position; the
    // index-midpoint fallback (biased left in right-edge whitespace, see
    // readCenterBarTs) covers a zero-width pane where the pixel read fails.
    const priorCenterTs =
      readCenterBarTs(chart) ??
      (() => {
        const data = chart.getDataList();
        if (!data || data.length === 0) return null;
        const vr = chart.getVisibleRange();
        const mid = Math.round((vr.from + vr.to) / 2);
        return data[Math.max(0, Math.min(data.length - 1, mid))]?.timestamp ?? null;
      })();
    // How many bars the view shows — sizes the pre-paint coverage walk below
    // (the restored center needs half a viewport of bars to its left).
    const priorViewBars = (() => {
      const vr = chart.getVisibleRange();
      return Math.max(0, vr.to - vr.from);
    })();

    // A pure timeframe change (not an epic switch, no pending range pick) with
    // preserve-center ON keeps the centered time instead of jumping to the live
    // edge. Decided up front so the view can be held steady through the WHOLE
    // reload — the setPeriod re-init and the awaited fetch below both otherwise
    // snap to the edge. (epic/res change flags are recomputed with the same
    // reads further down for the range/measure teardown.)
    const isEpicChange = prevEpicRef.current !== symbol.epic;
    const isResChange = prevResRef.current !== period.resolution;
    // A backoff-retry re-run (empty or degraded load healing): same series, only
    // the nonce moved. It must NOT snap the view to the live edge — during an
    // outage the retry fires every 5-60s, and a user studying scrolled-back
    // history would be yanked to the edge on every cycle. Unconditional (not
    // gated on the preserve-center setting): that setting governs deliberate TF
    // switches, while this is a background refresh the user never asked for.
    const isRetryRun = retryNonce !== lastRetryNonceRef.current && !isEpicChange && !isResChange;
    lastRetryNonceRef.current = retryNonce;
    // Never while detached: the on-screen center is a target years back, and
    // holding it would make a timeframe change trip the too-deep notice below
    // (which would then print the very date a masked session hides) and park a
    // stale intent. Detached positioning is owned by the explicit centre on
    // detached.targetMs after the load — the same reasoning as replay's cursor.
    const keepCenter =
      !detachedMode &&
      ((isResChange &&
        !isEpicChange &&
        priorCenterTs != null &&
        !handle.pendingRangeRef.current &&
        loadSettings().preserveCenterOnTfChange) ||
        (isRetryRun && priorCenterTs != null && !handle.pendingRangeRef.current));
    // Fresh mount (page reload / cell open): restore the view position the
    // scroll/zoom subscription below last saved for this cell — same opt-in as
    // the TF-change preserve, and only when the saved epic+resolution still
    // match (a symbol or TF changed elsewhere makes the saved center stale).
    // Snapshot tabs position themselves (parked pendingRange), so skip them.
    // didInitRef is marked in the async block below, NOT here: StrictMode
    // mounts, cleans up, and remounts this effect, and the first (immediately
    // cancelled) run must not consume the one-shot restore before the second
    // run — the one that actually loads — gets to use it.
    const savedView = !didInitRef.current && loadSettings().preserveCenterOnTfChange ? loadViewPos(scope) : null;
    // Detached runs never consume the reload restore either (same reason as
    // replay: the saved centre is a LIVE view, and it must still be there for
    // the load that leaving detached triggers).
    const restoreView =
      !detachedMode &&
      savedView &&
      savedView.epic === symbol.epic &&
      savedView.resolution === period.resolution &&
      !handle.pendingRangeRef.current &&
      !loadSnapshotMeta(scope)
        ? savedView
        : null;
    // The single "where should the view land" target for the whole load: the
    // held center on a TF change, the saved center on a reload, else null (jump
    // to the latest bar). A pending intended center (a previous switch was too
    // deep and fell back to the latest candles) takes precedence over the
    // current view's center — but only while the view still sits snapped at
    // the live edge, i.e. exactly where that failed switch left it; anywhere
    // else means something (trade restore, range fit) repositioned the view
    // deliberately and the stale intent must not yank it away.
    if (isEpicChange) intendedCenterRef.current = null;
    const atLiveEdge = (() => {
      const data = chart.getDataList();
      if (!data || data.length === 0) return false;
      return chart.getVisibleRange().to >= data.length - 1;
    })();
    const pendingIntentTs = atLiveEdge ? intendedCenterRef.current : null;
    const wantCenterTs =
      keepCenter && priorCenterTs != null
        ? (pendingIntentTs ?? priorCenterTs)
        : (restoreView?.centerTs ?? null);
    // A center too deep for this timeframe's cover budget (e.g. a 1D view
    // centered years back switched to 1m) can never be reached — covering it
    // would fetch an unbounded bar count. Depth is knowable up front (target
    // vs now), so don't hold the view and burn hundreds of fetches on a lost
    // cause: jump to the latest bar and say why, mirroring jump-to-trade's
    // "open it on a higher timeframe" notice. Within budget, the cover below
    // fetches for real; if the BROKER's history bottoms out short of the
    // target, the view clamps to the oldest bar (the user's chosen edge
    // behavior), no notice.
    const tooDeep =
      wantCenterTs != null &&
      !period.liveOnly &&
      (Date.now() - wantCenterTs) / ((RESOLUTION_SECONDS[period.resolution] ?? 60) * 1000) >
        COVER_PAGE_BARS * COVER_MAX_WINDOWS;
    if (tooDeep) {
      const day = new Date(wantCenterTs!).toLocaleDateString();
      // Never while replaying: tooDeep measures distance from NOW, and a replay
      // centre is old by construction, so a re-run inside a session can trip it
      // and print the real date the session exists to hide. Only the COPY is
      // suppressed — the parked intent below still stands, and the centring this
      // feeds is already inert while replaying (the cursor owns the view).
      // Retry re-runs repeat on a 5-60s backoff — re-toasting the same notice
      // every cycle would spam; the parked intent below still survives.
      if (!isRetryRun && !(handle.replayRef.current?.isActive() ?? false))
        toast(`${day} is too far back for ${period.label}. Showing the latest candles instead.`);
      // Park the unreached center so the NEXT timeframe change can restore it
      // (cleared on gesture / epic change / a switch that lands — see the ref).
      intendedCenterRef.current = wantCenterTs;
    }
    // A parked zoom-to-range center wins unconditionally: it is an explicit user
    // intent that must override keepCenter, the too-deep fallback, and the
    // reset-view-on-timeframe-change setting. Only when THIS load is its target
    // resolution (else it stays parked for the load it was queued for).
    const pendingCenter = handle.pendingCenterRef.current;
    const zoomCenterTs =
      pendingCenter && pendingCenter.resolution === period.resolution ? pendingCenter.centerTs : null;
    // Detached positions itself on detached.targetMs after the load, so every
    // live-series centring target (including a parked zoom-to-range one, which
    // belongs to the live view) is inert here.
    const centerTargetTs = detachedMode ? null : (zoomCenterTs ?? (tooDeep ? null : wantCenterTs));

    // Declare the instrument (carries precision) + timeframe to v10. Both must be
    // set before the async setBars below, since v10 fires getBars(init) once
    // symbol+period+loader are all present; the facade serves stored bars, so the
    // extra init fire before setBars is harmless (empty until setBars runs).
    dataFacade.setSymbol(symbol.epic, effPrecision, 0);
    dataFacade.setPeriod(periodFromTf(period.label));
    // setPeriod re-inits v10 to the live edge with the OLD bars still loaded, and
    // that edge view is painted for the entire fetchRecent await below — the
    // visible "jump to the latest candle, then snap back" on every timeframe
    // change. Re-center on the old bars now so the view holds steady until the
    // new bars replace them (it re-centers again on the new data after load).
    // No-op on a fresh mount (no bars yet).
    if (centerTargetTs != null) scrollTsToCenter(chart, centerTargetTs);
    overlays.setPricePrecision(effPrecision); // keep alert-level rounding in lockstep
    overlays.setEpic(symbol.epic);
    // Alerts are stored per broker; address them with THIS cell's broker (not the
    // ambient persistBroker the toolbar may flip mid-switch). In lockstep with setEpic.
    overlays.setBroker(brokerId);
    // Backtest markers/equity belong to the previous series — drop the live
    // artifacts immediately (keep the persisted result; rehydrateBacktest below
    // redraws it for the new series once its bars are loaded). Capture the
    // selected trade FIRST: teardown nulls the shared selection, so we grab it
    // here (while this chart still owns the panel) to re-center on it after the
    // switch. Fall back to a restore a superseded run never got to attempt, so
    // rapid TF switches don't drop the selection.
    const capturedSelectedTrade = selectedTradeForChart(chart) ?? handle.pendingTradeRestoreRef.current;
    // Captured for the same reason, and it MUST be read here: teardownArtifacts
    // nulls `artifacts.result`, and after that "did this chart back the shared
    // panel?" can no longer be answered. The replaying branch at the tail of this
    // effect needs the answer (see backtestPanelActionForReplay).
    const ownedPanelBeforeTeardown = ownsBacktestPanel(chart);
    teardownArtifacts(chart);
    // Reset scroll-back state for the new series.
    handle.loadingRef.current = false;
    handle.exhaustedRef.current = false;
    handle.emptyStreakRef.current = 0;
    // A detached load replaces the series with a window years away, so any
    // parked quick-range pick targets bars that will not exist. Drop the token
    // (not just its walk): consumption requires the walk to run, and a token
    // left parked permanently gates ensureAnchorCoverage and every
    // coverBacktestTradeTo walk — including after the user comes back to live.
    if (detachedMode && handle.pendingRangeRef.current) {
      handle.pendingRangeRef.current = null;
      setActiveRange(null);
    }

    // Drop a stale quick-range when this re-run isn't the range pick itself.
    // - Epic change: the boundary belongs to the OLD instrument's timeline — clear
    //   the separator, the pill, and any in-flight fit (it targeted the old series).
    // - Manual interval change (toolbar, no pending pick): the view no longer
    //   matches the preset, so drop the pill; the separator stays (a "start of
    //   today" marker is still valid at any interval).
    const epicChanged = prevEpicRef.current !== symbol.epic;
    const resChanged = prevResRef.current !== period.resolution;
    // Preserve the outgoing symbol's analysis BEFORE anything of the incoming
    // symbol is written: capture it into its own template now (the replace-on-
    // open below would otherwise destroy un-captured work). The capture target
    // is lookEpicRef — the epic that actually OWNS the current on-chart look —
    // not prevEpicRef: a rapid A→B→A switch cancels B's async apply before it
    // ever ran, so at the return leg the cell still holds A's look and writing
    // it into B's template (the prev epic) would corrupt B. Guards:
    //  - autoSaveTemplates ON: with it off the user manages templates manually
    //    (an unconditional capture would silently overwrite a curated template);
    //    the matching replace below is gated off too, so nothing is destroyed.
    //  - lookEpic differs from the incoming epic (mount and TF-only re-runs
    //    are not switches; A→B→A lands here with lookEpic === epic → no-op).
    //  - Snapshot tabs are study copies and must never write the symbol's template.
    const autosaveOn = loadSettings().autoSaveTemplates;
    const lookEpic = lookEpicRef.current;
    const templateSwitch =
      autosaveOn && lookEpic !== null && lookEpic !== symbol.epic && !loadSnapshotMeta(scope);
    if (templateSwitch) {
      flushTemplateCapture(scope, lookEpic);
    }
    // Park the captured trade for the post-walk restore below. An epic change
    // loads a DIFFERENT backtest whose trade array the old index wouldn't map
    // onto — drop it instead.
    handle.pendingTradeRestoreRef.current = epicChanged ? null : capturedSelectedTrade;
    prevEpicRef.current = symbol.epic;
    prevResRef.current = period.resolution;
    // A symbol or interval change invalidates any live measurement (its anchors map
    // onto the old timescale) — discard it and disarm the ruler.
    if (epicChanged || resChanged) {
      measureArmed.set(false);
      overlays.clearMeasure();
      // A live slope line maps onto the old timescale too — discard it and disarm.
      slopeArmed.set(false);
      overlays.clearSlope();
      // A live Pick Range band is anchored to the old timescale too — disarm it.
      rangePickArmed.set(false);
      overlays.clearRangePick();
      // The zoom-to-range band: on an epic change or a MANUAL interval change
      // (no matching parked center) it is stale — drop it. On the tool's OWN
      // interval change (pendingCenterRef matches the incoming resolution) the
      // old-timescale overlay is dropped here too and redrawn after the load
      // settles (Step 3). Either way the old overlay goes now; on an epic change
      // the parked target is also stale, so null the ref.
      overlays.clearZoomBand();
      if (epicChanged) handle.pendingCenterRef.current = null; // stale target
    }
    if (epicChanged) {
      handle.separatorTsRef.current = null;
      sepCacheRef.current = null;
      handle.pendingRangeRef.current = null;
      setActiveRange(null);
    } else if (resChanged) {
      // A pending pick whose target interval doesn't match the one that just
      // loaded was OVERRIDDEN (the user changed interval again before its walk
      // ran) — it can never be consumed (consumption requires resolution
      // equality below), and leaving it parked would permanently gate the
      // drawing-anchor coverage walk. Drop it along with the pill.
      if (handle.pendingRangeRef.current && handle.pendingRangeRef.current.resolution !== period.resolution) {
        handle.pendingRangeRef.current = null;
      }
      if (!handle.pendingRangeRef.current) setActiveRange(null);
      // Same for a parked zoom-to-range center: a manual switch to a DIFFERENT
      // resolution overrides it, and consumption requires resolution equality —
      // left parked, a later switch back to its target resolution would
      // spuriously re-force the stale center and redraw the stale band. Drop it.
      if (handle.pendingCenterRef.current && handle.pendingCenterRef.current.resolution !== period.resolution) {
        handle.pendingCenterRef.current = null;
      }
    }
    // No data for the new series until history loads or a live tick arrives. The
    // banner is grace-gated, so this can't flash during a normal load — only when
    // the broker is genuinely unreachable.
    setHasData(false);
    setLoadError(null);
    setErrorOpen(false);

    (async () => {
      // A REPLAYING cell owns its own bars: it paints only what is closed at the
      // cursor and never streams. Branching HERE — before the recent-history
      // fetch — is load-bearing: handing off at the tail would paint live bars
      // (the future) for a frame, and in a masked session that is the one thing
      // the feature exists to prevent.
      const replay = handle.replayRef.current;
      const replaying = replay?.isActive() ?? false;
      let bars: KLineData[];
      let degraded: string | null = null;
      if (replaying) {
        bars = await replay!.barsFor(period.resolution);
      } else if (detachedMode) {
        // The detached window: a few 500-bar ranges around the target, fetched
        // concurrently (the backend serves a deep range pass-through, so this is
        // seconds even on a cold cache). Adjacent windows SHARE a boundary
        // second and the range read is inclusive, so dedupe by timestamp as well
        // as sort — duplicate timestamps corrupt the series.
        const resSec = RESOLUTION_SECONDS[period.resolution] ?? 60;
        const failures: unknown[] = [];
        const chunks = await Promise.all(
          detachedWindows(detached!.targetMs, resSec).map((w) =>
            fetchRange(symbol.epic, period.resolution, w.fromSec, w.toSec, priceSide, brokerId).catch(
              (err: unknown) => {
                // One window failing must not lose the rest; remember it so the
                // banner can say the load was incomplete rather than empty.
                failures.push(err);
                return [] as KLineData[];
              },
            ),
          ),
        );
        const byTs = new Map<number, KLineData>();
        for (const chunk of chunks) for (const b of chunk) byTs.set(b.timestamp, b);
        bars = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
        const failed = failures[0];
        if (failed !== undefined && !cancelled) {
          console.warn(`[chart] detached load incomplete for ${symbol.epic}`, failed);
          setLoadError(failed instanceof Error ? failed.message : String(failed));
        }
      } else {
        // Tolerate a failed initial load (offline/DNS/refused/CORS make fetchRecent
        // REJECT, not return []): fall back to no history and carry on. Crucially this
        // still reaches rehydrate() below, which advances overlays.hydratedEpic — skip
        // it and persist() stays gated on the stale epic forever, silently dropping
        // every alert/drawing the user adds until they switch symbol again.
        try {
          const loaded = await fetchRecentWithStatus(symbol.epic, period.resolution, 500, priceSide, brokerId);
          bars = loaded.bars;
          degraded = loaded.degraded;
        } catch (err) {
          console.warn(`[chart] initial load failed for ${symbol.epic}; continuing with no history`, err);
          bars = [];
          if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
      if (!cancelled) setDegraded(degraded);
      if (cancelled || !handle.chartRef.current) return;
      // This run owns the load — the saved-view restore is spent (see above).
      // A REPLAYING run does not consume it: it never uses restoreView (the
      // cursor owns the view), so leaving the one-shot unspent keeps it
      // available to the load that exiting the session triggers, which is the
      // run that should land the user back where they left the chart.
      if (!replaying) didInitRef.current = true;
      // Cover the preserved center BEFORE the first paint of the new timeframe.
      // The recent window above is only ~500 bars; a center further back than
      // that would otherwise paint a wrong view first (clamped to the window's
      // oldest bar) and only land on the centered time seconds later, when the
      // background coverage walks page the history in — a visible two-stage
      // switch. Covering here, while the OLD timeframe's bars are still
      // painted (held by the post-setPeriod re-center above), makes the new
      // bars appear once, already centered. Parallel windows, not a sequential
      // walk: the target is a KNOWN bar time (it was on screen), so every
      // window down to it can be computed up front and fetched concurrently —
      // the same trade-off jump-to-trade makes, with the same safety cap. A
      // 1D→1H switch centered years back needs dozens of windows; the old
      // 16-page sequential budget covered barely a year of hours and silently
      // clamped anything deeper. Past the cap, or where the broker's history
      // bottoms out, scrollTsToCenter clamps to the oldest loaded bar.
      // Replay positions itself at the cursor (right edge of its own slice), so
      // the preserve-center cover would only fetch history it never uses.
      if (!replaying && centerTargetTs != null && bars.length > 0 && centerTargetTs < bars[0].timestamp) {
        const resSec = RESOLUTION_SECONDS[period.resolution] ?? 60;
        // On a reload there's no prior view to size the pad from — assume a
        // typical viewport (the cover just fetches a window more than needed).
        const padBars = Math.ceil((priorViewBars || 280) / 2) + 8;
        let merged = bars;
        await coverHistoryRangeParallel<KLineData>({
          fromTs: centerTargetTs - padBars * resSec * 1000,
          toTs: bars[0].timestamp,
          resSec,
          pageBars: COVER_PAGE_BARS,
          maxWindows: COVER_MAX_WINDOWS,
          concurrency: 6,
          isStale: () => cancelled || !handle.chartRef.current,
          getData: () => merged,
          fetchOlder: (fromSec, toSec) =>
            fetchRange(symbol.epic, period.resolution, fromSec, toSec, priceSide, brokerId),
          applyData: (m) => {
            merged = m;
          },
        });
        if (cancelled || !handle.chartRef.current) return;
        bars = merged;
      }
      // A same-series re-run (a backoff retry, notably) that came back EMPTY
      // keeps whatever is already painted — wiping a chart the user is looking
      // at because one retry failed is strictly worse than stale bars under the
      // stale pill (e.g. bars a parked range pick's walk paged in after an
      // earlier empty load, or a degraded load's cached bars). A series SWITCH
      // that fails still clears below: the old series must not masquerade as
      // the new one. hasData stays false either way, so the banner + retry
      // still own recovery.
      // ...but NEVER while replaying: entering replay re-runs this effect on the
      // SAME series key, so an empty (degraded/failed) barsFor read would leave
      // the LIVE bars painted under an active session — the future on screen,
      // the exact leak this branch exists to prevent. Wiping them clears the
      // paint only — the session mode, the bar store and the persisted record
      // all stand — and the empty load re-arms the history backoff below, whose
      // re-run calls barsFor again. (Enter-from-live also still has its store,
      // populated by startAt, so stepping keeps working meanwhile; a resumed
      // session has no store yet and depends entirely on that retry.)
      const keepPainted = shouldKeepPaintedBars(
        bars.length,
        handle.chartRef.current.getDataList().length,
        // ...and never while DETACHED, for the same reason: entering detached is
        // a same-series re-run, so an empty window read would leave the LIVE
        // bars painted under a view the user thinks is 2021.
        sameSeriesRerun && !replaying && !detachedMode,
      );
      if (!keepPainted) {
        // Cursor starts at the oldest loaded bar; scroll-back requests older windows.
        handle.cursorSecRef.current = bars.length
          ? Math.floor(bars[0].timestamp / 1000)
          : Math.floor(Date.now() / 1000);
        // canLoadOlder arms left-edge scroll-back paging (the facade owns the v10
        // flag translation; onLoadRequest answers the loads). Live-only (seconds)
        // intervals have no history, so disable scroll-back there to avoid firing
        // empty fetchRange windows that walk back for nothing.
        dataFacade.setBars(bars, !period.liveOnly);
      }
      if (isSynthetic(symbol.epic) && bars.length > 0) {
        const p = synthPrecision(bars[bars.length - 1].close);
        setFetchedPrecision(p);
        setSyntheticPrecision(symbol.epic, p);
      }
      // Live-only (seconds) intervals legitimately start empty and fill from the
      // stream, so don't badge them no-data on the empty history; the first tick
      // below flips hasData true. Native intervals with no history are genuinely
      // empty until proven otherwise.
      setHasData(bars.length > 0);
      if (!shouldRetryHistory(bars.length, degraded)) {
        retryAttemptRef.current = 0;
      } else if (
        !period.liveOnly &&
        !cancelled &&
        // Detached reads its own fixed window, so a DEGRADED live tail says
        // nothing about it — no healing loop. But an EMPTY read is a failed
        // fetch just as it is under replay, and the banner promises a retry, so
        // re-arm the backoff for that case exactly (the re-run refetches the
        // same windows; `detached` is in the dep array but unchanged, and the
        // nonce is what re-enters).
        ((!replaying && !detachedMode) || bars.length === 0)
      ) {
        // Live-only (seconds) intervals legitimately start empty (they fill from
        // the stream) — everything else with no bars is a failed/empty load, and
        // a DEGRADED load (cached bars served during a broker outage) is missing
        // its tail: schedule a re-run either way so the series heals when the
        // broker returns. The cleanup below clears the timer, so a series
        // switch or unmount can't leak a stale retry.
        // A replaying cell owns its own bars and needs no history retry — UNLESS
        // its load came back EMPTY, which is a failed read, not an empty series.
        // That case re-arms this same backoff, and it is the ONLY way a resumed
        // session heals: on the mount run useReplay's store is still empty, and
        // nothing inside the hook can create one (refillIfNeeded early-returns on
        // an empty store — a refill extends a store, it cannot create it — and
        // stepForward can't advance without a loaded successor). The re-run calls
        // barsFor again; the backoff delay is what paces it. A SUCCESSFUL replay
        // load has bars and schedules nothing.
        const delay = nextHistoryRetryDelayMs(retryAttemptRef.current++);
        retryTimer = window.setTimeout(() => setRetryNonce((n) => n + 1), delay);
      }
      // Anchor the view. Default (reset-on-TF off): a pure timeframe change
      // keeps the previously-centered time centered, so the same moment stays
      // in view across timeframes (scrollTsToCenter clamps to the nearest
      // loaded bar). Jump to the latest bar when the user opted into
      // reset-on-TF-change, when this isn't a pure TF switch (epic change, or
      // a side/broker refresh that left the resolution unchanged), or when we
      // couldn't read a prior center. On a fresh mount, centerTargetTs instead
      // carries the saved-view center (reload restore) — with its saved zoom
      // re-applied first so the centered window spans what it did before.
      // centerTargetTs was decided up front (before setPeriod) so the view
      // could be held steady through the fetch too.
      // keepPainted: the bars (and therefore the user's view onto them) were
      // left untouched — repositioning would yank a view the user may be
      // reading to the live edge for a load that applied nothing.
      if (replaying) {
        // The cursor bar IS the right edge of the replay slice.
        handle.chartRef.current.scrollToRealTime();
      } else if (detachedMode) {
        // The target date IS the view: centre on it (scrollTsToCenter clamps to
        // the nearest loaded bar if the broker's history starts inside the
        // window). No live-edge jump, and no captureViewPos — a detached centre
        // is not where the user's LIVE chart belongs, and persisting it would
        // drop the cell into the past on the next reload.
        scrollTsToCenter(handle.chartRef.current, detached!.targetMs);
        repositionPinRef.current?.();
      } else if (!keepPainted) {
        if (restoreView && restoreView.barSpace > 0) {
          handle.chartRef.current.setBarSpace(restoreView.barSpace);
        }
        if (centerTargetTs != null) {
          scrollTsToCenter(handle.chartRef.current, centerTargetTs);
          // Landed on the target — any parked too-deep intent is fulfilled (or
          // superseded by this fresher preserve).
          intendedCenterRef.current = null;
        } else {
          handle.chartRef.current.scrollToRealTime();
        }
        // Record the settled position (see captureViewPos): programmatic
        // positioning fires no scroll action, so the subscription alone would
        // leave the saved view stale after a TF/symbol switch. A too-deep switch
        // persists the UNREACHED intended center, not the latest-candles view it
        // fell back to, so a reload keeps the chosen center too.
        captureViewPos(
          handle.chartRef.current,
          scope,
          symbol.epic,
          period.resolution,
          tooDeep ? (intendedCenterRef.current ?? undefined) : undefined,
        );
        repositionPinRef.current?.();
      }
      // Rehydrate this symbol's saved drawings + alerts now that the data (and
      // therefore the timescale their points map onto) is loaded. Passing the
      // resolution makes rehydrate adopt it BEFORE points materialize — a
      // future-anchored point decodes its timestamp with the bar width, and a
      // trailing setResolution() call left it decoding with the PREVIOUS
      // timeframe's width on every switch (trendline slope changed, and the
      // next persist baked the drift in). This also re-derives each drawing's
      // per-interval visibility, so no separate setResolution call remains.
      // Read-only snapshot view must be set BEFORE rehydrate: it decides whether
      // drawings materialize locked and whether the epic's live alert lines
      // materialize at all. This is the one storage read; it re-asserts
      // controller.readOnly (whose subscription mirrors it into snapViewRef) and
      // refreshes the banner state (effect re-runs on TF switches; meta only
      // actually changes via Unlock).
      const markerMeta = loadSnapshotMeta(scope);
      controller.readOnly.set(markerMeta != null);
      setSnapView(markerMeta);
      overlays.setReadOnly(markerMeta != null);
      overlays.rehydrate(period.resolution);
      // Redraw the zoom-to-range band from its stored timestamps now that the
      // lower-TF bars are loaded and the view is centered, then consume the ref
      // (guarded on matching resolution so it fires at most once). Must run
      // AFTER rehydrate: rehydrate starts by tearing down EVERY overlay
      // registered in the manager's entries — including transient ones like
      // this band — so a redraw before it is wiped a few lines later.
      const pc = handle.pendingCenterRef.current;
      if (pc && pc.resolution === period.resolution) {
        overlays.redrawZoomBand(pc.bandStartTs, pc.bandEndTs);
        handle.pendingCenterRef.current = null;
      }
      // A restored pattern-search selection band, parked by the series-reset
      // effect for the same reason: painted any earlier, rehydrate's teardown
      // wipes it. Consumed once, like the zoom band above.
      const ppb = handle.pendingPatternBandRef.current;
      if (ppb) {
        overlays.redrawZoomBand(ppb.fromMs, ppb.toMs);
        handle.pendingPatternBandRef.current = null;
      }
      // A cross-tab pattern jump's match/aftermath bands, parked by the mount
      // that consumed the pending jump — painted here for the same reason.
      const pmb = handle.pendingMatchBandsRef.current;
      if (pmb) {
        overlays.showMatchBands(pmb.fromMs, pmb.toMs, pmb.fwd);
        handle.pendingMatchBandsRef.current = null;
      }
      // Snapshot-moment marker: dashed vertical line + time-axis chip at the
      // taken-at timestamp of a restored snapshot tab, independent of the
      // pendingRange walk below. Remove the previous marker first — this effect
      // re-runs on every symbol/TF switch, and the old overlay id no longer
      // matches the freshly loaded series. Clicking the chip = Unlock (same flow
      // as the banner button).
      if (handle.snapMarkerIdRef.current) {
        handle.chartRef.current.removeOverlay({ id: handle.snapMarkerIdRef.current });
        handle.snapMarkerIdRef.current = null;
      }
      if (markerMeta) {
        handle.snapMarkerIdRef.current = renderSnapshotMarker(handle.chartRef.current, markerMeta, () => {
          unlockSnapshotView();
        });
      }
      // Restore this cell's saved backtest (markers/equity/trades) for the new
      // series — the backtest counterpart to overlays.rehydrate. Markers show on
      // the backtest's native timeframe and any finer one where fills align to
      // bars; equity only on the native one; a coarser timeframe draws nothing
      // but keeps the result saved. Republishes backtestResultSignal so the
      // trades panel + summary chip come back.
      // (Re-selecting the previously-studied trade waits until the coverage
      // walks below settle — see the anchor-coverage chain.)
      //
      // NEVER while replaying — the rule, and the reasons, live on
      // backtestPanelActionForReplay. "clear" needs the ownership captured
      // BEFORE the teardown at the top of this effect: by here `artifacts.result`
      // is null, so an owner check made now would answer no and quietly leave the
      // pre-session run on the panel behind the session.
      const panelAction = backtestPanelActionForReplay({
        replaying: handle.replayRef.current?.isActive() ?? false,
        stalePanelOwner: ownedPanelBeforeTeardown,
      });
      if (panelAction === "rehydrate") {
        rehydrateBacktest(handle.chartRef.current, scope, symbol.epic, period.resolution);
      } else if (panelAction === "clear") {
        backtestResultSignal.set(null);
      }
      // Redraw position lines for the (possibly new) epic at the current precision.
      handle.posLinesRef.current?.setPrecision(effPrecision);
      handle.posDrawRef.current();
      // Same for the live trade markers — the epic's entry/exit arrows against the
      // freshly loaded bars (reconcile drops the old epic's markers).
      handle.tradeMarkersDrawRef.current();
      // Re-evaluate the selected-trade pill against the now-current epic: selecting a
      // dock row for an OFF-chart symbol switches the epic here, and the pill only
      // shows for a trade on this epic — so refresh once the rehydrate lands rather
      // than waiting for the next live tick.
      handle.redrawRef.current();
      // Mirror the drawings' interval filter for indicators: re-derive each
      // indicator's effective visibility (user intent AND interval match) against
      // the now-current resolution. Runs here so both a fresh rehydrate (above)
      // and a plain period switch (this effect re-runs on period.resolution) land
      // on the right on-chart state — a view reaction only, nothing persisted.
      // Guard: the sidebar "Hide indicators" master switch overrides this re-derive —
      // while it's on, re-assert all-hidden instead of un-hiding.
      applyIndicatorVisibility(handle.chartRef.current, period.resolution, controller.indicatorsHidden.value);
      // Same reasoning, same call site: every live Slope's barHours must track the
      // CURRENT resolution (nominal, never inferred) so the pane and the backend rule
      // path agree bar-for-bar. Runs here — not from applyIndicator — because the
      // chart's resolution isn't reliably known at indicator-creation time (a fresh
      // rehydrate runs before this effect ever sets the chart's period).
      applySlopeBarHours(handle.chartRef.current, period.resolution);
      // A symbol switch recreates the sub-panes at their default height, so re-assert
      // the double-click "hide bottom sub-panes" collapse if it's on. forceCollapse
      // (not collapseSubPanes) so it doesn't overwrite the captured heights with the
      // freshly-recreated defaults — the map from the original toggle is the source of
      // truth for restore (recreated panes have new ids and fall back to the default).
      if (controller.subPanesHidden.value) forceCollapseSubPanes(handle.chartRef.current);
      // A quick-range pick that switched interval parked its window here; the
      // initial new-resolution bars are loaded, so page back to the period start
      // (if needed) and fit. ensureCoverageAndFit clears pendingRangeRef when done.
      const pend = handle.pendingRangeRef.current;
      // A deepCover fit that lands successfully must survive the anchor walk
      // chained below: that walk prepends bars toward the run's OLDEST fill,
      // and each prepend is a full setBars re-init that resets the view to
      // the live edge — the same wipe positionSnapshotRange re-asserts
      // against. Recorded here, re-applied in the anchorWalk.then block.
      let drillFit: { fromTs: number; toTs: number } | null = null;
      // A deepCover token (backtest drill-in) targets bars behind the sequential
      // walk's 16-page budget: run the parallel cover first (goToRange's recipe
      // for match jumps — every window between the target and the loaded left
      // edge fetched concurrently), then let the walk land the fit on bars that
      // now exist. Toast when the broker's history bottoms out short of the
      // trades: silence there reads as a broken drill-in (whitespace where the
      // markers should be).
      const rangeWalk =
        pend && pend.resolution === period.resolution && handle.chartRef.current
          ? pend.deepCover
            ? coverBacktestTradeTo(pend.fromTs, { owner: pend }).then(async () => {
                if (handle.pendingRangeRef.current !== pend) return "aborted" as const;
                const res = await handle.ensureCoverageAndFitRef.current(pend);
                if (res !== "aborted" && !cancelled) {
                  drillFit = { fromTs: pend.fromTs, toTs: pend.toTs };
                  // Warn against the UNPADDED trade start: the padded fromTs
                  // routinely sits in a closed-market gap (weekend) that no
                  // broker has bars for, and warning on it would cry wolf on
                  // every span that opens a Monday (see goToRange's identical
                  // lesson: the target is the trades, padding is context).
                  const oldest = handle.chartRef.current?.getDataList()[0];
                  if (oldest && oldest.timestamp > (pend.targetFromTs ?? pend.fromTs))
                    toast(`History doesn't reach these trades on ${period.label}. Showing the oldest available.`);
                }
                return res;
              })
            : handle.ensureCoverageAndFitRef.current(pend)
          : null;
      // Re-apply each AVWAP instance's anchor for this epic (anchors are per-epic,
      // per-instance; no-op if no AVWAP is active).
      const candlePane = getIndicatorsByPane(handle.chartRef.current).get("candle_pane");
      for (const [id, ind] of candlePane ?? []) {
        if (indTypeOf(ind) !== "AVWAP") continue;
        handle.chartRef.current.overrideIndicator({
          name: id,
          calcParams: [loadAvwapAnchor(scope, symbol.epic, id)],
        });
      }
      // Re-fetch HTF data for any EMA/MA pinned to a higher timeframe — the
      // stashed series belonged to the previous epic/range (no-op otherwise).
      liveMtfBucketRef.current = null; // this refresh covers the current bucket
      void refreshMtfIndicators(handle.chartRef.current, symbol.epic, brokerId);

      // Make the cell LOOK like this symbol's saved template (replace-on-open).
      // Runs once per epic open (lookEpicRef), after rehydrate so it sees final
      // state. Replace is allowed ONLY on the switch that captured the outgoing
      // look above (templateSwitch) — on mount/reload, or with autosave off, a
      // populated cell may hold analysis no template ever captured, so only a
      // FRESH cell gets the template (applyLookOnOpen's default gate). A snapshot
      // tab (markerMeta non-null) marks the epic handled WITHOUT applying — and
      // must keep doing so through Unlock, or the freshly unlocked study copy
      // would be stomped by the symbol's template on the next effect re-run.
      if (lookEpicRef.current !== symbol.epic) {
        lookEpicRef.current = symbol.epic;
        if (!markerMeta) {
          applyLookOnOpen(handle.chartRef.current, controller, scope, symbol.epic, {
            replace: templateSwitch,
          });
        }
      }

      // A restored snapshot tab parks a one-shot pendingRange on this scope's
      // snapshotMeta (see writeSnapshotToScope) — page history back to cover it.
      // Reuses coverBacktestTradeTo directly — it has no backtest-only guards,
      // just a generic bounded page-back-to-a-target walk that no-ops the
      // backtest-marker redraw when there's no rendered result. Both this walk
      // and the anchor walk below are already running by the time either
      // .then() fires — the chaining doesn't sequence their execution. What
      // actually prevents the two pagers from contending for loadingRef is
      // coverBacktestTradeTo's own pendingRangeRef bail (each walk gates the
      // others) plus the bounded loadingRef wait; the .then() chain only
      // controls when positionSnapshotRange/ensureAnchorCoverage run relative
      // to the pagers' settling. The snapshot range usually already covers the
      // restored drawings' anchors (captured inside that same window), so
      // ensureAnchorCoverage typically finds nothing left to do.
      const snapMeta = markerMeta;
      const pendingRange = snapMeta?.pendingRange ?? null;
      // Not while detached: the walk would page from the detached window's left
      // edge toward a range in another era. The pendingRange stays unconsumed on
      // snapMeta, and a later run (leaving detached, the next TF switch) retries
      // it — the same "leave it parked" behaviour a preempted walk relies on.
      const snapshotWalk = pendingRange && !detachedMode ? coverBacktestTradeTo(pendingRange.from) : null;
      // Position the window on the saved snapshot range and clear pendingRange
      // (one-shot — a later reload of this same tab must not re-scroll). Called
      // only once the walk(s) ahead of it have fully settled: paging via the
      // facade's setBars resets the view to realtime on every page it applies, so
      // positioning any earlier risks being clobbered by a later page (e.g. a
      // drawing anchor older than the snapshot's own saved range).
      const positionSnapshotRange = (reached: boolean) => {
        if (cancelled || !pendingRange) return;
        // A quick-range pick made right after restore preempts this walk (see
        // coverBacktestTradeTo's own pendingRangeRef bail, which is why `reached`
        // can be false here without history actually being exhausted). Bail
        // before touching the view or meta so the user's pick stands, and leave
        // pendingRange unconsumed on snapMeta — a later effect run (e.g. the next
        // symbol/TF switch) retries the snapshot positioning then.
        if (handle.pendingRangeRef.current !== null) return;
        const c = handle.chartRef.current;
        if (!c) return;
        const data = c.getDataList() ?? [];
        if (data.length === 0) return;
        const oldest = data[0].timestamp;
        applyVisibleRange(c, Math.max(pendingRange.from, oldest), pendingRange.to);
        // The marker chip's dismiss confirm (above) may have deleted this scope's
        // snapshotMeta while this walk was still in flight — re-check before
        // writing it back, otherwise this unconditionally resurrects the record
        // the user just removed. The positioning itself still applies: dismissing
        // the marker is a decision about the meta/marker, not the scroll.
        if (loadSnapshotMeta(scope)) {
          saveSnapshotMeta(scope, {
            snapshotId: snapMeta!.snapshotId,
            name: snapMeta!.name,
            takenAt: snapMeta!.takenAt,
          });
        }
        if (!reached && oldest > pendingRange.from) {
          toast("History doesn't reach the snapshot range — showing oldest available");
        }
      };

      // Page back (no fit) until every saved drawing anchor maps onto a loaded bar —
      // otherwise klinecharts clamps older anchors to the first loaded bar and the
      // drawing renders with the wrong slope on this interval. Runs AFTER the
      // template auto-apply so template-added drawings count. It's chained after
      // the quick-range walk and the snapshot walk above, but that chaining is
      // just ordering of the .then() callbacks — the walks themselves are already
      // running concurrently by then, and mutual exclusion for the loading mutex
      // comes from pendingRangeRef/loadingRef (each walk bails if another already
      // owns it), not from this chain. Live-only intervals have no history to
      // page, so the snapshot walk (which also no-ops without history) settles on
      // its own and positions directly.
      // Not while detached either: every drawing anchor and backtest fill sits
      // in the LIVE era, so the walk would page from the detached window back
      // toward them — the years-deep backfill detaching exists to avoid. The
      // capped-anchor bookkeeping stays untouched, so leaving detached walks
      // them normally.
      if (!period.liveOnly && !detachedMode) {
        const baseWalk = snapshotWalk
          ? rangeWalk
            ? snapshotWalk.then(() => rangeWalk)
            : snapshotWalk
          : rangeWalk;
        const anchorWalk = baseWalk
          ? baseWalk.then(() => handle.ensureAnchorCoverageRef.current())
          : handle.ensureAnchorCoverageRef.current();
        if (snapshotWalk) {
          void anchorWalk.then(() => snapshotWalk.then(positionSnapshotRange)).catch(() => {});
        }
        // Re-select the trade the user was studying before the switch — only NOW,
        // once the switch-time coverage walks have settled. The walks prepend
        // pages via the facade's setBars, which resets the view to realtime each page; a
        // re-center issued while one is still running lands on the trade and then
        // snaps back to the live edge. Re-emitting the selection fires the
        // subscription renderArtifacts installed: redraw the R/R zone, page the
        // trade's own bars in if still off-window (coverBacktestTradeTo), scroll.
        // A superseded run (cancelled) leaves the ref parked for its successor.
        void anchorWalk.then(() => {
          if (cancelled || !handle.chartRef.current) return;
          // Re-land a drill-in fit the anchor walk's prepends reset (see
          // drillFit above). Clamped to the loaded oldest bar the same way
          // positionSnapshotRange clamps its window.
          if (drillFit && !handle.pendingRangeRef.current) {
            const oldest = handle.chartRef.current.getDataList()[0];
            if (oldest) {
              applyVisibleRange(handle.chartRef.current, Math.max(drillFit.fromTs, oldest.timestamp), drillFit.toTs);
            }
            return;
          }
          const restore = handle.pendingTradeRestoreRef.current;
          if (restore == null) {
            // No studied trade to restore. If we're preserving a center (TF
            // change with preserve-center on, or a reload's saved view), re-assert
            // it now: the same page-back setBars that clobbers a trade
            // re-center also clobbers the center set right after load. Skip if
            // a quick-range walk claimed the view in the meantime, and skip
            // unless the view actually sits snapped at the live edge — that's
            // the walk's re-init signature; anywhere else means either the walk
            // applied nothing (still centered) or the user panned while it ran,
            // and yanking their view back would be worse than a stale center.
            // Never while replaying: the cursor owns the view (positioned at the
            // right edge above), and centerTargetTs here is a LIVE center — a
            // resumed session's saved reload view, or the pre-switch center of a
            // timeframe change made mid-session. Re-asserting it would yank the
            // view off the cursor once the walks settle, and captureViewPos would
            // persist that yank.
            if (centerTargetTs != null && !handle.pendingRangeRef.current && !replaying) {
              const data = handle.chartRef.current.getDataList();
              const vr = handle.chartRef.current.getVisibleRange();
              if (data.length > 0 && vr.to >= data.length - 1) {
                scrollTsToCenter(handle.chartRef.current, centerTargetTs);
                captureViewPos(handle.chartRef.current, scope, symbol.epic, period.resolution);
                repositionPinRef.current?.();
              }
            }
            return;
          }
          handle.pendingTradeRestoreRef.current = null;
          restoreTradeSelection(handle.chartRef.current, restore);
        });
      } else if (snapshotWalk) {
        void snapshotWalk.then(positionSnapshotRange).catch(() => {});
      }

      // Live updates for the current bar. A replaying cell gets NONE: beyond the
      // future candles, the callback publishes setLivePrice to the positions dock
      // and drives the price/bid/ask axis tags. Closing the previous socket still
      // happens — entering replay must kill the stream this cell had.
      handle.wsRef.current?.close();
      handle.wsRef.current = null;
      // A DETACHED cell gets none either, and for the same reasons: a tick would
      // append a now-bar onto a window years earlier (klinecharts appends any
      // newer timestamp), and the axis tags would price today's market against
      // 2021 candles. The close() above already killed the stream this cell had.
      if (replaying || detachedMode) {
        // A detached cell's stream is closed ON PURPOSE, but `status` still
        // says whatever it said before the jump — and every consumer (legend
        // dot, price-axis tag, staleness watchdog) inherits that lie. "down"
        // is the honest value: there is no stream. Stamped at the source so
        // indicators don't each need their own !detached special case.
        // Replaying cells are deliberately left as they are (same quirk,
        // different mode ownership — the replay pill owns that cell's story).
        if (detachedMode) setStatus("down");
        // Stale spread sides would keep painting bid/ask lines from live prices.
        handle.bidRef.current = null;
        handle.askRef.current = null;
        // The price-axis tag renders `(lastPrice ?? priceTag.price)` — leaving the
        // last streamed price in place would pin TODAY's price to the axis of a
        // session replaying months ago. Nulling it falls back to priceTag.price,
        // which is the cursor bar's close (the chart holds only revealed bars).
        setLastPrice(null);
        // Repaint NOW: the refs above are only read by redraw (the bid/ask axis
        // tags and their dashed lines), and this effect's own redraw call ran
        // ~190 lines earlier, off the still-live values. Without this the last
        // streamed bid/ask would sit on the axis of a session replaying months
        // ago until some unrelated pan/zoom/crosshair happened to repaint.
        handle.redrawRef.current();
        return;
      }
      setStatus("connecting");
      setLastPrice(null);
      handle.wsRef.current = openLive(
        symbol.epic,
        period.resolution,
        (k: KLineData, bid: number | null, ask: number | null) => {
          const chart = handle.chartRef.current;
          if (!chart) return;
          // Latest raw spread sides for the bid/ask lines (redraw reads the refs).
          handle.bidRef.current = bid;
          handle.askRef.current = ask;
          // pushBar updates the last bar (==ts) or appends (>ts); an older ts
          // is silently ignored by klinecharts. Log regressions so a frozen chart
          // is diagnosable rather than mysterious.
          const list = chart.getDataList();
          const lastTs = list.length ? list[list.length - 1].timestamp : 0;
          if (k.timestamp < lastTs) {
            console.warn(
              `[live] stale candle ${k.timestamp} < last ${lastTs} for ${symbol.epic}; ignoring`,
            );
            return;
          }
          // pushBar runs the whole synchronous recalc chain (klinecharts
          // _addData -> _calcIndicator for EVERY indicator, over the full
          // loaded series). That is the single most expensive thing a tick
          // does, so it is the thing worth timing (see lib/perfDiag).
          if (PERF_DIAG_ON) {
            const t0 = performance.now();
            handle.dataFacadeRef.current?.pushBar(k);
            recordTick(performance.now() - t0);
          } else {
            handle.dataFacadeRef.current?.pushBar(k);
          }
          // An APPENDED bar shifts every bar left at the live edge without any
          // scroll/zoom action — keep the center pin from drifting stale.
          if (k.timestamp > lastTs) repositionPinRef.current?.();
          setHasData(true); // a flowing stream clears the no-data banner (React no-ops if unchanged)
          // Deliberately NOT clearing `degraded` here: the stream can be healthy
          // while REST history is blocked (WAF/429), and a tick gluing a now-bar
          // onto a short cached tail is exactly the state the pill must keep
          // naming. The healing retry loop clears it on the first non-degraded
          // reload instead.
          setLastPrice(k.close);
          // Publish the price so the positions dock can mark P&L to market without
          // polling the server (see trading.setLivePrice / PositionsPanel).
          setLivePrice(symbol.epic, k.close);
          // A live candle proves the market is open: record it (so the status check
          // stays event-driven) and flip the badge open instantly if it was closed.
          lastCandleAtRef.current = Date.now();
          if (marketClosedRef.current) setMarketClosed(false);
          // Forming-mode MTF pins ("Wait for timeframe closes" unchecked)
          // re-fold their forming HTF bar from the fresh candle — throttled
          // inside, no-op when nothing opted in. When the tick lands in a NEW
          // HTF bucket, the fold alone can't advance (it ignores candles past
          // the stashed bucket's close), so run the full refetch instead —
          // the live twin of useReplay's bucket-crossing refresh, same
          // epoch-grid approximation (errs stale, self-corrects next crossing).
          const bucket = mtfBucketMs(chart);
          if (bucket) {
            const idx = Math.floor(k.timestamp / bucket);
            if (liveMtfBucketRef.current === null) {
              liveMtfBucketRef.current = idx; // load's own refresh covered this bucket
            } else if (idx !== liveMtfBucketRef.current && !liveMtfRefreshingRef.current) {
              liveMtfBucketRef.current = idx;
              liveMtfRefreshingRef.current = true;
              void refreshMtfIndicators(chart, symbol.epic, brokerId)
                .catch(() => {}) // broker outage: the coordinator's own retry handles it
                .finally(() => {
                  liveMtfRefreshingRef.current = false;
                });
            }
          }
          refreshFormingBarThrottled(chart);
          handle.redrawRef.current(); // keep the price/alert pills glued as the bar moves
          // NOTE: alert FIRING is owned by the background alertEngine (the single
          // authority across all tabs, active included) — not here. This chart feed
          // only drives the visible candles/pills. The engine persists fired/removed
          // alerts and bumps the alerts signal; overlays reconciles its lines off it.
        },
        setStatus,
        priceSide,
        brokerId,
      );
    })();

    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      handle.wsRef.current?.close();
      handle.wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol.epic, period.resolution, priceSide, brokerId, retryNonce, replayEpoch, detached]);

  // Persist the view position (centered bar time + zoom) on every user
  // pan/zoom, debounced, so a page reload can reopen the chart where the user
  // left it (the restore path in the load effect above). Detected via DOM
  // events (wheel; pointer drag, not a bare click), NOT the chart's
  // onScroll/onZoom actions: those also fire for some programmatic moves (the
  // load settle's own positioning), which both overwrote the saved intended
  // center of a too-deep switch with the fallback latest-candles view and
  // cleared the parked intent before the settle save could persist it. The
  // same claim-listener idiom as the date-range sync's user-vs-programmatic
  // split. Programmatic repositioning is persisted by the load's explicit
  // settle saves instead.
  useEffect(() => {
    const chart = handle.chartRef.current;
    const dom = chart?.getDom();
    if (!chart || !dom) return;
    let timer: number | null = null;
    let dragging = false;
    // The centre as of the most recent gesture event, refreshed while the LIVE
    // bars are still on screen (the read sits behind gesture's replay guard, so
    // it can never hold a session-era value). Only ever consulted when a
    // window's 400ms happens to elapse INSIDE a replay session (see save): by
    // then the chart is showing the session's bars, so re-reading would persist
    // a replay-era centre, while merely re-arming until the session ended would
    // persist the centre the exit restore had already put back — both silently
    // losing the pan the user actually made. The live path ignores this and
    // re-reads, so ordinary persistence is unchanged.
    let armedCenterTs: number | null = null;
    const save = () => {
      timer = null;
      const c = handle.chartRef.current;
      if (!c) return;
      // A timer armed just BEFORE a session started. Skip the READ, not the
      // write: persist what was captured live, so the pan survives to the exit
      // restore that consumes this saved view.
      // Same for a timer armed just before the cell DETACHED: the detached view
      // is not where the live chart belongs, so persist the captured live centre
      // instead of re-reading a 2021 one.
      if (handle.replayRef.current?.isActive() || detachedRef.current) {
        if (armedCenterTs == null) return;
        captureViewPos(c, scope, symbol.epic, period.resolution, armedCenterTs);
        armedCenterTs = null;
        return;
      }
      captureViewPos(c, scope, symbol.epic, period.resolution);
      armedCenterTs = null;
    };
    const gesture = () => {
      // Panning a REPLAYING cell says nothing about where its LIVE view belongs.
      // Persisting the replay centre would poison the saved view that exit
      // itself consumes (the session leaves didInitRef false, so the load effect
      // re-runs on exit with restoreView live), dropping the cell back into the
      // past and burning a cover walk paging history down to it. Returning
      // before the line below also keeps the parked too-deep intent alive, which
      // the load effect deliberately preserves across a session.
      // Scrolling a DETACHED cell says nothing about its live view either, and
      // persisting a detached centre would drop the cell into the past on the
      // next page reload (and burn a cover walk paging history down to it).
      if (handle.replayRef.current?.isActive() || detachedRef.current) return;
      // A real pan/zoom gesture: the user owns the position now — drop any
      // parked too-deep intended center (see intendedCenterRef).
      intendedCenterRef.current = null;
      // Refresh on EVERY gesture event, not just the one that arms the timer: a
      // pan that completes inside a single debounce window would otherwise leave
      // this holding the position the pan STARTED from, and the mid-session
      // flush below would persist that — restoring the pre-pan centre on exit,
      // the very thing the flush exists to prevent. Refreshing leaves a residual
      // lag of one move-step. The read is unreachable while replaying (the early
      // return above), so this can only ever hold a live-bar centre.
      const c = handle.chartRef.current;
      armedCenterTs = c ? readCenterBarTs(c) : null;
      if (timer == null) timer = window.setTimeout(save, 400);
    };
    const onWheel = () => gesture();
    const onPointerDown = () => {
      dragging = true;
    };
    const onPointerMove = () => {
      if (dragging) gesture();
    };
    const onPointerUp = () => {
      dragging = false;
    };
    dom.addEventListener("wheel", onWheel, { capture: true, passive: true });
    dom.addEventListener("pointerdown", onPointerDown, { capture: true });
    dom.addEventListener("pointermove", onPointerMove, { capture: true });
    dom.addEventListener("pointerup", onPointerUp, { capture: true });
    return () => {
      if (timer != null) window.clearTimeout(timer);
      dom.removeEventListener("wheel", onWheel, { capture: true });
      dom.removeEventListener("pointerdown", onPointerDown, { capture: true });
      dom.removeEventListener("pointermove", onPointerMove, { capture: true });
      dom.removeEventListener("pointerup", onPointerUp, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol.epic, period.resolution, scope]);

  // Center pin: with preserve-center ON, a target glyph just above the time axis marks
  // the bar whose time is anchored (the one a TF change keeps centered and a
  // reload restores). Pure DOM over the axis — the same read as the capture
  // (readCenterBarTs), so the pin always shows exactly what would be preserved:
  // usually the bar under the screen center, the LAST bar when the view sits in
  // right-edge whitespace. Repositioned on the chart's scroll/zoom actions
  // (programmatic moves included — this only repositions, unlike the gesture
  // effect above which must ignore them) and on the settings toggle (App
  // dispatches "at:settings-saved"; no prop reaches this hook).
  useEffect(() => {
    const chart = handle.chartRef.current;
    const dom = chart?.getDom();
    if (!chart || !dom) return;
    // Append beside the chart, not inside getDom(): klinecharts manages that
    // element's children and wipes foreign nodes on relayout. The parent (the
    // React-owned chart container, created once per mount) is stable; it is
    // static, so the pin's absolute offsets resolve against .chart-wrap, same
    // as the app's other DOM overlays (pane-clip, axis-plus, price tags).
    const host = dom.parentElement ?? dom;
    const pin = document.createElement("div");
    pin.className = "center-pin";
    pin.style.cssText =
      "position:absolute;width:13px;height:13px;color:#2962ff;" +
      "pointer-events:none;z-index:40;display:none;line-height:0;";
    // Same target glyph as the DrawSidebar toggle button.
    pin.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="7" />' +
      '<path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />' +
      '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /></svg>';
    host.appendChild(pin);
    // Vertical guide through the anchored bar, ending where the time axis (and
    // the pin glyph) begins.
    const line = document.createElement("div");
    line.className = "center-pin-line";
    line.style.cssText =
      "position:absolute;top:0;width:0;border-left:1px dashed #2962ff;" +
      "opacity:0.4;pointer-events:none;z-index:40;display:none;";
    host.appendChild(line);
    let raf: number | null = null;
    const reposition = () => {
      raf = null;
      const c = handle.chartRef.current;
      if (!c) return;
      const ts = loadSettings().preserveCenterOnTfChange ? readCenterBarTs(c) : null;
      if (ts == null) {
        pin.style.display = "none";
        line.style.display = "none";
        return;
      }
      // Draw at the center PIXEL, not the anchored bar's own x: the anchor is
      // the bar under the screen center (within half a bar of it), and pinning
      // to the bar makes the marker hop a bar-width every time a pan moves the
      // next bar under the center. The one case where the anchor is NOT at the
      // center is right-edge whitespace — readCenterBarTs clamps to the LAST
      // bar — so follow that bar's x whenever it sits left of center.
      const data = c.getDataList();
      const lastTs = data[data.length - 1]?.timestamp;
      const p =
        lastTs != null
          ? c.convertToPixel([{ timestamp: lastTs }], { paneId: "candle_pane", absolute: true })
          : null;
      const lastX = (Array.isArray(p) ? p[0] : p)?.x;
      const centerX = (c.getSize("candle_pane", "main")?.width ?? 0) / 2;
      const x = lastX != null && isFinite(lastX) ? Math.min(centerX, lastX) : centerX;
      if (!(x > 0)) {
        pin.style.display = "none";
        line.style.display = "none";
        return;
      }
      // The pin sits just above the time axis (clear of its labels); the guide
      // line stops at the pin's top edge so it doesn't cut through the glyph.
      const xAxisH = c.getSize("x_axis_pane", "root")?.height ?? 0;
      pin.style.display = "block";
      pin.style.left = `${x - 7}px`;
      pin.style.bottom = `${xAxisH + 1}px`;
      line.style.display = "block";
      line.style.left = `${x}px`;
      line.style.bottom = `${xAxisH + 14}px`;
    };
    // rAF-coalesced, except when the browser tab is hidden — rAF never fires
    // there (same gotcha as notify.ts) and the pin would wake up stale.
    const schedule = () => {
      if (raf != null) return;
      raf = document.hidden ? window.setTimeout(reposition, 0) : requestAnimationFrame(reposition);
    };
    // rAF also frame-aligns the move with the candles: klinecharts v10 paints
    // its canvases inside its own requestAnimationFrame, so a synchronous
    // reposition here would land a frame AHEAD of the repaint.
    repositionPinRef.current = schedule;
    schedule();
    chart.subscribeAction("onScroll", schedule);
    chart.subscribeAction("onZoom", schedule);
    window.addEventListener("at:settings-saved", schedule);
    return () => {
      if (raf != null) {
        cancelAnimationFrame(raf);
        window.clearTimeout(raf);
      }
      repositionPinRef.current = null;
      window.removeEventListener("at:settings-saved", schedule);
      const c = handle.chartRef.current;
      c?.unsubscribeAction("onScroll", schedule);
      c?.unsubscribeAction("onZoom", schedule);
      pin.remove();
      line.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Back to live": send the view to the newest bar. Lives here (not in
  // ChartCore) because landing has to go through the SAME save path a real pan
  // does — a programmatic move fires no scroll gesture, so without an explicit
  // capture a reload would restore the far-past view the user just left, and a
  // parked too-deep intended center would still outrank it.
  // Inert while DETACHED. The cell's newest bar is then the right edge of a
  // window years back, so "live" is not where this would land — and the capture
  // below would persist that detached centre as the cell's saved view, dropping
  // it into the past on the next page reload. The detached view has exactly one
  // way out (the Back-to-live pill that reloads the live series); until it
  // exists, the live-edge pill's click is a no-op rather than a wrong landing
  // plus a poisoned save.
  const goLive = () => {
    const chart = handle.chartRef.current;
    if (!chart || detachedRef.current) return;
    intendedCenterRef.current = null;
    jumpToLive(chart, () => {
      const c = handle.chartRef.current;
      if (!c) return;
      captureViewPos(c, scope, symbol.epic, period.resolution);
      repositionPinRef.current?.();
    });
  };

  return { goLive };
}

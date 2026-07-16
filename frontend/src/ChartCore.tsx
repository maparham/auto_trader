// Owns a klinecharts-core Chart instance. Loads history for the current
// symbol/period, streams live updates, applies the theme, and supports
// scroll-back pagination. Hands the Chart up via onReady so the toolbar can
// drive indicators, overlays, and the price scale.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  init,
  dispose,
  type Chart,
  type KLineData,
} from "klinecharts";
import {
  fetchRange,
  fetchRangeStrict,
  fetchMarketMeta,
  fetchCandleCacheStats,
  RESOLUTION_SECONDS,
  type Instrument,
  type LiveHandle,
  type LiveStatus,
  type Period,
  type CandleCacheStats,
  isFeedStale,
  periodByResolution,
} from "./lib/feed";
import ChartRangeBar from "./ChartRangeBar";
import { type RangeKey } from "./lib/rangeWindow";
import { pageHistoryBack, scrollbackLoadOlder } from "./lib/historyPaging";
import { klineStyles } from "./lib/chartTheme";
import ChartLegend, {
  type ChartLegendHandle,
  type LegendRow,
  type SubPaneLegendData,
} from "./ChartLegend";
import { ChartController } from "./lib/chartController";
import { isInvertShortcut } from "./lib/invertShortcut";
import MarketInfoPopover from "./MarketInfoPopover";
import Tooltip from "./components/Tooltip";
import CandleCacheStatsModal from "./CandleCacheStatsModal";
import CurveLabels, { type CurveLabelsHandle } from "./CurveLabels";
import {
  teardownArtifacts,
  reanchorBacktestMarkers,
  registerBacktestPager,
} from "./lib/backtest";
import BacktestAggMarkers, { type BacktestAggMarkersHandle } from "./BacktestAggMarkers";
import { inspectModeSignal, inspectSelectedBarSignal } from "./lib/backtestInspect";
import {
  alertEditRequest,
  requestConfirm,
  indicatorSettingsRequest,
  drawingSettingsRequest,
  alertsChanged,
  openSettings,
  requestSymbolSearch,
  pendingEditsSignal,
  draftOrderSignal,
  tradeLineUiSignal,
  setTradeHovered,
  setTradeSelected,
  selectTradeLine,
  openTradeEditor,
  stageChartOrder,
  tradePanelOpen,
  editTradeSignal,
  confirmLineEditsSignal,
  tradeMarkerHoverSignal,
  highlightTradeSignal,
  snapshotViewChanged,
  indicatorOverlayRepaint,
  type PendingEdit,
  type TradeLineField,
  type DraftOrder,
  type TradeLineUi,
} from "./lib/signals";
import {
  saveAvwapAnchor,
  saveScalePriceOnly,
  loadLegendCollapsed,
  saveLegendCollapsed,
  loadCandleHidden,
  saveCandleHidden,
  CONDITION_LABELS,
  loadSnapshotMeta,
  deleteSnapshotMeta,
  type SnapshotMeta,
  type AlertCondition,
  type AlertTrigger,
} from "./lib/persist";
import {
  applyIndicatorVisibility,
  collapseSubPanes,
  expandSubPanes,
  hydrateIndicators,
  getIndicatorsByPane,
} from "./lib/indicators";
import { onLayoutChanged } from "./lib/persist/layoutEvents";
import { scheduleAutoSave, cancelAutoSave } from "./lib/templateAutosave";
import {
  indTypeOf,
  setIndicatorTimezone,
} from "./lib/customIndicators";
import {
  HIT_TOLERANCE_PX,
  type LineCache,
  hitTestCache,
} from "./chart/chartGeometry";
import {
  browserTimezone,
  first,
} from "./chart/chartPainters";
import { chartSync, rangeSync, readVisibleRange, readExactAnchor, applyVisibleRange, applyVisibleRangeExact, setAlignAnchor, getAlignAnchor, setGestureCell, isGestureCell, releaseGestureCell } from "./lib/chartSync";
import { refreshMtfIndicators } from "./lib/mtfCoordinator";
import { PositionLines, tradeLineSpecs, DRAFT_ID, restingLineEndX } from "./lib/positionLines";
import {
  TradeMarkers,
  entryMarkerSpecs,
  exitMarkerSpecs,
  aggregateExitsByBar,
  exitsCollide,
  type ExitCluster,
} from "./lib/tradeMarkers";
import { journalSignal } from "./lib/liveJournal";
import TradeExitAggMarkers, { type TradeExitAggMarkersHandle } from "./TradeExitAggMarkers";
import {
  brokerLabel,
  subscribeTrades,
  type TradeView,
  type OrderSide,
} from "./lib/trading";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { MenuIcons } from "./lib/menuIcons";
import { hitSlopeHandle, type SlopeGrab } from "./lib/slopeHandles";
import { snapSlopeEndpoint } from "./lib/slopeMagnet";
import { effectiveMagnetMode } from "./lib/magnet";
import { loadSettings, type BidAsk, type BidAskStyle, type Clock, type CrosshairStyle, type DateFormat, type PriceSide, type Theme } from "./theme";
import { hexToRgba } from "./lib/lineStyle";
import { makeFormatDate } from "./lib/timeFormat";
import { formatRemaining, resolveExpiry } from "./lib/alertUi";
import { isSynthetic } from "./lib/syntheticRegistry";
import type { ChartHandle, RangeReq } from "./chart/chartHandle";
import { createChartDataFacade, type ChartDataFacade } from "./chart/chartDataFacade";
import { applyScalePriceOnly } from "./chart/priceOnlyRange";
import { useLiveMarketData } from "./chart/useLiveMarketData";
import { useRangeNavigation } from "./chart/useRangeNavigation";
import { useChartPaint } from "./chart/useChartPaint";
import { useIndicatorCommands } from "./chart/useIndicatorCommands";
import { useLineDrag, type TradeLinePx } from "./chart/useLineDrag";
import { usePointerCrosshair } from "./chart/usePointerCrosshair";
import AlertTags from "./chart/AlertTags";
import TradePills from "./chart/TradePills";

// klinecharts' own initial bar spacing (its DEFAULT_BAR_SPACE, not exported) — used to
// restore the time axis on double-click, matching what a freshly loaded chart starts at.
const DEFAULT_BAR_SPACE = 8;

// AVWAP anchor drag handle: a larger solid grab handle painted at the anchor bar
// when AVWAP is selected, draggable left/right to re-anchor (TradingView-style).
const ANCHOR_GRAB_PX = 11; // mousedown hit radius (forgiving)

// TradingView-style position furniture, left→right: %/R:R badges · connector spine
// + per-line circle handles · always-on pills. The spine sits IN from the left edge
// so the badges have room on its left; pills sit just to its right. Shared by the DOM
// pills (TRADE_PILL_LEFT) and the canvas spine/handles/badges (TRADE_SPINE_X).
const TRADE_SPINE_X = 92;
const TRADE_PILL_LEFT = TRADE_SPINE_X + 14; // pills anchored just right of the spine


interface Props {
  // Identity + storage scope for this cell (one tab can hold several cells).
  cellId: string;
  tabId: string;
  scope: string;
  symbol: Instrument;
  // Active data broker id ("capital"). Epics are broker-specific, so candle
  // history + the live stream are fetched against this broker; a change refetches.
  brokerId: string;
  period: Period;
  theme: Theme;
  // IANA timezone for the time axis ("" = browser local).
  timezone: string;
  // Time-axis timestamp format: clock (24h/12h) + date format.
  clock: Clock;
  dateFormat: DateFormat;
  // Prefix day-granularity timestamps with the weekday. Global.
  showWeekday: boolean;
  // Which side of the spread candles render from (bid/mid/ask). Global setting;
  // a change refetches history and reconnects the live stream for this cell.
  priceSide: PriceSide;
  // Live bid & ask display: off / axis labels / labels + lines. Global.
  bidAsk: BidAsk;
  // Colors / line opacity / line style for the bid & ask display. Global.
  bidAskStyle: BidAskStyle;
  // Appearance of the crosshair guide lines (style/color/opacity). Global.
  crosshair: CrosshairStyle;
  // When on, broadcast this cell's hovered timestamp to its tab's sibling cells
  // and paint their broadcasts as a vertical time guide (crosshair link).
  syncCrosshair?: boolean;
  // When on, scrolling/zooming the time axis here matches the same wall-clock
  // window on the tab's sibling cells (date-range link; mapped by timestamp).
  syncTime?: boolean;
  // "Lock charts" master mode. Same effect as syncTime/Crosshair/Interval combined,
  // but the date-range broadcast carries this cell's barSpace so siblings (forced to
  // the same interval) reproduce the window EXACTLY rather than approximately.
  locked?: boolean;
  // Published once the chart instance + controller are live, so App can route the
  // FOCUSED cell's chart/controller to the Toolbar / AlertsSidebar / modals.
  onReady?: (cellId: string, chart: Chart, controller: ChartController) => void;
  // Fired on pointer-down anywhere in the cell, so App can mark it focused.
  onFocus?: (cellId: string) => void;
  // Switch THIS cell's interval (used by the quick-range bar when a preset needs a
  // coarser/finer resolution than the current one). Cell-scoped so a keyboard-
  // activated preset targets the owning cell even without a prior pointer-down.
  onPeriod?: (cellId: string, p: Period) => void;
}

const PAGE_BARS = 500; // older bars to request per scroll-back page
// Empty windows can be legitimate (weekend/overnight gaps), so step back a few
// windows before declaring history exhausted instead of stopping at the first gap.
const MAX_EMPTY_WINDOWS = 6;
// A window count alone under-budgets fine timeframes: 6 windows of 1m bars span
// only ~50h, which a 3-4 day holiday closure exceeds, latching a false
// exhaustion mid-gap. Budget by TIME as well: keep walking until this much
// continuous emptiness before calling the broker's history bottomed out
// (2 weeks dwarfs any real market closure). The count acts as a floor for
// coarse timeframes whose windows already span years.
const MAX_EMPTY_GAP_SEC = 14 * 86400;

export default function ChartCore({
  cellId,
  tabId,
  scope,
  symbol,
  brokerId,
  period,
  theme,
  timezone,
  clock,
  dateFormat,
  showWeekday,
  priceSide,
  bidAsk,
  bidAskStyle,
  crosshair,
  syncCrosshair,
  syncTime,
  locked,
  onReady,
  onFocus,
  onPeriod,
}: Props) {
  // Per-cell controller: its own OverlayManager + the per-chart UI signals that
  // used to be module globals. Stable for the life of this mount (the cell key is
  // cell.id, so cellId/scope never change here). Destructured into same-named
  // locals so the rest of this component reads them exactly as before.
  const controller = useMemo(() => new ChartController(cellId, scope), [cellId, scope]);
  const {
    overlays,
    avwapAnchorMode,
    autoScale,
    invertScale,
    scalePriceOnly,
    logScale,
    measureArmed,
    slopeArmed,
    rangePickArmed,
    rangePickResult,
    selectedIndicator,
    legendHovered,
    legendHoverName,
    curveHover,
    indicatorRemoved,
  } = controller;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const dataFacadeRef = useRef<ChartDataFacade | null>(null);
  const wsRef = useRef<LiveHandle | null>(null);
  const inited = useRef(false);
  // Prior sub-pane heights captured when the double-click "hide bottom sub-panes"
  // gesture collapses them, so un-collapsing restores each pane to its own height.
  const collapsedHeightsRef = useRef<Map<string, number>>(new Map());
  // Active quick-range button (null once the user manually zooms/scrolls or
  // changes interval). Transient — not persisted.
  const [activeRange, setActiveRange] = useState<RangeKey | null>(null);
  // The in-flight quick-range request (resolution + window + the series identity it
  // was issued for). Acts as an ownership token: ensureCoverageAndFit bails if a
  // newer pick replaces it OR the epic/broker/side drifts from what it captured.
  // The data-load effect consumes it once the (possibly new-resolution) bars land.
  // (RangeReq now lives in chart/chartHandle.ts so the extracted hooks share it.)
  const pendingRangeRef = useRef<RangeReq | null>(null);
  // Bridge refs for the range-coverage walks (defined below as ChartCore locals,
  // moving to useRangeNavigation in Step 7). Assigned in render (before any effect
  // runs) so useLiveMarketData can call them across the extraction boundary via
  // handle.*.current() — staleness-proof, same pattern as redrawRef.
  const ensureCoverageAndFitRef = useRef<(token: RangeReq) => Promise<void>>(async () => {});
  const ensureAnchorCoverageRef = useRef<() => Promise<void>>(async () => {});
  // Trade index to re-select after a timeframe switch's coverage walks settle
  // (see the data-load effect). A ref, not an effect local, so a SECOND switch
  // arriving before the first walk settles still carries the selection over —
  // the shared selection signal is already nulled by then, so re-capturing from
  // it would lose the trade. Cleared once a restore is attempted or on epic change.
  const pendingTradeRestoreRef = useRef<number | null>(null);
  // The current snapshot-moment marker overlay's id, so the data-load effect
  // can remove it before recreating on a symbol/TF switch (see renderSnapshotMarker).
  const snapMarkerIdRef = useRef<string | null>(null);
  // Read-only snapshot view. controller.readOnly is THE sentinel (seeded from the
  // scope's snapshotMeta at construction, re-asserted by the data-load effect,
  // cleared by Unlock); snapView holds the meta CONTENT the banner renders (name),
  // and snapViewRef mirrors the controller flag for the non-React callbacks
  // (klinecharts handlers, keyboard/paste) that gate every mutating action.
  const [snapView, setSnapView] = useState<SnapshotMeta | null>(() => loadSnapshotMeta(scope));
  const snapViewRef = useRef<boolean>(controller.readOnly.value);
  useEffect(() => {
    // Re-seed before subscribing: a scope change without a remount (merging a
    // cell into the active tab keeps its cell id) swaps in a NEW controller,
    // and a subscription alone only hears FUTURE set() calls — the fresh
    // controller's constructor-seeded value would otherwise be missed.
    snapViewRef.current = controller.readOnly.value;
    return controller.readOnly.subscribe((v) => {
      snapViewRef.current = v;
    });
  }, [controller]);

  // Unlock = graduate the study copy into a normal editable chart: delete the
  // scope's snapshotMeta sentinel, drop the marker, lift the overlay read-only
  // mode (rehydrate unlocks drawings + materializes the epic's live alert lines),
  // and redraw position lines. snapshotViewChanged tells App/Toolbar to re-render
  // their own gates (DrawSidebar, menus). The saved snapshot is not affected.
  const unlockSnapshotView = () => {
    requestConfirm({
      title: "Unlock snapshot view",
      message:
        "Turn this snapshot view into a normal editable chart? The saved snapshot itself is not affected.",
      confirmLabel: "Unlock",
      onConfirm: () => {
        deleteSnapshotMeta(scope);
        controller.readOnly.set(false);
        setSnapView(null);
        const c = chartRef.current;
        if (c && snapMarkerIdRef.current) {
          c.removeOverlay({ id: snapMarkerIdRef.current });
          snapMarkerIdRef.current = null;
        }
        overlays.setReadOnly(false);
        overlays.rehydrate();
        // Same-value set still notifies: re-runs drawPositions + pill redraw.
        controller.positionsHidden.set(controller.positionsHidden.value);
        snapshotViewChanged.set(scope);
      },
    });
  };
  // The token a walk-back has already been launched for, so a re-run of the
  // data-load effect (priceSide/broker change, same pending pick) can't start a
  // second concurrent walk over the same token.
  const launchedTokenRef = useRef<RangeReq | null>(null);
  // True while a range pick is programmatically moving the view, so the
  // scroll/zoom listener doesn't treat it as a manual gesture and clear the pill.
  const programmaticMoveRef = useRef(false);
  // Pan/zoom the chart to a window without the scroll/zoom listener clearing the
  // active-range pill: flag the move as programmatic, then release on the next
  // macrotask after klinecharts has emitted its scroll event.
  const fitVisibleRange = (chart: Chart, fromTs: number, toTs: number) => {
    programmaticMoveRef.current = true;
    applyVisibleRange(chart, fromTs, toTs);
    setTimeout(() => {
      programmaticMoveRef.current = false;
    }, 0);
  };

  // Extend any higher-timeframe EMA/MA overlay to cover the currently-loaded
  // history. The stashed HTF series is sized to the span loaded WHEN the indicator
  // was applied/rehydrated, so ANY later history extension — user scroll-back, a
  // quick-range cover+fit, or the startup drawing/backtest anchor walk — would
  // otherwise leave the MTF curve stopping mid-chart. Call this after every path
  // that pages older bars in; the coverage guard inside refreshMtfIndicators makes
  // it a no-op once the series already reaches far enough. `explicitOldestMs` is
  // the just-loaded page's first bar when the caller has it (klinecharts may not
  // have merged the prepend into getDataList yet).
  const extendMtfCoverage = (explicitOldestMs?: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    const loaded = chart.getDataList()[0]?.timestamp;
    const oldest = Math.min(explicitOldestMs ?? Infinity, loaded ?? Infinity);
    if (!Number.isFinite(oldest)) return;
    void refreshMtfIndicators(chart, epicRef.current, brokerIdRef.current, oldest);
  };

  // (ensureCoverageAndFit + ensureAnchorCoverage moved into
  // chart/useRangeNavigation.ts; that hook assigns them onto
  // handle.ensureCoverageAndFitRef / handle.ensureAnchorCoverageRef so the
  // data-load effect can still call them across the extraction boundary.)

  // Anchor-coverage "hopeless anchor" memo: series key -> the target a prior walk
  // failed to reach + how deep it got. Read/written by ensureAnchorCoverage (now in
  // chart/useRangeNavigation.ts via handle.cappedAnchorRef); kept on the handle so
  // that walk and this component share the same instance. Without it, EVERY later
  // trigger (backtest run, template apply, range pick) would re-walk a full 16-page
  // budget toward the same unreachable anchor, slowing back-to-back runs
  // quadratically (measured 1.9s → 6.9s → 31.4s).
  const cappedAnchorRef = useRef(new Map<string, { target: number; reached: number }>());

  // On-demand page-back so the backtest trades panel can scroll to a trade whose
  // entry predates the loaded bars. ensureAnchorCoverage pages to the OLDEST anchor
  // with a small budget (enough for a just-finished run on the recent-only load);
  // this instead targets ONE trade's entry with a larger bounded budget, so an old
  // trade can be reached on demand. The bars come from the local candle cache, so
  // even a deep walk is fast, and pageHistoryBack stops the moment coverage reaches
  // `fromTs` — the budget is only a safety cap. Returns whether the oldest loaded
  // bar now reaches `fromTs` (false → older than reachable history: the caller
  // shows a notice rather than scrolling nowhere). Shares the loadingRef mutex +
  // stale guards with the other pagers; a quick-range pick still preempts it.
  const coverBacktestTradeTo = async (fromTs: number): Promise<boolean> => {
    const chart = chartRef.current;
    if (!chart) return false;
    const epic = epicRef.current;
    const resolution = resRef.current;
    const broker = brokerIdRef.current;
    const side = priceSideRef.current;
    const first = chart.getDataList()[0];
    if (!first) return false;
    if (fromTs >= first.timestamp) return true; // already covered
    if (pendingRangeRef.current) return false; // a quick-range pick owns paging
    const isStale = () =>
      !chartRef.current ||
      pendingRangeRef.current !== null ||
      epicRef.current !== epic ||
      brokerIdRef.current !== broker ||
      priceSideRef.current !== side ||
      resRef.current !== resolution;
    // Same mutex dance as ensureAnchorCoverage: wait out an in-flight scroll-back
    // page (bounded), then hold the mutex so the pagers can't interleave.
    for (let i = 0; loadingRef.current && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (isStale()) return false;
    }
    if (isStale()) return false;
    loadingRef.current = true;
    try {
      await pageHistoryBack<KLineData>({
        fromTs,
        toTs: first.timestamp,
        resSec: RESOLUTION_SECONDS[resolution] ?? 60,
        pageBars: PAGE_BARS,
        // Bounded safety cap only: the walk breaks as soon as coverage reaches
        // fromTs. Sized to reach a several-months-old trade on a fine timeframe
        // (500 bars × 80 ≈ 40k bars ≈ ~14 months of near-24h 15m bars; ~28 days
        // at 1m).
        maxPages: 80,
        // No empty-exhaustion here (unlike scroll-back): fromTs is a KNOWN trade
        // timestamp, so real bars provably exist there and any empty windows en
        // route are interior gaps the instrument is closed for (a weekend is
        // ~49h — far past the 4×8.3h≈33h scroll-back budget), never the true
        // history edge. Letting maxEmpty trip made a trade one weekend back read
        // as "older than history available" even though the backtest fetched its
        // 1m bars from the same endpoint. maxPages is the sole bound.
        maxEmpty: Infinity,
        isStale,
        getData: () => chartRef.current?.getDataList(),
        fetchOlder: (fromSec, toSec) => fetchRange(epic, resolution, fromSec, toSec, side, broker),
        applyData: (merged) => overlays.applyOlderBars(merged),
        onCursor: (sec) => {
          cursorSecRef.current = sec;
        },
        onProgress: () => {
          exhaustedRef.current = false;
        },
        onExhausted: () => {
          exhaustedRef.current = true;
        },
      });
      // Redraw the markers/period bands against the now-extended history: the
      // recent-only load culled the fills this trade belongs to (same reason
      // ensureAnchorCoverage reanchors after its walk). No-op if nothing's drawn.
      if (!isStale()) {
        reanchorBacktestMarkers(chart);
        extendMtfCoverage();
      }
      const oldest = chartRef.current?.getDataList()[0];
      return !!oldest && oldest.timestamp <= fromTs;
    } finally {
      // Release only if a quick-range pick hasn't taken the mutex for its own walk.
      if (pendingRangeRef.current === null) {
        loadingRef.current = false;
      }
    }
  };

  // Drill into a backtest aggregate pill (higher-timeframe view): switch this
  // cell to the backtest's native timeframe and zoom to the bar's [fromMs, toMs]
  // trade span, where the per-fill arrows render. Mirrors onRangePick's
  // interval-switch path (park a pending range; the data-load effect covers +
  // fits once the new-resolution bars land); if already on the native timeframe
  // it just zooms. Padded so a same-window span still yields a real view.
  const onBacktestDrillIn = (resolution: string, fromMs: number, toMs: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    onFocus?.(cellId);
    const span = Math.max(toMs - fromMs, 0);
    const pad = Math.max(span * 0.25, 60_000);
    const fromTs = fromMs - pad;
    const toTs = toMs + pad;
    if (resolution === period.resolution) {
      fitVisibleRange(chart, fromTs, toTs);
      return;
    }
    const target = periodByResolution(resolution);
    if (!target) return;
    pendingRangeRef.current = { resolution, fromTs, toTs, epic: symbol.epic, broker: brokerId, side: priceSide };
    setActiveRange(null);
    onPeriod?.(cellId, target);
  };

  // On-chart trade lines (entry/SL/TP for positions + resting orders). Server-
  // owned, non-persisted; see positionLines.ts.
  const posLinesRef = useRef<PositionLines | null>(null);
  // Master-hide ("Hide positions and orders" eye toggle), mirrored as a ref so the
  // pill-building redraw loop can skip drawing pills without reaching into `controller`.
  const positionsHiddenRef = useRef(false);
  // On-chart LIVE trade markers: entry arrow per open position + exit arrow per
  // journaled close, reusing the backtest fill glyph. Owned/lifecycled exactly
  // like posLines (per cell, filtered to this epic); see tradeMarkers.ts.
  const tradeMarkersRef = useRef<TradeMarkers | null>(null);
  // Latest journal (closed live trades) from journalSignal — the exit-marker
  // source, mirrored so an epic change / redraw can re-filter without a poll.
  const journalRef = useRef(journalSignal.value);
  // Redraw the live trade markers filtered to the current epic; set in chart init,
  // called again after a symbol-change rehydrate (paired with posDrawRef).
  const tradeMarkersDrawRef = useRef<() => void>(() => {});
  // Latest trades + pending drags from the shared signals, so an epic change can
  // re-filter/re-merge without waiting for the next poll tick.
  const tradesRef = useRef<TradeView[]>([]);
  const pendingRef = useRef<Record<string, PendingEdit>>({});
  const draftRef = useRef<DraftOrder | null>(null);
  // Per-trade line UI (hidden ids + hovered + selected) from the positions panel /
  // chart, so hide/hover/select re-filter the drawn lines without waiting for a poll.
  const tradeUiRef = useRef<TradeLineUi>({ hidden: [], hovered: null, selected: null, selectedField: null });
  // Mirrors confirmLineEditsSignal so the drag handler (below) can decide whether a
  // drag should select the trade (confirm mode) or just stage for auto-apply.
  const confirmLineEditsRef = useRef<boolean>(confirmLineEditsSignal.value);
  // Redraw trade lines filtered to the current epic. Set in chart init; called
  // again after a symbol-change rehydrate so the new epic's lines appear at once.
  const posDrawRef = useRef<() => void>(() => {});
  // Coalesces the heavy overlay redraw triggered by pending-edit changes to one per
  // animation frame, so a line drag (which restages the pending price on every
  // mousemove) repaints the overlay once per frame, not once per pixel.
  const pendingRedrawRafRef = useRef(0);
  // Unsubscribe from the shared trades/pending subscriptions (stored in a ref so
  // the effect's outer teardown can reach it; the subscribe happens in init).
  const posUnsubRef = useRef<() => void>(() => {});
  // Indicator-selection overlay: a canvas above klinecharts' canvases on which we
  // paint the hollow selection handles, plus a cache of every visible indicator
  // line in pixel space (rebuilt each redraw, read by the click/hover hit-test).
  const selCanvasRef = useRef<HTMLCanvasElement>(null);
  const lineCacheRef = useRef<LineCache[]>([]);
  // The H position bracket: a split-colour spine linking the SELECTED trade's (or the
  // staged draft's) entry to its SL/TP, with %/R:R badges. Its own canvas so it can be
  // repainted cheaply without touching the heavier selection/redraw layer. The spine is
  // pinned at TRADE_SPINE_X (a fixed left column, in from the edge), appears on hover
  // (grey) / selection (position side colour, selected handle filled), with the %/R:R
  // badges to ITS LEFT. `bracketShownRef` clears it exactly once on the active→idle
  // transition so the common nothing-active move costs ~nothing.
  const bracketCanvasRef = useRef<HTMLCanvasElement>(null);
  // Slope "Show MAs on chart": the SLOPE indicator's underlying MA curves drawn on
  // the candle pane (its own overlay canvas, under the separator/bracket/selection
  // layers but over the candles). Repainted in the redraw cycle so it tracks
  // scroll/zoom, and on any slope edit via indicatorOverlayRepaint.
  const maCanvasRef = useRef<HTMLCanvasElement>(null);
  const bracketShownRef = useRef(false);
  const paintBracketRef = useRef<() => void>(() => {});
  // The hovered LINE's field (price/stop/tp), captured by the hover hit-test so the
  // connector can outline just that handle in its colour while nothing is selected.
  const hoveredFieldRef = useRef<TradeLineField | null>(null);
  // The period-start separator: a dashed vertical line + date pill marking where
  // the active quick-range begins (e.g. start of today for 1D). Painted on its own
  // canvas in the redraw cycle so it tracks scroll/zoom; cleared when no range is
  // active (the pill clears on manual zoom/scroll too).
  const sepCanvasRef = useRef<HTMLCanvasElement>(null);
  const separatorTsRef = useRef<number | null>(null);
  const paintSeparatorRef = useRef<() => void>(() => {});
  // (prevEpicRef/prevResRef moved into useLiveMarketData — the data-load effect is
  // their only reader; they detect epic-vs-interval changes to drop a stale
  // quick-range that would otherwise bleed onto a different series/interval.)
  // Cache for the separator's label + accent so paintSeparator doesn't rebuild an
  // Intl formatter / read getComputedStyle every redraw (it runs on every tick).
  const sepCacheRef = useRef<{ ts: number; tz: string; theme: string; label: string; accent: string } | null>(
    null,
  );
  // Imperative handle to the curve-end label pills (a sibling DOM overlay). Pills
  // are recomputed from the line cache each redraw and pushed here, mirroring the
  // legend's imperative-update pattern (no React churn per crosshair pixel).
  const curveLabelsRef = useRef<CurveLabelsHandle>(null);
  const aggMarkersRef = useRef<BacktestAggMarkersHandle>(null);
  // Coarse-timeframe LIVE exit pills (one per bar, count + net P&L) — the live
  // analog of aggMarkersRef. Clusters are recomputed in drawTradeMarkers and
  // projected to pixels each redraw, like the backtest aggregate pills.
  const exitAggMarkersRef = useRef<TradeExitAggMarkersHandle>(null);
  const exitClustersRef = useRef<ExitCluster[]>([]);
  // While the cursor is parked over the "+" affordance, klinecharts has lost the
  // canvas hover and dropped its crosshair. We redraw just the HORIZONTAL crosshair
  // line ourselves at this y (the vertical one is intentionally gone — x is
  // meaningless on the axis strip). Also used to draw the snapped crosshair when the
  // cursor is within ALERT_SNAP_PX of an alert line. null = neither case active.
  const plusCrosshairYRef = useRef<number | null>(null);
  // Cursor pixel (container space) for the Pivots-High/Low Δ-label hover-enlarge,
  // shared between the pointer handlers (which set it + repaint on hover change)
  // and the paint loop (which re-hit-tests it every redraw). pivotHoverKeyRef holds
  // the enlarged pivot's identity so a move only repaints when it changes.
  const pointerPxRef = useRef<{ x: number; y: number } | null>(null);
  const pivotHoverKeyRef = useRef<string | null>(null);
  // Tracks whether the snap was active on the last onMove so we only call
  // setSuppressNativeLine when the state actually changes.
  const snapActiveRef = useRef(false);
  // Crosshair-link: the timestamp broadcast by a SIBLING cell (null = none). When
  // set, redraw paints a vertical time guide at that bar. syncCrosshairRef mirrors
  // the prop so the once-mounted crosshair subscription can read it without
  // re-subscribing.
  const syncedTsRef = useRef<number | null>(null);
  const syncCrosshairRef = useRef<boolean>(!!syncCrosshair);
  syncCrosshairRef.current = !!syncCrosshair;
  // Formats a timestamp for the synced crosshair's x-axis label, mirroring
  // klinecharts' own crosshair label (identical dtf options + the user's
  // clock/date format), so a linked chart's time pill reads the same as the
  // chart under the cursor. Rebuilt by the format effect below.
  const crosshairLabelFmtRef = useRef<(ts: number) => string>(() => "");
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;
  // Date-range link: syncTimeRef mirrors the prop so the once-mounted scroll/zoom
  // subscription can read it. A cell only broadcasts the gestures it owns (the cell
  // the cursor is on); a sibling merely applying a range never owns one, so it can't
  // echo back — see the broadcast effect and isGestureCell in chartSync.
  const syncTimeRef = useRef<boolean>(!!syncTime);
  syncTimeRef.current = !!syncTime;
  // "Lock charts" exact mode: when set, the date-range broadcast carries this cell's
  // barSpace so siblings reproduce the window pixel-for-pixel (see onRange below).
  const lockedRef = useRef<boolean>(!!locked);
  lockedRef.current = !!locked;
  // Last timestamp this cell published as the live (cursor-driven) align anchor, so
  // the hover handler only re-broadcasts when the hovered BAR changes, not every move.
  const lastHoverAnchorTsRef = useRef<number | null>(null);
  // AVWAP anchor drag: the handle's current pixel (when AVWAP is selected and the
  // anchor is on-screen), whether a drag is in progress, and guards so a drag
  // doesn't also fire the click→deselect at mouseup. pendingAnchorX/raf throttle
  // the O(bars) recalc to one per animation frame while dragging.
  const anchorPxRef = useRef<{ x: number; y: number; ts: number; color: string } | null>(null);
  const draggingAnchorRef = useRef(false);
  const dragMovedRef = useRef(false);
  const justDraggedRef = useRef(false);
  // The trade id whose line is being actively dragged, so its lines render fully
  // revealed (not a resting stub that jumps under the cursor) even in no-confirm mode
  // where a drag doesn't select. Cleared on drop/abort. See tradeLineSpecs `dragging`.
  const draggingTradeRef = useRef<string | null>(null);
  const pendingAnchorXRef = useRef(0);
  const anchorRafRef = useRef(0);
  // Trade- and alert-line drags are driven by makeLineDrag instances created inside
  // useLineDrag (their active/moved state lives in those closures, not in refs); the
  // hook exposes isActive() via these two out-direction bridges for the few staying
  // places that need to know a drag is in flight (onMove reads the trade drag, onLeave
  // the alert drag). Assigned in useLineDrag's effect; default to false before it runs.
  const tradeDragActiveRef = useRef<() => boolean>(() => false);
  const alertDragActiveRef = useRef<() => boolean>(() => false);
  // In-direction bridge: the init-effect-local tradeLinePixels() is shared by three
  // staying readers (tradeLineHitTest, onMove, redraw) AND by useLineDrag's
  // grabbableTradeLine. The init effect assigns it here so the hook reaches it.
  const tradeLinePixelsRef = useRef<() => TradeLinePx[]>(() => []);
  // In-direction bridge: the init-effect-local alertHitTest() is called by the
  // staying onClick AND by usePointerCrosshair's onMove. The init effect assigns
  // it here so the crosshair hook reaches it. Mirrors tradeLinePixelsRef.
  const alertHitTestRef = useRef<(x: number, y: number) => string | null>(() => null);
  // snapHover is the alert the crosshair has snapped to and auto-hovered, so a leave can
  // clear it.
  const snapHoverRef = useRef<string | null>(null);
  // redraw() is defined far below (useCallback); the once-mounted click handler
  // needs to trigger a repaint after changing the selection, so reach it via ref.
  const redrawRef = useRef<() => void>(() => {});

  // DOM legend (top-left): which candle-pane indicator ROWS exist is React state,
  // gated on a shallow signature so it only re-renders on add/remove/visibility/
  // recolor — not per crosshair pixel. The legend's VALUES update imperatively via
  // this handle (textContent), driven from the crosshair subscription + live tick.
  const [legendRows, setLegendRows] = useState<LegendRow[]>([]);
  const legendRowsSigRef = useRef("");
  // TV-style legend chevron: collapsed hides the indicator rows (symbol/OHLC row
  // stays). Per-cell, persisted so it survives reload.
  const [legendCollapsed, setLegendCollapsed] = useState(() => loadLegendCollapsed(scope));
  const toggleLegendCollapsed = () => {
    const next = !legendCollapsed;
    setLegendCollapsed(next);
    saveLegendCollapsed(scope, next);
  };
  // TV-style "hide main series": when true, the candlesticks render transparent (via
  // klineStyles' candleHidden arg) while indicators/drawings/price marks stay. Per-cell,
  // persisted. A ref mirrors it so the various klineStyles(...) call sites (theme/symbol
  // re-applies) read the current value, like crosshairRef.
  const [candleHidden, setCandleHidden] = useState(() => loadCandleHidden(scope));
  const candleHiddenRef = useRef(candleHidden);
  candleHiddenRef.current = candleHidden;
  const toggleCandleHidden = () => {
    const next = !candleHidden;
    setCandleHidden(next);
    saveCandleHidden(scope, next);
    chartRef.current?.setStyles(
      klineStyles(themeRef.current, legendHovered.value, crosshairRef.current, next),
    );
  };
  // Sub-pane indicator legends (Volume/MACD/RSI…): same signature-gated pattern as
  // the candle rows, but the signature also folds in each pane's `top` so the cards
  // reposition when a separator is dragged (geometry, not just membership, changed).
  const [subPaneLegends, setSubPaneLegends] = useState<SubPaneLegendData[]>([]);
  const subPaneLegendsSigRef = useRef("");
  // Drop-indicator line's y-offset (relative to chart root) during a sub-pane drag;
  // null when no drag is in progress.
  const [paneDropTop, setPaneDropTop] = useState<number | null>(null);
  const legendHandleRef = useRef<ChartLegendHandle>(null);
  // Latest hovered bar index from the crosshair (null = no crosshair → last bar).
  const crosshairIdxRef = useRef<number | null>(null);
  const getChart = useCallback(() => chartRef.current, []);
  // Selected candle-pane indicator name as React state (mirrors the
  // selectedIndicator signal) so the DOM legend re-renders its blue row highlight.
  // The selected indicator's name drives the blue row highlight. Names are globally
  // unique across panes, so a single name covers the candle legend AND the sub-pane
  // legends — whichever card holds that row highlights it.
  const [selectedName, setSelectedName] = useState<string | null>(
    selectedIndicator.value?.name ?? null,
  );
  // Also repaint the canvas on change so a selection driven from OUTSIDE the chart
  // (e.g. the chart-operand picker selecting an indicator) shows its hollow handles.
  // The in-chart click path pairs its own set() with a repaint(), so this just
  // double-covers that (idempotent) and covers external setters that don't.
  useEffect(
    () =>
      selectedIndicator.subscribe((s) => {
        setSelectedName(s?.name ?? null);
        redrawRef.current();
      }),
    [],
  );
  // Hovering an indicator's legend row also shows its curve in "selected mode"
  // (the hollow handles), TradingView-style — repaint the overlay on hover change.
  useEffect(() => legendHoverName.subscribe(() => redrawRef.current()), [legendHoverName]);
  useEffect(
    () => indicatorOverlayRepaint.subscribe(() => redrawRef.current()),
    [],
  );
  // The inverse: hovering an indicator's CURVE highlights its legend card AND paints
  // its curve in selected mode. Mirror the name into state (the DOM legend's card
  // highlight) and repaint the overlay (the curve handles) on every hover change.
  const [curveHoverNameState, setCurveHoverNameState] = useState<string | null>(
    curveHover.value?.name ?? null,
  );
  useEffect(
    () =>
      curveHover.subscribe((s) => {
        setCurveHoverNameState(s?.name ?? null);
        redrawRef.current();
      }),
    [curveHover],
  );

  const [status, setStatus] = useState<LiveStatus>("connecting");
  // The socket reports "live" (handshake up) but no candle has arrived for a while
  // on an open market — a silently-wedged upstream (e.g. a MetaApi stream that
  // hangs awaiting ticks with no error frame). Drives the amber legend dot + a
  // greyed price tag so a frozen chart doesn't keep looking fully live. See the
  // staleness watchdog effect below.
  const [streamStale, setStreamStale] = useState(false);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  // True once the chart has candles to show (history loaded or a live tick arrived).
  const [hasData, setHasData] = useState(false);
  // Chart instance exists (init effect ran). State, not a ref read in render, so the
  // quick-range bar enables the moment the chart is live even on a static frame.
  const [chartReady, setChartReady] = useState(false);
  // Banner gate: no data for a grace period. Gated on time, NOT the live status —
  // the WS connects to OUR backend (which stays up), so it reports "live" even when
  // the upstream broker delivers nothing (maintenance / auth). A healthy load sets
  // hasData within ~1-2s, well under the grace, so this never flashes normally.
  const [noData, setNoData] = useState(false);
  // The backend's error detail from the last failed history load (e.g. a broker
  // 401/maintenance), shown in the no-data banner. null when the load just returned
  // empty (404 / closed market) with no error to report.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Whether the (long) error detail is expanded in the banner.
  const [errorOpen, setErrorOpen] = useState(false);
  const [anchoring, setAnchoring] = useState(false);
  // True while the Measure ruler is armed — drives the crosshair cursor on the
  // chart container (mirrors `anchoring`), reset when a press consumes the arm.
  const [measureArmedUi, setMeasureArmedUi] = useState(false);
  // Same, for the Slope tool while it's armed (placing the two anchors).
  const [slopeArmedUi, setSlopeArmedUi] = useState(false);
  const [rangePickArmedUi, setRangePickArmedUi] = useState(false);
  // Cursor over the chart canvas: "cur-pointer" (hand) over a selectable indicator
  // curve, "cur-default" (arrow) over the legend strip, "" = klinecharts crosshair.
  // A class (not inline style) because klinecharts sets cursor on the canvas itself,
  // which beats an ancestor's inline cursor; updated only on boundary crossings.
  // "cur-ns" (ns-resize) when snapped to a draggable line — single-select so it
  // cleanly overrides "cur-pointer" (a line drag beats curve selection).
  const [cursorMode, setCursorMode] = useState<"" | "cur-pointer" | "cur-default" | "cur-grab" | "cur-grabbing" | "cur-ns">("");
  const cursorModeRef = useRef<"" | "cur-pointer" | "cur-default" | "cur-grab" | "cur-grabbing" | "cur-ns">("");
  // Live price label + candle countdown, anchored at the last close on the axis.
  const [priceTag, setPriceTag] = useState<{
    y: number;
    price: number;
    countdown: string | null;
    w: number; // price-axis column width, so the pill fits inside it
    // Last candle's body direction, so the pill matches the dotted last-price
    // line's up/down color (TradingView keeps the line and its label one color).
    dir: "up" | "down";
  } | null>(null);
  // Live bid & ask axis pills (TradingView's bid/ask price labels). Each is null
  // when the bid/ask display is off, the feed is down, or the side is unknown.
  const [bidTag, setBidTag] = useState<{ y: number; price: number; w: number } | null>(null);
  const [askTag, setAskTag] = useState<{ y: number; price: number; w: number } | null>(null);
  const [alertTags, setAlertTags] = useState<
    Array<{
      id: string;
      y: number;
      level: number;
      condition: AlertCondition;
      trigger: AlertTrigger;
      expiresAt: number | null;
      hovered: boolean;
      active: boolean;
      selected: boolean;
    }>
  >([]);
  // The ACTIVE line's pill for the selected trade (at most one): the entry, SL, or TP
  // line the user clicked/dragged. The entry pill shows symbol + summary + uPnL +
  // close; the SL/TP pills show symbol + level + the P/L that level would realise if
  // hit + remove. Any pill shows Apply/Discard when ITS OWN line has a staged drag.
  // Anchored at the line's pixel y (recomputed in redraw); x frozen at selection.
  const [tradePills, setTradePills] = useState<
    Array<{
      tradeId: string;
      field: TradeLineField;
      y: number;
      kind: "position" | "order";
      side: OrderSide;
      qty: number;
      level: number;
      pl: number | null; // entry: uPnL; SL/TP: P/L if that level is hit
      changed: boolean; // this line has an un-applied drag → show Apply/Discard
      expiresAt: number | null; // resting order good-till-date epoch ms; null = GTC/position
      // entry pill only: which level merged into the entry at breakeven (SL or TP sits
      // at entry) → show a "BE" chip; the field says which pending edit Discard clears.
      breakevenField?: "stop" | "takeProfit";
    }>
  >([]);
  // Shared x for the trade pill, frozen at selection so the buttons sit still. null
  // until a trade is selected (mirrors pillLeftRef's "don't snap to 0" intent).
  const tradePillLeftRef = useRef<number | null>(null);
  // Live trade-pill DOM nodes keyed "tradeId:field". The pill body is pointer-events:
  // none (see .trade-pill) so it can't carry its own cursor/click — instead the chart's
  // mousemove/click handlers rect-test the cursor against these nodes to show the hand
  // cursor over a pill and let a click anywhere on the pill select its line.
  const tradePillNodesRef = useRef(new Map<string, HTMLDivElement>());
  // The pill (if any) under the given viewport point, as its line's id + field.
  const tradePillHitTest = (
    clientX: number,
    clientY: number,
  ): { id: string; field: TradeLineField } | null => {
    for (const [key, node] of tradePillNodesRef.current) {
      const r = node.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        const i = key.lastIndexOf(":");
        return { id: key.slice(0, i), field: key.slice(i + 1) as TradeLineField };
      }
    }
    return null;
  };
  // The hovered trade id — drives the pill hover-lift (soft shadow + red close). Kept
  // as light state so a hover only toggles a CSS class, not a full pill rebuild.
  // The hovered pill, keyed "tradeId:field" — ONLY the line under the cursor (not the
  // whole trade), so its hover-lift shadow is scoped to that one pill. Hover-only: a
  // selected-but-unhovered pill gets no shadow. String-encoded so React dedupes.
  const [hoveredPillKey, setHoveredPillKey] = useState<string | null>(null);
  // The pill whose RECT the cursor is literally inside (not merely its line's band),
  // keyed "tradeId:field" — gates the details popover so it opens on the pill only, not
  // on a bare line-hover. Distinct from hoveredPillKey, which also lifts on line hover.
  const [hoveredPillRectKey, setHoveredPillRectKey] = useState<string | null>(null);
  // The focused pill, keyed "tradeId:field" — the selected line wins, else the hovered
  // one. Drives z-order so an overlapped pill in focus rises above its neighbours. Encoded
  // as a string so React dedupes: staying on the same line doesn't re-render.
  const [focusedPillKey, setFocusedPillKey] = useState<string | null>(null);
  // The on-line pill is shown while the line is hovered/selected (driven by
  // klinecharts via overlays) OR while the cursor is over the pill itself —
  // moving cursor from canvas line onto the DOM pill ends the line hover, so this
  // local flag keeps it from flickering away under the pointer.
  const [pillHoverId, setPillHoverId] = useState<string | null>(null);
  // Last alert whose pill was shown (hovered/selected). Sticky — only ever set to
  // a real id, never cleared — so when the cursor slides off the line onto the "+"
  // affordance (a DOM sibling that makes klinecharts drop the canvas hover) we can
  // keep that pill alive instead of letting it vanish.
  const lastActivePillIdRef = useRef<string | null>(null);
  // Whether the dotted last-price line is currently suppressed (klinecharts style).
  // We hide it — and the live price axis pill — while an alert line is click-selected
  // so the selected alert reads cleanly with nothing layered over its price row. A
  // mere hover does NOT trigger this (the live price stays the authoritative read);
  // only selection does. Tracked as a ref so redraw() (runs every tick) only calls
  // setStyles on an actual transition, not on every frame.
  const lastPriceHiddenRef = useRef(false);
  // True while the cursor is over the price-axis column (right strip). Hides the
  // alert pill outright — the axis is a no-interaction zone, so the descriptive
  // pill (and its delete button) shouldn't ride along there. Toggled on transition
  // only (ref mirrors it for the once-mounted mousemove handler).
  const [onAxis, setOnAxis] = useState(false);
  const onAxisRef = useRef(false);
  // Alert pills track the cursor's x so they sit next to the pointer (TV-style).
  // Positioned imperatively (like the "+" affordance) to avoid a re-render per
  // mousemove: cursorXRef holds the latest x, pillNodesRef the live pill nodes.
  const cursorXRef = useRef(0);
  const pillNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Last computed `left` (px) per pill id. The pill's x is set imperatively (no
  // per-mousemove re-render), but React owns the element's `style`, so on any
  // re-render it would reset `left` to the CSS default (0) and a frozen, selected
  // pill would jump to the far left. Seeding the rendered style from this ref makes
  // React reassert the imperative position instead of clobbering it.
  const pillLeftRef = useRef<Map<string, number>>(new Map());
  // Low-frequency clock driving the pill's remaining-time chip. Only ticks while a
  // VISIBLE pill actually has an expiry, so we don't re-render on idle.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Place a pill just past the cursor, flipping to the left of it near the right
  // edge so it never spills over the price axis. Reads refs only, so it's stable.
  const positionPill = useCallback((node: HTMLDivElement) => {
    const c = chartRef.current;
    const cont = containerRef.current;
    const mainW = c?.getSize("candle_pane", 'main')?.width ?? cont?.clientWidth ?? 0;
    const gap = 14;
    const w = node.offsetWidth;
    let left = cursorXRef.current + gap;
    if (mainW && left + w + 4 > mainW) left = cursorXRef.current - w - gap;
    if (left < 4) left = 4;
    node.style.left = `${left}px`;
    const id = node.dataset.alertId;
    if (id) pillLeftRef.current.set(id, left); // survive React re-renders (see ref)
  }, []);

  // Stable ref callback for pill nodes (id carried via data-alert-id). Stable so
  // React only runs it on real mount/unmount — NOT on every redraw, which would
  // otherwise yank a selected (frozen) pill back to the cursor. On mount, a pill
  // is placed at the cursor unless its line is already selected.
  const registerPill = useCallback(
    (node: HTMLDivElement | null) => {
      const map = pillNodesRef.current;
      if (node) {
        const id = node.dataset.alertId ?? "";
        map.set(id, node);
        // Position on mount unless this is the frozen, selected pill that already
        // has a stored x (re-mount after a redraw) — repositioning that would yank
        // it to the cursor. A selected pill with no stored x (selected straight from
        // the sidebar, never hovered) still gets placed once so it isn't at left 0.
        const isSelected = id === overlays.getSelectedAlertId();
        if (!isSelected || !pillLeftRef.current.has(id)) positionPill(node);
      } else {
        for (const [id, n] of map)
          if (!n.isConnected) {
            map.delete(id);
            pillLeftRef.current.delete(id); // drop the stored left with the node
          }
      }
    },
    [positionPill],
  );

  // Anchor the active line's pill at its OWN label's spot (the far-left edge, where the
  // line draws its `TP …`/`SL …` label). Selecting a line then suppresses that canvas
  // label (see tradeLineSpecs `selectedField`) and shows the pill IN ITS PLACE — the
  // label "grows" into the richer, actionable pill rather than a second pill dropping
  // near the cursor and covering it (Idea C). 0 matches the label's background left edge
  // (drawn at x:6 with paddingLeft:6).
  const freezeTradePillX = useCallback(() => {
    tradePillLeftRef.current = 0;
  }, []);

  // "+" axis affordance: positioned imperatively on mousemove (no per-move state).
  const wrapRef = useRef<HTMLDivElement>(null);
  // Clips the candle-pane DOM overlays (alert tags + pills, trade pills) to the
  // candle pane's height so a level priced below the visible range slides off the
  // pane edge (TV-style) instead of bleeding into the indicator sub-panes below.
  // Its height is set imperatively from the redraw loop (getSize candle_pane).
  const pillClipRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLDivElement>(null);
  const plusPriceLabelRef = useRef<HTMLSpanElement>(null);
  const plusPriceRef = useRef(0);
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number; price: number } | null>(null);
  const plusMenuOpenRef = useRef(false);
  plusMenuOpenRef.current = plusMenu != null;
  // TradingView-style right-click menu for an indicator (Settings / Hide / Copy /
  // Remove). Opened from a legend-row right-click (ChartLegend) or a right-click on
  // the indicator's curve (onContextMenu below). paneId + name identify the target.
  const [indMenu, setIndMenu] = useState<{
    x: number;
    y: number;
    paneId: string;
    name: string;
  } | null>(null);
  // TradingView-style right-click menu for the CHART itself (empty space) — Paste an
  // indicator or drawing copied earlier. Opened by a right-click that isn't on an
  // indicator curve.
  const [chartMenu, setChartMenu] = useState<{ x: number; y: number; price: number | null } | null>(null);
  // TradingView-style right-click menu for the PRICE AXIS column — a single "Scale
  // price chart only" toggle (see onContextMenu, which opens it over the axis strip).
  const [axisMenu, setAxisMenu] = useState<{ x: number; y: number } | null>(null);
  // Reflect the persisted toggle so the menu's checkmark stays in sync across cells.
  const [scaleOnly, setScaleOnly] = useState(scalePriceOnly.value);
  // The value only changes via toggleScalePriceOnly (a user action after mount), so
  // the initial useState seed is authoritative — just subscribe to later flips.
  useEffect(() => scalePriceOnly.subscribe(setScaleOnly), [scalePriceOnly]);
  // Auto-save this cell's per-symbol template on real layout edits. layoutEvents
  // fires only for genuine edits (merge-applies are suppressed at the emitter, and
  // mount/symbol hydration doesn't persist), so this never fights hydration. The
  // engine itself no-ops when auto-save is off or the content is unchanged.
  useEffect(() => {
    const myScope = scope;
    const epic = symbol.epic;
    const off = onLayoutChanged((changedScope) => {
      // Never auto-save the template from a snapshot-restored tab: edits to a
      // study copy must not become the symbol's template.
      if (changedScope === myScope && !snapViewRef.current) {
        scheduleAutoSave(myScope, epic);
      }
    });
    // Cancel any pending save on teardown: a timer that fires after the cell's
    // scope storage is purged (cell/tab close) would capture an empty layout and
    // blank the symbol's real template.
    return () => {
      off();
      cancelAutoSave(myScope, epic);
    };
  }, [scope, symbol.epic]);
  // Invert scale (Alt/Option+I or the toolbar "I" button): push the flip onto the
  // live chart. Candle pane only — klinecharts' YAxisImp.isReverse() ignores
  // yAxis.reverse for sub-panes. Session-only, so no initial apply is needed
  // (the signal is always false at mount) — just react to later flips. Theme
  // changes deep-merge styles via klineStyles() (which never sets reverse), so
  // an active inversion survives them.
  useEffect(
    () =>
      invertScale.subscribe((reverse) => {
        // overrideYAxis triggers a synchronous repaint that can throw from deep in
        // klinecharts (x-axis tick formatting on a NaN scroll offset, a latent
        // bug unrelated to inversion) AFTER the override is already committed.
        // Signal.set stops notifying on a throw, so contain it here or the
        // toolbar "I" button (a later subscriber) would miss the flip.
        try {
          // v10 moved `reverse` off styles.yAxis onto the axis itself.
          chartRef.current?.overrideYAxis({ paneId: "candle_pane", reverse });
        } catch (e) {
          console.error("invert-scale repaint", e);
        }
      }),
    [invertScale],
  );
  // Re-assert the scale-price-only createRange after a log/normal toggle. The
  // log toggle passes a new axis `name`, which recreates the candle pane's y-axis
  // from its template and drops our createRange override. The override itself is
  // axis-type-aware (delegates the log10 transform to the live axis), so simply
  // re-installing it restores candles-only fitting on whichever axis kind is now
  // active. (autoFit re-applies the SAME name, which merges and preserves the
  // override, so no re-assert is needed there.)
  useEffect(
    () =>
      logScale.subscribe(() => {
        const c = chartRef.current;
        if (c) applyScalePriceOnly(c, scalePriceOnly.value);
      }),
    [logScale, scalePriceOnly],
  );
  // Flip "scale price chart only": persist it and swap the candle pane's
  // createRange override (candles-only vs the framework's default full-pane fit).
  // v10 replaced v9's cheap private scale-price-only flag with a supported createRange
  // override, and overrideYAxis is the only way to change it: that call resets
  // the axis auto-calc flag and re-fits (the same recompute the auto-fit
  // double-click triggers). So unlike v9 we can no longer stage the setting
  // without re-fitting, and the v9 "skip re-fit while manually zoomed" guard is
  // gone: toggling always re-fits the candle pane. Any manual zoom is discarded,
  // which is preferable to silently applying a stale setting on the next fit.
  const toggleScalePriceOnly = useCallback(() => {
    const next = !scalePriceOnly.value;
    scalePriceOnly.set(next);
    saveScalePriceOnly(scope, next);
    const c = chartRef.current;
    if (!c) return;
    applyScalePriceOnly(c, next);
  }, [scalePriceOnly, scope]);
  // status read inside the once-mounted countdown interval without re-subscribing.
  const statusRef = useRef<LiveStatus>(status);
  statusRef.current = status;
  // Flip the no-data banner on only after a grace period with no candles, so a
  // normal load (history lands in ~1-2s) never shows it; a switch resets hasData
  // false → this re-arms. Cleared the instant data arrives.
  useEffect(() => {
    if (hasData) {
      setNoData(false);
      return;
    }
    const t = setTimeout(() => setNoData(true), 6000);
    return () => clearTimeout(t);
  }, [hasData, symbol.epic, period.resolution, brokerId]);
  // Authoritative display precision fetched per epic. Symbols persisted from the
  // bulk markets list can lack pricePrecision (e.g. oil), so we don't trust the
  // stored value: fetch the platform's own decimals and prefer them.
  const [fetchedPrecision, setFetchedPrecision] = useState<number | null>(null);
  const effPrecision = fetchedPrecision ?? symbol.pricePrecision ?? 2;
  const precisionRef = useRef(effPrecision);
  precisionRef.current = effPrecision;
  // Whether this epic's market is currently closed (derived from opening hours),
  // fetched with precision and polled (see effect below). Drives the price label's
  // "closed" text in place of the candle countdown; the ref lets the once-mounted
  // countdown logic read it without re-subscribing. (The tab badge's closed/next-open
  // state is sourced separately by an App-level epic poll, so this cell tracks only
  // the boolean it needs for its own price label.)
  const [marketClosed, setMarketClosed] = useState(false);
  const marketClosedRef = useRef(marketClosed);
  marketClosedRef.current = marketClosed;
  // When the live stream last delivered a candle. Lets the open/closed check be
  // event-driven: a ticking stream means the market is open (no server call), so
  // we only re-check status when the stream falls silent (see the effect below).
  const lastCandleAtRef = useRef(0);
  // When the live socket last transitioned to "live" (stamped by the effect below).
  // The staleness watchdog measures silence from max(lastCandle, thisConnect) so a
  // stream that connects and then NEVER delivers a first tick is caught too — a
  // last-candle-only baseline (which stays 0) would miss that case entirely. Kept
  // SEPARATE from lastCandleAtRef so it doesn't feed the market open/closed
  // fallback (which must see real ticks, not a bare connect, to infer "open").
  const streamLiveAtRef = useRef(0);
  // Stamp the connect time on each true transition INTO "live". A setState no-op
  // (openLive re-emits "live" on every candle) doesn't re-run this, so it captures
  // when the socket came up, not each tick — exactly the baseline the watchdog wants.
  useEffect(() => {
    if (status === "live") streamLiveAtRef.current = Date.now();
  }, [status]);
  // Staleness watchdog: the socket can report "live" while the upstream is silently
  // wedged (a MetaApi stream that hangs on `queue.get()` sends no error frame — a
  // known limitation), so status alone never flips off and the chart freezes while
  // looking live. Flag it when an OPEN market's connected feed has been silent past
  // STALE_MS. We do NOT auto-reconnect: a client socket bounce re-attaches to the
  // same backend stream (`_ensure_stream` short-circuits on cached sync;
  // `register_tick_queue` is ref-counted) — the wedge only clears via the SDK's own
  // resync, so a bounce would flap the indicator without recovering anything.
  // Threshold sits above the illiquid-but-open quiet gaps we'd otherwise cry wolf on;
  // a genuine close resolves via the marketClosed gate (the 180s market re-check).
  useEffect(() => {
    const STALE_MS = 90_000;
    setStreamStale(false);
    const id = setInterval(() => {
      setStreamStale(
        isFeedStale({
          status: statusRef.current,
          marketClosed: marketClosedRef.current,
          lastCandleAt: lastCandleAtRef.current,
          streamLiveAt: streamLiveAtRef.current,
          now: Date.now(),
          staleMs: STALE_MS,
        }),
      );
    }, 10_000);
    return () => clearInterval(id);
  }, [symbol.epic, period.resolution, brokerId]);
  // Market-info popover anchor (viewport coords of the legend ⓘ); null = closed.
  const [detailsAnchor, setDetailsAnchor] = useState<{ x: number; y: number } | null>(null);
  const [cacheStatsOpen, setCacheStatsOpen] = useState(false);
  const [cacheStats, setCacheStats] = useState<CandleCacheStats | null>(null);
  // Current epic/resolution, readable from once-mounted callbacks without re-subscribing.
  const epicRef = useRef(symbol.epic);
  epicRef.current = symbol.epic;
  const resRef = useRef(period.resolution);
  resRef.current = period.resolution;
  // Active broker, readable from once-mounted callbacks (scroll-back) without re-subscribing.
  const brokerIdRef = useRef(brokerId);
  brokerIdRef.current = brokerId;
  // Scroll-back (getBars) reads refs, not props, so keep the live price side here.
  const priceSideRef = useRef(priceSide);
  priceSideRef.current = priceSide;
  // redraw() (a []-deps callback) reads the bid/ask setting + latest quote sides
  // through refs, not the captured props.
  const bidAskRef = useRef(bidAsk);
  bidAskRef.current = bidAsk;
  const bidAskStyleRef = useRef(bidAskStyle);
  bidAskStyleRef.current = bidAskStyle;
  const crosshairRef = useRef(crosshair);
  crosshairRef.current = crosshair;
  const bidRef = useRef<number | null>(null);
  const askRef = useRef<number | null>(null);
  // Current theme, readable from the once-mounted mousemove handler so the
  // legend-hover restyle doesn't snap back to the mount-time theme.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Scroll-back pagination state (reset per symbol/period load). Declared ABOVE
  // the handle useMemo so they can be folded into it — three consumers coordinate
  // through these (the init effect's scroll-back loader, the range-navigation
  // walks, and the live-data reset), so every consumer must reach the SAME ref
  // instances via handle.*.
  const loadingRef = useRef(false); // re-entrancy guard
  const exhaustedRef = useRef(false); // no older history left
  const cursorSecRef = useRef(0); // unix-sec boundary we've loaded back to
  const emptyStreakRef = useRef(0); // consecutive empty windows (gap-walking)

  // Single imperative handle bundling the refs + controller objects that the
  // one-time init effect and the later callbacks share. Declared once all its
  // member refs exist; stable for the mount ([] deps), so `handle.redrawRef` is
  // the SAME object as `redrawRef` — this is a pure access-shape consolidation
  // (no logic change) that lets later hook extractions reach every shared ref
  // through `handle.*`. `overlays` is a stable controller value (not a ref); the
  // controller carries the per-cell UI signals.
  const handle: ChartHandle = useMemo(
    () => ({
      controller,
      overlays,
      chartRef,
      dataFacadeRef,
      redrawRef,
      posDrawRef,
      posLinesRef,
      tradesRef,
      pendingRef,
      draftRef,
      tradeUiRef,
      resRef,
      crosshairRef,
      aggMarkersRef,
      exitAggMarkersRef,
      paintBracketRef,
      paintSeparatorRef,
      // Live-data + range-navigation shared refs (folded in for the hook extractions).
      wsRef,
      bidRef,
      askRef,
      epicRef,
      brokerIdRef,
      priceSideRef,
      loadingRef,
      exhaustedRef,
      cursorSecRef,
      emptyStreakRef,
      pendingRangeRef,
      launchedTokenRef,
      cappedAnchorRef,
      separatorTsRef,
      programmaticMoveRef,
      pendingTradeRestoreRef,
      snapMarkerIdRef,
      tradeMarkersDrawRef,
      // Cross-boundary call bridges to useRangeNavigation (assigned there in Step 7).
      ensureCoverageAndFitRef,
      ensureAnchorCoverageRef,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Range coverage/fit + quick-range/go-to-date callbacks. The hook also assigns
  // the two coverage walks onto handle.ensureCoverageAndFitRef /
  // handle.ensureAnchorCoverageRef (in render, before any effect runs) so
  // useLiveMarketData + the init effect can call them across the boundary.
  const { onRangePick, onGoToDate } = useRangeNavigation(handle, {
    pageHistoryBack,
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
  });

  // Create the chart once (StrictMode-safe: init has no idempotent guard).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || inited.current) return;
    inited.current = true;
    const chart = init(el);
    if (!chart) return;
    chartRef.current = chart;
    // v10 data pipeline: the facade owns setDataLoader and replays our
    // push-based data (setBars/pushBar) as pull-based getBars/subscribeBar.
    const dataFacade = createChartDataFacade();
    dataFacade.attach(chart);
    dataFacadeRef.current = dataFacade;
    // Seed the "scale price chart only" createRange override onto the live chart
    // before any render or indicator add, so the candle pane fits candles-only
    // from the first frame (see chart/priceOnlyRange.ts). The override persists on
    // the axis across auto-fits (same-name overrideYAxis merges); only a log-scale
    // toggle recreates the axis and drops it, so we re-apply on logScale change.
    applyScalePriceOnly(chart, scalePriceOnly.value);
    setChartReady(true);
    chart.setTimezone(timezone || browserTimezone());
    chart.setFormatter({ formatDate: makeFormatDate(clock, dateFormat, showWeekday) });

    // Preload the Material Symbols subset the legend icons are drawn from, then
    // nudge a redraw — otherwise the first hover can paint before the canvas font
    // is ready and show blank icons.
    document.fonts
      ?.load("16px 'Material Symbols Outlined'")
      .then(() => chartRef.current?.setStyles(klineStyles(theme, legendHovered.value, crosshairRef.current, candleHiddenRef.current)))
      .catch(() => {});

    // Indicator legend action icons (gear/eye/remove) are driven entirely by our own
    // DOM legend (ChartLegend + useIndicatorCommands' onLegend* handlers), not by
    // klinecharts' canvas tooltip: our indicator tooltip source emits `features: []`
    // (lib/indicators/shared.ts legendTooltipSource), so klinecharts never draws a
    // feature icon and its v10 'onIndicatorTooltipFeatureClick' action can never fire.
    // The v9 OnTooltipIconClick subscription here was therefore dead; removed rather
    // than ported (no-legacy-code rule). See task-6-report.md for the evidence.

    // Repaint the selection overlay. Our dots live on our OWN canvas (not
    // klinecharts'), so we just re-run the component's redraw (wired via ref once
    // mounted), which rebuilds the line cache and repaints the canvas.
    const repaint = () => handle.redrawRef.current();

    // Chart clicks drive, in priority order:
    //  1. AVWAP anchor placement (while in anchor mode) — resolve x to a bar ts.
    //  2. TradingView-style indicator selection: a click on a candle-pane
    //     indicator's legend row, or near ANY indicator's curve (sub-panes
    //     included), selects it (hollow handles appear); a click on empty chart
    //     space deselects. Keyed by pane+name (v1 is one-instance-per-name).
    const onClick = (e: MouseEvent) => {
      const c = chartRef.current;
      if (!c) return;
      // Swallow the click that closes an anchor drag, so it doesn't deselect AVWAP.
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }
      // A pill button's click (Apply/Discard/Close/Remove — the pointer-events:auto
      // islands in the click-through trade pill) bubbles up to this native listener
      // BEFORE React's root-delegated handlers run, so the button can't stop it
      // itself. The button's own action is the whole click — it must not also
      // toggle/deselect the line (or anything else) underneath.
      if (e.target instanceof Element && e.target.closest(".tp-btn")) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const anchoringId = avwapAnchorMode.value;
      if (anchoringId) {
        const pt = first(
          c.convertFromPixel([{ x, y }], { paneId: "candle_pane", absolute: true }),
        );
        if (typeof pt.timestamp !== "number") return;
        c.overrideIndicator({ name: anchoringId, calcParams: [pt.timestamp] });
        saveAvwapAnchor(scope, epicRef.current, anchoringId, pt.timestamp);
        avwapAnchorMode.set(null);
        return;
      }

      // Backtest inspect mode: a candle-pane click selects that bar for the
      // inspector (bar open time, seconds → matches the trace keys) instead of the
      // normal indicator select/deselect. Only one backtest panel is open at a time.
      if (inspectModeSignal.value) {
        const pt = first(
          c.convertFromPixel([{ x, y }], { paneId: "candle_pane", absolute: true }),
        );
        if (typeof pt.timestamp === "number") {
          inspectSelectedBarSignal.set(Math.floor(pt.timestamp / 1000));
        }
        return;
      }

      // The top-left legend is now DOM (<ChartLegend>): its rows handle their own
      // select-click and the eye/gear/trash icons their own clicks (pointer-events
      // on the rows; the container is pass-through). So here we only handle curve
      // hits on the canvas: a click near ANY indicator's curve (sub-panes included)
      // selects it; a click on empty chart space deselects.
      const hit = hitTestCache(lineCacheRef.current, x, y);
      if (hit) {
        const cur = selectedIndicator.value;
        if (cur?.paneId !== hit.paneId || cur?.name !== hit.name) {
          selectedIndicator.set({ paneId: hit.paneId, name: hit.name });
          repaint();
        }
      } else if (selectedIndicator.value) {
        selectedIndicator.set(null);
        repaint();
      }
      // Alert-line selection (chart -> panel). klinecharts doesn't fire onSelected
      // for these horizontal priceLines on a plain click, so we hit-test them here
      // ourselves. Single-click SELECTS (idempotent — re-selecting the same line is
      // a no-op, NOT a toggle: a toggle would make the first click after a fresh,
      // auto-selected create deselect, so selecting took two clicks). Deselection
      // happens via empty-space click or selecting another line. This is the
      // counterpart to the sidebar row click, so the two stay in sync.
      const alertHit = alertHitTest(x, y);
      if (alertHit) overlays.selectAlert(alertHit);
      else if (!hit) overlays.selectAlert(null);
      // Clear the drawing selection on an empty-space click. klinecharts fires
      // onSelected for drawings but NOT onDeselected on empty space (verified), so
      // mirror the indicator/alert deselect here. Skip when a drawing is under the
      // cursor — that click is selecting it (onSelected handles that).
      if (!hit && !alertHit && !overlays.getHoveredDrawingId()) overlays.selectDrawing(null);
      // Trade-line selection (chart -> dock). Single-click focuses THAT line (its pill
      // shows + dock row lights up) without opening the edit ticket — double-click
      // opens it. A click on empty space drops the trade.
      // A click on a live trade MARKER is handled by the marker's own overlay
      // onClick (klinecharts fires it from its mouseup, before this DOM click) —
      // hovering the glyph is the tell, same idiom as getHoveredDrawingId above.
      // Skip the line hit-test for that click too: a trade line passing within
      // tolerance of the glyph would otherwise select in the same gesture and,
      // selectTradeLine being a toggle, cancel or hijack the marker's selection.
      const overTradeMarker = tradeMarkerHoverSignal.value != null;
      // A pill click (its body is pointer-events:none, so it lands here on the canvas)
      // selects the pill's line even where the pill pokes past the line's ±6px click
      // band — the hand cursor shows across the whole pill, so the whole pill selects.
      const tradeHit = overTradeMarker
        ? null
        : tradeLineHitTest(x, y) ?? tradePillHitTest(e.clientX, e.clientY);
      if (tradeHit) selectTradeLine(tradeHit.id, tradeHit.field, false /* openPanel */);
      // Click on empty space drops the trade — UNLESS the edit ticket is open (clicking
      // away from the lines must not slam an open ticket shut; it closes only via its
      // own Cancel/✕/Escape, or by opening another trade), and UNLESS the click landed
      // on a trade marker: a live glyph (its own onClick just applied the selection)
      // or a backtest fill/caret glyph (hover sets highlightTradeSignal) — inspecting
      // a backtest trade must not deselect the live position as a side effect.
      else if (!overTradeMarker && highlightTradeSignal.value == null && !tradePanelOpen.value)
        setTradeSelected(null);
    };

    // Shared alert-line hit-test (used by single-click select and double-click
    // edit): returns the id of the alert line within HIT_TOLERANCE_PX of (x,y) in
    // the candle pane (not the axis column), or null.
    const alertHitTest = (x: number, y: number): string | null => {
      const c = chartRef.current;
      if (!c) return null;
      const mainW = c.getSize("candle_pane", 'main')?.width ?? Infinity;
      if (x > mainW) return null;
      for (const a of overlays.getAlerts()) {
        const ay = first(
          c.convertToPixel([{ value: a.level }], { paneId: "candle_pane", absolute: true }),
        ).y;
        if (ay != null && Math.abs(ay - y) <= HIT_TOLERANCE_PX) return a.id;
      }
      return null;
    };

    // This cell's trade lines, each resolved to a pixel-y ONCE — the single source
    // for the hover hit-test, the drag-grab test, AND the magnet/snap. Built from the
    // SAME tradeLineSpecs that draws the lines (current hidden/hovered/selected
    // applied) so a hidden, un-revealed line isn't hittable and it matches exactly
    // what's on screen. The draft (un-submitted) order is included (it has no dock
    // row but IS a snap target); consumers that don't want it filter on DRAFT_ID.
    // Computing it once per mousemove avoids rebuilding the spec list and re-running
    // convertToPixel per line in two separate places on the hot path.
    // (TradeLinePx now lives in chart/useLineDrag.ts so the drag hook's
    // grabbableTradeLine shares the exact shape.)
    const tradeLinePixels = (): TradeLinePx[] => {
      const c = chartRef.current;
      if (!c) return [];
      const specs = tradeLineSpecs({
        trades: tradesRef.current,
        pending: pendingRef.current,
        epic: epicRef.current,
        precision: precisionRef.current,
        levelsDraggable: true,
        onDrag: () => {},
        draft: draftRef.current,
        hidden: new Set(tradeUiRef.current.hidden),
        hovered: tradeUiRef.current.hovered,
        selected: tradeUiRef.current.selected,
        dragging: draggingTradeRef.current,
      });
      return specs.map((s) => {
        const sep = s.key.lastIndexOf(":");
        return {
          id: s.key.slice(0, sep),
          field: s.key.slice(sep + 1) as TradeLineField, // "price" | "stop" | "tp"
          level: s.level,
          draggable: s.draggable,
          y: first(
            c.convertToPixel([{ value: s.level }], { paneId: "candle_pane", absolute: true }),
          ).y,
          restKind: s.restKind,
          entryTs: s.entryTs,
          emphasized: s.emphasized ?? false,
        };
      });
    };
    // Bridge the init-effect-local tradeLinePixels to useLineDrag's grabbableTradeLine.
    tradeLinePixelsRef.current = tradeLinePixels;
    // Bridge the init-effect-local alertHitTest to usePointerCrosshair's onMove.
    alertHitTestRef.current = alertHitTest;

    // Trade-line hit-test (for click-select + double-click-edit): the TRADE id + field
    // of the entry/SL/TP line within HIT_TOLERANCE_PX of (x,y) in the candle pane, or
    // null. A locked position-entry line ignores klinecharts overlay events, so this
    // manual test (not onMouseEnter) covers every line. Excludes the draft.
    //
    // Unlike grab/hover/snap (deliberately full-width y-bands so a truncated SL/TP is
    // still grabbable anywhere), a CLICK must land on the DRAWN line — else clicking
    // empty chart space at a truncated line's price would select a trade with no visible
    // line under the cursor. So gate x to each line's resting extent (restingLineEndX,
    // the same source the overlay draws from); an emphasised line is full-width, so once
    // revealed it stays clickable across the pane.
    const tradeLineHitTest = (
      x: number,
      y: number,
    ): { id: string; field: TradeLineField } | null => {
      const c = chartRef.current;
      if (!c) return null;
      const mainW = c.getSize("candle_pane", 'main')?.width ?? Infinity;
      if (x > mainW) return null;
      const bars = c.getDataList() ?? [];
      const oldestTs = bars.length ? bars[0].timestamp : null;
      let best: { id: string; field: TradeLineField; d: number } | null = null;
      for (const t of tradeLinePixels()) {
        if (t.id === DRAFT_ID || t.y == null) continue;
        const d = Math.abs(t.y - y);
        if (d > HIT_TOLERANCE_PX || (best && d >= best.d)) continue;
        // Entry-candle x (only for a bar line whose entry is within the loaded window —
        // mirrors PositionLines.render's off-window→stub fallback).
        const entryX =
          t.restKind === "bar" && t.entryTs != null && oldestTs != null && t.entryTs >= oldestTs
            ? first(c.convertToPixel([{ timestamp: t.entryTs }], { paneId: "candle_pane", absolute: true })).x ?? null
            : null;
        const { endX } = restingLineEndX({ restKind: t.restKind, emphasized: t.emphasized, entryX, width: mainW });
        if (x > endX + HIT_TOLERANCE_PX) continue; // past the drawn line → not a hit
        best = { id: t.id, field: t.field, d };
      }
      return best ? { id: best.id, field: best.field } : null;
    };

    // Double-click an alert line -> open the edit modal (prefilled). Uses the same
    // DOM hit-test (klinecharts' overlay dblclick is unreliable for these lines).
    const onDblClick = (e: MouseEvent) => {
      const c = chartRef.current;
      if (!c) return;
      // Same guard as onClick: a dblclick on a pill button is two button actions,
      // not a line-edit or empty-space gesture.
      if (e.target instanceof Element && e.target.closest(".tp-btn")) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Double-click a trade MARKER: an entry glyph opens its position's edit
      // ticket (mirroring dblclick on the trade's lines; the two preceding clicks
      // toggled the selection on/off through the marker's own onClick, hence the
      // force-set openTradeEditor). Any marker dblclick returns here so it can't
      // fall through to the empty-space collapse of the bottom sub-panes.
      const hoverMarker = tradeMarkerHoverSignal.value;
      if (hoverMarker) {
        if (hoverMarker.tradeId) openTradeEditor(hoverMarker.tradeId, "price");
        return;
      }
      // Double-click a trade line -> force the edit ticket open. Using openTradeEditor
      // rather than selectTradeLine because a dblclick is preceded by two clicks that
      // may have toggled selection back to its start state — force-set unconditionally.
      // The pill-rect fallback mirrors onClick's: the whole pill is one hit target,
      // so a dblclick on its outer strips opens the ticket too instead of falling
      // through to the empty-space sub-pane collapse.
      const tradeHit = tradeLineHitTest(x, y) ?? tradePillHitTest(e.clientX, e.clientY);
      if (tradeHit) {
        openTradeEditor(tradeHit.id, tradeHit.field);
        return;
      }
      const id = alertHitTest(x, y);
      if (id) {
        alertEditRequest.set({ id });
        return;
      }
      // Double-click a drawing -> open its TV-style settings modal. hoveredDrawingId
      // is set by the overlay's onMouseEnter, so it's reliable here.
      const drawingId = overlays.getHoveredDrawingId();
      if (drawingId) {
        if (!snapViewRef.current) drawingSettingsRequest.set({ id: drawingId });
        return;
      }
      // Double-click an indicator's curve -> open its settings (TradingView-style).
      const hit = hitTestCache(lineCacheRef.current, x, y);
      if (hit) {
        if (!snapViewRef.current) indicatorSettingsRequest.set({ paneId: hit.paneId, name: hit.name });
        return;
      }
      // Double-click empty chart space -> hide/unhide the bottom sub-pane indicators
      // (Volume/MACD/RSI…). Price-overlay indicators on the candle pane (EMA…) stay
      // put — only the panes "at the bottom" collapse. Skip the axis gutters, which
      // own their own dblclick (reset price scale / bar spacing) and aren't "empty".
      if (overPriceAxis(e) || overTimeAxis(e)) return;
      controller.subPanesHidden.set(!controller.subPanesHidden.value);
    };

    // Right-click the chart -> our context menu (Paste an indicator). Suppress the
    // native browser menu. Skip the price-axis column (klinecharts owns that).
    const onContextMenu = (e: MouseEvent) => {
      const c = chartRef.current;
      if (!c) return;
      // If the right-click landed on an overlay (drawing OR alert line), klinecharts
      // has already fired its onRightClick on this gesture's mousedown (→ the
      // Toolbar's Lock/Settings/Delete menu). Yield: don't ALSO open the chart menu
      // stacked on top of it. Gating this on hoveredDrawingId was flaky — klinecharts'
      // onMouseEnter doesn't always precede the press, and never covers alert lines —
      // so both menus opened together; the claim is set by the SAME callback that
      // opens the overlay menu, so the two can't disagree. preventDefault so the
      // native browser menu doesn't stack on the overlay menu either.
      if (overlays.consumeOverlayRightClick()) {
        e.preventDefault();
        return;
      }
      const rect = el.getBoundingClientRect();
      // overPriceAxis (defined below, initialized before this listener ever fires)
      // is the shared "is the cursor in the right-hand y-axis column" test — reused
      // here so the axis-menu region can't drift from the drag/double-click gestures.
      if (overPriceAxis(e)) {
        // The y-axis column spans the FULL chart height, but "Scale price chart only"
        // only affects the candle pane. Restrict the toggle to the candle pane's own
        // axis strip (the topmost pane); a right-click on a sub-pane (RSI/MACD/Volume)
        // axis falls through to native behavior, since the toggle can't scale it.
        const candleH = c.getSize("candle_pane", 'main')?.height ?? 0;
        if (candleH && e.clientY - rect.top <= candleH) {
          e.preventDefault();
          setAxisMenu({ x: e.clientX, y: e.clientY });
        }
        return;
      }
      e.preventDefault();
      // Price under the cursor at right-click, so buy/sell-limit (and alert/line)
      // actions in the menu land on the confluence level the user just eyeballed —
      // computed fresh from clientY (not plusPriceRef) so it skips the alert/trade
      // snapping onMove applies and honours the raw-cursor-price behaviour.
      const menuY = e.clientY - rect.top;
      // Only the candle pane's y-axis is a price. Over a sub-pane (RSI/MACD/Volume)
      // convertFromPixel still returns an EXTRAPOLATED number, not null — so guard on
      // the candle pane's own bounds (mirroring onMove's candleBottom check) and leave
      // price null there, so the menu shows only Paste/Settings.
      const cb = c.getSize("candle_pane", 'root');
      const inCandle =
        cb != null && menuY >= cb.top && menuY <= cb.top + cb.height;
      const pt = inCandle
        ? first(c.convertFromPixel([{ y: menuY }], { paneId: "candle_pane", absolute: true }))
        : null;
      const price = pt != null && typeof pt.value === "number" ? pt.value : null;
      setChartMenu({ x: e.clientX, y: e.clientY, price });
    };

    // AVWAP anchor drag + the manual horizontal-line drag (trade SL/TP/entry +
    // alert lines) now live in chart/useLineDrag.ts, which attaches onAnchorDown
    // / onLineDown (capture-phase, on `el`) in its own effect — placed AFTER this
    // init effect so they still register LAST among the capture-phase mousedowns.

    // ⌘/Ctrl-drag clone (TradingView-style): pressing ⌘ on a drawing leaves a copy
    // behind and drags the original. We clone IN PLACE on the ⌘-mousedown and do
    // NOT stopPropagation — klinecharts then drags the overlay the press targeted,
    // so the duplicate stays at the source position. hoveredDrawingId is the
    // pressed drawing (set by its onMouseEnter). Left button only; never in anchor
    // mode (the AVWAP handler above already claimed those presses).
    const onClonePress = (e: MouseEvent) => {
      if (e.button !== 0 || (!e.metaKey && !e.ctrlKey) || avwapAnchorMode.value) return;
      const id = overlays.getHoveredDrawingId();
      if (!id) return;
      const d = overlays.getDrawing(id);
      if (!d || d.lock) return;
      overlays.placeDrawing({
        name: d.name,
        points: d.points,
        styles: d.styles,
        visible: d.visible,
        zLevel: d.zLevel,
        extendData: d.extendData,
      });
    };

    // --- Measure ruler (TradingView-style) ---
    // A transient two-point overlay drawn by CLICK, like the Draw-menu tools: arm it
    // (ruler button, or hold Shift), click to set the start, move, click to set the
    // end. klinecharts collects the two anchors — no press-drag. On completion the
    // box freezes and the tool disarms (one-shot). The frozen box is discarded on the
    // next plain press, Esc, or a symbol/interval change. Nothing is persisted.
    //
    // Arming and the draw are wired to the measureArmed signal in a separate effect
    // (subscribe → startMeasureDraw; measureDone → disarm). These two capture-phase
    // presses are the remaining pieces: reserve a Shift press for measuring, and
    // clear a frozen box on a plain press. Neither stops propagation — klinecharts
    // must still receive the press to place the anchor. Registered FIRST so arming
    // via Shift flips measureArmed before the line/clone/anchor handlers run (they
    // bail while measuring), keeping every placing click for the ruler.
    const onMeasureShift = (e: MouseEvent) => {
      if (e.button !== 0 || !e.shiftKey) return;
      if (measureArmed.value || overlays.isMeasureDrawing()) return;
      // The price-axis strip is a scale gesture, not a measurement.
      const c = chartRef.current;
      const mainW = c?.getSize("candle_pane", 'main')?.width ?? Infinity;
      if (e.clientX - el.getBoundingClientRect().left > mainW) return;
      measureArmed.set(true); // → startMeasureDraw() synchronously; THIS click sets the start
    };
    const onMeasureClear = (e: MouseEvent) => {
      if (e.button !== 0 || e.shiftKey) return;
      // Only a plain press with a FROZEN box (not armed, not mid-draw) clears it.
      if (measureArmed.value || overlays.isMeasureDrawing()) return;
      if (overlays.hasMeasure()) overlays.clearMeasure();
    };

    // --- Slope tool interactive handles ---
    // Unlike the measure box, a placed slope line STAYS live: press-drag its endpoints
    // (reshape), its midpoint (translate, keeping length + angle), or the rotate knob
    // (swing both ends around the midpoint pivot; Shift snaps to 15°). We drive all of
    // this ourselves — the overlay's figures are inert (ignoreEvent) — hit-testing the
    // cursor against the handle pixels via the shared slopeHandles geometry and pushing
    // the new data-space points back through overlays.updateSlope. Capture-phase and
    // stopPropagation so a handle grab pre-empts klinecharts' pan. While the tool is
    // still ARMED/placing we bail, leaving those clicks for klinecharts to place anchors.
    let slopeDragCleanup: (() => void) | null = null;
    const slopeHandlePixels = (): { a: { x: number; y: number }; b: { x: number; y: number } } | null => {
      const c = chartRef.current;
      if (!c) return null;
      const pts = overlays.getSlopePoints();
      if (!pts || pts.length < 2) return null;
      const toPix = (p: { timestamp?: number; value?: number; dataIndex?: number }) =>
        first(c.convertToPixel([{ timestamp: p.timestamp, value: p.value, dataIndex: p.dataIndex }], { paneId: "candle_pane", absolute: true }));
      const a = toPix(pts[0]);
      const b = toPix(pts[1]);
      if (a.x == null || a.y == null || b.x == null || b.y == null) return null;
      return { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
    };
    const beginSlopeDrag = (
      grab: SlopeGrab,
      a0: { x: number; y: number },
      b0: { x: number; y: number },
      startPx: { x: number; y: number },
    ) => {
      const pivot = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
      const va = { x: a0.x - pivot.x, y: a0.y - pivot.y };
      const vb = { x: b0.x - pivot.x, y: b0.y - pivot.y };
      const grabAngle = Math.atan2(startPx.y - pivot.y, startPx.x - pivot.x);
      const origLineAngle = Math.atan2(b0.y - a0.y, b0.x - a0.x);
      const SNAP = (15 * Math.PI) / 180;
      const onMove = (ev: MouseEvent) => {
        const c = chartRef.current;
        if (!c) return;
        const r = el.getBoundingClientRect();
        const cur = { x: ev.clientX - r.left, y: ev.clientY - r.top };
        let na = a0;
        let nb = b0;
        if (grab === "a") {
          na = cur;
        } else if (grab === "b") {
          nb = cur;
        } else if (grab === "mid") {
          const dx = cur.x - startPx.x;
          const dy = cur.y - startPx.y;
          na = { x: a0.x + dx, y: a0.y + dy };
          nb = { x: b0.x + dx, y: b0.y + dy };
        } else {
          // knob: rotate both ends around the midpoint by how far the cursor swept.
          // Relative — starts at zero delta on grab, so there's no jump.
          let delta = Math.atan2(cur.y - pivot.y, cur.x - pivot.x) - grabAngle;
          if (ev.shiftKey) {
            const target = origLineAngle + delta;
            delta = Math.round(target / SNAP) * SNAP - origLineAngle;
          }
          const cos = Math.cos(delta);
          const sin = Math.sin(delta);
          const rot = (v: { x: number; y: number }) => ({
            x: pivot.x + v.x * cos - v.y * sin,
            y: pivot.y + v.x * sin + v.y * cos,
          });
          na = rot(va);
          nb = rot(vb);
        }
        const da = first(c.convertFromPixel([{ x: na.x, y: na.y }], { paneId: "candle_pane", absolute: true }));
        const db = first(c.convertFromPixel([{ x: nb.x, y: nb.y }], { paneId: "candle_pane", absolute: true }));
        if (da.value == null || db.value == null) return;
        // Magnet: snap the ENDPOINT being dragged to the nearest bar OHLC (weak = within
        // the px band; strong = always; Ctrl/Cmd inverts). Only endpoints snap — a
        // midpoint-translate or rotate preserves geometry, so snapping would fight it.
        let av = da.value;
        let bv = db.value;
        const mode = effectiveMagnetMode();
        if (mode !== "normal" && (grab === "a" || grab === "b")) {
          const idx = grab === "a" ? da.dataIndex : db.dataIndex;
          const bar = idx != null ? c.getDataList()[idx] : undefined;
          if (bar) {
            const cands = [bar.open, bar.high, bar.low, bar.close].map((price) => ({
              price,
              py: first(c.convertToPixel([{ dataIndex: idx, value: price }], { paneId: "candle_pane", absolute: true })).y ?? 0,
            }));
            const cursorPy = grab === "a" ? na.y : nb.y;
            if (grab === "a") av = snapSlopeEndpoint(da.value, cursorPy, cands, mode);
            else bv = snapSlopeEndpoint(db.value, cursorPy, cands, mode);
          }
        }
        overlays.updateSlope([
          { timestamp: da.timestamp, value: av, dataIndex: da.dataIndex },
          { timestamp: db.timestamp, value: bv, dataIndex: db.dataIndex },
        ]);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp, true);
        slopeDragCleanup = null;
        // Swallow the trailing click so it can't fall through to a plain click handler.
        justDraggedRef.current = true;
        setTimeout(() => { justDraggedRef.current = false; }, 0);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp, true);
      slopeDragCleanup = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp, true);
        slopeDragCleanup = null;
      };
    };
    const onSlopeHandleDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      // Still placing the anchors → let the click reach klinecharts.
      if (slopeArmed.value || overlays.isSlopeDrawing()) return;
      if (!overlays.hasSlope()) return;
      const px = slopeHandlePixels();
      if (!px) return;
      const r = el.getBoundingClientRect();
      const cur = { x: e.clientX - r.left, y: e.clientY - r.top };
      const grab = hitSlopeHandle(px.a, px.b, cur);
      if (!grab) return;
      e.preventDefault();
      e.stopPropagation();
      beginSlopeDrag(grab, px.a, px.b, cur);
    };

    // --- Pick Range (backtest) ---
    // Armed from the backtest panel (rangePickArmed). While armed, selecting a time
    // range shades a full-height band (live), and on completion publishes
    // [fromMs,toMs] on rangePickResult and disarms (one-shot). Two gestures, like
    // TradingView's measure: PRESS-DRAG (down → drag → release) OR CLICK-MOVE-CLICK
    // (click to set the start, move the cursor to size it, click again to end).
    // Chart scroll/zoom are disabled while armed, so this owns the gesture — it runs
    // FIRST among the capture mousedowns and stops propagation so the line-drag /
    // clone / anchor handlers don't also fire.
    let rangePickDragCleanup: (() => void) | null = null;
    // "idle" = not selecting; "drag" = between press and release; "track" = after a
    // click with no drag, the cursor now sizes the band until the next click.
    let rangePickPhase: "idle" | "drag" | "track" = "idle";
    let rangePickDownX = 0;
    let rangePickMoved = false;
    // Timestamp at an absolute page x, clamped into whitespace to the nearest end
    // bar (a range to "now" ends past the last bar, where convertFromPixel is null).
    const rangePickTsAtX = (clientX: number): number | null => {
      const c = chartRef.current;
      if (!c) return null;
      const r = c.convertFromPixel([{ x: clientX }], { paneId: "candle_pane", absolute: true });
      const p = Array.isArray(r) ? r[0] : r;
      if (p && typeof p.timestamp === "number") return p.timestamp;
      // convertFromPixel is null in the whitespace past either end — snap to that
      // end bar (a range to "now" ends past the last bar). Only snap when x is
      // genuinely beyond an end; an in-range null (transient during layout) returns
      // null so the caller skips it rather than jumping the band to an edge.
      const data = c.getDataList();
      if (!data.length) return null;
      const lastTs = data[data.length - 1].timestamp;
      const firstTs = data[0].timestamp;
      const xOf = (ts: number): number | null => {
        const q = c.convertToPixel([{ timestamp: ts }], { paneId: "candle_pane", absolute: true });
        const qp = Array.isArray(q) ? q[0] : q;
        return qp && typeof qp.x === "number" ? qp.x : null;
      };
      const lastX = xOf(lastTs);
      if (lastX != null && clientX > lastX) return lastTs;
      const firstX = xOf(firstTs);
      if (firstX != null && clientX < firstX) return firstTs;
      return null;
    };
    const rangePickFinalize = (endTs: number | null) => {
      if (endTs != null) overlays.updateRangePick(endTs);
      const res = overlays.finishRangePick(); // null if no real range (start === end)
      if (res) rangePickResult.set(res);
      rangePickDragCleanup?.();
      rangePickDragCleanup = null;
      rangePickPhase = "idle";
      rangePickArmed.set(false); // one-shot: disarm after a pick
    };
    const onRangePickMove = (me: MouseEvent) => {
      const ts = rangePickTsAtX(me.clientX);
      if (ts == null) return;
      if (Math.abs(me.clientX - rangePickDownX) > 4) rangePickMoved = true;
      overlays.updateRangePick(ts);
    };
    const onRangePickUp = (ue: MouseEvent) => {
      window.removeEventListener("mouseup", onRangePickUp, true);
      if (rangePickPhase !== "drag") return;
      if (rangePickMoved) {
        rangePickFinalize(rangePickTsAtX(ue.clientX)); // press-drag: release ends it
      } else {
        rangePickPhase = "track"; // a click: cursor now sizes it (onMove stays), next click ends
      }
    };
    const onRangePickDown = (e: MouseEvent) => {
      if (!rangePickArmed.value || e.button !== 0) return;
      const c = chartRef.current;
      const mainW = c?.getSize("candle_pane", 'main')?.width ?? Infinity;
      if (e.clientX - el.getBoundingClientRect().left > mainW) return; // price-axis strip
      // Second click of a click-move-click ends the selection here.
      if (rangePickPhase === "track") {
        e.preventDefault();
        e.stopImmediatePropagation();
        rangePickFinalize(rangePickTsAtX(e.clientX));
        return;
      }
      const startTs = rangePickTsAtX(e.clientX);
      if (startTs == null) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // Pick Range owns this gesture
      overlays.startRangePick(startTs);
      rangePickPhase = "drag";
      rangePickDownX = e.clientX;
      rangePickMoved = false;
      window.addEventListener("mousemove", onRangePickMove, true);
      window.addEventListener("mouseup", onRangePickUp, true);
      rangePickDragCleanup = () => {
        window.removeEventListener("mousemove", onRangePickMove, true);
        window.removeEventListener("mouseup", onRangePickUp, true);
      };
    };

    // TradingView-style "A" auto-scale: pressing on the price-axis column (the
    // strip right of the candle pane) is a manual y-axis scale gesture, so it
    // exits auto mode and the toolbar "A" de-highlights. Re-enabled by clicking
    // "A" (Toolbar.autoFit). Capture phase so it sees the press before the chart.
    // True when the pointer x is within the price-axis column (right of the
    // candle pane's main area). Shared by the press (exit auto) and double-click
    // (re-enter auto) handlers below.
    const overPriceAxis = (e: MouseEvent): boolean => {
      const c = chartRef.current;
      const mainW = c?.getSize("candle_pane", 'main')?.width ?? 0;
      if (!mainW) return false;
      return e.clientX - el.getBoundingClientRect().left > mainW;
    };
    const onAxisDown = (e: MouseEvent) => {
      if (e.button !== 0 || !autoScale.value) return;
      if (measureArmed.value || overlays.isMeasureDrawing()) return; // measuring owns the press
      if (slopeArmed.value || overlays.isSlopeDrawing()) return; // slope placing owns the press
      if (overPriceAxis(e)) autoScale.set(false);
    };
    // Double-clicking the price-axis column resets to auto-scale (TV behaviour):
    // re-fit the price axis and re-highlight the toolbar "A".
    const onAxisDblClick = (e: MouseEvent) => {
      if (e.button !== 0 || !overPriceAxis(e)) return;
      // Re-applying the current y-axis kind recomputes the fit, clearing any
      // manual zoom (matches Toolbar.autoFit). v10: overrideYAxis resets the
      // axis auto-calc flag; the kind is the y-axis `name`.
      const c = chartRef.current;
      const name = c?.getYAxes({ paneId: "candle_pane" })[0]?.name ?? "normal";
      c?.overrideYAxis({ paneId: "candle_pane", name });
      autoScale.set(true);
    };
    // True when the pointer y is within the time-axis strip (below the candle
    // pane's main area). Mirrors overPriceAxis but for the bottom edge.
    const overTimeAxis = (e: MouseEvent): boolean => {
      const c = chartRef.current;
      const xAxisH = c?.getSize("x_axis_pane", 'root')?.height ?? 0;
      if (!xAxisH) return false;
      const rect = el.getBoundingClientRect();
      return e.clientY - rect.top > rect.height - xAxisH;
    };
    // Double-clicking the time-axis strip resets the bar spacing to its
    // default (TV behaviour) WITHOUT moving the view — mirrors onAxisDblClick,
    // which only re-fits the price axis and never pans it either. Anchored at
    // the pane's right edge (matching plain setBarSpace's natural anchor, which
    // holds the right-offset fixed) via zoomAtCoordinate rather than
    // chart.setBarSpace directly: setBarSpace never fires klinecharts'
    // 'onZoom', so the lock-charts date-range sync below (subscribed
    // to OnZoom/OnScroll) would silently fail to mirror this reset to sibling
    // cells. zoomAtCoordinate goes through the same zoom() path a wheel-zoom
    // gesture does, so it fires OnZoom like any other zoom.
    const onTimeAxisDblClick = (e: MouseEvent) => {
      if (e.button !== 0 || !overTimeAxis(e)) return;
      const c = chartRef.current;
      const cur = c?.getBarSpace().bar;
      const mainW = c?.getSize("candle_pane", 'main')?.width;
      if (!c || !cur || !mainW) return;
      c.zoomAtCoordinate(DEFAULT_BAR_SPACE / cur, { x: mainW, y: 0 });
    };

    // A removed indicator (legend trash icon) must drop its selection, or a
    // re-added same-name indicator would appear pre-selected.
    const unsubRemoved = indicatorRemoved.subscribe((name) => {
      if (selectedIndicator.value?.name === name) {
        selectedIndicator.set(null);
        repaint();
      }
    });

    // The "+" crosshair pointer handlers (onMove / onLeave) — the price-guide
    // affordance, magnet snap, curve/trade-line hover, and native-crosshair
    // suppression — now live in chart/usePointerCrosshair.ts, which attaches them
    // on wrapRef/containerRef in its own effect (called after this init effect +
    // useLineDrag below, so the chart exists).
    const unsubAnchor = avwapAnchorMode.subscribe((id) => setAnchoring(id != null));
    // Arm/draw the measure ruler off the measureArmed signal: arming starts the
    // interactive draw (click/drag to place the two anchors); disarming mid-draw
    // cancels it; measureDone disarms the one-shot after completion. Also drives the
    // crosshair cursor (measureArmedUi).
    const unsubMeasureArm = measureArmed.subscribe((on) => {
      setMeasureArmedUi(on);
      if (on) {
        overlays.startMeasureDraw();
        // Focus the cell so Esc reaches onKeyDown even when arming came from the
        // toolbar button (which would otherwise hold focus) — Esc must always cancel.
        wrapRef.current?.focus({ preventScroll: true });
      } else if (overlays.isMeasureDrawing()) {
        overlays.clearMeasure(); // disarmed before finishing
      }
    });
    overlays.setMeasureDone(() => measureArmed.set(false));

    // Arm/draw the Slope tool off slopeArmed, mirroring measure: arming starts the
    // click-to-place draw and focuses the wrap (so Esc reaches onKeyDown); disarming
    // mid-draw cancels it; slopeDone disarms the one-shot once both anchors are placed
    // (the line then stays live for handle drags). Also drives the crosshair cursor.
    const unsubSlopeArm = slopeArmed.subscribe((on) => {
      setSlopeArmedUi(on);
      if (on) {
        overlays.startSlopeDraw();
        wrapRef.current?.focus({ preventScroll: true });
      } else if (overlays.isSlopeDrawing()) {
        overlays.clearSlope(); // disarmed before finishing
      }
    });
    overlays.setSlopeDone(() => slopeArmed.set(false));

    // Pick Range arm/disarm: toggle the crosshair cursor and disable chart
    // scroll/zoom while armed (so the press-drag selects a range instead of
    // panning), restoring both on disarm and clearing any half-drawn band.
    const unsubRangePickArm = rangePickArmed.subscribe((on) => {
      setRangePickArmedUi(on);
      const c = chartRef.current;
      if (on) {
        c?.setScrollEnabled(false);
        c?.setZoomEnabled(false);
        wrapRef.current?.focus({ preventScroll: true }); // so Esc reaches onKeyDown
      } else {
        rangePickDragCleanup?.();
        rangePickDragCleanup = null;
        rangePickPhase = "idle";
        if (overlays.hasRangePick()) overlays.clearRangePick();
        c?.setScrollEnabled(true);
        c?.setZoomEnabled(true);
      }
    });

    if (chart) {
      chart.setStyles(klineStyles(theme, legendHovered.value, crosshairRef.current, candleHiddenRef.current));
      el.addEventListener("click", onClick);
      el.addEventListener("dblclick", onDblClick); // alert-line -> edit; curve -> settings
      el.addEventListener("contextmenu", onContextMenu); // right-click -> Paste menu
      // Measure ruler FIRST among the capture-phase mousedowns: a Shift press flips
      // measureArmed here before the line/clone/anchor handlers run (they bail while
      // measuring), so every placing press is reserved for the ruler. Neither measure
      // handler stops propagation — klinecharts still needs the press to place a point.
      // Pick Range FIRST: when armed it owns the press (stopImmediatePropagation),
      // so the measure/line/clone/anchor handlers below never fire during a pick.
      el.addEventListener("mousedown", onRangePickDown, true);
      el.addEventListener("mousedown", onMeasureShift, true);
      el.addEventListener("mousedown", onMeasureClear, true);
      // Slope handles before the line/anchor/pan handlers: a grab on an endpoint /
      // midpoint / rotate knob owns the press (stopPropagation); a miss falls through.
      el.addEventListener("mousedown", onSlopeHandleDown, true);
      // onAnchorDown (AVWAP anchor) + onLineDown (trade/alert line drag) are now
      // attached by useLineDrag's own effect (capture-phase, on `el`) — placed AFTER
      // this init effect so they still register LAST among the capture-phase mousedowns.
      el.addEventListener("mousedown", onClonePress, true);
      el.addEventListener("mousedown", onAxisDown, true);
      el.addEventListener("dblclick", onAxisDblClick, true);
      el.addEventListener("dblclick", onTimeAxisDblClick, true);
      // The crosshair onMove/onLeave listeners (wrapRef mousemove+mouseleave and
      // containerRef mousemove) are now attached by usePointerCrosshair's own
      // effect (called after this init effect + useLineDrag).
      // Scroll-back pagination. klinecharts requests "Forward" (= older, prepended
      // to the left) when the user scrolls to the left edge. We answer with a
      // window of older bars; returning more=false stops further requests. Guards
      // prevent the old infinite loop (each prepend re-triggering a load).
      // NOTE: shares cursorSecRef/exhaustedRef/loadingRef with the quick-range walk
      // (ensureCoverageAndFit) — see its "DESIGN DEBT" comment before adding a third
      // paging consumer.
      dataFacade.onLoadRequest = (type, timestamp, done) => {
        if (type !== 'forward') {
          // Backward (newer) loads have no source here: v9 returned more=false.
          done([], false);
          return;
        }
        if (exhaustedRef.current || loadingRef.current || timestamp == null) {
          done([], !exhaustedRef.current);
          return;
        }
        const epic = epicRef.current;
        const resolution = resRef.current;
        const broker = brokerIdRef.current;
        const side = priceSideRef.current;
        const resSec = RESOLUTION_SECONDS[resolution] ?? 60;
        // Cap the per-page span. For high/derived timeframes PAGE_BARS*resSec is
        // enormous (a 1Y page = 500 years), and the backend folds that from DAY
        // base bars: Capital.get_candles would loop ~180 sequential requests for
        // one page, stalling the chart and tripping the breaker. Bounding the span
        // just makes pages smaller (more of them); it stays hole-free because the
        // cursor follows fromSec exactly. ~6yr keeps the base fetch to a few pages.
        const pageSpanSec = Math.min(PAGE_BARS * resSec, 6 * 365 * 86400);
        // scrollbackLoadOlder owns the mutex ordering and gap-crossing rules;
        // see its contract note in historyPaging.ts.
        void scrollbackLoadOlder<KLineData>({
          boundary: timestamp,
          resSec,
          pageBars: PAGE_BARS,
          maxPageSpanSec: pageSpanSec,
          // Time-based exhaustion budget with the window count as a floor; see
          // MAX_EMPTY_GAP_SEC.
          maxEmpty: Math.max(MAX_EMPTY_WINDOWS, Math.ceil(MAX_EMPTY_GAP_SEC / pageSpanSec)),
          cursorSec: cursorSecRef,
          emptyStreak: emptyStreakRef,
          exhausted: exhaustedRef,
          loading: loadingRef,
          // Stale once the series identity drifts mid-flight, the chart is torn
          // down, or a quick-range pick takes over paging (its coverage walk
          // owns the mutex; without this check an in-flight page here would
          // stomp cursorSecRef and prepend bars under the walk's merge).
          isStale: () =>
            !chartRef.current ||
            pendingRangeRef.current !== null ||
            epic !== epicRef.current ||
            resolution !== resRef.current ||
            broker !== brokerIdRef.current ||
            side !== priceSideRef.current,
          // fetchRangeStrict (not fetchRange): a non-2xx (503/504 from an open
          // broker breaker or a slow source) THROWS and is treated as a transient
          // "retry on next scroll", instead of being flattened to an empty page
          // that would count toward the exhaustion budget and permanently latch
          // exhaustedRef, walling scroll-back for the whole session over a
          // momentary broker hiccup. A genuine empty 200 (real gap / end of
          // history) still returns [] and does count toward exhaustion.
          fetchOlder: (fromSec, toSec) =>
            fetchRangeStrict(epic, resolution, fromSec, toSec, side, broker),
          // A Forward load's prepend: klinecharts' own updatePointPosition shifts
          // dataIndex-only overlay points by the prepend size, so do NOT shift
          // them again (see applyOlderBars for the INIT-type path).
          done,
          // Extend any HTF EMA/MA overlay back over the newly-loaded range so
          // the MTF curve doesn't stop where the older bars begin. `fresh[0]`
          // is the new global oldest (explicit, because klinecharts may not have
          // merged the prepend into getDataList yet).
          onFresh: (fresh) => extendMtfCoverage(fresh[0].timestamp),
        });
      };
      overlays.attach(chart, dataFacade);
      // On-chart trade lines for this cell. Subscribes to the shared trades poll
      // AND pending drags, and redraws (filtered to THIS cell's epic, pending
      // merged over server levels) on every update. Bound to this chart instance,
      // so it lives and dies with the chart (remount-safe). Stage 2 renders
      // read-only; drag/edit wiring lands in Stage 3.
      const posLines = new PositionLines(chart, precisionRef.current, (hovering) =>
        containerRef.current?.classList.toggle("trade-line-grab", hovering),
      );
      posLinesRef.current = posLines;
      // A dropped line stages a pending edit (merged over server level so the
      // poll can't snap it back). The panel shows a combined Apply/Cancel.
      const onDrag = (
        id: string,
        field: "price" | "stop" | "takeProfit",
        level: number,
      ) => {
        // A line drag ends with a trailing DOM click; swallow it (same flag AVWAP
        // uses) so it doesn't toggle the trade's selection back off. A PURE click on
        // a line fires no onDrag, so click-to-select still works.
        justDraggedRef.current = true;
        if (id === DRAFT_ID) {
          // Dragging a draft line just sets that value (Submit commits it).
          const d = draftOrderSignal.value;
          if (d) draftOrderSignal.set({ ...d, [field]: level });
          return;
        }
        const cur = pendingEditsSignal.value;
        pendingEditsSignal.set({ ...cur, [id]: { ...cur[id], [field]: level } });
        // Confirm mode: dragging a line selects its trade AND focuses the dragged line
        // (so Apply/Discard land on THAT line's pill) — but openPanel=false, so a DRAG
        // never opens the edit ticket (only an explicit double-click does). No-confirm
        // mode leaves selection alone so the dock's auto-apply effect commits the drag at
        // once (selecting would mark it editId and exclude it).
        if (confirmLineEditsRef.current) {
          setTradeSelected(id, field === "takeProfit" ? "tp" : field, false);
        }
      };
      const drawPositions = () => {
        if (isSynthetic(epicRef.current)) return; // analysis-only: no trade lines
        // Sidebar eye menu "Hide positions and orders": master-hide clears every
        // line (render([]) removes the previously-rendered ones) instead of
        // building specs from the (unaffected) underlying trade state.
        posLines.render(
          controller.positionsHidden.value || snapViewRef.current
            ? []
            : tradeLineSpecs({
                trades: tradesRef.current,
                pending: pendingRef.current,
                epic: epicRef.current,
                precision: precisionRef.current,
                levelsDraggable: true,
                onDrag,
                draft: draftRef.current,
                hidden: new Set(tradeUiRef.current.hidden),
                hovered: tradeUiRef.current.hovered,
                selected: tradeUiRef.current.selected,
                dragging: draggingTradeRef.current,
                selectedField: tradeUiRef.current.selectedField,
                // Always-on DOM pills carry the labels now — blank the canvas text so the
                // two don't double up; just the bare lines are drawn here.
                hideTradeLabels: true,
              }),
        );
      };
      handle.posDrawRef.current = drawPositions;
      // Live trade markers (entry per open position, exit per journaled close),
      // reusing the backtest fill glyph. Redraw on the same trades/journal updates
      // that drive the position lines, filtered to this cell's epic. Native
      // timestamp-anchored overlays reproject themselves on pan/zoom, so — unlike
      // the coarse-TF aggregate pills — they need no per-frame projection loop.
      // Marker clicks are inert while AVWAP anchor placement is armed — that
      // click is placing the anchor, not selecting the position under it.
      const tradeMarkers = new TradeMarkers(chart, () => avwapAnchorMode.value != null);
      tradeMarkersRef.current = tradeMarkers;
      const drawTradeMarkers = () => {
        if (isSynthetic(epicRef.current)) {
          tradeMarkers.render([]); // analysis-only: no trade markers
          exitClustersRef.current = [];
          return;
        }
        const bars = chart.getDataList() ?? [];
        const oldestLoadedMs = bars[0]?.timestamp ?? null;
        const opts = {
          trades: tradesRef.current,
          journal: journalRef.current,
          epic: epicRef.current,
          precision: precisionRef.current,
          oldestLoadedMs,
        };
        // The entry arrow is always native (one netted position per epic can't
        // collide). Exits collide on a coarse view — bucket them per bar and, if
        // any bar packs ≥2 closes, draw one aggregate pill per bar instead of
        // per-fill arrows (mirrors the backtest's native/aggregate render gate,
        // but data-driven since live markers have no fixed native timeframe).
        const entry = entryMarkerSpecs(opts);
        const clusters = aggregateExitsByBar(
          journalRef.current,
          epicRef.current,
          bars.map((k) => ({ timestamp: k.timestamp, high: k.high })),
        );
        if (exitsCollide(clusters)) {
          tradeMarkers.render(entry); // exits go to the DOM pill layer, not arrows
          exitClustersRef.current = clusters;
        } else {
          tradeMarkers.render([...entry, ...exitMarkerSpecs(opts)]);
          exitClustersRef.current = [];
        }
      };
      tradeMarkersDrawRef.current = drawTradeMarkers;
      const unsubTrades = subscribeTrades((t) => {
        tradesRef.current = t;
        drawPositions();
        drawTradeMarkers();
        handle.redrawRef.current(); // refresh the selected-trade pill (label/uPnL/levels)
      });
      const unsubJournal = journalSignal.subscribe((j) => {
        journalRef.current = j;
        drawTradeMarkers();
        handle.redrawRef.current(); // re-project the coarse-TF exit pills
      });
      const unsubPending = pendingEditsSignal.subscribe((p) => {
        pendingRef.current = p;
        drawPositions(); // move the line now (cheap — reconciles just the changed line)
        // Coalesce the heavier overlay redraw (pill follow + P/L + selection canvas)
        // to one per frame: a line drag restages pending every mousemove, and redrawing
        // the whole overlay per pixel is wasteful (and laggy on slower machines).
        if (pendingRedrawRafRef.current) return;
        pendingRedrawRafRef.current = requestAnimationFrame(() => {
          pendingRedrawRafRef.current = 0;
          handle.redrawRef.current();
        });
      });
      const unsubDraft = draftOrderSignal.subscribe((d) => {
        draftRef.current = d;
        drawPositions();
        handle.paintBracketRef.current(); // the bracket follows the draft's SL/TP too
      });
      const unsubConfirm = confirmLineEditsSignal.subscribe((v) => {
        confirmLineEditsRef.current = v;
      });
      const unsubTradeUi = tradeLineUiSignal.subscribe((ui) => {
        const prevSelected = tradeUiRef.current.selected;
        const prevField = tradeUiRef.current.selectedField;
        const selectedChanged = ui.selected !== prevSelected;
        const fieldChanged = ui.selectedField !== prevField;
        tradeUiRef.current = ui;
        // Trade selection is mutually exclusive with this cell's alert/drawing/
        // indicator selection. We clear here (not only in onClick) so selecting a
        // trade via a DOCK ROW — whose click never reaches the chart's onClick —
        // still drops the chart's other selection. Guard on the transition TO a
        // non-null selection so a pure hover update doesn't re-clear every move.
        if (ui.selected && selectedChanged) {
          overlays.selectAlert(null);
          overlays.selectDrawing(null);
          if (selectedIndicator.value) selectedIndicator.set(null);
        }
        drawPositions();
        // Re-anchor / show / hide the active-line pill when the selected TRADE or the
        // focused LINE changes — not on every hover tick. Freeze the pill's x at the
        // cursor only on a new trade selection; clear it on deselect.
        if (selectedChanged) {
          if (ui.selected) freezeTradePillX();
          else tradePillLeftRef.current = null;
        }
        if (selectedChanged || fieldChanged) handle.redrawRef.current();
        // Keep the focused pill (z-order) in sync when selection changes without a mouse
        // move — e.g. selecting a trade from its dock row. Selected line wins, else hover.
        {
          const fId = ui.selected ?? ui.hovered;
          const fField = ui.selected != null ? ui.selectedField : hoveredFieldRef.current;
          setFocusedPillKey(fId ? `${fId}:${fField}` : null);
        }
      });
      // The bracket now keys off EDIT state, which lives in its own signals — repaint it
      // when the edit ticket opens/closes or its target changes (e.g. Cancel sets
      // tradePanelOpen=false without a tradeLineUiSignal change).
      const unsubEditOpen = tradePanelOpen.subscribe(() => handle.paintBracketRef.current());
      const unsubEditId = editTradeSignal.subscribe(() => handle.paintBracketRef.current());
      // Sidebar eye menu "Hide positions and orders" toggle: re-run drawPositions
      // (which reads controller.positionsHidden.value itself, above).
      positionsHiddenRef.current = controller.positionsHidden.value;
      const unsubPositionsHidden = controller.positionsHidden.subscribe((h) => {
        positionsHiddenRef.current = h;
        drawPositions();
        handle.redrawRef.current(); // pills follow the same show/hide
      });
      posUnsubRef.current = () => {
        unsubTrades();
        unsubJournal();
        unsubPending();
        unsubDraft();
        unsubConfirm();
        unsubTradeUi();
        unsubEditOpen();
        unsubEditId();
        unsubPositionsHidden();
        if (pendingRedrawRafRef.current) {
          cancelAnimationFrame(pendingRedrawRafRef.current);
          pendingRedrawRafRef.current = 0;
        }
      };
      // Prime precision synchronously at attach so alert-level rounding never sees a
      // null precision: fetchPrecision() resolves async, and an alert created/edited in
      // that window would otherwise be stored/read raw. effPrecision already has a
      // synchronous fallback (symbol.pricePrecision ?? 2); the async fetch refines it.
      overlays.setPricePrecision(effPrecision);
      controller.chart = chart;
      // Let outside chrome (DrawSidebar) hand keyboard focus to this cell after
      // arming a drawing tool, so Esc-cancel reaches onKeyDown (same reason the
      // measure arm subscription focuses the wrap above).
      controller.focusChart = () => wrapRef.current?.focus({ preventScroll: true });
      // Let a template apply (templates.ts writes drawings + rehydrates outside
      // this component) request the anchor-coverage walk, so a template drawing
      // anchored before the loaded window doesn't render clamped to the left edge.
      controller.coverDrawingAnchors = () => handle.ensureAnchorCoverageRef.current();
      // Let the backtest trades panel page an out-of-window trade in before
      // scrolling to it (see coverBacktestTradeTo). Registered per-chart so the
      // panel's selection subscription — which only holds the Chart — can reach it.
      controller.coverBacktestTradeTo = (fromTs) => coverBacktestTradeTo(fromTs);
      registerBacktestPager(chart, (fromTs) => coverBacktestTradeTo(fromTs));
      // Hydrate this cell's saved indicators synchronously on chart-ready (they
      // recalc once data arrives). Done here — not after the async data fetch — so
      // the focused Toolbar reflects them immediately on mount / tab switch, and
      // non-focused cells get them too (the Toolbar binds only to the focused cell).
      controller.indicators.set(hydrateIndicators(chart, scope, symbol.epic));
      // e2e verify hook: a per-cell registry plus a focused alias. Tests that
      // predate multi-cell use `__chart`; multi-cell tests index `__charts`.
      const w = window as unknown as { __chart?: Chart; __charts?: Map<string, Chart> };
      (w.__charts ??= new Map()).set(cellId, chart);
      w.__chart = chart;
      onReady?.(cellId, chart, controller);
    }
    return () => {
      wsRef.current?.close();
      unsubAnchor();
      unsubMeasureArm();
      unsubSlopeArm();
      unsubRangePickArm();
      rangePickDragCleanup?.();
      slopeDragCleanup?.(); // drop an in-flight slope handle drag's window listeners
      overlays.setMeasureDone(null);
      overlays.setSlopeDone(null);
      unsubRemoved();
      // Backtest chart-sync subscriptions (highlightTradeSignal/focusTradeSignal)
      // strongly capture this chart + its BacktestResult — release them on unmount
      // so a detached/closed cell can be GC'd (no-op if none ran). Teardown only:
      // the persisted result must survive so a reopened cell can rehydrate it.
      teardownArtifacts(chart);
      el.removeEventListener("click", onClick);
      el.removeEventListener("dblclick", onDblClick);
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("mousedown", onRangePickDown, true);
      el.removeEventListener("mousedown", onMeasureShift, true);
      el.removeEventListener("mousedown", onMeasureClear, true);
      el.removeEventListener("mousedown", onSlopeHandleDown, true);
      // onAnchorDown / onLineDown detach + the in-flight line-drag dispose + the
      // anchor window listeners are all handled by useLineDrag's own effect cleanup.
      el.removeEventListener("mousedown", onClonePress, true);
      el.removeEventListener("mousedown", onAxisDown, true);
      el.removeEventListener("dblclick", onAxisDblClick, true);
      el.removeEventListener("dblclick", onTimeAxisDblClick, true);
      // The crosshair onMove/onLeave listeners are detached by
      // usePointerCrosshair's own effect cleanup.
      posUnsubRef.current();
      posUnsubRef.current = () => {};
      posLinesRef.current?.clear();
      posLinesRef.current = null;
      handle.posDrawRef.current = () => {};
      overlays.detach();
      controller.chart = null;
      controller.focusChart = null;
      controller.coverDrawingAnchors = null;
      controller.coverBacktestTradeTo = null;
      registerBacktestPager(chart, null);
      const w = window as unknown as { __charts?: Map<string, Chart> };
      w.__charts?.delete(cellId);
      if (el) dispose(el);
      chartRef.current = null;
      inited.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AVWAP anchor drag + trade/alert horizontal-line drag. Attaches its own
  // capture-phase mousedown listeners on the container in its own effect — placed
  // AFTER the init effect above so onAnchorDown/onLineDown still register LAST among
  // the capture-phase mousedowns (preserving the measure/rangePick/slope precedence).
  useLineDrag(handle, {
    containerRef,
    scope,
    avwapAnchorMode,
    measureArmed,
    slopeArmed,
    selectedIndicator,
    overlays,
    ANCHOR_GRAB_PX,
    precisionRef,
    confirmLineEditsRef,
    cursorModeRef,
    draggingAnchorRef,
    dragMovedRef,
    justDraggedRef,
    anchorPxRef,
    pendingAnchorXRef,
    anchorRafRef,
    draggingTradeRef,
    setCursorMode,
    setTradeSelectedFn: setTradeSelected,
    tradeLinePixelsRef,
    tradeDragActiveRef,
    alertDragActiveRef,
  });

  // The "+" crosshair pointer handlers (onMove / onLeave). Attaches its own
  // mousemove/mouseleave listeners on wrapRef + containerRef in its own effect —
  // placed AFTER the init effect + useLineDrag so the chart exists. Reads the two
  // init-effect-local bridges (tradeLinePixelsRef, alertHitTestRef) and the
  // drag-active bridges useLineDrag assigns (tradeDragActiveRef/alertDragActiveRef).
  usePointerCrosshair(handle, {
    containerRef,
    wrapRef,
    avwapAnchorMode,
    curveHover,
    ANCHOR_GRAB_PX,
    precisionRef,
    cursorModeRef,
    draggingAnchorRef,
    anchorPxRef,
    lineCacheRef,
    pointerPxRef,
    pivotHoverKeyRef,
    plusCrosshairYRef,
    plusBtnRef,
    plusMenuOpenRef,
    plusPriceRef,
    plusPriceLabelRef,
    cursorXRef,
    onAxisRef,
    pillNodesRef,
    hoveredFieldRef,
    snapActiveRef,
    snapHoverRef,
    positionPill,
    tradePillHitTest,
    setCursorMode,
    setOnAxis,
    setTradeHovered,
    setHoveredPillKey,
    setHoveredPillRectKey,
    setFocusedPillKey,
    tradeLinePixelsRef,
    alertHitTestRef,
    tradeDragActiveRef,
    alertDragActiveRef,
  });

  // Theme / symbol / period / live-status changes -> restyle. The canvas legend
  // embeds the symbol (green while live), interval, and precision, so it must
  // re-apply on those too. crosshair (style/color/opacity) restyles here too so a
  // settings change shows at once instead of waiting for the next mouse move.
  useEffect(() => {
    chartRef.current?.setStyles(klineStyles(theme, legendHovered.value, crosshairRef.current, candleHiddenRef.current));
    // A full base-style re-apply resets priceMark.last.line.show to its default
    // (visible). If an alert is selected the last-price line must stay hidden, so
    // re-assert it here. lastPriceHiddenRef already reflects the desired state, so
    // a single re-apply keeps it in sync without waiting for the next redraw().
    if (lastPriceHiddenRef.current) {
      chartRef.current?.setStyles({ candle: { priceMark: { last: { line: { show: false } } } } });
    }
  }, [theme, symbol.epic, effPrecision, period.label, status, crosshair]);

  // Resolve the epic's authoritative precision + open/closed status on symbol
  // change, then poll the status so the tab badge and price label flip when the
  // market closes (or reopens) while the chart stays open. One snapshot call
  // yields both (fetchMarketMeta); precision is stable so we only apply it once.
  //
  // Event-driven, NOT polled: fetch once for precision + the initial state, then
  // re-check only on an event —
  //   - closed market: a single re-check scheduled exactly at `nextOpen`;
  //   - open market: nothing, unless the live stream falls silent for a while (a
  //     possible close), then ONE fallback re-check confirms it.
  // A market that's ticking (even slowly) keeps the badge open with zero server
  // calls; a reopened market flips instantly on its first tick (stream handler).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only consulted while the stream is silent; an active stream never triggers it.
    const FALLBACK_MS = 180_000;
    setFetchedPrecision(null); // drop the previous epic's value while we re-resolve
    // Default to open on an in-cell symbol switch so a now-open symbol doesn't flash
    // "closed" until the first fetch resolves a round-trip later.
    setMarketClosed(false);
    if (isSynthetic(symbol.epic)) return; // synthetic: no market-status poll, never "closed"

    const schedule = (closed: boolean, nextOpen: string | null): void => {
      clearTimeout(timer);
      if (cancelled) return;
      if (closed && nextOpen) {
        // Re-check exactly when it should reopen — an event, not a poll.
        const ms = Math.min(Math.max(1000, Date.parse(nextOpen) - Date.now()), 2_000_000_000);
        timer = setTimeout(() => void recheck(false), ms);
        return;
      }
      // Open (or closed with no known reopen): re-check only if the stream goes
      // quiet — a ticking market needs no server call.
      const fallback = (): void => {
        if (cancelled) return;
        if (Date.now() - lastCandleAtRef.current < FALLBACK_MS) {
          if (marketClosedRef.current) setMarketClosed(false); // ticks ⇒ open
          timer = setTimeout(fallback, FALLBACK_MS);
        } else {
          void recheck(false); // silent for a while → confirm open/closed
        }
      };
      timer = setTimeout(fallback, FALLBACK_MS);
    };

    const recheck = async (wantPrecision: boolean): Promise<void> => {
      let meta: Awaited<ReturnType<typeof fetchMarketMeta>>;
      try {
        meta = await fetchMarketMeta(symbol.epic, brokerId);
      } catch {
        schedule(false, null); // transient: treat as open, re-arm the silence check
        return;
      }
      if (cancelled) return;
      if (wantPrecision && meta.pricePrecision != null) setFetchedPrecision(meta.pricePrecision);
      // null `closed` (failed lookup) is treated as open, so it never shows a live
      // market closed.
      const closed = meta.closed === true;
      setMarketClosed(closed);
      schedule(closed, meta.nextOpen);
    };

    void recheck(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [symbol.epic, brokerId]);

  // A market open/closed change must repaint the price pill (the redraw reads the
  // ref, so a re-render alone won't). The tab badge is sourced separately by an
  // App-level epic poll, so this cell only needs to refresh its own price label.
  useEffect(() => {
    handle.redrawRef.current();
  }, [marketClosed]);

  // Apply precision to the chart whenever it resolves (the async fetch lands after
  // the symbol/period effect declares the symbol at its initial precision). v10
  // carries precision on the symbol, so re-declare it; the facade serves stored
  // bars, so the getBars(init) this triggers just re-paints at the new decimals.
  useEffect(() => {
    dataFacadeRef.current?.setSymbol(epicRef.current, effPrecision, 0);
    overlays.setPricePrecision(effPrecision); // keep alert-level rounding in lockstep
    handle.redrawRef.current(); // re-place the price/bid/ask pills at the new decimals
    tradeMarkersDrawRef.current(); // entry labels carry the price at this precision
  }, [effPrecision]);

  // Timezone changes -> retime the axis ("" follows the browser), and rebucket the
  // Previous-period H/L lines in the same zone so their day/week/month/year steps
  // stay aligned with the axis date labels. PREV_HL has no calcParams, so we force
  // a recompute by re-applying its extendData (klinecharts reruns calc on override).
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    const resolved = timezone || browserTimezone();
    c.setTimezone(resolved);
    if (!setIndicatorTimezone(resolved)) return; // zone unchanged → nothing to redo
    const candlePane = getIndicatorsByPane(c).get("candle_pane");
    for (const [id, ind] of candlePane ?? []) {
      if (indTypeOf(ind) !== "PREV_HL") continue;
      c.overrideIndicator({ name: id, extendData: { ...(ind.extendData as object) } });
    }
  }, [timezone]);

  // Time-axis format changes -> re-register the formatter. setFormatter doesn't
  // force a repaint on its own, so nudge one via setStyles (same trick the
  // font-load path uses) to reformat the axis ticks + crosshair label at once.
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    const fmt = makeFormatDate(clock, dateFormat, showWeekday);
    c.setFormatter({ formatDate: fmt });
    c.setStyles(klineStyles(themeRef.current, legendHovered.value, crosshairRef.current, candleHiddenRef.current));
    // The full base-style re-apply un-hides the last-price line; if an alert is
    // selected it must stay hidden, so re-assert (see the theme effect's rationale).
    if (lastPriceHiddenRef.current) {
      c.setStyles({ candle: { priceMark: { last: { line: { show: false } } } } });
    }
    // Mirror klinecharts' dtf (same options) so our synced-crosshair label matches
    // the source chart's. "YYYY-MM-DD HH:mm" is the format klinecharts hands to
    // formatDate for the crosshair; makeFormatDate re-renders it per clock/date pref.
    let dtf: Intl.DateTimeFormat | null = null;
    try {
      dtf = new Intl.DateTimeFormat("en", {
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: timezone || browserTimezone(),
      });
    } catch {
      dtf = null;
    }
    crosshairLabelFmtRef.current = dtf
      ? (ts: number) =>
          fmt({ dateTimeFormat: dtf!, timestamp: ts, template: "YYYY-MM-DD HH:mm", type: "crosshair" })
      : () => "";
  }, [clock, dateFormat, showWeekday, timezone]);

  // Symbol / period changes -> reload history, (re)subscribe live, set scroll-back.
  // Extracted to chart/useLiveMarketData.ts; every value it read from this
  // closure is passed via `handle` or the deps object below.
  useLiveMarketData(handle, {
    symbol,
    brokerId,
    priceSide,
    period,
    scope,
    effPrecision,
    setStatus,
    setLastPrice,
    setHasData,
    setLoadError,
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
  });


  // Two independent hide gestures, each with its own live effect:
  //  • Sidebar eye menu "Hide indicators" — masks every indicator's curve IN PLACE
  //    (pane stays); re-derives visibility from intent + interval on toggle.
  //  • Double-click "hide bottom sub-panes" — COLLAPSES the sub-pane heights to ~0 so
  //    the candle pane reclaims the space (plain masking left an empty band). Captures
  //    prior heights on collapse; restores them on expand. A legend filter drops the
  //    collapsed panes' cards (see buildSubPaneLegends). resRef (not the closed-over
  //    period.resolution) is read live — this effect only re-runs when `controller`
  //    changes, same idiom as the scroll-back fetcher above (~2204).
  useEffect(() => {
    const unsubAll = controller.indicatorsHidden.subscribe(() => {
      if (chartRef.current)
        applyIndicatorVisibility(chartRef.current, resRef.current, controller.indicatorsHidden.value);
    });
    const unsubSub = controller.subPanesHidden.subscribe((hidden) => {
      const c = chartRef.current;
      if (!c) return;
      if (hidden) collapsedHeightsRef.current = collapseSubPanes(c);
      else expandSubPanes(c, collapsedHeightsRef.current);
      handle.redrawRef.current(); // refresh the DOM legends (drop/restore the sub-pane cards)
    });
    return () => {
      unsubAll();
      unsubSub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  // Candle-cache stats badge: poll this cell's own series on an interval, reset
  // to null immediately on series change so the badge never shows a stale
  // series' numbers while the new one's first poll is in flight.
  useEffect(() => {
    let cancelled = false;
    setCacheStats(null);
    const poll = () => {
      void fetchCandleCacheStats(symbol.epic, period.resolution, priceSide, brokerId).then(
        (s) => {
          if (!cancelled) setCacheStats(s);
        },
      );
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol.epic, period.resolution, priceSide, brokerId]);

  const cacheBadge = (() => {
    if (!cacheStats) return null;
    if (cacheStats.oldestTs == null) {
      return {
        label: "n/a",
        title: "No cache data yet for this series.",
        state: "none" as const,
      };
    }
    const ageSec = cacheStats.lastFetchTs != null ? Date.now() / 1000 - cacheStats.lastFetchTs : null;
    const fresh = ageSec != null && ageSec < 60;
    const days = Math.max(0, Math.round((cacheStats.newestTs! - cacheStats.oldestTs) / 86400));
    const total = cacheStats.hits + cacheStats.misses;
    const hitPct = total > 0 ? Math.round((cacheStats.hits / total) * 100) : null;
    return {
      label: hitPct != null ? `${hitPct}%` : "—",
      title: `Hit rate: ${hitPct != null ? `${hitPct}% (${cacheStats.hits}/${total})` : "n/a"} · Coverage: ${days}d · ${cacheStats.cachedBarCount} bars`,
      state: fresh ? ("fresh" as const) : ("stale" as const),
    };
  })();

  // The bar the legend should show values for: this cell's own crosshair when the
  // cursor is over it, else the bar holding a sibling's synced-crosshair timestamp
  // (last bar at-or-before it — the cells' intervals may differ), else null (the
  // legend then falls back to the last bar). Reads only refs, so it's safe to call
  // from any effect closure regardless of which render captured it.
  const legendBarIdx = (): number | null => {
    if (crosshairIdxRef.current != null) return crosshairIdxRef.current;
    const ts = syncCrosshairRef.current ? syncedTsRef.current : null;
    if (ts == null) return null;
    const data = chartRef.current?.getDataList();
    if (!data || data.length === 0 || ts < data[0].timestamp) return null;
    let lo = 0;
    let hi = data.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (data[m].timestamp <= ts) lo = m;
      else hi = m - 1;
    }
    return lo;
  };
  const legendBarIdxRef = useRef(legendBarIdx);
  legendBarIdxRef.current = legendBarIdx;

  // Paint the position CONNECTOR for the active trade/draft on its own canvas: a fixed
  // left-column spine linking the line's entry/SL/TP with a circle handle on each, and
  // the %/R:R badges to its LEFT. Cheap and React-free, so it runs on every mousemove
  // (hover gate) and from `redraw` (so it stays glued to its lines through scroll/zoom/
  // ticks and line drags). Appears on HOVER (grey spine, hovered handle outlined in its
  // colour) or SELECTION (position side colour, selected handle filled). Reads refs only.
  //
  // The master redraw loop + its two self-drawn painters (paintBracket, paintSeparator/
  // fmtSeparatorLabel) live in chart/useChartPaint.ts. It publishes onto the bridge refs
  // (handle.paintBracketRef / paintSeparatorRef / redrawRef) in render, and returns
  // `redraw` for the ChartCore effects that subscribe it to the 1s tick / scroll / zoom.
  const { redraw } = useChartPaint(handle, {
    setPriceTag,
    setBidTag,
    setAskTag,
    setAlertTags,
    setTradePills,
    setLegendRows,
    setSubPaneLegends,
    timezone,
    theme,
    containerRef,
    wrapRef,
    pillClipRef,
    bracketCanvasRef,
    maCanvasRef,
    sepCanvasRef,
    selCanvasRef,
    bracketShownRef,
    draggingTradeRef,
    hoveredFieldRef,
    marketClosedRef,
    statusRef,
    bidAskRef,
    bidAskStyleRef,
    lastPriceHiddenRef,
    lastActivePillIdRef,
    positionsHiddenRef,
    snapViewRef,
    sepCacheRef,
    lineCacheRef,
    pointerPxRef,
    plusCrosshairYRef,
    syncCrosshairRef,
    syncedTsRef,
    crosshairLabelFmtRef,
    curveLabelsRef,
    legendRowsSigRef,
    subPaneLegendsSigRef,
    legendHandleRef,
    legendBarIdxRef,
    exitClustersRef,
    precisionRef,
    themeRef,
    anchorPxRef,
    period,
  });


  // Apply a bid/ask display OR style change immediately (pills + lines) instead of
  // waiting for the next tick. redraw reads bidAskRef/bidAskStyleRef, kept current
  // above; the label colors come from the bidAskStyle prop in render. priceSide is
  // here too so hiding the redundant bid/ask side updates at once on a side switch.
  useEffect(() => {
    handle.redrawRef.current();
  }, [bidAsk, bidAskStyle, priceSide]);

  // 1s tick keeps the countdown live and tracks slow price/scroll drift.
  useEffect(() => {
    redraw();
    const id = setInterval(redraw, 1000);
    return () => clearInterval(id);
  }, [redraw, status, period.resolution]);

  // Redraw immediately when alerts change or the view scrolls/zooms/pane-drags.
  // OnPaneDrag fires while a separator between panes is dragged — without it the
  // sub-pane legend cards would lag ~1s (next tick) before snapping to the pane's new
  // top. A ResizeObserver on the container covers the other geometry shifts (window
  // resize, split-layout cell resize) that move pane positions without a chart action.
  useEffect(() => {
    overlays.setAlertsListener(redraw);
    const chart = chartRef.current;
    chart?.subscribeAction('onScroll', redraw);
    chart?.subscribeAction('onZoom', redraw);
    chart?.subscribeAction('onPaneDrag', redraw);
    // OnPaneDrag keeps the cards moving DURING the drag; the final mouseup frame can
    // settle the pane geometry without another action, so re-read after layout on
    // pointerup (rAF = post-layout). A ResizeObserver on the container catches the
    // remaining cases (window / split-cell resize) where panes move without a drag.
    const onPointerUp = () => requestAnimationFrame(() => handle.redrawRef.current());
    window.addEventListener("pointerup", onPointerUp);
    // Tell klinecharts to re-measure first, THEN redraw. On a split-layout switch
    // (e.g. 2h→1) the surviving cell keeps its id, so <ChartCore> is not remounted
    // — the chart instance persists with the old (narrower) container's internal
    // layout. Without resize(), it keeps the stale main-pane width and dumps the
    // extra space into the y-axis gutter (axis balloons to ~half the cell). resize()
    // refits the panes to the new width; redraw then reads fresh getSize() for the pills.
    const ro = new ResizeObserver(() => {
      chartRef.current?.resize();
      handle.redrawRef.current();
    });
    if (containerRef.current) ro.observe(containerRef.current);
    // The background alertEngine can fire/remove an alert on THIS (active) epic and
    // write the change to storage; reconcile the on-chart lines off the signal so a
    // "once" alert it deleted also vanishes from the chart.
    const unsubAlerts = alertsChanged.subscribe(() => overlays.reconcileAlerts());
    return () => {
      overlays.setAlertsListener(null);
      unsubAlerts();
      ro.disconnect();
      window.removeEventListener("pointerup", onPointerUp);
      chart?.unsubscribeAction('onScroll', redraw);
      chart?.unsubscribeAction('onZoom', redraw);
      chart?.unsubscribeAction('onPaneDrag', redraw);
    };
  }, [redraw]);

  // The DOM legend's values track the crosshair (TradingView-style): on each
  // crosshair change, remember the hovered bar index and push the values for that
  // bar imperatively (textContent). When the crosshair leaves the chart, klinecharts
  // fires with no dataIndex → fall back to the last bar (or to a sibling's synced
  // crosshair bar when the crosshair link is on). klinecharts already
  // rAF-throttles crosshair changes, and we only touch textContent (no re-render).
  useEffect(() => {
    const chart = chartRef.current;
    // v10 ActionCallback is (data?: unknown) => void. Unlike v9, the crosshair
    // change payload is the RAW crosshair ({ x, y, paneId }) — klinecharts builds
    // the enriched { dataIndex, timestamp, kLineData } into its internal _crosshair
    // but fires the action with the raw object (setCrosshair in index.esm.js). So
    // dataIndex is absent on hover; derive it from the pixel x, else the legend
    // would freeze on the last bar instead of tracking the cursor.
    const onCrosshair = (data?: unknown) => {
      const d = data as { dataIndex?: number; x?: number } | undefined;
      let idx = typeof d?.dataIndex === "number" ? d.dataIndex : null;
      if (idx == null && typeof d?.x === "number" && chart) {
        const p = chart.convertFromPixel([{ x: d.x, y: 0 }], { paneId: "candle_pane" });
        const di = (Array.isArray(p) ? p[0]?.dataIndex : p?.dataIndex);
        if (typeof di === "number") idx = di;
      }
      crosshairIdxRef.current = idx;
      // (The Pivots-High/Low Δ-label hover-enlarge is now driven by a real pixel
      // hit-test off the cursor position in usePointerCrosshair's onMove, not this
      // bar-change crosshair action — so no pivot-specific redraw is needed here.)
      // idx null (cursor left) falls through to a sibling's synced bar if one is
      // active, else to the last bar — same resolution as every other update site.
      legendHandleRef.current?.updateValues(legendBarIdxRef.current());
      // While the cursor is over THIS chart it's the link source, not a receiver, so
      // drop any sibling guide it was painting and repaint — otherwise that guide
      // stays frozen under this cell's own crosshair when the pointer crosses straight
      // from a sibling (which doesn't reliably fire its own "cursor left" event). Our
      // redraw isn't wired to crosshair changes, so clear it here explicitly.
      if (idx != null && syncedTsRef.current != null) {
        syncedTsRef.current = null;
        handle.redrawRef.current();
      }
      // Crosshair link: broadcast the hovered bar's timestamp to sibling cells (or
      // null when the cursor leaves this chart, so their guides clear).
      const dl = chart?.getDataList();
      const ts = idx != null && dl && dl[idx] ? dl[idx].timestamp : null;
      if (syncCrosshairRef.current) {
        chartSync.publish(tabIdRef.current, { sourceCellId: cellId, timestamp: ts });
      }
      // Lock: the alignment anchor FOLLOWS THE CURSOR. Hovering a bar makes it the
      // tab's anchor and re-aligns siblings live (no click needed) — only when the
      // hovered bar changes. On cursor-leave (ts null) the anchor stays put (sticky),
      // so a later pan/zoom keeps the last-hovered candle aligned. Skipped mid-drawing
      // so placing a drawing's points doesn't yank the other charts around.
      if (lockedRef.current && !overlays.isDrawing()) {
        if (ts == null) {
          lastHoverAnchorTsRef.current = null; // re-assert on the next hover
        } else if (ts !== lastHoverAnchorTsRef.current && chart) {
          lastHoverAnchorTsRef.current = ts;
          setGestureCell(cellId); // the hovered cell is the master → siblings can't echo
          setAlignAnchor(tabIdRef.current, ts);
          const r = readVisibleRange(chart);
          const exact = readExactAnchor(chart, ts);
          if (r && exact) {
            rangeSync.publish(tabIdRef.current, { sourceCellId: cellId, ...r, ...exact });
          }
        }
      }
    };
    chart?.subscribeAction('onCrosshairChange', onCrosshair);
    return () => chart?.unsubscribeAction('onCrosshairChange', onCrosshair);
  }, [cellId]);

  // Receive sibling cells' crosshair broadcasts for this tab and paint a vertical
  // time guide at the shared timestamp (cleared on null / when not linked).
  useEffect(() => {
    const unsub = chartSync.subscribe(tabId, (m) => {
      if (m.sourceCellId === cellId) return; // ignore our own broadcasts
      // A sibling broadcasting means the cursor is over THAT cell, so any crosshair
      // index we still hold is stale (crossing straight off this chart doesn't
      // reliably fire its "cursor left" event) — drop it or it would keep beating
      // the synced timestamp in legendBarIdx.
      crosshairIdxRef.current = null;
      const next = syncCrosshair ? m.timestamp : null;
      if (syncedTsRef.current === next) return;
      syncedTsRef.current = next;
      handle.redrawRef.current();
      // The legend follows the synced crosshair too (TV-style): show the values of
      // OUR bar holding the broadcast timestamp, not just paint the guide. null
      // (source cursor left) falls back to the last bar inside updateValues.
      legendHandleRef.current?.updateValues(legendBarIdxRef.current());
    });
    return () => {
      unsub();
      // Drop any lingering guide when this cell stops listening (tab/sync change).
      if (syncedTsRef.current != null) {
        syncedTsRef.current = null;
        handle.redrawRef.current();
        legendHandleRef.current?.updateValues(legendBarIdxRef.current());
      }
    };
  }, [tabId, cellId, syncCrosshair]);

  // Date-range link — BROADCAST. When the link is on, publish this cell's visible
  // time window (the two pixel-edge timestamps) to the tab's sibling cells on every
  // scroll/zoom, coalesced to one publish per frame. Only the cell the cursor is
  // driving broadcasts: pointer-enter / pointer-down / wheel mark this cell as the
  // gesture owner, and onRange bails unless it still owns the gesture. A sibling
  // that merely applies a range gets no pointer events, so it never owns and never
  // echoes — that's what prevents the A→B→A feedback loop (no reliance on klinecharts'
  // scroll-callback timing). Live data ticks fire no scroll/zoom, so an untouched
  // cell never broadcasts on its own.
  useEffect(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return;
    const claim = () => setGestureCell(cellId);
    // klinecharts fires OnScroll/OnZoom roughly once per frame, so publish straight
    // away rather than coalescing through requestAnimationFrame (rAF is paused while
    // the tab is hidden, which would silently stall the link). Gesture ownership —
    // not event timing — is what prevents the echo loop.
    const onRange = () => {
      // A user-driven scroll/zoom drops the quick-range pill (the view no longer
      // matches the preset). The separator MARKER persists though — it's anchored
      // to the period-start timestamp and only becomes visible once you scroll/zoom
      // away from the left edge, which is exactly when it's useful.
      if (!programmaticMoveRef.current) setActiveRange(null);
      if (!syncTimeRef.current || !isGestureCell(cellId)) return;
      // A window edge in whitespace past the last bar is extrapolated (not bailed on),
      // so panning into right-edge whitespace keeps driving the followers — they reveal
      // their own newest candles, then mirror the whitespace.
      const r = readVisibleRange(chart);
      if (!r) return;
      // Under lock, carry the exact-mode anchor (barSpace + reference bar + its pixel)
      // so siblings on the same interval mirror the window pixel-for-pixel; the plain
      // date-range link omits it (cross-interval, synthesised from fromTs/toTs). The
      // anchor is the tab's sticky align timestamp (last hovered bar) when set, else
      // the right-edge bar — so a hover-aligned offset is preserved through pan/zoom.
      const exact = lockedRef.current
        ? readExactAnchor(chart, getAlignAnchor(tabIdRef.current))
        : null;
      rangeSync.publish(tabIdRef.current, { sourceCellId: cellId, ...r, ...exact });
    };
    container.addEventListener("pointerenter", claim);
    container.addEventListener("pointerdown", claim);
    // Capture phase: klinecharts fires OnScroll SYNCHRONOUSLY from its own wheel
    // handler on an inner container div, before a bubbling wheel reaches us. A
    // capture-phase listener on this ancestor runs first, so `claim` lands before
    // onRange even on the very first wheel after a remount. Programmatic scrolls
    // (a receiver applying a range) dispatch no DOM wheel event, so this only ever
    // claims on real user input — preserving the user-vs-programmatic distinction
    // that keeps the A→B→A echo loop closed.
    container.addEventListener("wheel", claim, { capture: true, passive: true });
    chart.subscribeAction('onScroll', onRange);
    chart.subscribeAction('onZoom', onRange);
    return () => {
      container.removeEventListener("pointerenter", claim);
      container.removeEventListener("pointerdown", claim);
      container.removeEventListener("wheel", claim, { capture: true });
      chart.unsubscribeAction('onScroll', onRange);
      chart.unsubscribeAction('onZoom', onRange);
      // Drop ownership if this (unmounting) cell held it, so the global never points
      // at a dead cell and a freshly-mounted cell's first scroll isn't suppressed.
      releaseGestureCell(cellId);
    };
  }, [cellId]);

  // Date-range link — RECEIVE. Match a sibling cell's broadcast window onto this
  // cell's own bars (handles a different interval). Always applies: publishing is
  // already gated on the source being linked, so a message only ever arrives when
  // this cell should follow it.
  useEffect(() => {
    const unsub = rangeSync.subscribe(tabId, (m) => {
      if (m.sourceCellId === cellId) return; // ignore our own broadcasts
      const chart = chartRef.current;
      if (!chart) return;
      // Exact anchor present = "lock charts" mode (siblings share the interval):
      // reproduce the master's window pixel-for-pixel. Absent = cross-interval date-
      // range link, which synthesises the window from the two edge timestamps.
      if (m.barSpace != null && m.anchorTs != null && m.anchorX != null) {
        applyVisibleRangeExact(chart, m.anchorTs, m.anchorX, m.barSpace);
      } else {
        applyVisibleRange(chart, m.fromTs, m.toTs);
      }
    });
    return unsub;
  }, [tabId, cellId]);

  const precision = effPrecision;
  // Hovering an alert line swaps the crosshair for a drag cursor (TV-style).
  const alertHovered = alertTags.some((t) => t.hovered);

  // Pills currently on screen: the descriptive pill shows while the line is
  // hovered/selected (or the pill itself is hovered), and never over the y-axis.
  const visibleTags = alertTags.filter(
    (t) => !onAxis && (t.active || pillHoverId === t.id),
  );
  // Drive the remaining-time chip: tick once a minute, but ONLY while a visible
  // pill actually carries an expiry (otherwise stay idle — no wasted re-renders).
  const anyVisibleExpiry = visibleTags.some((t) => t.expiresAt != null);
  useEffect(() => {
    if (!anyVisibleExpiry) return;
    setNowTick(Date.now()); // refresh immediately when a pill with expiry appears
    const h = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(h);
  }, [anyVisibleExpiry]);

  const {
    onLegendToggleVisible,
    onLegendOpenSettings,
    onLegendRemove,
    onLegendSelectRow,
    pasteIndicator,
    copySelectedIndicator,
    copySelectedDrawing,
    pasteDrawing,
    deleteSelectedDrawing,
    reorderPaneByName,
    startPaneReorderDrag,
    indicatorMenuItems,
    onLegendOpenMenu,
  } = useIndicatorCommands(handle, {
    scope,
    period,
    snapViewRef,
    wrapRef,
    setPaneDropTop,
    setIndMenu,
  });

  // Shared source of truth for the four price-level actions offered by both the
  // axis "+" menu and the empty-chart right-click menu. `price` is the level under
  // the cursor at the moment the menu opened.
  const priceActionItems = useCallback(
    (price: number): MenuItem[] => {
      const label = price.toFixed(precision);
      // Quantize to instrument precision (matches the label) so a valid limit level —
      // not a raw many-decimal float — is staged and later sent to the broker.
      const level = Number(price.toFixed(precision));
      return [
        {
          label: `Add alert at ${label}`,
          icon: MenuIcons.bell,
          // Create immediately, inheriting the user's alert defaults (no modal).
          // Matches TV's quick "add alert here" — editable afterwards (dbl-click).
          onClick: () => {
            const ad = loadSettings().alertDefaults;
            overlays.addAlert(price, {
              condition: ad.condition,
              trigger: ad.trigger,
              message: "",
              expiresAt: resolveExpiry(ad.expiry, Date.now()),
              notify: ad.notify,
            });
          },
        },
        {
          label: `Buy limit at ${label}`,
          icon: MenuIcons.chevronUp,
          onClick: () => stageChartOrder({ epic: symbol.epic, side: "buy", price: level }),
        },
        {
          label: `Sell limit at ${label}`,
          icon: MenuIcons.chevronDown,
          onClick: () => stageChartOrder({ epic: symbol.epic, side: "sell", price: level }),
        },
        {
          label: `Draw line at ${label}`,
          icon: MenuIcons.horizontalLine,
          onClick: () => overlays.addDrawing("horizontalStraightLine", [{ value: price }]),
        },
      ];
    },
    [precision, symbol.epic, overlays],
  );


  return (
    <div
      ref={wrapRef}
      className={`chart-wrap${alertHovered ? " alert-hover" : ""}${cursorMode ? " " + cursorMode : ""}`}
      style={{ width: "100%", height: "100%", position: "relative", outline: "none" }}
      // tabIndex makes the cell focusable so Ctrl/Cmd+C/V are scoped to it (only the
      // focused cell responds — no global listener cross-talk between split cells).
      tabIndex={0}
      // Capture-phase so focus registers even when an inner handler (anchor drag)
      // stops propagation. App marks this cell focused → routes the chrome to it; we
      // also DOM-focus the wrap so it receives keyboard shortcuts.
      onPointerDownCapture={() => {
        onFocus?.(cellId);
        wrapRef.current?.focus({ preventScroll: true });
      }}
      onKeyDown={(e) => {
        // Don't hijack copy/paste/delete while typing in a field.
        const t = e.target as HTMLElement;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
        // Escape cancels the most recent transient first: an ARMED measure (TV: Esc
        // cancels the ruler), then an armed/mid-placement drawing tool, and only
        // then a leftover frozen measure box — a stale box must not swallow the
        // Esc meant for the tool the user just armed.
        if (e.key === "Escape") {
          if (rangePickArmed.value) {
            rangePickArmed.set(false); // subscription clears the band + restores scroll
            e.preventDefault();
          } else if (measureArmed.value) {
            measureArmed.set(false);
            overlays.clearMeasure();
            e.preventDefault();
          } else if (slopeArmed.value) {
            slopeArmed.set(false);
            overlays.clearSlope();
            e.preventDefault();
          } else if (overlays.cancelDrawing()) {
            // TV: Esc cancels an armed/mid-placement drawing tool.
            e.preventDefault();
          } else if (overlays.hasMeasure()) {
            overlays.clearMeasure();
            e.preventDefault();
          } else if (overlays.hasSlope()) {
            overlays.clearSlope();
            e.preventDefault();
          }
          return;
        }
        // Escape on a selected trade (discard pending → deselect) is handled by a
        // window listener in App, so it works even when focus isn't on the chart.
        // Delete / Backspace removes the selected drawing, or — failing that — the live
        // slope line (it's the transient thing on the chart the user most likely means).
        if (e.key === "Delete" || e.key === "Backspace") {
          if (deleteSelectedDrawing()) e.preventDefault();
          else if (overlays.hasSlope()) {
            overlays.clearSlope();
            e.preventDefault();
          }
          return;
        }
        // Alt/Option+I: TV-style invert scale (flip the price axis upside down).
        if (isInvertShortcut(e)) {
          invertScale.set(!invertScale.value);
          e.preventDefault();
          return;
        }
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        const k = e.key.toLowerCase();
        if (k === "c") {
          // A selected drawing wins over a selected indicator for copy; fall back to
          // the indicator. Only swallow the event when something was copied (else
          // normal text copy still works).
          if (copySelectedDrawing() || copySelectedIndicator()) e.preventDefault();
        } else if (k === "v") {
          // Try a drawing paste first; if the clipboard holds an indicator instead,
          // fall through to the indicator paste. Both read the clipboard async.
          e.preventDefault();
          void pasteDrawing().then((did) => {
            if (!did) void pasteIndicator();
          });
        }
      }}
    >
      <div
        ref={containerRef}
        className={anchoring || measureArmedUi || slopeArmedUi || rangePickArmedUi ? "anchoring" : undefined}
        style={{ width: "100%", height: "100%" }}
      />
      {paneDropTop != null && (
        <div className="pane-drop-indicator" style={{ top: paneDropTop }} />
      )}
      <ChartRangeBar
        activeKey={activeRange}
        disabled={!chartReady}
        onPick={onRangePick}
        onGoToDate={onGoToDate}
      />
      {/* Indicator-selection overlay: hollow selection handles + the AVWAP anchor
          grab handle + the self-drawn "+" crosshair, painted in redraw(). z-index 10
          puts it above klinecharts' own canvases (z-index 2) so the rings sit on top
          of the lines. pointer-events:none so clicks/hover reach the chart below. */}
      {/* The H position bracket (spine + %/R:R badges). Its own canvas under the
          selection overlay (z-index 9) so it's above klinecharts' lines but the
          indicator-selection handles still draw on top. pointer-events:none — purely
          decorative; the draggable lines underneath stay the interactive surface. */}
      {/* Slope "Show MAs on chart": the SLOPE indicator's underlying MA curves.
          z-index 7: above klinecharts' candles (z2) but below the separator (z8),
          bracket (z9) and selection (z10) overlays. pointer-events:none. */}
      <canvas
        ref={maCanvasRef}
        data-testid="slope-ma-overlay"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 7,
          pointerEvents: "none",
        }}
      />
      {/* Period-start separator (dashed line + date pill). z-index 8: above
          klinecharts' candles (z2) but below the bracket (z9) and selection (z10)
          overlays. pointer-events:none — purely a marker. */}
      <canvas
        ref={sepCanvasRef}
        data-testid="range-separator"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 8,
          pointerEvents: "none",
        }}
      />
      <canvas
        ref={bracketCanvasRef}
        data-testid="position-bracket"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 9,
          pointerEvents: "none",
        }}
      />
      <canvas
        ref={selCanvasRef}
        data-testid="selection-overlay"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 10,
          pointerEvents: "none",
        }}
      />
      {/* Data-unavailable banner: no candles after a grace period (broker maintenance,
          auth failure, offline, or an unknown epic). Generic on purpose — a 401 can't
          be told apart from expired creds, so we don't claim a specific cause. */}
      {noData && (
        <div className="chart-nodata" role="status">
          <div className="chart-nodata-card">
            <svg
              className="chart-nodata-icon"
              viewBox="0 0 24 24" width="28" height="28" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="chart-nodata-title">No data to display</span>
            <span className="chart-nodata-hint">
              Couldn’t load {symbol.epic} — the broker may be temporarily unavailable.
            </span>
            {loadError &&
              (loadError.length <= 90 ? (
                // Short enough to read inline.
                <span className="chart-nodata-err">{loadError}</span>
              ) : (
                // Long / multi-line detail — collapse behind a toggle.
                <div className="chart-nodata-details">
                  <button
                    type="button"
                    className="chart-nodata-toggle"
                    aria-expanded={errorOpen}
                    onClick={() => setErrorOpen((o) => !o)}
                  >
                    {errorOpen ? "Hide error details" : "Show error details"}
                  </button>
                  {errorOpen && <pre className="chart-nodata-errbox">{loadError}</pre>}
                </div>
              ))}
            <span className="chart-nodata-retry">
              <span className="chart-nodata-spinner" aria-hidden="true" />
              Retrying automatically…
            </span>
          </div>
        </div>
      )}

      {/* Curve-end key-parameter labels (DOM pills, crisp text) for the selected/
          highlighted indicator. z-index 11 sits just above the handle overlay. */}
      <CurveLabels handleRef={curveLabelsRef} />
      {/* Higher-timeframe backtest markers: DOM pills (count + net P&L) for a
          backtest viewed on a coarser timeframe. Hover opens the trade-list
          popover; click drills into the native timeframe. Fed by the redraw loop. */}
      <BacktestAggMarkers handleRef={aggMarkersRef} onDrillIn={onBacktestDrillIn} />
      {/* Coarse-timeframe LIVE exit pills (count + net P&L) — the live analog of the
          backtest aggregate markers, for journaled closes that collide on the current
          timeframe. Hover lists that bar's exits; no drill-in. Fed by the redraw loop. */}
      <TradeExitAggMarkers handleRef={exitAggMarkersRef} />
      {/* Read-only snapshot view banner: top-center pill naming the snapshot, a
          READ-ONLY tag, and Unlock (graduates the tab into a normal chart). The
          one always-visible cue that editing is deliberately off on this cell. */}
      {snapView && (
        <div className="snapshot-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          <span className="snapshot-banner-name">{snapView.name}</span>
          <span className="snapshot-banner-tag">Read-only</span>
          <button className="snapshot-banner-unlock" onClick={unlockSnapshotView}>
            Unlock
          </button>
        </div>
      )}
      {/* Top-left legend as crisp DOM (the candle/OHLC row + one row per candle-pane
          indicator), replacing klinecharts' blurry canvas legend. Row membership is
          React state (signature-gated); values update imperatively via the handle. */}
      <ChartLegend
        getChart={getChart}
        controller={controller}
        ctx={{
          symbol: isSynthetic(symbol.epic) ? (symbol.name ?? symbol.epic) : symbol.epic,
          period: period.label,
          precision,
          // The socket connects to OUR backend, so status alone stays "live"
          // through a market close — gate the dot on the market being open too.
          // A stale (silently-wedged) feed shows the amber dot instead of green;
          // the two are mutually exclusive.
          live: status === "live" && !marketClosed && !streamStale,
          stale: streamStale && !marketClosed && status === "live",
          broker: brokerLabel(brokerId),
        }}
        rows={legendRows}
        collapsed={legendCollapsed}
        onToggleCollapsed={toggleLegendCollapsed}
        candleHidden={candleHidden}
        onToggleCandle={toggleCandleHidden}
        subPanes={subPaneLegends}
        selectedName={selectedName}
        highlightedName={curveHoverNameState}
        handleRef={legendHandleRef}
        onToggleVisible={onLegendToggleVisible}
        onOpenSettings={onLegendOpenSettings}
        onRemove={onLegendRemove}
        onSelectRow={onLegendSelectRow}
        onOpenMenu={onLegendOpenMenu}
        onMove={reorderPaneByName}
        onStartReorder={startPaneReorderDrag}
        onOpenDetails={(x, y) => setDetailsAnchor({ x, y })}
        cacheBadge={cacheBadge}
        onOpenCacheStats={() => setCacheStatsOpen(true)}
        // Clicking the symbol name swaps the instrument (TradingView-style). The
        // wrap's onPointerDownCapture has already focused this cell, so the shared
        // symbol-search modal targets this cell's symbol.
        onChangeSymbol={requestSymbolSearch}
      />

      {detailsAnchor && (
        <MarketInfoPopover
          epic={symbol.epic}
          brokerId={brokerId}
          title={symbol.name ?? symbol.epic}
          anchor={detailsAnchor}
          onClose={() => setDetailsAnchor(null)}
        />
      )}

      {cacheStatsOpen && (
        <CandleCacheStatsModal
          epic={symbol.epic}
          resolution={period.resolution}
          priceSide={priceSide}
          brokerId={brokerId}
          title={`${symbol.name ?? symbol.epic} cache stats`}
          onClose={() => setCacheStatsOpen(false)}
        />
      )}

      {indMenu && (
        <ContextMenu
          x={indMenu.x}
          y={indMenu.y}
          items={indicatorMenuItems(indMenu.paneId, indMenu.name)}
          onClose={() => setIndMenu(null)}
        />
      )}

      {chartMenu && (
        <ContextMenu
          x={chartMenu.x}
          y={chartMenu.y}
          items={[
            // Price-level actions at the cursor's level, so a confluence point picked
            // mid-chart can be traded/alerted/drawn without traveling to the axis "+".
            // Gated to non-synthetic epics, matching the hidden "+" button there.
            ...(chartMenu.price != null && !isSynthetic(symbol.epic)
              ? priceActionItems(chartMenu.price)
              : []),
            {
              label: "Paste",
              icon: MenuIcons.paste,
              // Mirror the Ctrl/Cmd+V handler: a copied drawing or indicator can be
              // on the clipboard, so try drawing first and fall back to indicator.
              onClick: () =>
                void pasteDrawing().then((did) => {
                  if (!did) void pasteIndicator();
                }),
            },
            { label: "Settings", icon: MenuIcons.settings, onClick: () => openSettings() },
          ]}
          onClose={() => setChartMenu(null)}
        />
      )}

      {axisMenu && (
        <ContextMenu
          x={axisMenu.x}
          y={axisMenu.y}
          items={[
            {
              label: "Scale price chart only",
              icon: scaleOnly ? MenuIcons.apply : undefined,
              onClick: toggleScalePriceOnly,
            },
          ]}
          onClose={() => setAxisMenu(null)}
        />
      )}

      {priceTag && (
        <div
          className={`price-tag ${status === "live" && !streamStale ? `live ${priceTag.dir}` : "stale"}`}
          style={{ top: priceTag.y, width: priceTag.w }}
        >
          <span className="pt-price">
            {(lastPrice ?? priceTag.price).toFixed(precision)}
          </span>
          {priceTag.countdown && <span className="pt-cd">{priceTag.countdown}</span>}
        </div>
      )}

      {/* Live ask (buy) and bid (sell) axis labels, TradingView two-tone: a solid
          colored side tag + the price on a light tint of the same color. Colors
          come from the global bid/ask style (labels stay opaque; opacity is for
          the lines only). */}
      {askTag && (
        <div className="ba-tag" style={{ top: askTag.y }}>
          <span className="ba-side" style={{ background: bidAskStyle.askColor }}>Ask</span>
          <span
            className="ba-price"
            style={{ width: askTag.w, background: hexToRgba(bidAskStyle.askColor, 0.16), color: bidAskStyle.askColor }}
          >
            {askTag.price.toFixed(precision)}
          </span>
        </div>
      )}
      {bidTag && (
        <div className="ba-tag" style={{ top: bidTag.y }}>
          <span className="ba-side" style={{ background: bidAskStyle.bidColor }}>Bid</span>
          <span
            className="ba-price"
            style={{ width: bidTag.w, background: hexToRgba(bidAskStyle.bidColor, 0.16), color: bidAskStyle.bidColor }}
          >
            {bidTag.price.toFixed(precision)}
          </span>
        </div>
      )}

      {/* Candle-pane overlay clip: alert tags/pills + trade pills anchor to a price
          via the candle pane's absolute y, which extrapolates past the pane bottom
          for a level below the visible range. This wrapper is sized to the candle
          pane height (set imperatively in the redraw loop) with overflow:hidden, so
          such a level's tag/pill slides off the pane edge instead of drawing over
          the indicator sub-panes. pointer-events:none passes chart interaction
          through; the interactive descendants (.alert-pill, .tp-btn) opt back in. */}
      <div
        ref={pillClipRef}
        className="pane-clip"
        // height starts at 100% (no clip) and is narrowed to the candle pane by the
        // redraw loop; absolute-only children can't give it an auto height, so an
        // explicit 100% avoids a pre-first-paint window where it collapses to 0.
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: "100%", overflow: "hidden", pointerEvents: "none" }}
      >
      <AlertTags tags={alertTags} priceTag={priceTag} precision={precision} />

      {/* TV-style descriptive pill on the line itself — shown while the line is
          hovered/selected (or the pill itself is hovered). Follows the cursor's x
          (positioned imperatively) and carries the delete affordance. */}
      {visibleTags.map((t) => {
          const remaining =
            t.expiresAt != null ? formatRemaining(t.expiresAt - nowTick) : null;
          const isOnce = t.trigger === "once";
          return (
          <div
            key={t.id}
            ref={registerPill}
            data-alert-id={t.id}
            className={`alert-pill${t.selected ? " selected" : ""}`}
            // Seed `left` from the last imperative position so a re-render (e.g.
            // moving the cursor onto the sidebar) doesn't reset a frozen pill to 0.
            style={{ top: t.y, left: pillLeftRef.current.get(t.id) ?? undefined }}
            onMouseEnter={() => setPillHoverId(t.id)}
            onMouseLeave={() => setPillHoverId((cur) => (cur === t.id ? null : cur))}
            // Double-click the pill body -> edit modal (matches the alert line).
            onDoubleClick={() => alertEditRequest.set({ id: t.id })}
          >
            <span className="ap-text">
              {symbol.epic} {CONDITION_LABELS[t.condition]} {t.level.toFixed(precision)}
            </span>
            {/* Clickable one-time (1×) ↔ permanent (∞) toggle. Always present. */}
            <Tooltip content={isOnce ? "One-time alert. Click to make permanent." : "Permanent alert. Click to make one-time."}>
              <button
                className={`ap-trigger ${isOnce ? "once" : "every"}`}
                aria-label={isOnce ? "One-time alert" : "Permanent alert"}
                onClick={() => overlays.toggleAlertTrigger(t.id)}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {isOnce ? "1×" : "∞"}
              </button>
            </Tooltip>
            {remaining && (
              <Tooltip content="Time until this alert expires">
                <span className="ap-remaining">
                  {remaining}
                </span>
              </Tooltip>
            )}
            <Tooltip content="Delete alert">
              <button
                className="ap-del"
                onClick={() => {
                  requestConfirm({
                    message: `Delete alert ${CONDITION_LABELS[t.condition]} ${t.level.toFixed(precision)} on ${symbol.epic}?`,
                    onConfirm: () => {
                      overlays.remove(t.id);
                      setPillHoverId((cur) => (cur === t.id ? null : cur));
                    },
                  });
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </button>
            </Tooltip>
          </div>
          );
        })}

      {/* The ACTIVE line's pill (entry / SL / TP — only one shows). It carries the
          symbol + level; the entry pill adds uPnL + close, the SL/TP pills add the P/L
          that level would realise if hit + remove. ANY pill shows Apply/Discard when
          ITS OWN line has a staged drag. Anchored at the line's y, frozen x. */}
      <TradePills
        pills={tradePills}
        precisionRef={precisionRef}
        tradesRef={tradesRef}
        pendingRef={pendingRef}
        tradePillNodesRef={tradePillNodesRef}
        hoveredPillKey={hoveredPillKey}
        hoveredPillRectKey={hoveredPillRectKey}
        focusedPillKey={focusedPillKey}
        tradePillLeft={TRADE_PILL_LEFT}
      />
      </div>

      {!isSynthetic(symbol.epic) && !snapView && (
      <div
        ref={plusBtnRef}
        className="axis-plus"
        style={{ display: "none" }}
        title="Add alert / draw at this price"
        // Moving the cursor onto the "+" makes klinecharts drop the line's hover
        // (it's a DOM sibling over the canvas). Keep the active alert's pill shown
        // (and following) while parked here, mirroring the pill's own hover guard.
        onMouseEnter={() => {
          if (lastActivePillIdRef.current) setPillHoverId(lastActivePillIdRef.current);
        }}
        onMouseLeave={() =>
          setPillHoverId((cur) => (cur === lastActivePillIdRef.current ? null : cur))
        }
        onClick={() => {
          const el = containerRef.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const top = parseFloat(plusBtnRef.current?.style.top || "0");
          setPlusMenu({ x: rect.right - 12, y: rect.top + top, price: plusPriceRef.current });
        }}
      >
        <span className="axis-plus-icon">
          {/* SVG plus (not the "+" glyph) so it's perfectly centered in the circle. */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </span>
        <span className="axis-plus-price" ref={plusPriceLabelRef} />
      </div>
      )}


      {plusMenu && (
        <ContextMenu
          x={plusMenu.x}
          y={plusMenu.y}
          items={priceActionItems(plusMenu.price)}
          onClose={() => {
            setPlusMenu(null);
            if (plusBtnRef.current) plusBtnRef.current.style.display = "none";
          }}
        />
      )}
    </div>
  );
}

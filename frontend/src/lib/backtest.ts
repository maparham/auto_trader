// Backtest visualization (task 7): trade markers as overlays + an equity curve
// in its own sub-pane via a custom "EQUITY" indicator.
//
// The equity series is dynamic (it depends on the backtest params), but an
// indicator's calc only sees the kline dataList. So we stash the equity series
// on the EQUITY instance's OWN extendData (a ts→value map) and the calc looks
// each bar up there. It must NOT live in a module global: the app runs one chart
// per cell but shares the single registered EQUITY template, so a global would
// let a backtest in one cell overwrite/clear another cell's curve. Per-chart
// bookkeeping (pane id + marker ids, for clearing) lives in a WeakMap keyed by
// the chart instance. Markers are created directly on the chart (NOT via the
// overlays manager) so they aren't persisted as user drawings — they're
// ephemeral backtest artifacts.
//
// This file keeps the render lifecycle (run, render, selection zone, markers,
// period bands, WFO, teardown). The pieces it builds on live under backtest/:
// markerMath, overlayTemplates, equity, replayPolicy and the artifacts
// registry. Their public names are re-exported here, so importers use this path.

import type { Chart, KLineData } from "klinecharts";
import { runBacktest, runExprBacktest, type BacktestRequest, type ExprBacktestRequest, type WfoScheme } from "../api";
import { toast } from "./notify";
import { applyVisibleRangeKeepStart, scrollTsToCenter } from "./chartSync";
import {
  backtestResultSignal,
  highlightTradeSignal,
  selectedTradeSignal,
  backtestClusterHoverSignal,
  backtestSignalHoverSignal,
  backtestPeriodsShownSignal,
  backtestRegionsShownSignal,
  backtestMarkersShownSignal,
  backtestEquityShownSignal,
  backtestSelectNoticeSignal,
  wfoEquityShownSignal,
  wfoBandsShownSignal,
  wfoEquityCompoundedSignal,
  tradeMarkerHoverSignal,
} from "./signals";
import type { OpenStrategyTrade } from "./replayReveal";
import { buildSignalGlyphs, isEntryFill } from "./signalGlyphs";
import { tradeZones, zoneLabels } from "./tradeZones";
import { chartBarMs } from "./barInterval";
import { RESOLUTION_SECONDS } from "./feed";
import { saveBacktestResult, loadBacktestResult, clearBacktestResult, type StoredBacktestResult } from "./persist";
import { computePeriodBands, type BacktestPeriod } from "./backtestPeriods";
import {
  type Trade,
  markerPillLabel,
  nextMarkerStack,
  markerPlacement,
  barIndexForBars,
  aggregateTradesByBar,
  snapNearestBar,
  fillWithinLoadedWindow,
  overlayEndTs,
  strategyZoneSpan,
  oldestBacktestAnchorMs,
} from "./backtest/markerMath";
import {
  BUY_COLOR,
  SELL_COLOR,
  MARKER_OVERLAY,
  type MarkerExtra,
  ensureMarkerOverlayRegistered,
  SIGNAL_OVERLAY,
  type SignalMarkerExtra,
  ensureSignalGlyphOverlayRegistered,
  setMarkerHoverCursor,
  ZONE_OVERLAY,
  type ZoneExtra,
  ensureZoneOverlayRegistered,
  STRATEGY_ZONE_OVERLAY,
  ensureStrategyZoneOverlayRegistered,
  PERIOD_OVERLAY,
  ensurePeriodOverlayRegistered,
} from "./backtest/overlayTemplates";
import { EQUITY_INDICATOR, wfoEquityPoints, wfoFoldBandPoints } from "./backtest/equity";
import {
  type BacktestArtifacts,
  artifactsByChart,
  pagerByChart,
  isChartReplaying,
  artifactsFor,
} from "./backtest/artifacts";
export {
  markerLabel,
  entryDirection,
  LONG_GLYPH,
  SHORT_GLYPH,
  markerPillLabel,
  aggPillLabel,
  MARKER_PILL_STACK_STEP,
  nextMarkerStack,
  markerPlacement,
  barIndexForTs,
  barIndexForBars,
  aggregateTradesByBar,
  tradeDashes,
  dashSliceBounds,
  snapNearestBar,
  fillWithinLoadedWindow,
  overlayEndTs,
  strategyZoneSpan,
  oldestBacktestAnchorMs,
} from "./backtest/markerMath";
export type { TradeCluster, TradeDash } from "./backtest/markerMath";
export {
  MARKER_OVERLAY,
  LIVE_GLYPH_GAP,
  LIVE_GLYPH_H,
  LIVE_GLYPH_HALF_W,
  liveMarkerGlyph,
  ensureMarkerOverlayRegistered,
  setMarkerHoverCursor,
} from "./backtest/overlayTemplates";
export {
  EQUITY_INDICATOR,
  equityForBars,
  registerBacktestIndicators,
  wfoEquityPoints,
  wfoFoldBandPoints,
} from "./backtest/equity";
export { backtestPanelActionForReplay, backtestActionBlockedByReplay } from "./backtest/replayPolicy";
export type { BacktestPanelAction, BacktestReplayAction } from "./backtest/replayPolicy";
export {
  registerBacktestPager,
  registerReplayingChart,
  isChartReplaying,
  coverBacktestHistory,
  getBacktestAggregate,
  chartOwnsActiveResult,
  selectedTradeForChart,
  restoreTradeSelection,
  releaseBacktestPanel,
  ownsBacktestPanel,
} from "./backtest/artifacts";

// Bridge from a Chart to its ChartCore page-back function. The selection
// subscription below only holds the Chart (it's installed by renderArtifacts,
// which knows nothing of the controller), so ChartCore registers its
// coverBacktestTradeTo here at chart-ready and clears it on teardown. Lets the
// subscription page an out-of-window trade in before scrolling to it.
// True while a selectedTradeSignal.set originates from an on-chart marker
// click (see toggleTradeSelect in drawMarkers). The selection subscription —
// which runs synchronously inside the .set — consumes it to skip the scroll.
let selectFromMarkerClick = false;

/** Remove every overlay drawn for the sticky selection (windowed zone) and
 * reset the bookkeeping — shared by the reset-at-top-of-run, clearBacktest,
 * and the selectedTradeSignal subscription's own "replace" step. */
function removeSelectionOverlays(chart: Chart, artifacts: BacktestArtifacts): void {
  for (const id of artifacts.selectionOverlayIds) chart.removeOverlay({ id });
  artifacts.selectionOverlayIds = [];
  artifacts.openZoneFor = null;
  artifacts.openZoneOverlayId = null;
}

/** Pan the chart — never zoom — so the selected trade is in view. If the whole
 * entry↔exit span is ALREADY visible, do nothing (selecting a trade you're
 * looking at must not yank the view). Otherwise scroll, at the current bar
 * spacing, to center the span's midpoint; when the span is wider than the
 * view, center the ENTRY instead (seeing where the trade started beats a
 * midpoint that shows neither end). */
function scrollChartToTrade(chart: Chart, entryTs: number, exitTs: number): void {
  const data = chart.getDataList();
  if (!data || data.length < 2) return;
  const firstTs = data[0].timestamp;
  const lastTs = data[data.length - 1].timestamp;
  const lo = Math.min(entryTs, exitTs);
  const hi = Math.max(entryTs, exitTs);
  // Bail if the span doesn't overlap the loaded window at all — the trade can't
  // be shown here (its markers are culled too), so leave the view put rather
  // than scroll somewhere meaningless. A same-bar trade (entry===exit) has a
  // zero-width span but IS showable: don't conflate "zero width" with "no
  // overlap".
  if (hi < firstTs || lo > lastTs) return;
  const iLo = barIndexForBars(data, Math.max(lo, firstTs));
  const iHi = barIndexForBars(data, Math.min(hi, lastTs));
  const vr = chart.getVisibleRange();
  // Already fully in view → don't pan.
  if (iLo >= vr.from && iHi < vr.to) return;
  const visibleBars = Math.max(1, vr.to - vr.from);
  // Span comfortably narrower than the view (0.9 leaves a small context margin
  // before flipping modes) → aim at its midpoint; wider → aim at its start.
  const desired = iHi - iLo <= visibleBars * 0.9 ? Math.round((iLo + iHi) / 2) : iLo;
  // Clamp the anchor so the centered window stays inside the loaded data: a
  // trade near the live edge must not drag the last bar to mid-pane (half a
  // pane of trailing whitespace), and one near the oldest loaded bar can't be
  // centered anyway — pin to the window edge instead.
  const half = Math.floor(visibleBars / 2);
  const anchorIdx = Math.max(0, Math.min(Math.max(desired, half), data.length - 1 - half));
  scrollTsToCenter(chart, data[anchorIdx].timestamp);
}

/**
 * Fit the chart to the whole traded span (first entry → last exit) so a finished
 * backtest lands the user right on the trades instead of far to the right. The
 * FIRST (leftmost) trade is always kept in view: when the span is too wide to fit
 * at max zoom-out, applyVisibleRangeKeepStart pins the first entry near the left
 * rather than letting the right-anchored fit push it off screen. No-op when the
 * run produced no trades or the span doesn't overlap the loaded window (those
 * markers are culled too). Call AFTER coverDrawingAnchors so trades that predate
 * the chart's loaded bars have been paged in and count toward the span.
 */
export function fitBacktestTrades(chart: Chart, result: StoredBacktestResult): void {
  const trades = result.trades;
  if (!trades?.length) return;
  const data = chart.getDataList();
  if (!data || data.length < 2) return;
  const firstTs = data[0].timestamp;
  const lastTs = data[data.length - 1].timestamp;
  const barMs = chartBarMs(chart, data.map((k) => k.timestamp)) || 1;
  let minEntry = Infinity;
  let maxExit = -Infinity;
  for (const t of trades) {
    minEntry = Math.min(minEntry, t.entry_time * 1000);
    maxExit = Math.max(maxExit, t.exit_time * 1000);
  }
  // Clamp the traded span to the loaded bar window (same guard as
  // scrollChartToTrade: out-of-data timestamps make applyVisibleRange extrapolate
  // into negative virtual bars and wreck the view). A first trade older than the
  // broker's finest history can't be shown at all, so fall back to the earliest
  // loaded bar. Bail if the span doesn't overlap what's loaded.
  const start = Math.max(minEntry, firstTs);
  const end = Math.min(maxExit, lastTs);
  if (!(end >= start)) return;
  // A little context on each side; a single same-bar trade still yields a window.
  const pad = Math.max((end - start) * 0.1, barMs * 5);
  const from = Math.max(start - pad, firstTs);
  const to = Math.min(end + pad, lastTs);
  if (!(to > from)) return;
  applyVisibleRangeKeepStart(chart, from, to, start);
}

/** Remove this chart's period-band AND strategy-region overlays (one lifecycle:
 * both are run-scoped shading, cleared and redrawn together) and reset the
 * bookkeeping. */
function clearPeriodBands(chart: Chart, artifacts: BacktestArtifacts): void {
  for (const id of artifacts.periodBandIds) chart.removeOverlay({ id });
  artifacts.periodBandIds = [];
}

/** Draw the trading-period bands and the strategy's viz regions (chart_regions
 * hook — e.g. BB Regime's squeeze windows) for the CURRENT loaded bars, if the
 * global shading toggle is on. Caller clears any prior bands first. Independent
 * of markerMode — both are pure time spans, valid on every timeframe. Region
 * ids share periodBandIds so every clear/redraw call site treats them as one. */
function drawPeriodBands(chart: Chart, artifacts: BacktestArtifacts, result: StoredBacktestResult): void {
  const periodsOn = backtestPeriodsShownSignal.value;
  const regionsOn = backtestRegionsShownSignal.value;
  if (!periodsOn && !regionsOn) return;
  const data = chart.getDataList() ?? [];
  if (data.length === 0) return;
  const period = result.period;
  if (periodsOn && period) {
    const barTimes = data.map((k) => k.timestamp);
    const bands = computePeriodBands(period, barTimes);
    if (bands.length > 0) {
      ensurePeriodOverlayRegistered();
      const yVal = data[0].close; // a valid in-range price so the point projects (y is unused)
      for (const b of bands) {
        const id = chart.createOverlay({
          name: PERIOD_OVERLAY,
          lock: true,
          points: [
            { timestamp: b.fromMs, value: yVal },
            { timestamp: b.toMs, value: yVal },
          ],
        });
        if (typeof id === "string") artifacts.periodBandIds.push(id);
      }
    }
  }
  if (regionsOn && result.regions?.length) {
    ensureStrategyZoneOverlayRegistered();
    const firstTs = data[0].timestamp;
    const lastTs = data[data.length - 1].timestamp;
    for (const r of result.regions) {
      const span = strategyZoneSpan(r, firstTs, lastTs);
      if (!span) continue;
      const id = chart.createOverlay({
        name: STRATEGY_ZONE_OVERLAY,
        lock: true,
        points: [
          { timestamp: span.fromTs, value: r.top },
          { timestamp: span.toTs, value: r.bottom },
        ],
        extendData: { label: r.label },
      });
      if (typeof id === "string") artifacts.periodBandIds.push(id);
    }
  }
}

/** Draw the windowed risk/reward zone overlay for trade `t` and scroll the
 * chart to its entry↔exit span. Pushes the created overlay's id into
 * `artifacts.selectionOverlayIds` (the caller is responsible for clearing any
 * prior selection first — see the selectedTradeSignal subscription). */
/** The replay reveal's OPEN trade, shaped for `drawSelectionZone` — the same
 * windowed R/R zone a selected closed trade draws, with everything the trade
 * does not know yet standing in honestly:
 *
 *  - exit = the LAST LOADED BAR (during replay that is the cursor bar), so the
 *    zone's right edge sits at "now" and the entry→exit segment reads as the
 *    trade so far. It grows on the next full reveal redraw, not per step.
 *  - stop_final = stop_initial: where the trail ends up is the future's
 *    knowledge, so the zone never draws a moved-stop line.
 *  - pnl = the mark-to-market sign, which only picks the segment's win/loss
 *    colour — it is never summed anywhere.
 *
 * The unread bookkeeping fields (mae/mfe/context/...) are zeroed, not omitted,
 * so this stays an honest `Trade` for the type system without a cast chain. */
function openTradeAsTrade(
  t: OpenStrategyTrade,
  chart: Chart,
  bars?: readonly KLineData[],
): Trade {
  const data = bars ?? chart.getDataList() ?? [];
  const last = data.length > 0 ? data[data.length - 1] : null;
  const mark = last?.close ?? t.entryPrice;
  const exitSec = last != null ? Math.floor(last.timestamp / 1000) : t.entryTime;
  const dir = t.leg === "long" ? 1 : -1;
  return {
    side: t.leg === "long" ? "buy" : "sell",
    quantity: t.quantity,
    entry_time: t.entryTime,
    entry_price: t.entryPrice,
    exit_time: Math.max(exitSec, t.entryTime),
    exit_price: mark,
    pnl: dir * (mark - t.entryPrice) * t.quantity,
    leg: t.leg,
    reason: "open",
    stop_initial: t.stop,
    stop_final: t.stop,
    target: t.target,
    exit_time_exact: null,
    mae: 0,
    mfe: 0,
    mae_r: null,
    mfe_r: null,
    context: null,
  };
}

/** The open-trade zone's identity on `chart`, or null when none is drawn.
 * Captured by the replay reveal BEFORE its full redraw (teardownArtifacts wipes
 * it with the zone), and handed back to restoreOpenTradeZone afterwards. */
export function openTradeZoneKey(
  chart: Chart,
): { index: number; entryTime: number; leg: "long" | "short"; entryPrice: number } | null {
  return artifactsByChart.get(chart)?.openZoneFor ?? null;
}

/** Redraw the open trade's zone against the CURRENT result and bars — the
 * "grows with the cursor" half of the marker click. Two callers:
 *
 *  - updateShownResult, once per replay step: the zone's right edge and its
 *    entry→mark segment must follow the cursor, or the overlay freezes at the
 *    bar it was clicked on while the session plays on.
 *  - the reveal's full-redraw path (via useReplay), where teardownArtifacts has
 *    just wiped the zone with everything else.
 *
 * When the trade is no longer in `openTrades`, its exit bar has printed: the
 * zone is handed over to the CLOSED trade's normal selection (found by
 * entry_time+leg — the slice is a filtered list, so the run index no longer
 * addresses it), which draws the finished entry→exit zone and lights its panel
 * row. The marker-click flag skips the selection scroll: the user is already
 * at the cursor where the exit just printed, and yanking the view mid-session
 * is exactly what that flag exists to prevent. */
export function restoreOpenTradeZone(
  chart: Chart,
  key: { index: number; entryTime: number; leg: "long" | "short"; entryPrice: number },
): void {
  const artifacts = artifactsByChart.get(chart);
  if (!artifacts || backtestResultSignal.value !== artifacts.result) return;
  const open = artifacts.result?.openTrades?.find((o) => o.index === key.index);
  if (open) {
    // Read ONCE and threaded through both: this runs on every revealed bar, and
    // the list is the whole loaded window.
    const bars = chart.getDataList() ?? [];
    const t = openTradeAsTrade(open, chart, bars);
    // Already on screen: move it instead of rebuilding it. A remove + create per
    // revealed bar is exactly the destructive churn updateShownResult was built
    // to avoid, and this runs on the same cadence. extendData rides along with
    // the points — `win` is the mark-to-market sign and flips mid-trade.
    const points = zonePoints(t, chart, bars);
    if (artifacts.openZoneOverlayId && points) {
      chart.overrideOverlay({
        id: artifacts.openZoneOverlayId,
        points,
        extendData: zoneExtra(t),
      });
      artifacts.openZoneFor = key;
      return;
    }
    removeSelectionOverlays(chart, artifacts);
    zoneOverlayId = null;
    drawSelectionZone(chart, artifacts, t, false);
    artifacts.openZoneFor = key;
    artifacts.openZoneOverlayId = zoneOverlayId;
    return;
  }
  // Entry PRICE as well as time+leg: a strategy that pyramids opens two trades
  // on one bar in one direction, and matching on the bar alone would hand the
  // zone to whichever of them happens to be first in the list.
  const closedIdx = (artifacts.result?.trades ?? []).findIndex(
    (t) => t.entry_time === key.entryTime && t.leg === key.leg && t.entry_price === key.entryPrice,
  );
  if (closedIdx < 0) return; // gone entirely (result replaced): nothing to restore
  selectFromMarkerClick = true;
  try {
    selectedTradeSignal.set(closedIdx);
  } finally {
    selectFromMarkerClick = false;
  }
}

/** A `tradeZone` overlay's extendData. Shared by the initial draw and the replay
 * reveal's per-step update for the same reason zonePoints is: `win` is the
 * MARK-to-market sign for an open trade, so it flips the entry→mark segment and
 * the exit dot from green to red the moment price crosses back through the
 * entry. An update that moved only the points would strand the colour at
 * whatever it was when the marker was clicked. */
function zoneExtra(t: Trade): ZoneExtra {
  const z = tradeZones(t);
  return {
    hasReward: z.hasReward,
    hasRisk: z.hasRisk,
    rewardRealized: z.rewardRealized,
    riskRealized: z.riskRealized,
    stopMoved: z.stopMoved,
    rewardPct: z.rewardPct,
    riskPct: z.riskPct,
    rr: z.rr,
    labels: zoneLabels(z),
    win: t.pnl >= 0,
  };
}

/** The six points a `tradeZone` overlay is built from, or null when the trade's
 * span doesn't overlap the loaded bars at all (a 5m run's Jun-22 trade viewed on
 * 3m, whose broker history only reaches Jun-25). klinecharts would clamp every
 * off-window point onto the first bar, drawing a degenerate zero-width zone
 * stranded at the left edge, and scrollChartToTrade can't frame a span that is
 * not loaded — so the caller skips the zone entirely and leaves the row
 * highlighted instead.
 *
 * Shared by the initial draw and the replay reveal's per-step in-place update,
 * so the two cannot drift: an open trade's zone is re-pointed on every revealed
 * bar, and a geometry that disagreed with the draw would make the zone jump the
 * moment it was first updated. */
function zonePoints(
  t: Trade,
  chart: Chart,
  bars?: readonly KLineData[],
): Array<{ timestamp: number; value: number }> | null {
  const z = tradeZones(t);
  const entryTs = t.entry_time * 1000;
  const exitTs = t.exit_time * 1000;
  const hasExact = t.exit_time_exact != null;
  const exitPointTs = hasExact ? (t.exit_time_exact as number) * 1000 : exitTs;
  // `bars` lets the per-step caller hand over the list it already read rather
  // than scanning the whole loaded window twice on every revealed bar.
  const data = bars ?? chart.getDataList();
  // Robust bar interval, NOT the last-two-bars gap: that trailing gap can
  // straddle a session/overnight/weekend break (or the seam between loaded
  // history and a freshly appended live bar) and run to hours or days, which
  // would balloon the zone's right edge for a short-lived trade. See
  // minPositiveGap. The chart's declared width wins when registered: on a
  // custom timeframe the smallest gap is the day's short last bar.
  const barMs = (data && chartBarMs(chart, data.map((k) => k.timestamp))) || 1;
  if (data && data.length > 0) {
    const firstTs = data[0].timestamp;
    const lastTs = data[data.length - 1].timestamp;
    if (Math.max(entryTs, exitTs) < firstTs || Math.min(entryTs, exitTs) > lastTs) return null;
  }
  // End the zone AT the trade's exit so the reward/risk bands + entry line are
  // tight to the position's actual duration (a trailing pad made the box span
  // longer than the trade). Floor at one bar so a same-bar trade (entry≈exit)
  // still has a visible, non-zero width.
  const windowEnd = hasExact
    ? overlayEndTs(exitPointTs, data ?? [], barMs, entryTs)
    : Math.max(Math.max(entryTs, exitTs), entryTs + barMs);
  return [
    { timestamp: entryTs, value: t.entry_price },
    { timestamp: windowEnd, value: t.entry_price },
    { timestamp: entryTs, value: z.rewardLevel ?? t.entry_price },
    { timestamp: entryTs, value: z.riskLevel ?? t.entry_price },
    { timestamp: entryTs, value: z.stopMoved ? (t.stop_final as number) : t.entry_price },
    { timestamp: exitPointTs, value: t.exit_price },
  ];
}

// The ZONE_OVERLAY id drawSelectionZone created on its last call — read only by
// restoreOpenTradeZone, immediately after, so the per-step update can address
// that overlay directly. A module-level handoff rather than a return value
// because drawSelectionZone has four other callers that want nothing back.
let zoneOverlayId: string | null = null;

function drawSelectionZone(
  chart: Chart,
  artifacts: BacktestArtifacts,
  t: Trade,
  scroll = true,
): void {
  ensureZoneOverlayRegistered();
  const entryTs = t.entry_time * 1000;
  const exitPointTs = (t.exit_time_exact ?? t.exit_time) * 1000;
  const data = chart.getDataList();
  const points = zonePoints(t, chart);
  if (!points) return; // span doesn't overlap the loaded bars — see zonePoints
  const id = chart.createOverlay({
    name: ZONE_OVERLAY,
    lock: true,
    points,
    extendData: zoneExtra(t),
  });
  if (typeof id === "string") artifacts.selectionOverlayIds.push(id);
  zoneOverlayId = typeof id === "string" ? id : null;
  // Strategy-attached zones (e.g. the consolidation range a breakout broke out
  // of): one shaded rect each, cleared with the selection like the R/R zone.
  if (t.zones?.length) {
    ensureStrategyZoneOverlayRegistered();
    const firstTs = data && data.length > 0 ? data[0].timestamp : -Infinity;
    const lastTs = data && data.length > 0 ? data[data.length - 1].timestamp : Infinity;
    for (const z of t.zones) {
      const span = strategyZoneSpan(z, firstTs, lastTs);
      if (!span) continue;
      const zid = chart.createOverlay({
        name: STRATEGY_ZONE_OVERLAY,
        lock: true,
        points: [
          { timestamp: span.fromTs, value: z.top },
          { timestamp: span.toTs, value: z.bottom },
        ],
        extendData: { label: z.label },
      });
      if (typeof zid === "string") artifacts.selectionOverlayIds.push(zid);
    }
  }
  // `scroll` is false when the selection came from clicking an on-chart marker
  // — the user is already looking at the trade, so the view must not move.
  if (scroll) scrollChartToTrade(chart, entryTs, exitPointTs);
  // The jump can land the view far from where the (visible-range-virtualized)
  // markers were last drawn — remount them around the trade without waiting for
  // a scroll/zoom event to notice.
  ensureMarkersCoverVisibleRange(chart);
}

// An expr run posts { expr, enabled }[] rows (arrays); a coded BacktestRequest no
// longer carries longExit at all, so Array.isArray(longExit) cleanly separates
// expr (ExprRow[] → true) from coded (undefined → false). Both share
// epic/resolution, which is all runAndRender itself reads off the request.
export function isExprRequest(req: BacktestRequest | ExprBacktestRequest): req is ExprBacktestRequest {
  return Array.isArray((req as ExprBacktestRequest).longExit);
}

export async function runAndRender(
  chart: Chart,
  req: BacktestRequest | ExprBacktestRequest,
  scope: string,
  displayResolution: string,
  period?: BacktestPeriod,
  signal?: AbortSignal,
): Promise<StoredBacktestResult> {
  // Temporary phase timing (perf investigation).
  const t0 = performance.now();
  const result = isExprRequest(req) ? await runExprBacktest(req, signal) : await runBacktest(req, signal);
  const t1 = performance.now();
  // Drops the previous run's markers/equity/highlight/selection zone AND
  // detaches its highlight/selection subscriptions + resets
  // highlightTradeSignal/selectedTradeSignal — so a stale trade index from the
  // prior result can never draw against this run's data. (Does NOT delete the
  // persisted store — the save() below overwrites it with the fresh run.)
  teardownArtifacts(chart);
  // Persist so markers/equity/trades survive a timeframe switch and a full reload.
  // If the write was dropped (localStorage quota exhausted — several large runs
  // across cells share the ~5MB budget), the in-memory render below still works,
  // but a later rehydrate would find nothing: warn the user rather than let the
  // markers silently vanish on their next TF switch.
  const saveOk = saveBacktestResult(scope, req.epic, result, period);
  if (!saveOk) {
    toast("Backtest too large to save — it won't persist across timeframe switches or reloads.");
  }
  // Render for the CURRENTLY displayed timeframe, not blindly native: the run's
  // base TF (req.resolution) can differ from the chart's TF (the settings panel's
  // "base TF" dropdown lets you run e.g. 5m while viewing 1H), and running does
  // NOT switch the chart. Hardcoding native+equity then piled every fine fill onto
  // the coarse bars (aggregate's whole reason to exist) and drew a gappy equity
  // pane. Same flags rehydrate uses, so a run and a switch-away-and-back now agree.
  // On a successful save, render the freshly-STORED copy (downsampled equity +
  // period shading). If the save was dropped (quota), read-back would return a
  // STALE prior run — render the in-memory `result` instead so the chart matches
  // what just ran (and the toast's promise).
  const stored = (saveOk ? loadBacktestResult(scope, req.epic) : null) ?? result;
  const flags = backtestRenderFlags(displayResolution, req.resolution);
  const t2 = performance.now();
  renderArtifacts(chart, stored, { markerMode: flags.markerMode, canEquity: flags.drawEquity });
  const t3 = performance.now();
  console.info(
    `[backtest perf] runAndRender: backend total ${(t1 - t0).toFixed(0)}ms, ` +
      `teardown+persist ${(t2 - t1).toFixed(0)}ms, render ${(t3 - t2).toFixed(0)}ms ` +
      `(${stored.trades.length} trades, ${stored.markers.length} markers)`,
  );
  return stored;
}

/** Draw this result's trade markers for the CURRENT loaded bars, per
 * `artifacts.markerMode`:
 *   - "native"    — one locked `backtestMarker` overlay per fill (arrow + label),
 *                   skipping fills outside the loaded bar window (they'd otherwise
 *                   clamp onto the edge bar into a pile — see fillWithinLoadedWindow).
 *   - "aggregate" — recompute the per-bar DOM pill clusters (ChartCore's redraw
 *                   loop projects them).
 * Split out of renderArtifacts so `reanchorBacktestMarkers` can redraw ONLY the
 * markers after the history-coverage page-back extends the loaded window, without
 * re-creating the equity pane or re-installing the hover/selection subscriptions.
 * Assumes the caller cleared any prior marker overlays/clusters for this chart. */
function drawMarkers(chart: Chart, result: StoredBacktestResult, artifacts: BacktestArtifacts): void {
  if (artifacts.markerMode === "native") {
    // time|leg|side -> QUEUE of trade indexes, so each fill marker can be tied
    // back to the trade it belongs to (its opening fill is at entry_time, its
    // closing fill at exit_time). Side splits entries from exits at the same
    // bar; the queue disambiguates several same-leg trades sharing a timestamp
    // (scaling + flatten-at-close closes them on one bar) — a plain map's
    // last-write-wins would point all of those markers at one trade. Exit fills
    // book trades in fill order, so queue order matches marker order per key.
    const tradeIndexByFill = new Map<string, number[]>();
    const pushFillKey = (key: string, i: number) => {
      const q = tradeIndexByFill.get(key);
      if (q) q.push(i);
      else tradeIndexByFill.set(key, [i]);
    };
    result.trades.forEach((t, i) => {
      pushFillKey(`${t.entry_time}|${t.leg}|${t.leg === "long" ? "buy" : "sell"}`, i);
      pushFillKey(`${t.exit_time}|${t.leg}|${t.leg === "long" ? "sell" : "buy"}`, i);
    });

    // Replay's in-flight trades. Their ENTRY fill has a marker (it happened) but
    // no entry in the map above, because the reveal keeps an unclosed trade out of
    // `trades` — it has no P&L to report. Without this the newest marker on a
    // replaying chart is inert: no hover, no click, no selection, in the exact
    // spot the user is watching. It has no index for `selectedTradeSignal` to
    // carry, so its click draws the SAME windowed R/R zone a selected trade
    // gets, directly — with the zone's right edge at the cursor, since the exit
    // is the one part of the trade that has not happened yet.
    // A QUEUE per key, for the same reason the trade map above uses one: a
    // strategy that pyramids opens two trades on one bar, and both their entry
    // markers carry the identical time|leg|side. A plain map's last-write-wins
    // would point both markers at one trade and leave the other unreachable.
    const openByFill = new Map<string, OpenStrategyTrade[]>();
    for (const t of result.openTrades ?? []) {
      const key = `${t.entryTime}|${t.leg}|${t.leg === "long" ? "buy" : "sell"}`;
      const q = openByFill.get(key);
      if (q) q.push(t);
      else openByFill.set(key, [t]);
    }

    // Fill timestamps land on the native timeframe's bar opens. On a finer view
    // whose interval doesn't evenly divide the native one (3m viewing a 5m run) a
    // fill falls between two bars — snap it to the nearest loaded bar so the arrow
    // sits on a real candle. Same-or-evenly-dividing views already land exactly, so
    // snapNearestBar is a no-op there (returns the identical timestamp).
    const bars = chart.getDataList() ?? [];
    const barTimes = bars.map((k) => k.timestamp);
    // timestamp -> {high, low} so a marker can hang from whichever side of its
    // candle clears the body (markerPlacement), keyed by the snapped bar time.
    const barByTime = new Map(bars.map((k) => [k.timestamp, k]));

    // Virtualize to the visible range plus one visible-span of buffer per side
    // (floored so a tight zoom still buffers a real distance): only markers whose
    // fill lands inside the window get overlays. ensureMarkersCoverVisibleRange
    // (wired to scroll/zoom in ChartCore) schedules a remount once panning
    // approaches the window's edge. An edge that reaches the corresponding end
    // of the loaded data is recorded as ±Infinity — bars appended at the live
    // edge, or a window that starts at the oldest loaded bar, must not read as
    // "outside the drawn span" (markers can only appear via a prepend, which the
    // extendBacktestArtifacts path already remounts for).
    const vr = chart.getVisibleRange();
    const span = Math.max(vr.to - vr.from, 1);
    const buf = Math.max(span, 200);
    const loIdx = Math.max(0, Math.floor(vr.from - buf));
    const hiIdx = Math.min(bars.length - 1, Math.ceil(vr.to + buf));
    const winFromTs = loIdx <= 0 ? -Infinity : (bars[loIdx]?.timestamp ?? -Infinity);
    const winToTs = hiIdx >= bars.length - 1 ? Infinity : (bars[hiIdx]?.timestamp ?? Infinity);
    artifacts.markerDrawWindow = { fromTs: winFromTs, toTs: winToTs };
    // Culling by the RAW fill time is safe for the trade-index queues below:
    // same-key markers share the exact timestamp, so they are always culled (or
    // kept) together and the per-key queue order can't skew.
    const inDrawWindow = (tMs: number) => tMs >= winFromTs && tMs <= winToTs;

    // Trade markers -> locked backtestMarker overlays (arrow + label). Markers
    // that map to a trade also emphasize/scroll the trades panel row on hover
    // (chart -> row half of the two-way sync; the row -> chart half is the
    // highlightTradeSignal subscription in renderArtifacts). The gating on
    // `backtestResultSignal.value === artifacts.result` (identity) keeps a not-currently-
    // shown cell's markers inert instead of cross-talking into another chart's
    // trade indices — a backtest can be rendered in more than one cell at once.
    ensureMarkerOverlayRegistered();
    // Pill collision counter per snapped bar + placement (see nextMarkerStack):
    // markers iterate in fill order, so the earlier fill keeps the candle-hugging
    // spot and later same-bar fills stack outward.
    const pillStacks = new Map<string, number>();
    for (const m of result.markers) {
      // Skip fills outside the loaded bar window: on a finer timeframe the
      // backtest may predate the (much shorter) loaded history, and snapNearestBar
      // would otherwise clamp every such fill onto the edge bar — the disconnected
      // marker pile. In-window fills still snap normally (3m viewing a 5m run).
      // The history-coverage page-back then loads the older bars and
      // reanchorBacktestMarkers redraws, so the initially-skipped fills reappear
      // on their real candles once covered.
      if (!fillWithinLoadedWindow(m.time * 1000, barTimes)) continue;
      if (!inDrawWindow(m.time * 1000)) continue;
      const idx = tradeIndexByFill.get(`${m.time}|${m.leg}|${m.side}`)?.shift();
      // Only consulted when the marker has no trade behind it, so a closed trade's
      // marker keeps its existing behaviour untouched.
      const openTrade =
        idx === undefined ? openByFill.get(`${m.time}|${m.leg}|${m.side}`)?.shift() : undefined;
      const snappedTs = snapNearestBar(m.time * 1000, barTimes);
      const bar = barByTime.get(snappedTs);
      // Shared click handler for this trade's fill marker AND its signal caret:
      // sticky-select the trade, same as clicking its dock row — the
      // selectedTradeSignal subscription draws the risk/reward zone and scrolls
      // to it. Clicking the already-selected trade toggles it back off. One
      // definition so the two glyphs of the same trade can't drift apart.
      const toggleTradeSelect = () => {
        if (backtestResultSignal.value === artifacts.result && idx !== undefined) {
          // The user clicked the trade ON the chart — they're already looking
          // at it, so the selection subscription must not pan/zoom the view.
          // Signal.set notifies synchronously; the subscription reads-and-
          // clears this flag.
          selectFromMarkerClick = true;
          try {
            selectedTradeSignal.set(selectedTradeSignal.value === idx ? null : idx);
          } finally {
            selectFromMarkerClick = false;
          }
        }
        return false;
      };
      const pillPlacement = bar ? markerPlacement(m.price, bar.high, bar.low) : "above";
      const id = chart.createOverlay({
        name: MARKER_OVERLAY,
        points: [{ timestamp: snappedTs, value: m.price }],
        lock: true, // backtest artifacts: not user-editable
        extendData: {
          label: markerPillLabel(m.side, m.leg, m.reason),
          win: idx !== undefined ? result.trades[idx].pnl >= 0 : null,
          placement: pillPlacement,
          stack: nextMarkerStack(pillStacks, snappedTs, pillPlacement),
        } satisfies MarkerExtra,
        // v10 deletes an overlay on right-click unless the handler calls
        // e.preventDefault() (lock:true does NOT protect it) — without this a
        // right-click on a fill marker silently removed it until the next reconcile.
        // Top-level (not inside the idx spread) so idx-less markers are safe too.
        onRightClick: (e) => {
          e.preventDefault?.();
          return false;
        },
        ...(idx !== undefined
          ? {
              onMouseEnter: () => {
                if (backtestResultSignal.value === artifacts.result) {
                  highlightTradeSignal.set(idx);
                  setMarkerHoverCursor(chart, true);
                }
                return false;
              },
              onMouseLeave: () => {
                if (backtestResultSignal.value === artifacts.result) {
                  highlightTradeSignal.set(null);
                  setMarkerHoverCursor(chart, false);
                }
                return false;
              },
              onClick: toggleTradeSelect,
            }
          : openTrade !== undefined
            ? (() => {
                const openKey = {
                  index: openTrade.index,
                  entryTime: openTrade.entryTime,
                  leg: openTrade.leg,
                  entryPrice: openTrade.entryPrice,
                };
                return {
                  // tradeMarkerHoverSignal is load-bearing, not decoration:
                  // ChartCore's DOM click handler reads it (`overTradeMarker`)
                  // to know the click landed on a marker and skip both its own
                  // line hit-test and the empty-space deselect — without the
                  // tell, the DOM click that follows this overlay's onClick
                  // fights the zone it just drew. Same idiom as
                  // lib/tradeMarkers' live glyphs. No `tradeId`: there is no
                  // trade-line selection behind this marker for a double-click
                  // to open. label is empty on purpose: this marker paints its
                  // own pill, so the DOM hover popover (which skips empty
                  // labels) must not duplicate it.
                  onMouseEnter: (e: { pageX?: number; pageY?: number }) => {
                    tradeMarkerHoverSignal.set({
                      label: "",
                      win: null,
                      x: e.pageX ?? 0,
                      y: e.pageY ?? 0,
                    });
                    setMarkerHoverCursor(chart, true);
                    return false;
                  },
                  onMouseLeave: () => {
                    tradeMarkerHoverSignal.set(null);
                    setMarkerHoverCursor(chart, false);
                    return false;
                  },
                  // Same treatment as clicking any other trade's marker: the
                  // windowed R/R zone. It cannot travel through
                  // selectedTradeSignal (an open trade has no index in
                  // `trades`), so the zone is drawn directly. Toggle semantics
                  // match toggleTradeSelect: clicking the marker again takes
                  // its zone back off.
                  onClick: () => {
                    if (backtestResultSignal.value !== artifacts.result) return false;
                    const wasDrawn = artifacts.openZoneFor?.index === openTrade.index;
                    // One selection at a time. The set clears a selected CLOSED
                    // trade's zone (and its panel row) through the subscription
                    // renderArtifacts installed; the explicit remove covers this
                    // zone itself (no subscription owns it) and re-nulls
                    // openZoneFor either way. The marker-click flag skips the
                    // subscription's scroll, as toggleTradeSelect does.
                    selectFromMarkerClick = true;
                    try {
                      selectedTradeSignal.set(null);
                    } finally {
                      selectFromMarkerClick = false;
                    }
                    removeSelectionOverlays(chart, artifacts);
                    if (!wasDrawn) {
                      zoneOverlayId = null;
                      drawSelectionZone(chart, artifacts, openTradeAsTrade(openTrade, chart), false);
                      artifacts.openZoneFor = openKey;
                      // Recorded here too, not just in restoreOpenTradeZone:
                      // without it the FIRST step after the click would rebuild
                      // the overlay before the in-place path could take over.
                      artifacts.openZoneOverlayId = zoneOverlayId;
                    }
                    return false;
                  },
                };
              })()
            : {}),
      });
      if (typeof id === "string") artifacts.markerIds.push(id);

      // Signal-candle glyph: a subtle caret on the bar BEFORE this fill, drawn
      // only for a rule-based fill (non-empty terms) whose signal bar is loaded.
      // Built via the same tested filter the popover uses, and drawn HERE in the
      // fill's loop iteration so it reuses the already-resolved trade `idx` and
      // shares the fill marker's highlight group (signal ↔ fill ↔ row light up
      // together). Tracked in markerIds so teardown/reanchor clears it too.
      const [glyph] = buildSignalGlyphs([m]);
      if (glyph && idx !== undefined) glyph.tradeNo = idx + 1; // dock row number
      if (
        glyph &&
        fillWithinLoadedWindow(glyph.signalTime * 1000, barTimes) &&
        inDrawWindow(glyph.signalTime * 1000)
      ) {
        const sigSnapped = snapNearestBar(glyph.signalTime * 1000, barTimes);
        const sigBar = barByTime.get(sigSnapped);
        // Anchor at the signal bar's low (long ⇒ glyph hangs below) / high (short
        // ⇒ above) so the caret clears the body; fall back to the fill price when
        // the snapped bar isn't in the map.
        const anchorPrice = sigBar
          ? glyph.placement === "below"
            ? sigBar.low
            : sigBar.high
          : m.price;
        ensureSignalGlyphOverlayRegistered();
        const sid = chart.createOverlay({
          name: SIGNAL_OVERLAY,
          points: [{ timestamp: sigSnapped, value: anchorPrice }],
          lock: true,
          extendData: { placement: glyph.placement } satisfies SignalMarkerExtra,
          // v10 deletes an overlay on right-click unless the handler calls
          // e.preventDefault() (lock:true does NOT protect it) — keep the signal glyph.
          onRightClick: (e) => {
            e.preventDefault?.();
            return false;
          },
          onMouseEnter: (e) => {
            if (backtestResultSignal.value === artifacts.result) {
              backtestSignalHoverSignal.set({ glyph, x: e.pageX ?? 0, y: e.pageY ?? 0 });
              if (idx !== undefined) highlightTradeSignal.set(idx);
              setMarkerHoverCursor(chart, true);
            }
            return false;
          },
          onMouseLeave: () => {
            if (backtestResultSignal.value === artifacts.result) {
              backtestSignalHoverSignal.set(null);
              if (idx !== undefined) highlightTradeSignal.set(null);
              setMarkerHoverCursor(chart, false);
            }
            return false;
          },
          onClick: toggleTradeSelect,
        });
        if (typeof sid === "string") artifacts.markerIds.push(sid);
      }
    }
  } else if (artifacts.markerMode === "aggregate") {
    // Aggregate: bucket trades per currently-loaded bar and stash the clusters;
    // ChartCore's redraw loop projects them to pixels and renders the DOM pill
    // layer (which owns the hover popover + click-to-drill-in). No klinecharts
    // overlays here — see the module note above.
    const bars = (chart.getDataList() ?? []).map((k) => ({ timestamp: k.timestamp, high: k.high }));
    artifacts.aggClusters = aggregateTradesByBar(result.trades, bars);
    artifacts.markerDrawWindow = null; // native-only bookkeeping
  }
}

/** The oldest bar timestamp (ms) this chart needs loaded to draw its backtest
 * artifacts, or null when nothing is drawn (no result, or a markerMode-"none"
 * run with no period). The min over the marker anchors (skipped when markerMode
 * is "none" — nothing to draw) AND the traded period's start: bands render on
 * every timeframe and a run's period can begin before its first fill, so
 * covering only the fills would leave the band truncated. ChartCore and the
 * anchor-coverage walk fold this into their history page-backs, then call
 * reanchorBacktestMarkers; extendBacktestArtifacts uses it as its skip guard —
 * one definition of "what the run needs loaded" for every path. */
export function getBacktestCoverageFromTs(chart: Chart): number | null {
  const a = artifactsByChart.get(chart);
  if (!a || !a.result) return null;
  const needed = Math.min(
    a.markerMode !== "none" ? (oldestBacktestAnchorMs(a.result.markers) ?? Infinity) : Infinity,
    a.result.period?.fromMs ?? Infinity,
  );
  return Number.isFinite(needed) ? needed : null;
}

/** Redraw a chart's backtest markers against the CURRENT loaded bars — call
 * after the history-coverage page-back loads older history the initial
 * recent-only load didn't cover. On a finer timeframe the initial load starts
 * well after the backtest's own range, so renderArtifacts culled every fill as
 * out-of-window (clamping them would pile them at the left edge). Once the
 * covering bars page in, this recreates the native overlays / recomputes the
 * aggregate clusters so the markers land on their real candles. Markers and
 * period bands ONLY — the equity pane and the highlight/selection subscriptions
 * renderArtifacts installed stay in place (re-running the full render would
 * double-install them). No-op if this chart has no rendered result. Bands
 * redraw even when markerMode is "none": renderArtifacts draws them on every
 * timeframe (they're pure time spans), so gating them on markerMode would
 * leave a band-only chart truncated forever. */
export function reanchorBacktestMarkers(chart: Chart): void {
  const artifacts = artifactsByChart.get(chart);
  if (!artifacts || !artifacts.result) return;
  if (artifacts.markerMode !== "none") {
    redrawMarkersOnly(chart, artifacts);
  }
  clearPeriodBands(chart, artifacts);
  drawPeriodBands(chart, artifacts, artifacts.result);
}

/** Tear down and redraw ONLY the fill markers / aggregate clusters — the shared
 * body of the reanchor, the "Show Markers" toggle flip, and the visible-range
 * remount below. Respects the toggle: a redraw never resurrects markers the
 * user has hidden. */
function redrawMarkersOnly(chart: Chart, artifacts: BacktestArtifacts): void {
  for (const id of artifacts.markerIds) chart.removeOverlay({ id });
  artifacts.markerIds = [];
  artifacts.aggClusters = [];
  artifacts.markerDrawWindow = null;
  if (backtestMarkersShownSignal.value && artifacts.result) {
    drawMarkers(chart, artifacts.result, artifacts);
  }
}

/** Remount native markers when the view pans/zooms toward the edge of the span
 * they were drawn for (drawMarkers virtualizes to visible range + buffer).
 * Called from ChartCore's scroll/zoom subscription; the check is a couple of
 * comparisons, the actual remount is debounced so a continuous drag redraws
 * once per settle, not per event. */
export function ensureMarkersCoverVisibleRange(chart: Chart): void {
  const artifacts = artifactsByChart.get(chart);
  const win = artifacts?.markerDrawWindow;
  if (!artifacts?.result || artifacts.markerMode !== "native" || !win) return;
  if (!backtestMarkersShownSignal.value) return;
  const bars = chart.getDataList() ?? [];
  if (bars.length === 0) return;
  const vr = chart.getVisibleRange();
  const fromTs = bars[Math.max(0, Math.min(vr.from, bars.length - 1))]?.timestamp;
  const toTs = bars[Math.max(0, Math.min(vr.to - 1, bars.length - 1))]?.timestamp;
  if (fromTs == null || toTs == null) return;
  if (fromTs >= win.fromTs && toTs <= win.toTs) return; // still inside the buffer
  const prior = markerRemountTimerByChart.get(chart);
  if (prior != null) clearTimeout(prior);
  markerRemountTimerByChart.set(
    chart,
    setTimeout(() => {
      markerRemountTimerByChart.delete(chart);
      const a = artifactsByChart.get(chart);
      if (a?.result && a.markerMode === "native") redrawMarkersOnly(chart, a);
    }, 150),
  );
}
const markerRemountTimerByChart = new WeakMap<Chart, ReturnType<typeof setTimeout>>();

/** Redraw a chart's backtest artifacts after older history streamed in via the
 * NATIVE scroll-back loader (the user dragging left), which the coverage-walk
 * pagers don't own — without this, markers the recent-only load culled and
 * period bands computed (and clamped) against the then-loaded window stay
 * missing/truncated forever once the covering bars actually arrive. Worst on 1m,
 * whose initial load rarely overlaps the traded span at all.
 *
 * The redraw is skipped when it's provably a no-op, so a long drag doesn't pay
 * a full overlay teardown/rebuild per prepended page: `prevOldestMs` (oldest
 * loaded bar BEFORE the prepend) already past the run's coverage need means
 * everything was drawn; `newOldestMs` (the prepend's first bar) still NEWER
 * than the run's newest drawable time means the window hasn't reached the run
 * yet and nothing new can anchor. Only pages that actually move the window
 * across the run's span redraw. */
export function extendBacktestArtifacts(
  chart: Chart,
  prevOldestMs: number,
  newOldestMs: number,
): void {
  const artifacts = artifactsByChart.get(chart);
  if (!artifacts || !artifacts.result) return;
  const needed = getBacktestCoverageFromTs(chart);
  if (needed == null || needed >= prevOldestMs) return; // already fully covered
  let newestNeeded = artifacts.result.period?.toMs ?? -Infinity;
  for (const m of artifacts.result.markers) {
    newestNeeded = Math.max(newestNeeded, m.time * 1000);
  }
  if (newestNeeded < newOldestMs) return; // window hasn't reached the run yet
  scheduleReanchor(chart);
}

// Coalesce a scroll-back page chain's redraws. Each prepended page that crosses
// the run's span requests a reanchor, but a drag lands several pages per second
// and a full overlay teardown+rebuild + period-band recompute per page (cost
// growing with the loaded bar count) froze the chart in bursts. A trailing
// debounce turns the chain into one redraw once the pages settle; a chart torn
// down before the timer fires is a no-op (reanchorBacktestMarkers bails when
// its artifacts are gone).
const reanchorTimerByChart = new WeakMap<Chart, ReturnType<typeof setTimeout>>();
function scheduleReanchor(chart: Chart): void {
  const prior = reanchorTimerByChart.get(chart);
  if (prior != null) clearTimeout(prior);
  reanchorTimerByChart.set(
    chart,
    setTimeout(() => {
      reanchorTimerByChart.delete(chart);
      reanchorBacktestMarkers(chart);
    }, 150),
  );
}

/** Draw a backtest result's on-chart artifacts (equity sub-pane + trade
 * markers) and wire the trades-panel hover/selection sync. Shared by a fresh
 * run (runAndRender) and a rehydrate after a timeframe switch / reload
 * (rehydrateBacktest). The caller is responsible for tearing down any prior
 * artifacts first and for publishing `backtestResultSignal` with THIS exact
 * `result` object (the sync gating below is identity-based).
 *
 * `drawEquity` renders the equity curve (on any timeframe — equityForBars
 * re-anchors the native-bar series to the loaded bars). `markerMode` picks how
 * trades are drawn:
 *   - "native"    — per-fill arrows (same-or-finer timeframe where each fill
 *                   timestamp still lands on a bar boundary).
 *   - "aggregate" — one pill per bar (count + net P&L) on a COARSER timeframe,
 *                   where individual fills would collapse onto the same bar.
 *   - "none"      — nothing drawn (a finer timeframe that doesn't divide the
 *                   native one, so fills can't be anchored).
 * The trades-panel row↔chart hover/selection sync (highlight segment + windowed
 * risk/reward zone) is installed for BOTH "native" and "aggregate" — those are
 * timestamp-anchored and work on any timeframe, so the panel stays interactive
 * when zoomed out. On "none" nothing is drawn and no sync installed, but the
 * result stays saved and the panel still shows it. */
export function renderArtifacts(
  chart: Chart,
  result: StoredBacktestResult,
  { markerMode, canEquity }: { markerMode: "native" | "aggregate" | "none"; canEquity: boolean },
): void {
  const artifacts = artifactsFor(chart);

  // Equity curve -> own sub-pane, gated by the "Equity" toggle AND the
  // timeframe-known flag (canEquity). A live add/remove so flipping the toggle in
  // the Results row shows/hides the pane without re-running. The series travels on
  // the instance's extendData so this chart's calc looks up its own values.
  const addEquity = () => {
    if (artifacts.equityIndicatorId) return; // already drawn
    // Ascending [timestampMs, value] pairs — equityForBars re-anchors them onto
    // whatever bars are loaded (any timeframe), so no per-timeframe map.
    const equityPoints: Array<[number, number]> = result.equity.map((p) => [p.time * 1000, p.value]);
    // v10 createIndicator returns the INDICATOR id (not the pane id) — remove by id.
    artifacts.equityIndicatorId =
      chart.createIndicator({ name: EQUITY_INDICATOR, extendData: equityPoints }, false) ?? null;
  };
  const removeEquity = () => {
    if (artifacts.equityIndicatorId) {
      chart.removeIndicator({ id: artifacts.equityIndicatorId });
      artifacts.equityIndicatorId = null;
    }
  };
  if (canEquity && backtestEquityShownSignal.value) addEquity();
  const unsubEquity = backtestEquityShownSignal.subscribe(() => {
    if (canEquity && backtestEquityShownSignal.value) addEquity();
    else removeEquity();
  });

  // Always record the result + trades so teardownArtifacts' ownership check and
  // any installed subscriptions read a coherent state, even when nothing is
  // drawn (coarser timeframe).
  artifacts.trades = result.trades;
  artifacts.result = result;
  artifacts.markerMode = markerMode;
  artifacts.aggClusters = []; // set by drawMarkers only in "aggregate" mode

  // Period shading — draw now (gated by the toggle) and redraw on toggle flips.
  // Installed BEFORE the markerMode "none" early-return so periods still respond
  // to the toggle on a timeframe where markers aren't drawn.
  clearPeriodBands(chart, artifacts);
  drawPeriodBands(chart, artifacts, result);
  const redrawBands = () => {
    clearPeriodBands(chart, artifacts);
    drawPeriodBands(chart, artifacts, result);
  };
  const unsubPeriodsOnly = backtestPeriodsShownSignal.subscribe(redrawBands);
  const unsubRegions = backtestRegionsShownSignal.subscribe(redrawBands);
  const unsubPeriods = () => {
    unsubPeriodsOnly();
    unsubRegions();
  };

  if (markerMode === "none") {
    artifacts.unsub = () => {
      unsubPeriods();
      unsubEquity();
    };
    return;
  }

  // Draw the trade markers for the currently-loaded bars, gated by the "Show
  // Markers" toggle. Split out so the history-coverage page-back can redraw JUST
  // the markers later (see reanchorBacktestMarkers) without re-creating the equity
  // pane or re-installing the subscriptions below. The toggle subscription clears/
  // redraws ONLY the markers on a flip, leaving the equity pane, period bands, and
  // the selection/highlight subs below (installed regardless of the toggle, so
  // selecting a trade still draws its zone with markers off) untouched.
  if (backtestMarkersShownSignal.value) drawMarkers(chart, result, artifacts);
  const unsubMarkers = backtestMarkersShownSignal.subscribe(() => {
    redrawMarkersOnly(chart, artifacts);
  });

  // Row -> chart: draw ONE transient locked line spanning entry -> exit,
  // colored win/loss, while a row (or a marker, above) is highlighted; null
  // removes it. Never persisted, never more than one at a time.
  const unsubHighlight = highlightTradeSignal.subscribe((i) => {
    // Every subscriber clears its OWN leftover line unconditionally (so a chart
    // that just lost "active" status — the panel switched to another cell's
    // result — can't strand a stale line), but only the panel's currently
    // active backtest draws a new one (see note above).
    if (artifacts.highlightOverlayId) {
      chart.removeOverlay({ id: artifacts.highlightOverlayId });
      artifacts.highlightOverlayId = null;
    }
    if (i == null || backtestResultSignal.value !== artifacts.result) return;
    const t = artifacts.trades[i];
    if (!t) return;
    const id = chart.createOverlay({
      name: "segment",
      points: [
        { timestamp: t.entry_time * 1000, value: t.entry_price },
        { timestamp: (t.exit_time_exact ?? t.exit_time) * 1000, value: t.exit_price },
      ],
      lock: true,
      needDefaultPointFigure: false,
      styles: { line: { color: t.pnl >= 0 ? BUY_COLOR : SELL_COLOR, style: 'solid' } },
      // v10 deletes an overlay on right-click unless the handler calls
      // e.preventDefault() — keep this transient highlight from vanishing on right-click.
      onRightClick: (e) => {
        e.preventDefault?.();
        return false;
      },
    });
    artifacts.highlightOverlayId = typeof id === "string" ? id : null;
  });

  // Row click -> chart: draw the STICKY windowed risk/reward zone for the
  // selected trade and pan/zoom to its span; null removes it. Unlike the
  // transient highlight above, this persists until the selection changes —
  // gated the same way (identity on backtestResultSignal) so only the chart
  // backing the panel's currently displayed result draws/moves.
  // (focusTradeSignal — the older one-shot "just scroll" signal — lost its
  // click publisher when the panel switched to selectedTradeSignal; this
  // subscription is the one that now does both the draw AND the scroll, so
  // focusTradeSignal is no longer consumed here.)
  const unsubSelection = selectedTradeSignal.subscribe((i) => {
    // Every subscriber clears its OWN leftover zone unconditionally (same
    // "active chart may have changed" reasoning as the highlight above).
    removeSelectionOverlays(chart, artifacts);
    // A fresh selection supersedes any prior "can't reach this trade" notice.
    backtestSelectNoticeSignal.set(null);
    if (i == null || backtestResultSignal.value !== artifacts.result) return;
    const t = artifacts.trades[i];
    if (!t) return;
    const entryTs = t.entry_time * 1000;
    const exitTs = t.exit_time * 1000;
    // A rule-based entry's signal caret anchors one bar BEFORE the entry fill
    // (its signal bar). Fold that bar into the coverage span so paging to reach
    // this trade loads it too — otherwise the page-back lands exactly on the
    // entry bar, leaving the signal bar just outside the window, and drawMarkers
    // draws the arrow but skips the caret (the leftmost-entry "missing caret" bug).
    // Read through `artifacts`, not the closure: updateShownResult can advance
    // the shown result in place (the replay reveal does, once per bar), and a
    // subscription still consulting the object it was installed with would go
    // looking for this trade's caret in a stale marker list.
    const entryMarker = (artifacts.result?.markers ?? []).find(
      (m) => m.time === t.entry_time && m.leg === t.leg && isEntryFill(m.side, m.leg),
    );
    const signalTs = entryMarker?.signal_time != null ? entryMarker.signal_time * 1000 : entryTs;
    const data = chart.getDataList();
    const firstTs = data?.[0]?.timestamp;
    const lastTs = data?.[data.length - 1]?.timestamp;
    const lo = Math.min(entryTs, exitTs, signalTs);
    const hi = Math.max(entryTs, exitTs);
    // In the loaded window → draw + scroll straight away (the common case; also
    // when firstTs/lastTs are unknown, let drawSelectionZone's own guard decide).
    // A selection that came from clicking the trade's own on-chart marker skips
    // the scroll entirely — the user is already looking at it.
    if (firstTs == null || lastTs == null || (hi >= firstTs && lo <= lastTs)) {
      drawSelectionZone(chart, artifacts, t, !selectFromMarkerClick);
      return;
    }
    // Out of window. A finer timeframe's initial load is recent-only, so an older
    // trade sits before the first loaded bar — page history in to cover it, then
    // draw + scroll. (A future-side trade, lo > lastTs, can't be paged toward;
    // fall through to the notice.) Guard against the selection / active result
    // changing during the async walk before drawing.
    const pager = pagerByChart.get(chart);
    if (pager && lo < firstTs) {
      // Paging a fine timeframe back several months is a few seconds of sequential
      // fetches — show a note NOW so the click doesn't read as "nothing happened"
      // (a silent gap is indistinguishable from the very bug this fixes). Replaced
      // in the .then: cleared on success (the scroll is the feedback), or swapped
      // for the "too far back" notice when the walk can't reach the trade.
      backtestSelectNoticeSignal.set("Loading history for this trade…");
      void pager(lo).then((reached) => {
        if (selectedTradeSignal.value !== i || backtestResultSignal.value !== artifacts.result) return;
        backtestSelectNoticeSignal.set(null);
        if (reached) drawSelectionZone(chart, artifacts, t);
        else
          backtestSelectNoticeSignal.set(
            "This trade is older than the history available at this timeframe — open it on a higher timeframe.",
          );
      });
      return;
    }
    backtestSelectNoticeSignal.set(
      "This trade is outside the loaded range on this timeframe.",
    );
  });

  artifacts.unsub = () => {
    unsubHighlight();
    unsubSelection();
    unsubPeriods();
    unsubEquity();
    unsubMarkers();
  };
}

// ─── Walk-forward (WFO) chart artifacts ──────────────────────────────────────
// The stitched out-of-sample equity curve + alternating fold shading for a
// walk-forward result. Reuses the EQUITY_INDICATOR and PERIOD_OVERLAY machinery
// above (one results overlay at a time, so renderWfoArtifacts tears down first),
// so WFO artifacts are cleared by teardownArtifacts like any other backtest.

/** Render a walk-forward scheme's stitched OOS equity curve and fold shading on
 * `chart`. Tears down any prior results overlay first (only one at a time), then
 * draws the equity pane (gated by wfoEquityShownSignal, series picked by
 * wfoEquityCompoundedSignal) and the alternating fold bands (gated by
 * wfoBandsShownSignal) — mirroring renderArtifacts' equity add/remove +
 * subscription idiom so the Results-row toggles show/hide/swap live without a
 * re-run. */
export function renderWfoArtifacts(chart: Chart, scheme: WfoScheme): boolean {
  // Not onto a REPLAYING chart. A walk-forward scheme is fold bands and a
  // stitched out-of-sample equity curve over real calendar dates, and the first
  // thing this function does is teardownArtifacts — which would drop the
  // progressive reveal the session is drawing and replace it with the run's full
  // future. Both callers live in BacktestButton (the results panel's scheme
  // picker, and the render that follows a completed run), so the gate belongs
  // here rather than on either of them.
  //
  // Returns whether it rendered, so the picker can SAY that it refused instead
  // of looking like a control that did nothing.
  if (isChartReplaying(chart)) return false;
  teardownArtifacts(chart);
  const artifacts = artifactsFor(chart);

  // Equity pane — same createIndicator/extendData path as renderArtifacts, but
  // the series and its shown/compounded gating come from the WFO signals.
  const addEquity = () => {
    if (artifacts.equityIndicatorId) return; // already drawn
    const points = wfoEquityPoints(scheme, wfoEquityCompoundedSignal.value);
    artifacts.equityIndicatorId =
      chart.createIndicator({ name: EQUITY_INDICATOR, extendData: points }, false) ?? null;
  };
  const removeEquity = () => {
    if (artifacts.equityIndicatorId) {
      chart.removeIndicator({ id: artifacts.equityIndicatorId });
      artifacts.equityIndicatorId = null;
    }
  };
  if (wfoEquityShownSignal.value) addEquity();
  const unsubEquity = wfoEquityShownSignal.subscribe(() => {
    if (wfoEquityShownSignal.value) addEquity();
    else removeEquity();
  });
  // Compounded vs summed: swap the series in place (only while the pane shows).
  const unsubCompounded = wfoEquityCompoundedSignal.subscribe(() => {
    if (!wfoEquityShownSignal.value) return;
    removeEquity();
    addEquity();
  });

  // Fold shading — reuse the period-band overlay; each band is a locked
  // full-height rect over one OOS test span. Mirrors drawPeriodBands' point
  // shape (timestamp + an in-range y so the point projects).
  const drawBands = () => {
    if (!wfoBandsShownSignal.value) return;
    const data = chart.getDataList() ?? [];
    if (data.length === 0) return;
    ensurePeriodOverlayRegistered();
    const yVal = data[0].close; // a valid in-range price so the point projects (y is unused)
    for (const b of wfoFoldBandPoints(scheme)) {
      const id = chart.createOverlay({
        name: PERIOD_OVERLAY,
        lock: true,
        points: [
          { timestamp: b.from, value: yVal },
          { timestamp: b.to, value: yVal },
        ],
      });
      if (typeof id === "string") artifacts.periodBandIds.push(id);
    }
  };
  drawBands();
  const unsubBands = wfoBandsShownSignal.subscribe(() => {
    clearPeriodBands(chart, artifacts);
    drawBands();
  });

  artifacts.unsub = () => {
    unsubEquity();
    unsubCompounded();
    unsubBands();
  };
  return true;
}

/** Remove this chart's WFO artifacts (equity pane + fold bands) and detach their
 * subscriptions. Identical to teardownArtifacts — named for symmetry with the
 * render path and for callers that only mean to clear WFO output. */
export function clearWfoArtifacts(chart: Chart): void {
  teardownArtifacts(chart);
}

/** Decide what a saved backtest renders on the `current` timeframe given the
 * `native` one it was run on:
 *  - markerMode:
 *      "native"    — the native timeframe and ANY finer one: per-fill arrows.
 *                    When the finer interval doesn't evenly divide the native
 *                    one (e.g. 3m viewing a 5m run) a fill falls between bars, so
 *                    renderArtifacts snaps it to the nearest bar. 5m shows on
 *                    1m/3m/5m.
 *      "aggregate" — any COARSER timeframe: one pill per bar (count + net P&L),
 *                    since individual fills would collapse onto the same bar.
 *                    5m aggregates on 15m/1H/1D.
 *      "none"      — only when a resolution is unknown (no bar width to compare).
 *  - equity: drawn on ANY known timeframe — equityForBars re-anchors the
 *    native-bar series to the loaded bars (bar-close on coarser TFs, a native-
 *    granularity step on finer ones). Only an unknown resolution disables it.
 * Pure + exported for tests. */
export function backtestRenderFlags(
  current: string,
  native: string,
): { markerMode: "native" | "aggregate" | "none"; drawEquity: boolean } {
  const cur = RESOLUTION_SECONDS[current] ?? 0;
  const nat = RESOLUTION_SECONDS[native] ?? 0;
  let markerMode: "native" | "aggregate" | "none" = "none";
  if (cur > 0 && nat > 0) markerMode = cur > nat ? "aggregate" : "native";
  return { markerMode, drawEquity: cur > 0 && nat > 0 };
}

/** Restore a cell's saved backtest onto the chart after a symbol/timeframe
 * change or a page reload — the counterpart to overlays.rehydrate for backtest
 * artifacts. Called from ChartCore once the new series' bars are loaded.
 *
 * Markers render on the backtest's native timeframe AND any finer one where the
 * fill timestamps still align to bar boundaries (per-fill arrows), and on any
 * coarser timeframe as one aggregate pill per bar; the equity curve renders on
 * any timeframe (re-anchored to bar-close). The result stays saved and the
 * panel is repopulated regardless, so it's always discoverable. */
export function rehydrateBacktest(
  chart: Chart,
  scope: string,
  epic: string,
  resolution: string,
): void {
  // Did THIS chart own the panel before we tear it down? Only an owner may clear
  // the shared panel below — otherwise, in a split layout, a cell with no saved
  // backtest would null another cell's freshly-published result on mount.
  const prev = artifactsByChart.get(chart);
  const owned = !!prev && backtestResultSignal.value === prev.result;
  // Clean slate (the ChartCore effect also tears down synchronously on switch;
  // this is defensive so a direct call can't stack artifacts).
  teardownArtifacts(chart);
  const saved = loadBacktestResult(scope, epic);
  if (!saved) {
    // No backtest for this cell/epic — clear the panel only if this cell was the
    // one showing a result (switched to a no-backtest symbol/TF). A cell that
    // never owned the panel leaves another cell's result alone.
    if (owned) backtestResultSignal.set(null);
    return;
  }
  const flags = backtestRenderFlags(resolution, saved.resolution);
  renderArtifacts(chart, saved, { markerMode: flags.markerMode, canEquity: flags.drawEquity });
  // Publish with THIS exact object so renderArtifacts' identity-gated sync binds
  // to it, and the trades panel / summary chip repopulate.
  backtestResultSignal.set(saved);
  // NOTE: re-selecting the previously-studied trade is deliberately NOT done
  // here — ChartCore defers it (restoreTradeSelection) until its switch-time
  // coverage walks settle, because their applyNewData prepends reset the view
  // and would clobber the re-center scroll.
}

/** Remove a chart's live backtest artifacts (markers, equity pane, highlight +
 * selection overlays) and detach its subscriptions — WITHOUT touching the
 * persisted store. Used on a symbol/timeframe change and on unmount, where the
 * saved result must survive to be rehydrated. */
export function teardownArtifacts(chart: Chart): void {
  const artifacts = artifactsByChart.get(chart);
  if (!artifacts) return;
  for (const id of artifacts.markerIds) chart.removeOverlay({ id });
  artifacts.markerIds = [];
  artifacts.aggClusters = [];
  artifacts.markerMode = "none";
  clearPeriodBands(chart, artifacts);
  if (artifacts.equityIndicatorId) {
    chart.removeIndicator({ id: artifacts.equityIndicatorId });
    artifacts.equityIndicatorId = null;
  }
  if (artifacts.highlightOverlayId) {
    chart.removeOverlay({ id: artifacts.highlightOverlayId });
    artifacts.highlightOverlayId = null;
  }
  removeSelectionOverlays(chart, artifacts);
  if (artifacts.unsub) {
    artifacts.unsub();
    artifacts.unsub = null;
  }
  // Drop a hover popover left open over one of this chart's aggregate pills or
  // signal glyphs.
  if (backtestResultSignal.value === artifacts.result) {
    backtestClusterHoverSignal.set(null);
    backtestSignalHoverSignal.set(null);
  }
  artifacts.trades = [];
  // Reset the GLOBAL hover/selection signals ONLY when this chart owns the
  // currently-active backtest — otherwise clearing/unmounting an UNRELATED cell
  // would fire another cell's live subscription and wipe its shown selection.
  // Stale-index safety on re-run still holds: the owning chart's own
  // runAndRender calls teardownArtifacts at the top while it is still the active
  // result, so this condition is true and the reset happens.
  if (backtestResultSignal.value === artifacts.result) {
    highlightTradeSignal.set(null);
    selectedTradeSignal.set(null);
  }
  artifacts.result = null;
}

/** Advance the SHOWN result in place, without re-drawing anything that has not
 * changed. The replay reveal's per-step path.
 *
 * The alternative — teardownArtifacts + renderArtifacts on every cursor step —
 * is wrong twice over. It rebuilds every marker overlay, ten times a second at
 * 10x playback; and teardownArtifacts nulls `selectedTradeSignal` /
 * `highlightTradeSignal`, so a trade the user clicked to study disappears within
 * a tenth of a second, permanently, in the one mode where they are watching it
 * play out. Both are pure cost when the only thing that actually changed is the
 * equity curve growing by a point.
 *
 * So this swaps the result the artifacts and the panel are bound to, and pushes
 * the new equity series into the existing indicator instead of recreating it.
 * The marker overlays keep their baked-in trade indices, which stays correct
 * because the caller only takes this path when the trade list is UNCHANGED (a
 * progressive filter yields a growing prefix, so the indices of everything
 * already drawn are stable).
 *
 * Owner-gated: a chart that is not backing the panel must not publish onto it.
 * Returns whether it did anything, so a caller can fall back to a full render.
 */
export function updateShownResult(chart: Chart, result: StoredBacktestResult): boolean {
  const artifacts = artifactsByChart.get(chart);
  if (!artifacts || backtestResultSignal.value !== artifacts.result) return false;
  artifacts.result = result;
  artifacts.trades = result.trades;
  if (artifacts.equityIndicatorId) {
    // `name` is required by IndicatorCreate; `id` is what actually targets THIS
    // pane's instance (createIndicator returned it — see equityIndicatorId).
    chart.overrideIndicator({
      id: artifacts.equityIndicatorId,
      name: EQUITY_INDICATOR,
      extendData: result.equity.map((p) => [p.time * 1000, p.value] as [number, number]),
    });
  }
  // Published LAST, and with this exact object: every identity gate in this
  // module now reads `artifacts.result`, so the two must be swapped together or
  // the hover/selection sync goes inert for a frame.
  backtestResultSignal.set(result);
  // The open trade's R/R zone follows the cursor: this per-step path is the
  // only thing that runs between full redraws, so without the re-clamp the
  // zone freezes at the bar it was clicked on while the session plays on.
  if (artifacts.openZoneFor) restoreOpenTradeZone(chart, artifacts.openZoneFor);
  return true;
}

/** User-initiated clear (toolbar ✕): drop the live artifacts AND delete the
 * persisted store so it does NOT come back on the next timeframe switch or
 * reload. */
export function clearBacktest(chart: Chart, scope: string, epic: string): void {
  teardownArtifacts(chart);
  clearBacktestResult(scope, epic);
}

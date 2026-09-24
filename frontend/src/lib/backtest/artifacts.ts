// The per-chart artifact registry: what a rendered backtest left on each
// chart (panes, overlay ids, clusters, selection), the history pager and
// replay hooks a chart registers, and the small readers over that state.
import type { Chart } from "klinecharts";
import { backtestResultSignal, selectedTradeSignal } from "../signals";
import type { StoredBacktestResult } from "../persist";
import type { Trade, TradeCluster } from "./markerMath";

// Per-chart backtest artifacts, so clearing one cell's backtest never touches
// another's. The equity series itself rides on the indicator instance's
// extendData (see calc), not here.
//
// Phase C: `trades` is the last run's result.trades (row.i indexes into it —
// same array the trades panel reads). `highlightOverlayId` is the single
// transient entry↔exit line drawn while a row/marker is hovered (never more
// than one at a time — see the highlightTradeSignal subscription below).
// `selectionOverlayIds` (Phase 2 Task 2) are the STICKY windowed risk/reward
// zone overlay ids drawn for the selectedTradeSignal trade — unlike the single
// transient highlight line, this is one `tradeZone` overlay (see below) but
// tracked as an array for symmetry with markerIds/removeAll and in case a
// future revision splits it into more than one overlay.
// `unsub` detaches BOTH the highlight and selection subscriptions this run
// installed, so a stale run's closures (over a now-cleared `trades`) can never
// fire after clearBacktest/re-run.
export interface BacktestArtifacts {
  // The equity sub-pane's INDICATOR id (klinecharts v10 createIndicator returns
  // the indicator id, not the pane id). Removal must filter by `{ id }` — passing
  // this as `{ paneId }` silently matches nothing and strands the pane (each run
  // then stacks another). See removeEquity / teardownArtifacts.
  equityIndicatorId: string | null;
  markerIds: string[];
  // Higher-timeframe aggregate pills (one per bar). Not klinecharts overlays —
  // ChartCore's redraw loop reads these via getBacktestAggregate, projects them
  // to pixels, and renders the DOM <BacktestAggMarkers> layer. Empty unless the
  // current timeframe is coarser than the backtest's (markerMode === "aggregate").
  aggClusters: TradeCluster[];
  // How the current timeframe draws this result's trades (see renderArtifacts).
  // Retained so `reanchorBacktestMarkers` — called after the history-coverage
  // page-back loads older bars — knows whether to recreate native overlays or
  // recompute aggregate clusters, without re-running the whole render (which
  // would re-create the equity pane and re-install the sync subscriptions).
  markerMode: "native" | "aggregate" | "none";
  trades: Trade[];
  highlightOverlayId: string | null;
  selectionOverlayIds: string[];
  // Which OPEN trade (replay reveal) the currently-drawn selection zone belongs
  // to, or null when the zone is a closed trade's / none. `index` addresses the
  // trade in the RUN's list (openTradesAtCursor carries it); entryTime/leg are
  // kept so the moment the trade CLOSES its zone can be handed over to the real
  // trade's selection (the closed slice is a filtered list, so the run index no
  // longer addresses it). Lets the marker click toggle its own zone off, lets
  // the per-step reveal update re-clamp the zone to the new cursor, and is
  // cleared wherever the zone itself is (removeSelectionOverlays runs on every
  // selection change and teardown).
  openZoneFor: {
    index: number;
    entryTime: number;
    leg: "long" | "short";
    entryPrice: number;
  } | null;
  // The open-trade zone's own overlay id, so the per-step update can move its
  // points IN PLACE (overrideOverlay) instead of remove + create. That
  // distinction is the whole reason updateShownResult exists — see its note —
  // and the zone is redrawn on EVERY revealed bar, up to ten a second at 10x.
  // Null whenever no open-trade zone is drawn; cleared with it.
  openZoneOverlayId: string | null;
  // The result THIS chart rendered, so teardownArtifacts resets the global
  // hover/selection signals only when this chart owns the currently-active
  // backtest — closing an unrelated cell must not wipe another cell's selection.
  result: StoredBacktestResult | null;
  unsub: (() => void) | null;
  // Ids of the locked, non-interactive period-shading overlays (one per band).
  periodBandIds: string[];
  // The timestamp span (ms, inclusive) native fill markers were last drawn for.
  // Markers are VIRTUALIZED to the visible range plus a buffer (a 1-year 5m run
  // registers ~500 overlays otherwise, and klinecharts re-runs every overlay's
  // createPointFigures per repaint and hit-tests every one per mouse move).
  // ±Infinity edges mean "drawn to the corresponding end of loaded data" so the
  // live edge appending bars, or nothing older existing, can't read as
  // out-of-window. null until a native draw happens.
  markerDrawWindow: { fromTs: number; toTs: number } | null;
}
export const artifactsByChart = new WeakMap<Chart, BacktestArtifacts>();

export const pagerByChart = new WeakMap<Chart, (fromTs: number) => Promise<boolean>>();
export function registerBacktestPager(
  chart: Chart,
  fn: ((fromTs: number) => Promise<boolean>) | null,
): void {
  if (fn) pagerByChart.set(chart, fn);
  else pagerByChart.delete(chart);
}

// Which charts are inside a chart-replay session. Registered by chart/useReplay
// for the whole life of a cell (the reader answers false while the cell is not
// replaying), and read by the panel-publishing decisions below.
//
// Chart-keyed rather than taken from the ChartHandle, because not every caller
// has one: App's cross-tab/cross-device push handler holds only `{ chart,
// controller }` for a cell it does not own, and it is a genuine second mouth on
// the same leak — a backtest finishing in ANOTHER tab, on the same scope+epic,
// would otherwise rehydrate the whole run onto the shared panel mid-session.
const replayingByChart = new WeakMap<Chart, () => boolean>();
export function registerReplayingChart(chart: Chart, read: (() => boolean) | null): void {
  if (read) replayingByChart.set(chart, read);
  else replayingByChart.delete(chart);
}
export function isChartReplaying(chart: Chart): boolean {
  return replayingByChart.get(chart)?.() ?? false;
}

/** Page history back to `fromTs` via the chart's registered backtest pager
 * (ChartCore's coverBacktestTradeTo — bounded walk, stops as soon as coverage
 * reaches the target, reanchors the markers after). Used by a fresh run to
 * cover ITS OWN oldest fill before fitting — deliberately NOT the drawings
 * walk (ensureAnchorCoverage): that one targets the oldest saved drawing
 * anchor, which can be years older than the run and re-trigger a deep,
 * budget-capped page-back on every single run. Resolves false when no pager
 * is registered or the walk couldn't reach the target. */
export async function coverBacktestHistory(chart: Chart, fromTs: number): Promise<boolean> {
  const pager = pagerByChart.get(chart);
  if (!pager) return false;
  return pager(fromTs);
}

export function artifactsFor(chart: Chart): BacktestArtifacts {
  let a = artifactsByChart.get(chart);
  if (!a) {
    a = {
      equityIndicatorId: null,
      markerIds: [],
      aggClusters: [],
      markerMode: "none",
      trades: [],
      highlightOverlayId: null,
      selectionOverlayIds: [],
      openZoneFor: null,
      openZoneOverlayId: null,
      result: null,
      unsub: null,
      periodBandIds: [],
      markerDrawWindow: null,
    };
    artifactsByChart.set(chart, a);
  }
  return a;
}

/** The current higher-timeframe aggregate pills for a chart, plus the result
 * they belong to (for the drill-in resolution). null when the chart isn't in
 * aggregate mode (native/none, or no backtest). Read by ChartCore's redraw loop
 * to project the clusters to pixels and render the DOM pill layer. */
export function getBacktestAggregate(
  chart: Chart,
): { clusters: TradeCluster[]; result: StoredBacktestResult } | null {
  const a = artifactsByChart.get(chart);
  if (!a || !a.result || a.aggClusters.length === 0) return null;
  return { clusters: a.aggClusters, result: a.result };
}

/** Whether this chart's rendered backtest IS the panel-active result — the
 * gate every cross-chart signal consumer uses (highlight, selection, and the
 * review card's drill requests). */
export function chartOwnsActiveResult(chart: Chart): boolean {
  const a = artifactsByChart.get(chart);
  return a?.result != null && backtestResultSignal.value === a.result;
}

/** The trade index the user has selected on THIS chart's active backtest, or
 * null when this chart doesn't own the panel. ChartCore captures it BEFORE its
 * synchronous teardownArtifacts nulls the shared selection on a timeframe switch,
 * then hands it to restoreTradeSelection to re-center on the same trade. The
 * ownership gate (artifacts.result === the published result) mirrors the rest of
 * this module so a split-layout cell that doesn't own the panel can't restore
 * over another cell's selection. */
export function selectedTradeForChart(chart: Chart): number | null {
  const a = artifactsByChart.get(chart);
  return a && backtestResultSignal.value === a.result ? selectedTradeSignal.value : null;
}

/** Re-select the trade the user was studying before a timeframe switch —
 * ChartCore calls this AFTER its switch-time coverage walks settle (drawing/
 * backtest anchor paging), NOT right at rehydrate: those walks prepend pages via
 * applyNewData, which resets the view to realtime, so an immediate re-center
 * would land and then get thrown back to the live edge mid-walk. Re-emitting the
 * index fires the selection subscription renderArtifacts installed: redraw the
 * R/R zone, page the trade's own bars in if still off-window, and scroll to it.
 * No-op when this chart no longer owns the panel (split-cell guard), when the
 * user selected something else during the walk, or when the index no longer maps
 * to a trade (the subscription's own `if (!t) return` guard). */
export function restoreTradeSelection(chart: Chart, index: number): void {
  const a = artifactsByChart.get(chart);
  if (!a || backtestResultSignal.value !== a.result) return;
  if (selectedTradeSignal.value != null) return; // user re-selected mid-walk — keep theirs
  selectedTradeSignal.set(index);
}

/** Release the SHARED trades panel when THIS chart owns the currently-active
 * backtest — called on cell UNMOUNT (tab switch away / close) so the panel goes
 * blank instead of stranding this cell's result for the next tab's cells to
 * inherit. Owner-gated so unmounting a split-layout sibling never wipes another
 * cell's shown result. Deliberately NOT part of teardownArtifacts (which also
 * runs mid-run in runAndRender): calling it there would blink the panel empty on
 * every re-run. The persisted store is untouched — a reopened cell rehydrates. */
export function releaseBacktestPanel(chart: Chart): void {
  const a = artifactsByChart.get(chart);
  if (a && backtestResultSignal.value === a.result) backtestResultSignal.set(null);
}

/** Does THIS chart currently back the shared panel? The ownership test the
 * module gates every panel-clearing decision on, exported because two callers
 * outside this file have to ask it BEFORE tearing anything down —
 * teardownArtifacts nulls `artifacts.result`, and after that the question can no
 * longer be answered. */
export function ownsBacktestPanel(chart: Chart): boolean {
  const a = artifactsByChart.get(chart);
  return !!a && backtestResultSignal.value === a.result;
}

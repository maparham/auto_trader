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

import {
  registerIndicator,
  IndicatorSeries,
  LineType,
  PolygonType,
  registerOverlay,
  DomPosition,
  type Chart,
  type Indicator,
  type OverlayTemplate,
  type OverlayFigure,
} from "klinecharts";
import { runBacktest, type BacktestRequest, type Marker } from "../api";
import { applyVisibleRange, applyVisibleRangeKeepStart } from "./chartSync";
import {
  backtestResultSignal,
  highlightTradeSignal,
  selectedTradeSignal,
  backtestClusterHoverSignal,
  backtestSignalHoverSignal,
  backtestPeriodsShownSignal,
  backtestSelectNoticeSignal,
} from "./signals";
import { buildSignalGlyphs, isEntryFill } from "./signalGlyphs";
import { tradeZones } from "./tradeZones";
import { minPositiveGap } from "./barInterval";
import { RESOLUTION_SECONDS } from "./feed";
import {
  saveBacktestResult,
  loadBacktestResult,
  clearBacktestResult,
  type StoredBacktestResult,
} from "./persist";
import { computePeriodBands, type BacktestPeriod } from "./backtestPeriods";

type Trade = StoredBacktestResult["trades"][number];

export const EQUITY_INDICATOR = "EQUITY";

const BUY_COLOR = "#26a69a";
const SELL_COLOR = "#ef5350";
// Entry-line accent — matches PositionLines' PRICE_COLOR (the role-based
// entry/price blue) so the selected-trade overlay reads consistently with the
// live trade lines, without importing that module's private const.
const ACCENT_COLOR = "#2962ff";
// Neutral grey for the trading-period shading — deliberately off the green/red
// markers and the blue trade lines so an always-on layer doesn't compete.
const PERIOD_COLOR = "#59646f";

/** Chart marker label. Risk exits read by reason: stop/trailing => "SL",
 * target => "TP". Otherwise "+" opens a position and "-" closes it, prefixed by
 * the order side (B/S): open-long=B+, close-long=S-, open-short=S+, close-short=B-. */
export function markerLabel(side: "buy" | "sell", leg: "long" | "short", reason?: string): string {
  if (reason === "stop" || reason === "trail") return "SL";
  if (reason === "target") return "TP";
  const letter = side === "buy" ? "B" : "S";
  const opening = (leg === "long" && side === "buy") || (leg === "short" && side === "sell");
  return `${letter}${opening ? "+" : "-"}`;
}

/** Which side of the candle a fill marker should hang from so it clears the
 * body. The arrow always pins to the exact fill price, so the pill has to be
 * offset AWAY from the body: if the fill sits in the lower half of the candle
 * (e.g. a short opened at a bullish candle's open, which is its low), drop the
 * pill BELOW it; otherwise keep the historical ABOVE placement. Ties at the
 * exact midpoint default to "above". Decided once at draw time (price space, so
 * stable across zoom/pan). Returns "above" when high==low (a flat/degenerate
 * bar has no body to clear). */
export function markerPlacement(fillPrice: number, high: number, low: number): "above" | "below" {
  const mid = (high + low) / 2;
  return fillPrice < mid ? "below" : "above";
}

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
interface BacktestArtifacts {
  equityPaneId: string | null;
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
  // The result THIS chart rendered, so teardownArtifacts resets the global
  // hover/selection signals only when this chart owns the currently-active
  // backtest — closing an unrelated cell must not wipe another cell's selection.
  result: StoredBacktestResult | null;
  unsub: (() => void) | null;
  // Ids of the locked, non-interactive period-shading overlays (one per band).
  periodBandIds: string[];
}
const artifactsByChart = new WeakMap<Chart, BacktestArtifacts>();

// Bridge from a Chart to its ChartCore page-back function. The selection
// subscription below only holds the Chart (it's installed by renderArtifacts,
// which knows nothing of the controller), so ChartCore registers its
// coverBacktestTradeTo here at chart-ready and clears it on teardown. Lets the
// subscription page an out-of-window trade in before scrolling to it.
const pagerByChart = new WeakMap<Chart, (fromTs: number) => Promise<boolean>>();
export function registerBacktestPager(
  chart: Chart,
  fn: ((fromTs: number) => Promise<boolean>) | null,
): void {
  if (fn) pagerByChart.set(chart, fn);
  else pagerByChart.delete(chart);
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

function artifactsFor(chart: Chart): BacktestArtifacts {
  let a = artifactsByChart.get(chart);
  if (!a) {
    a = {
      equityPaneId: null,
      markerIds: [],
      aggClusters: [],
      markerMode: "none",
      trades: [],
      highlightOverlayId: null,
      selectionOverlayIds: [],
      result: null,
      unsub: null,
      periodBandIds: [],
    };
    artifactsByChart.set(chart, a);
  }
  return a;
}

/** Remove every overlay drawn for the sticky selection (windowed zone) and
 * reset the bookkeeping — shared by the reset-at-top-of-run, clearBacktest,
 * and the selectedTradeSignal subscription's own "replace" step. */
function removeSelectionOverlays(chart: Chart, artifacts: BacktestArtifacts): void {
  for (const id of artifacts.selectionOverlayIds) chart.removeOverlay(id);
  artifacts.selectionOverlayIds = [];
}

/** Pan/zoom the chart to center the trade's entry↔exit time span, with padding
 * for context. Reuses the date-range-sync geometry (applyVisibleRange) rather
 * than a bespoke scroll — same "given a time window, fit it" primitive the
 * cross-chart range sync uses (see chartSync.ts). Padding falls back to a
 * few-bars minimum so a same-bar (entry===exit) trade still yields a real,
 * non-empty window. */
function scrollChartToTrade(chart: Chart, entryTs: number, exitTs: number): void {
  const data = chart.getDataList();
  if (!data || data.length < 2) return;
  // Robust bar interval, not the last-two-bars gap (which can straddle a session
  // break and blow the fitted window up to hours) — see minPositiveGap.
  const barMs = minPositiveGap(data.map((k) => k.timestamp)) || 1;
  const firstTs = data[0].timestamp;
  const lastTs = data[data.length - 1].timestamp;
  // Clamp the trade's span to the loaded bar window. A trade OLDER than the
  // loaded history (e.g. a 5m run's Jun-22 trade viewed on 3m, whose broker
  // history only reaches Jun-25) has entry/exit before the first bar; feeding
  // those out-of-data timestamps to applyVisibleRange makes it extrapolate into
  // negative virtual-bar indices and blow the zoom/scroll up (candles collapse to
  // a sliver, price axis goes haywire). If the span doesn't overlap the loaded
  // window at all, don't scroll — the trade can't be shown here (its markers are
  // culled too), so leave the view put rather than wreck it.
  const from = Math.max(Math.min(entryTs, exitTs), firstTs);
  const to = Math.min(Math.max(entryTs, exitTs), lastTs);
  if (!(to > from)) return;
  const pad = Math.max((to - from) * 0.25, barMs * 3);
  // Keep the padded window inside the loaded data so applyVisibleRange never
  // extrapolates past either edge.
  applyVisibleRange(chart, Math.max(from - pad, firstTs), Math.min(to + pad, lastTs));
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
  const barMs = minPositiveGap(data.map((k) => k.timestamp)) || 1;
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

// Backtest fill marker (arrow + label). A hand-rolled clone of klinecharts'
// built-in `simpleAnnotation` — IDENTICAL geometry — with ONE deliberate
// difference: the figures do NOT set `ignoreEvent: true`. The built-in hardcodes
// `ignoreEvent: true` on its line/arrow/text, which klinecharts' _createFigureEvents
// reads to strip ALL mouse events at the dispatch layer, so an overlay-level
// onClick/onMouseEnter/onMouseLeave could never fire (that's the bug this fixes).
// Leaving ignoreEvent unset lets figure hits route to the overlay handlers
// (see drawFigures -> _createFigureEvents -> onMouseEnter/onClick).
// Appearance is preserved because per-figure styles are omitted, so each figure
// inherits `defaultStyles[type]` merged with the overlay-level `styles` we pass
// at createOverlay — the same merge the built-in relied on (only the vertical
// line is side-colored; arrow + text use theme defaults).
// Exported so the live trade-marker drawer (tradeMarkers.ts) reuses this exact
// overlay glyph rather than defining a parallel one — same arrow/pill geometry,
// same extendData contract (label / win / placement).
export const MARKER_OVERLAY = "backtestMarker";

// extendData for a `backtestMarker`: the label text plus the trade's outcome so
// the label pill can be win/loss colored (green won, red lost). `win` is null
// for a marker not tied to a trade — that keeps klinecharts' default blue pill.
interface MarkerExtra {
  label: string;
  win: boolean | null;
  // Which side of the candle the pill hangs from (see markerPlacement). Absent
  // in older persisted results — treated as "above" (the historical default).
  placement?: "above" | "below";
  // Rendering variant. Absent/"backtest" → the classic stem + arrow + always-on
  // label pill (backtest fills). "live" → a compact arrow glyph only, anchored a
  // gap off the candle's extreme; its label is a DOM pill revealed on hover
  // (tradeMarkerHoverSignal), so the always-on furniture never covers candles.
  style?: "backtest" | "live";
}
function asMarkerExtra(v: unknown): MarkerExtra {
  return (typeof v === "object" && v !== null ? v : { label: "", win: null }) as MarkerExtra;
}

const markerOverlay: OverlayTemplate = {
  name: MARKER_OVERLAY,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates }) => {
    if (coordinates.length < 1) return [];
    const { label, win, placement, style } = asMarkerExtra(overlay.extendData);
    const startX = coordinates[0].x;
    // "below" mirrors the historical "above" geometry through the anchor: the
    // arrow/pill grow downward and the pill's baseline flips so it hangs under
    // the fill instead of over it. `dir` is +1 downward, -1 upward.
    const dir = placement === "below" ? 1 : -1;

    if (style === "live") {
      // Compact glyph: just an arrow, sitting a fixed GAP off the candle's
      // extreme (the caller anchors this overlay at the bar low/high, so the gap
      // reads off the wick). The full label is a DOM pill shown on hover, so the
      // always-on marker never covers neighbouring candles. Arrow APEX points at
      // the candle; a transparent finger-sized hit target sits over it because
      // klinecharts' hit test on a tiny polygon is unreliable (same trick as the
      // signal glyph). Colour: entry = neutral blue, exit = win/loss.
      const glyphColor = win == null ? ACCENT_COLOR : win ? BUY_COLOR : SELL_COLOR;
      const tip = coordinates[0].y + dir * 7; // 7px gap from the wick
      const base = tip + dir * 8;
      return [
        {
          type: "circle",
          attrs: { x: startX, y: tip + dir * 4, r: 9 },
          styles: { style: PolygonType.Fill, color: "rgba(0,0,0,0)" },
        },
        {
          type: "polygon",
          attrs: {
            coordinates: [
              { x: startX, y: tip },
              { x: startX - 4, y: base },
              { x: startX + 4, y: base },
            ],
          },
          styles: { style: PolygonType.Fill, color: glyphColor },
        },
      ];
    }

    // Backtest fills: the classic stem + arrow + always-on label pill.
    const startY = coordinates[0].y + dir * 6;
    const lineEndY = startY + dir * 50;
    const arrowEndY = lineEndY + dir * 5;
    // The label renders as a filled pill via klinecharts' default overlay text
    // style (white text on a blue background). Override just the fill/border to
    // the win/loss color so a losing trade's marker reads red, a winner green.
    const pillColor = win == null ? undefined : win ? BUY_COLOR : SELL_COLOR;
    return [
      {
        type: "line",
        attrs: { coordinates: [{ x: startX, y: startY }, { x: startX, y: lineEndY }] },
      },
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x: startX, y: lineEndY },
            { x: startX - 4, y: arrowEndY },
            { x: startX + 4, y: arrowEndY },
          ],
        },
      },
      {
        type: "text",
        attrs: {
          x: startX,
          y: arrowEndY,
          text: label,
          align: "center",
          baseline: placement === "below" ? "top" : "bottom",
        },
        ...(pillColor ? { styles: { backgroundColor: pillColor, borderColor: pillColor } } : {}),
      },
    ];
  },
};

let markerOverlayRegistered = false;
export function ensureMarkerOverlayRegistered(): void {
  if (markerOverlayRegistered) return;
  markerOverlayRegistered = true;
  registerOverlay(markerOverlay);
}

// The signal-candle glyph: a small subtle caret on the bar BEFORE a rule-based
// fill, pointing at the candle (long ⇒ below, short ⇒ above). Deliberately
// lighter/plainer than the B+/SL fill markers — it's a "why did this fire" hint,
// not a fill. Hovering opens the terms popover (see drawMarkers). A separate
// overlay from MARKER_OVERLAY because it anchors on a different bar (signal_time)
// with caret-only geometry and no win/loss pill.
const SIGNAL_OVERLAY = "backtestSignal";
// Muted slate, distinct from the green/red fills and the blue trade lines.
const SIGNAL_COLOR = "#8a97a5";

interface SignalMarkerExtra {
  placement: "above" | "below";
}
function asSignalMarkerExtra(v: unknown): SignalMarkerExtra {
  return (typeof v === "object" && v !== null ? v : { placement: "below" }) as SignalMarkerExtra;
}

const signalGlyphOverlay: OverlayTemplate = {
  name: SIGNAL_OVERLAY,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates }) => {
    if (coordinates.length < 1) return [];
    const { placement } = asSignalMarkerExtra(overlay.extendData);
    const x = coordinates[0].x;
    // `dir` is +1 hanging below the candle (long) / -1 above it (short). The
    // caret's apex sits nearer the candle (`tip`), base further away, so it
    // reads as an arrow pointing at the signal bar.
    const dir = placement === "below" ? 1 : -1;
    const anchorY = coordinates[0].y;
    const tip = anchorY + dir * 4;
    const base = anchorY + dir * 11;
    return [
      // Transparent finger-sized hit target FIRST: the visible caret is a tiny
      // locked polygon, and klinecharts' hit test on such a small figure is
      // unreliable (the same reason aggregate pills went DOM). A ~9px transparent
      // circle over the caret gives the hover a dependable target at zero visual
      // cost; ignoreEvent stays unset so it routes to onMouseEnter/onMouseLeave.
      {
        type: "circle",
        attrs: { x, y: anchorY + dir * 7, r: 9 },
        styles: { style: PolygonType.Fill, color: "rgba(0,0,0,0)" },
      },
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x, y: tip },
            { x: x - 5, y: base },
            { x: x + 5, y: base },
          ],
        },
        styles: { style: PolygonType.Fill, color: SIGNAL_COLOR },
      },
    ];
  },
};

let signalGlyphOverlayRegistered = false;
function ensureSignalGlyphOverlayRegistered(): void {
  if (signalGlyphOverlayRegistered) return;
  signalGlyphOverlayRegistered = true;
  registerOverlay(signalGlyphOverlay);
}

// klinecharts hard-sets the candle pane's cursor to 'crosshair' in its
// IndicatorWidget ctor, so a hovered clickable marker would otherwise give no
// affordance. Flip the pane cursor to 'pointer' while a trade-mapped marker is
// hovered (onMouseEnter) and restore 'crosshair' on leave — the pane's DOM is
// the element carrying the cursor style (setting the root container wouldn't
// override the child pane's own cursor).
export function setMarkerHoverCursor(chart: Chart, hovering: boolean): void {
  const dom = chart.getDom("candle_pane", DomPosition.Main);
  if (dom) dom.style.cursor = hovering ? "pointer" : "crosshair";
}

// ---------------------------------------------------------------------------
// Aggregate markers (higher-timeframe view).
//
// On a timeframe COARSER than the backtest's own, an individual fill can't be
// anchored cleanly — many fills fall inside one bar and would collapse onto the
// same x. Instead we bucket each trade into the bar that contains its ENTRY and
// show ONE pill per bar with the trade count + net P&L. The pills are DOM, not
// klinecharts overlays (native hover/click events are reliable, whereas the
// overlay-event hit test on a tiny locked figure is flaky — the same reason the
// legend/curve labels are DOM). `renderArtifacts` just stashes the clusters on
// the chart's artifacts; ChartCore's redraw loop projects them to pixels each
// frame and feeds the <BacktestAggMarkers> layer, which owns the hover popover
// (backtestClusterHoverSignal) and the click→drill-in.

/** One higher-timeframe bar's worth of trades, ready to draw as a single pill.
 * `barTs`/`high` anchor the pill (ms + the bar's high price); `fromTs`/`toTs`
 * (ms) are the min-entry→max-exit span used to zoom on drill-in. Pure output of
 * `aggregateTradesByBar` — exported for tests. */
export interface TradeCluster {
  barTs: number;
  high: number;
  trades: { trade: Trade; index: number }[];
  net: number;
  fromTs: number;
  toTs: number;
}

/** Index of the loaded bar that CONTAINS `ms` — the last bar whose timestamp is
 * `<= ms`, clamped to `[0, last]`. The same "last bar at or before this time"
 * rule klinecharts uses to snap an overlay, rather than `floor(t / seconds)`
 * math — daily/weekly/derived bars don't align to epoch multiples. A time before
 * the first / after the last loaded bar clamps to the edge bar so it stays
 * discoverable. Empty `barTimes` returns -1. Pure + exported (shared by
 * `aggregateTradesByBar` and the live trade-marker drawer). */
export function barIndexForTs(barTimes: number[], ms: number): number {
  const last = barTimes.length - 1;
  if (last < 0) return -1;
  if (ms <= barTimes[0]) return 0;
  if (ms >= barTimes[last]) return last;
  let lo = 0;
  let hi = last;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (barTimes[mid] <= ms) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return idx;
}

/** Bucket trades into the loaded chart bar that CONTAINS each trade's entry
 * (the bar whose `[timestamp, nextTimestamp)` window covers `entry_time`), by
 * the shared `barIndexForTs` rule. Trades before the first / after the last
 * loaded bar clamp to the edge bar so they stay discoverable. Pure + exported
 * for tests. */
export function aggregateTradesByBar(
  trades: Trade[],
  bars: { timestamp: number; high: number }[],
): TradeCluster[] {
  if (bars.length === 0) return [];
  const barTimes = bars.map((b) => b.timestamp);
  const byBar = new Map<number, TradeCluster>();
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const entryMs = t.entry_time * 1000;
    const exitMs = t.exit_time * 1000;
    const idx = barIndexForTs(barTimes, entryMs);
    let cl = byBar.get(idx);
    if (!cl) {
      cl = {
        barTs: bars[idx].timestamp,
        high: bars[idx].high,
        trades: [],
        net: 0,
        fromTs: entryMs,
        toTs: exitMs,
      };
      byBar.set(idx, cl);
    }
    cl.trades.push({ trade: t, index: i });
    cl.net += t.pnl;
    cl.fromTs = Math.min(cl.fromTs, entryMs);
    cl.toTs = Math.max(cl.toTs, exitMs);
  }
  return [...byBar.values()].sort((a, b) => a.barTs - b.barTs);
}

/** Snap a timestamp (ms) to the closest bar in an ascending `barTimes` (ms).
 * Used to anchor native fill arrows on a finer view whose interval doesn't
 * evenly divide the native one (3m viewing a 5m run) — the fill falls between
 * two bars, so it lands on whichever is nearer. A fill already on a bar returns
 * that same bar; empty `barTimes` returns the input unchanged. Exported for tests. */
export function snapNearestBar(ms: number, barTimes: number[]): number {
  const n = barTimes.length;
  if (n === 0) return ms;
  if (ms <= barTimes[0]) return barTimes[0];
  if (ms >= barTimes[n - 1]) return barTimes[n - 1];
  // Binary search for the first bar at or after `ms`, then pick the nearer of it
  // and the bar before it (ties go to the earlier bar).
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (barTimes[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  const after = barTimes[lo];
  const before = barTimes[lo - 1];
  return ms - before <= after - ms ? before : after;
}

/** Whether a fill at `ms` falls within the loaded bar window `[first, last]`
 * (inclusive). A finer timeframe loads far less history than the backtest's own
 * resolution (a fixed bar count spans a much shorter time), so a trade older
 * than the loaded window can't be placed on a real candle: `snapNearestBar`
 * would clamp EVERY such fill onto the edge bar, stacking them into one
 * misleading vertical pile floating above the visible candles. Native markers
 * outside the window are skipped instead — the trade stays listed in the panel
 * and remains discoverable via any coarser view's aggregate pill. Empty
 * `barTimes` => false (nothing loaded to anchor to). Pure + exported for tests. */
export function fillWithinLoadedWindow(ms: number, barTimes: number[]): boolean {
  const n = barTimes.length;
  if (n === 0) return false;
  return ms >= barTimes[0] && ms <= barTimes[n - 1];
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

const ZONE_OVERLAY = "tradeZone";

// extendData for a `tradeZone` overlay instance: everything createPointFigures
// needs BESIDES the pixel-projected points (below) — which fields to draw and
// the precomputed labels (tradeZones() output), plus win/loss for the
// entry→exit segment + exit dot color.
interface ZoneExtra {
  hasReward: boolean;
  hasRisk: boolean;
  stopMoved: boolean;
  rewardPct: number | null;
  riskPct: number | null;
  rr: number | null;
  win: boolean;
}
function asZoneExtra(v: unknown): ZoneExtra {
  return v as ZoneExtra;
}

// Small filled pill (white text on a solid tag), matching the label style
// PositionLines' tradeLine/bracket pills use elsewhere on the chart.
function pillFigure(
  x: number,
  y: number,
  text: string,
  bg: string,
  align: "left" | "center" | "right" = "left",
): OverlayFigure {
  return {
    type: "text",
    attrs: { x, y, text, align, baseline: "middle" },
    styles: {
      color: "#ffffff",
      backgroundColor: bg,
      size: 11,
      family: "-apple-system, system-ui, sans-serif",
      paddingLeft: 5,
      paddingRight: 5,
      paddingTop: 2,
      paddingBottom: 2,
      borderRadius: 3,
    },
    ignoreEvent: true,
  };
}

// The windowed risk/reward zone for the STICKILY selected trade (Phase 2 Task
// 2). A single custom overlay (registered once, like PositionLines'
// `tradeLine`) rather than several linked ones: klinecharts only hands
// createPointFigures the pixel coordinates for the overlay's OWN `points`, so
// every price level the drawing needs (entry, target, stop_initial,
// stop_final, exit) rides its own point — even ones that don't have a
// meaningful x (target/stop_initial/stop_final share the entry timestamp;
// only their y-pixel is read):
//   0 entry(entryTs, entry_price)      3 stopInitial(entryTs, stop_initial)
//   1 windowEnd(exitTs+pad, entry_price) 4 stopFinal(entryTs, stop_final)
//   2 target(entryTs, target)          5 exit(exitTs, exit_price)
// (points 2-4 fall back to entry_price when the level is absent — harmless
// since the figures that would read them are gated on hasReward/hasRisk/
// stopMoved instead.)
// Read-only backtest artifact: `lock: true` on creation AND every figure
// `ignoreEvent: true`, so it never intercepts clicks/crosshair — same
// discipline as the marker/highlight overlays above.
const tradeZoneOverlay: OverlayTemplate = {
  name: ZONE_OVERLAY,
  totalStep: 6,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding }) => {
    if (coordinates.length < 6) return [];
    const z = asZoneExtra(overlay.extendData);
    const [c0, c1, c2, c3, c4, c5] = coordinates;
    const figures: OverlayFigure[] = [];
    // The TP/SL edge pills sit just right of the window's right edge — flip to
    // the LEFT (mirrors PositionLines' bracket-pill flip) when that would spill
    // past the pane, so a trade near the right edge doesn't clip its labels.
    const flip = c1.x > bounding.width - 70;
    const edgeX = flip ? c1.x - 4 : c1.x + 4;
    const edgeAlign: "left" | "right" = flip ? "right" : "left";
    // Clamp the R:R pill so it can't clip above the pane top for an entry
    // near the very top of the visible price range.
    const rrY = Math.max(c0.y - 14, 10);
    if (z.hasReward) {
      figures.push({
        type: "rect",
        attrs: { x: c0.x, y: Math.min(c0.y, c2.y), width: c1.x - c0.x, height: Math.abs(c0.y - c2.y) },
        styles: { style: PolygonType.Fill, color: `${BUY_COLOR}26` },
        ignoreEvent: true,
      });
    }
    if (z.hasRisk) {
      figures.push({
        type: "rect",
        attrs: { x: c0.x, y: Math.min(c0.y, c3.y), width: c1.x - c0.x, height: Math.abs(c0.y - c3.y) },
        styles: { style: PolygonType.Fill, color: `${SELL_COLOR}26` },
        ignoreEvent: true,
      });
    }
    if (z.stopMoved) {
      figures.push({
        type: "line",
        attrs: { coordinates: [{ x: c0.x, y: c4.y }, { x: c1.x, y: c4.y }] },
        styles: { style: LineType.Dashed, dashedValue: [4, 4], color: `${SELL_COLOR}80`, size: 1 },
        ignoreEvent: true,
      });
    }
    // entry -> exit (win/loss colored, like the transient highlight line).
    figures.push({
      type: "line",
      attrs: { coordinates: [{ x: c0.x, y: c0.y }, { x: c5.x, y: c5.y }] },
      styles: { style: LineType.Solid, color: z.win ? BUY_COLOR : SELL_COLOR, size: 1 },
      ignoreEvent: true,
    });
    // entry line (accent), spanning the window.
    figures.push({
      type: "line",
      attrs: { coordinates: [{ x: c0.x, y: c0.y }, { x: c1.x, y: c0.y }] },
      styles: { style: LineType.Solid, color: ACCENT_COLOR, size: 1.5 },
      ignoreEvent: true,
    });
    // entry / exit dots.
    figures.push({ type: "circle", attrs: { x: c0.x, y: c0.y, r: 3 }, styles: { style: PolygonType.Fill, color: ACCENT_COLOR }, ignoreEvent: true });
    figures.push({ type: "circle", attrs: { x: c5.x, y: c5.y, r: 3 }, styles: { style: PolygonType.Fill, color: z.win ? BUY_COLOR : SELL_COLOR }, ignoreEvent: true });
    // Labels: R:R centered above the entry line; +reward%/-risk% at the TP/SL edges.
    if (z.rr != null) {
      figures.push(pillFigure((c0.x + c1.x) / 2, rrY, `R:R 1:${z.rr.toFixed(2)}`, ACCENT_COLOR, "center"));
    }
    if (z.hasReward && z.rewardPct != null) {
      figures.push(pillFigure(edgeX, c2.y, `+${z.rewardPct.toFixed(1)}%`, BUY_COLOR, edgeAlign));
    }
    if (z.hasRisk && z.riskPct != null) {
      figures.push(pillFigure(edgeX, c3.y, `-${z.riskPct.toFixed(1)}%`, SELL_COLOR, edgeAlign));
    }
    return figures;
  },
};

let zoneOverlayRegistered = false;
function ensureZoneOverlayRegistered(): void {
  if (zoneOverlayRegistered) return;
  zoneOverlayRegistered = true;
  registerOverlay(tradeZoneOverlay);
}

const PERIOD_OVERLAY = "backtestPeriod";

// The trading-period band: a faint full-pane-height rect in the price pane, and
// a matching faint rect in the X-axis pane (createXAxisFigures — the native way to
// draw on the time axis, so it pans/zooms with the axis). No text label — the
// shading alone marks the traded span, and a per-band label collided with the
// axis time ticks. Read-only: lock on create AND every figure ignoreEvent, so it
// never intercepts clicks or the crosshair — the cursor's time pill (klinecharts'
// crosshair label, drawn above the overlay layer) stays fully legible.
const periodOverlay: OverlayTemplate = {
  name: PERIOD_OVERLAY,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const x0 = Math.min(coordinates[0].x, coordinates[1].x);
    const w = Math.abs(coordinates[1].x - coordinates[0].x);
    return [
      {
        type: "rect",
        attrs: { x: x0, y: 0, width: w, height: bounding.height },
        styles: { style: PolygonType.Fill, color: `${PERIOD_COLOR}0f` }, // ~6%
        ignoreEvent: true,
      },
    ];
  },
  createXAxisFigures: ({ coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const x0 = Math.min(coordinates[0].x, coordinates[1].x);
    const x1 = Math.max(coordinates[0].x, coordinates[1].x);
    return [
      {
        type: "rect",
        attrs: { x: x0, y: 0, width: x1 - x0, height: bounding.height },
        styles: { style: PolygonType.Fill, color: `${PERIOD_COLOR}33` }, // ~20%
        ignoreEvent: true,
      },
    ];
  },
};

let periodOverlayRegistered = false;
function ensurePeriodOverlayRegistered(): void {
  if (periodOverlayRegistered) return;
  periodOverlayRegistered = true;
  registerOverlay(periodOverlay);
}

/** Remove this chart's period-band overlays and reset the bookkeeping. */
function clearPeriodBands(chart: Chart, artifacts: BacktestArtifacts): void {
  for (const id of artifacts.periodBandIds) chart.removeOverlay(id);
  artifacts.periodBandIds = [];
}

/** Draw the trading-period bands for the CURRENT loaded bars, if the global
 * toggle is on and the result carries a period. Caller clears any prior bands
 * first. Independent of markerMode — periods are pure time spans, valid on every
 * timeframe. */
function drawPeriodBands(chart: Chart, artifacts: BacktestArtifacts, result: StoredBacktestResult): void {
  if (!backtestPeriodsShownSignal.value) return;
  const period = result.period;
  if (!period) return;
  const data = chart.getDataList() ?? [];
  if (data.length === 0) return;
  const barTimes = data.map((k) => k.timestamp);
  const bands = computePeriodBands(period, barTimes);
  if (bands.length === 0) return;
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

/** Draw the windowed risk/reward zone overlay for trade `t` and scroll the
 * chart to its entry↔exit span. Pushes the created overlay's id into
 * `artifacts.selectionOverlayIds` (the caller is responsible for clearing any
 * prior selection first — see the selectedTradeSignal subscription). */
function drawSelectionZone(chart: Chart, artifacts: BacktestArtifacts, t: Trade): void {
  ensureZoneOverlayRegistered();
  const z = tradeZones(t);
  const entryTs = t.entry_time * 1000;
  const exitTs = t.exit_time * 1000;
  const data = chart.getDataList();
  // Robust bar interval, NOT the last-two-bars gap: that trailing gap can straddle
  // a session/overnight/weekend break (or the seam between loaded history and a
  // freshly appended live bar) and run to hours or days, which would balloon the
  // zone's right edge for a short-lived trade. See minPositiveGap.
  const barMs = (data && minPositiveGap(data.map((k) => k.timestamp))) || 1;
  // Skip the zone entirely when the trade's span doesn't overlap the loaded bar
  // window at all (e.g. a 5m run's Jun-22 trade viewed on 3m, whose broker history
  // only reaches Jun-25). klinecharts would clamp every off-window point onto the
  // first bar, drawing a degenerate zero-width zone stranded at the left edge; and
  // scrollChartToTrade can't frame a span that isn't loaded. Selecting the row still
  // highlights it — the trade just isn't drawable on this timeframe.
  if (data && data.length > 0) {
    const firstTs = data[0].timestamp;
    const lastTs = data[data.length - 1].timestamp;
    const lo = Math.min(entryTs, exitTs);
    const hi = Math.max(entryTs, exitTs);
    if (hi < firstTs || lo > lastTs) return;
  }
  // End the zone AT the trade's exit so the reward/risk bands + entry line are
  // tight to the position's actual duration (a trailing pad made the box span
  // longer than the trade). Floor at one bar so a same-bar trade (entry≈exit)
  // still has a visible, non-zero width.
  const windowEnd = Math.max(Math.max(entryTs, exitTs), entryTs + barMs);
  const id = chart.createOverlay({
    name: ZONE_OVERLAY,
    lock: true,
    points: [
      { timestamp: entryTs, value: t.entry_price },
      { timestamp: windowEnd, value: t.entry_price },
      { timestamp: entryTs, value: z.hasReward ? (t.target as number) : t.entry_price },
      { timestamp: entryTs, value: z.hasRisk ? (t.stop_initial as number) : t.entry_price },
      { timestamp: entryTs, value: z.stopMoved ? (t.stop_final as number) : t.entry_price },
      { timestamp: exitTs, value: t.exit_price },
    ],
    extendData: {
      hasReward: z.hasReward,
      hasRisk: z.hasRisk,
      stopMoved: z.stopMoved,
      rewardPct: z.rewardPct,
      riskPct: z.riskPct,
      rr: z.rr,
      win: t.pnl >= 0,
    } satisfies ZoneExtra,
  });
  if (typeof id === "string") artifacts.selectionOverlayIds.push(id);
  scrollChartToTrade(chart, entryTs, exitTs);
}

export function registerBacktestIndicators(): void {
  registerIndicator<{ equity?: number }>({
    name: EQUITY_INDICATOR,
    shortName: "Equity",
    series: IndicatorSeries.Normal,
    precision: 2,
    figures: [{ key: "equity", title: "Equity: ", type: "line" }],
    // Read THIS instance's equity map off its extendData — never a module global,
    // so each cell's EQUITY pane plots its own backtest (see runAndRender).
    calc: (dataList, indicator: Indicator) => {
      const equity = indicator.extendData as Map<number, number> | undefined;
      if (!equity) return dataList.map(() => ({}));
      return dataList.map((k) => {
        const v = equity.get(k.timestamp);
        return v != null ? { equity: v } : {};
      });
    },
  });
}

export async function runAndRender(
  chart: Chart,
  req: BacktestRequest,
  scope: string,
  displayResolution: string,
  period?: BacktestPeriod,
  showEquity = false,
): Promise<StoredBacktestResult> {
  // Temporary phase timing (perf investigation).
  const t0 = performance.now();
  const result = await runBacktest(req);
  const t1 = performance.now();
  // Drops the previous run's markers/equity/highlight/selection zone AND
  // detaches its highlight/selection subscriptions + resets
  // highlightTradeSignal/selectedTradeSignal — so a stale trade index from the
  // prior result can never draw against this run's data. (Does NOT delete the
  // persisted store — the save() below overwrites it with the fresh run.)
  teardownArtifacts(chart);
  // Persist so the markers/equity/trades survive a timeframe switch and a full
  // reload (candles stripped — see saveBacktestResult). Attach the period so the
  // shading persists + rehydrates like the markers, and the equity-curve choice
  // so the reload honors it.
  saveBacktestResult(scope, req.epic, result, period, showEquity);
  // Render for the CURRENTLY displayed timeframe, not blindly native: the run's
  // base TF (req.resolution) can differ from the chart's TF (the settings panel's
  // "base TF" dropdown lets you run e.g. 5m while viewing 1H), and running does
  // NOT switch the chart. Hardcoding native+equity then piled every fine fill onto
  // the coarse bars (aggregate's whole reason to exist) and drew a gappy equity
  // pane. Same flags rehydrate uses, so a run and a switch-away-and-back now agree.
  // Render the freshly-STORED object (which carries `period`) so the shading is
  // present at render time.
  const stored = loadBacktestResult(scope, req.epic) ?? result;
  const flags = backtestRenderFlags(displayResolution, req.resolution);
  const t2 = performance.now();
  renderArtifacts(chart, stored, { ...flags, drawEquity: flags.drawEquity && showEquity });
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
    // time|leg -> trade index, so each fill marker can be tied back to the trade
    // it belongs to (its opening fill is at entry_time, its closing fill at
    // exit_time, both tagged with the trade's leg).
    const tradeIndexByFill = new Map<string, number>();
    result.trades.forEach((t, i) => {
      tradeIndexByFill.set(`${t.entry_time}|${t.leg}`, i);
      tradeIndexByFill.set(`${t.exit_time}|${t.leg}`, i);
    });

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

    // Trade markers -> locked backtestMarker overlays (arrow + label). Markers
    // that map to a trade also emphasize/scroll the trades panel row on hover
    // (chart -> row half of the two-way sync; the row -> chart half is the
    // highlightTradeSignal subscription in renderArtifacts). The gating on
    // `backtestResultSignal.value === result` (identity) keeps a not-currently-
    // shown cell's markers inert instead of cross-talking into another chart's
    // trade indices — a backtest can be rendered in more than one cell at once.
    ensureMarkerOverlayRegistered();
    for (const m of result.markers) {
      // Skip fills outside the loaded bar window: on a finer timeframe the
      // backtest may predate the (much shorter) loaded history, and snapNearestBar
      // would otherwise clamp every such fill onto the edge bar — the disconnected
      // marker pile. In-window fills still snap normally (3m viewing a 5m run).
      // The history-coverage page-back then loads the older bars and
      // reanchorBacktestMarkers redraws, so the initially-skipped fills reappear
      // on their real candles once covered.
      if (!fillWithinLoadedWindow(m.time * 1000, barTimes)) continue;
      const idx = tradeIndexByFill.get(`${m.time}|${m.leg}`);
      const snappedTs = snapNearestBar(m.time * 1000, barTimes);
      const bar = barByTime.get(snappedTs);
      // Shared click handler for this trade's fill marker AND its signal caret:
      // sticky-select the trade, same as clicking its dock row — the
      // selectedTradeSignal subscription draws the risk/reward zone and scrolls
      // to it. Clicking the already-selected trade toggles it back off. One
      // definition so the two glyphs of the same trade can't drift apart.
      const toggleTradeSelect = () => {
        if (backtestResultSignal.value === result && idx !== undefined) {
          selectedTradeSignal.set(selectedTradeSignal.value === idx ? null : idx);
        }
        return false;
      };
      const id = chart.createOverlay({
        name: MARKER_OVERLAY,
        points: [{ timestamp: snappedTs, value: m.price }],
        lock: true, // backtest artifacts: not user-editable
        extendData: {
          label: markerLabel(m.side, m.leg, m.reason),
          win: idx !== undefined ? result.trades[idx].pnl >= 0 : null,
          placement: bar ? markerPlacement(m.price, bar.high, bar.low) : "above",
        } satisfies MarkerExtra,
        styles: { line: { color: m.side === "buy" ? BUY_COLOR : SELL_COLOR, style: LineType.Solid } },
        ...(idx !== undefined
          ? {
              onMouseEnter: () => {
                if (backtestResultSignal.value === result) {
                  highlightTradeSignal.set(idx);
                  setMarkerHoverCursor(chart, true);
                }
                return false;
              },
              onMouseLeave: () => {
                if (backtestResultSignal.value === result) {
                  highlightTradeSignal.set(null);
                  setMarkerHoverCursor(chart, false);
                }
                return false;
              },
              onClick: toggleTradeSelect,
            }
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
      if (glyph && fillWithinLoadedWindow(glyph.signalTime * 1000, barTimes)) {
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
          onMouseEnter: (e) => {
            if (backtestResultSignal.value === result) {
              backtestSignalHoverSignal.set({ glyph, x: e.pageX ?? 0, y: e.pageY ?? 0 });
              if (idx !== undefined) highlightTradeSignal.set(idx);
              setMarkerHoverCursor(chart, true);
            }
            return false;
          },
          onMouseLeave: () => {
            if (backtestResultSignal.value === result) {
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
  }
}

/** The oldest bar timestamp (ms) a set of fill markers needs loaded so ALL their
 * on-chart artifacts can be drawn — the min over each marker's fill time AND its
 * `signal_time`. A rule-based fill's signal caret anchors ONE bar before the fill
 * (the signal bar), so covering only the oldest fill can leave the leftmost
 * entry's signal bar just outside the loaded window: reanchor then draws the fill
 * but the caret's window guard (see drawMarkers) skips it, and no later reanchor
 * fires to add it. Folding signal_time in pages back the extra bar so the caret
 * draws too. null when there are no markers. Pure + exported for tests. */
export function oldestBacktestAnchorMs(markers: Marker[]): number | null {
  let min = Infinity;
  for (const m of markers) {
    min = Math.min(min, m.time * 1000);
    if (m.signal_time != null) min = Math.min(min, m.signal_time * 1000);
  }
  return Number.isFinite(min) ? min : null;
}

/** The oldest bar timestamp (ms) this chart needs loaded to draw its backtest
 * markers, or null when nothing is drawn (markerMode "none" / no result).
 * ChartCore folds this into the history-coverage page-back so a finer-timeframe
 * view — whose initial load starts well after the run — pages back far enough to
 * cover the run, then calls reanchorBacktestMarkers. Reads the already-rendered
 * artifacts (rehydrate ran first), so it honors the current timeframe's
 * markerMode decision. */
export function getBacktestCoverageFromTs(chart: Chart): number | null {
  const a = artifactsByChart.get(chart);
  if (!a || !a.result || a.markerMode === "none") return null;
  return oldestBacktestAnchorMs(a.result.markers);
}

/** Redraw a chart's backtest markers against the CURRENT loaded bars — call
 * after the history-coverage page-back loads older history the initial
 * recent-only load didn't cover. On a finer timeframe the initial load starts
 * well after the backtest's own range, so renderArtifacts culled every fill as
 * out-of-window (clamping them would pile them at the left edge). Once the
 * covering bars page in, this recreates the native overlays / recomputes the
 * aggregate clusters so the markers land on their real candles. Markers ONLY —
 * the equity pane and the highlight/selection subscriptions renderArtifacts
 * installed stay in place (re-running the full render would double-install them).
 * No-op if this chart has no rendered result or draws nothing (markerMode none). */
export function reanchorBacktestMarkers(chart: Chart): void {
  const artifacts = artifactsByChart.get(chart);
  if (!artifacts || !artifacts.result || artifacts.markerMode === "none") return;
  for (const id of artifacts.markerIds) chart.removeOverlay(id);
  artifacts.markerIds = [];
  artifacts.aggClusters = [];
  drawMarkers(chart, artifacts.result, artifacts);
  clearPeriodBands(chart, artifacts);
  drawPeriodBands(chart, artifacts, artifacts.result);
}

/** Draw a backtest result's on-chart artifacts (equity sub-pane + trade
 * markers) and wire the trades-panel hover/selection sync. Shared by a fresh
 * run (runAndRender) and a rehydrate after a timeframe switch / reload
 * (rehydrateBacktest). The caller is responsible for tearing down any prior
 * artifacts first and for publishing `backtestResultSignal` with THIS exact
 * `result` object (the sync gating below is identity-based).
 *
 * `drawEquity` renders the equity curve (native timeframe only — a bar-indexed
 * equity series is misleading once bars aggregate). `markerMode` picks how
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
  { markerMode, drawEquity }: { markerMode: "native" | "aggregate" | "none"; drawEquity: boolean },
): void {
  const artifacts = artifactsFor(chart);

  // Equity curve -> own sub-pane. The series travels on the instance's
  // extendData so this chart's calc looks up its own values.
  if (drawEquity) {
    const equityByTs = new Map(result.equity.map((p) => [p.time * 1000, p.value]));
    artifacts.equityPaneId =
      chart.createIndicator(
        { name: EQUITY_INDICATOR, extendData: equityByTs },
        false,
      ) ?? null;
  }

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
  const unsubPeriods = backtestPeriodsShownSignal.subscribe(() => {
    clearPeriodBands(chart, artifacts);
    drawPeriodBands(chart, artifacts, result);
  });

  if (markerMode === "none") {
    artifacts.unsub = unsubPeriods;
    return;
  }

  // Draw the trade markers for the currently-loaded bars. Split out so the
  // history-coverage page-back can redraw JUST the markers later (see
  // reanchorBacktestMarkers) without re-creating the equity pane or re-installing
  // the subscriptions below.
  drawMarkers(chart, result, artifacts);

  // Row -> chart: draw ONE transient locked line spanning entry -> exit,
  // colored win/loss, while a row (or a marker, above) is highlighted; null
  // removes it. Never persisted, never more than one at a time.
  const unsubHighlight = highlightTradeSignal.subscribe((i) => {
    // Every subscriber clears its OWN leftover line unconditionally (so a chart
    // that just lost "active" status — the panel switched to another cell's
    // result — can't strand a stale line), but only the panel's currently
    // active backtest draws a new one (see note above).
    if (artifacts.highlightOverlayId) {
      chart.removeOverlay(artifacts.highlightOverlayId);
      artifacts.highlightOverlayId = null;
    }
    if (i == null || backtestResultSignal.value !== result) return;
    const t = artifacts.trades[i];
    if (!t) return;
    const id = chart.createOverlay({
      name: "segment",
      points: [
        { timestamp: t.entry_time * 1000, value: t.entry_price },
        { timestamp: t.exit_time * 1000, value: t.exit_price },
      ],
      lock: true,
      needDefaultPointFigure: false,
      styles: { line: { color: t.pnl >= 0 ? BUY_COLOR : SELL_COLOR, style: LineType.Solid } },
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
    if (i == null || backtestResultSignal.value !== result) return;
    const t = artifacts.trades[i];
    if (!t) return;
    const entryTs = t.entry_time * 1000;
    const exitTs = t.exit_time * 1000;
    // A rule-based entry's signal caret anchors one bar BEFORE the entry fill
    // (its signal bar). Fold that bar into the coverage span so paging to reach
    // this trade loads it too — otherwise the page-back lands exactly on the
    // entry bar, leaving the signal bar just outside the window, and drawMarkers
    // draws the arrow but skips the caret (the leftmost-entry "missing caret" bug).
    const entryMarker = result.markers.find(
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
    if (firstTs == null || lastTs == null || (hi >= firstTs && lo <= lastTs)) {
      drawSelectionZone(chart, artifacts, t);
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
        if (selectedTradeSignal.value !== i || backtestResultSignal.value !== result) return;
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
  };
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
 *  - equity: native timeframe ONLY (a bar-indexed equity curve is misleading
 *    once bars aggregate, and sparse once they subdivide).
 * Pure + exported for tests. */
export function backtestRenderFlags(
  current: string,
  native: string,
): { markerMode: "native" | "aggregate" | "none"; drawEquity: boolean } {
  const cur = RESOLUTION_SECONDS[current] ?? 0;
  const nat = RESOLUTION_SECONDS[native] ?? 0;
  let markerMode: "native" | "aggregate" | "none" = "none";
  if (cur > 0 && nat > 0) markerMode = cur > nat ? "aggregate" : "native";
  return { markerMode, drawEquity: current === native };
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

/** Restore a cell's saved backtest onto the chart after a symbol/timeframe
 * change or a page reload — the counterpart to overlays.rehydrate for backtest
 * artifacts. Called from ChartCore once the new series' bars are loaded.
 *
 * Markers render on the backtest's native timeframe AND any finer one where the
 * fill timestamps still align to bar boundaries (per-fill arrows), and on any
 * coarser timeframe as one aggregate pill per bar; the equity curve renders only
 * on the native timeframe. The result stays saved and the panel is repopulated
 * regardless, so it's always discoverable. */
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
  renderArtifacts(chart, saved, { ...flags, drawEquity: flags.drawEquity && (saved.showEquity ?? false) });
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
  for (const id of artifacts.markerIds) chart.removeOverlay(id);
  artifacts.markerIds = [];
  artifacts.aggClusters = [];
  artifacts.markerMode = "none";
  clearPeriodBands(chart, artifacts);
  if (artifacts.equityPaneId) {
    chart.removeIndicator(artifacts.equityPaneId, EQUITY_INDICATOR);
    artifacts.equityPaneId = null;
  }
  if (artifacts.highlightOverlayId) {
    chart.removeOverlay(artifacts.highlightOverlayId);
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

/** User-initiated clear (toolbar ✕): drop the live artifacts AND delete the
 * persisted store so it does NOT come back on the next timeframe switch or
 * reload. */
export function clearBacktest(chart: Chart, scope: string, epic: string): void {
  teardownArtifacts(chart);
  clearBacktestResult(scope, epic);
}

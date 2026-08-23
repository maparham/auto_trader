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
  registerOverlay,
  type Chart,
  type OverlayTemplate,
  type OverlayFigure,
} from "klinecharts";
import { runBacktest, runExprBacktest, type BacktestRequest, type ExprBacktestRequest, type Marker } from "../api";
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
} from "./signals";
import type { WfoScheme, TradeZone as TradeZoneWire } from "../api";
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

/** The trade direction to badge an ENTRY marker with, or null for an exit fill.
 * A fill opens a position when its side matches its leg (buy⇒long, sell⇒short) —
 * the same "opening" test markerLabel uses. Entries get a ▲long / ▼short arrow
 * in the pill; exits (which close the opposite side) get none. */
export function entryDirection(side: "buy" | "sell", leg: "long" | "short"): "long" | "short" | null {
  const opening = (leg === "long" && side === "buy") || (leg === "short" && side === "sell");
  return opening ? leg : null;
}

// The long/short direction glyphs, shared by the native pill (markerPillLabel)
// and the coarser-timeframe aggregate pill (aggPillLabel) so the up/down cue
// reads identically on every timeframe.
export const LONG_GLYPH = "▲";
export const SHORT_GLYPH = "▼";

/** The native fill pill's text: `markerLabel` prefixed with the direction glyph
 * on ENTRY fills (▲ B+ / ▼ S+) so long vs short reads at a glance. Exits
 * (S-/B-/SL/TP) get no glyph — direction only tags the opening fill. */
export function markerPillLabel(side: "buy" | "sell", leg: "long" | "short", reason?: string): string {
  const base = markerLabel(side, leg, reason);
  const dir = entryDirection(side, leg);
  return dir ? `${dir === "long" ? LONG_GLYPH : SHORT_GLYPH} ${base}` : base;
}

/** The aggregate (grouped) pill's text for a bar's cluster of trades: the same
 * direction glyphs as the native pill plus the count·net summary. A bar with
 * both directions splits the count inline (▲2 ▼1 · +4); a single-direction bar
 * shows one glyph (▲ 3 · +12, or ▲ +12 when it holds just one trade). Pure +
 * exported for tests; consumed by BacktestAggMarkers. */
export function aggPillLabel(longs: number, shorts: number, net: number): string {
  // One decimal for a single-digit magnitude (small nets read too coarse as
  // integers); drop to a whole number once |net| ≥ 10, where the decimal is just
  // pill-widening noise.
  const abs = Math.abs(net);
  const netStr = `${net >= 0 ? "+" : "−"}${abs.toFixed(abs >= 10 ? 0 : 1)}`;
  if (longs > 0 && shorts > 0) {
    return `${LONG_GLYPH}${longs} ${SHORT_GLYPH}${shorts} · ${netStr}`;
  }
  const glyph = longs > 0 ? LONG_GLYPH : SHORT_GLYPH;
  const count = longs + shorts;
  return count >= 2 ? `${glyph} ${count} · ${netStr}` : `${glyph} ${netStr}`;
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
const artifactsByChart = new WeakMap<Chart, BacktestArtifacts>();

// Bridge from a Chart to its ChartCore page-back function. The selection
// subscription below only holds the Chart (it's installed by renderArtifacts,
// which knows nothing of the controller), so ChartCore registers its
// coverBacktestTradeTo here at chart-ready and clears it on teardown. Lets the
// subscription page an out-of-window trade in before scrolling to it.
// True while a selectedTradeSignal.set originates from an on-chart marker
// click (see toggleTradeSelect in drawMarkers). The selection subscription —
// which runs synchronously inside the .set — consumes it to skip the scroll.
let selectFromMarkerClick = false;

const pagerByChart = new WeakMap<Chart, (fromTs: number) => Promise<boolean>>();
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

function artifactsFor(chart: Chart): BacktestArtifacts {
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
      result: null,
      unsub: null,
      periodBandIds: [],
      markerDrawWindow: null,
    };
    artifactsByChart.set(chart, a);
  }
  return a;
}

/** Remove every overlay drawn for the sticky selection (windowed zone) and
 * reset the bookkeeping — shared by the reset-at-top-of-run, clearBacktest,
 * and the selectedTradeSignal subscription's own "replace" step. */
function removeSelectionOverlays(chart: Chart, artifacts: BacktestArtifacts): void {
  for (const id of artifacts.selectionOverlayIds) chart.removeOverlay({ id });
  artifacts.selectionOverlayIds = [];
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

// Backtest fill marker (arrow + label). A hand-rolled take on klinecharts'
// built-in `simpleAnnotation` (minus its long stem line, which read as visual
// noise near the wicks) with ONE other deliberate difference: the figures do
// NOT set `ignoreEvent: true`. The built-in hardcodes `ignoreEvent: true` on
// its figures, which klinecharts' _createFigureEvents reads to strip ALL mouse
// events at the dispatch layer, so an overlay-level onClick/onMouseEnter/
// onMouseLeave could never fire (that's the bug this fixes).
// Leaving ignoreEvent unset lets figure hits route to the overlay handlers
// (see drawFigures -> _createFigureEvents -> onMouseEnter/onClick).
// Per-figure styles are omitted, so arrow + text inherit `defaultStyles[type]`
// merged with any overlay-level `styles` passed at createOverlay.
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
          styles: { style: 'fill', color: "rgba(0,0,0,0)" },
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
          styles: { style: 'fill', color: glyphColor },
        },
      ];
    }

    // Backtest fills: a compact arrow + always-on label pill hugging the fill.
    // (Historically these hung off a 50px stem, which read as a stray vertical
    // line near the candle wicks — the arrow alone points at the fill price.)
    const arrowTipY = coordinates[0].y + dir * 6;
    const arrowEndY = arrowTipY + dir * 6;
    // The label renders as a filled pill via klinecharts' default overlay text
    // style (white text on a blue background). Override just the fill/border to
    // the win/loss color so a losing trade's marker reads red, a winner green.
    const pillColor = win == null ? undefined : win ? BUY_COLOR : SELL_COLOR;
    // The long/short direction rides INSIDE the label pill (markerPillLabel
    // prefixes an entry with ▲/▼), so it reads on every timeframe — the coarser
    // aggregate view has only the DOM pill, no arrowhead.
    return [
      {
        type: "polygon",
        attrs: {
          coordinates: [
            { x: startX, y: arrowTipY },
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
        styles: { style: 'fill', color: "rgba(0,0,0,0)" },
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
        styles: { style: 'fill', color: SIGNAL_COLOR },
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
  const dom = chart.getDom("candle_pane", 'main');
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
  return barIndexBy(barTimes.length, (i) => barTimes[i], ms);
}

/** barIndexForTs over the bar objects directly — for callers that only need a
 * couple of lookups and shouldn't materialize a full timestamps array first
 * (the loaded list can run to 150k+ bars after a deep jump). */
export function barIndexForBars(bars: readonly { timestamp: number }[], ms: number): number {
  return barIndexBy(bars.length, (i) => bars[i].timestamp, ms);
}

function barIndexBy(len: number, tsAt: (i: number) => number, ms: number): number {
  const last = len - 1;
  if (last < 0) return -1;
  if (ms <= tsAt(0)) return 0;
  if (ms >= tsAt(last)) return last;
  let lo = 0;
  let hi = last;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tsAt(mid) <= ms) {
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

/** One per-trade dash for the coarse-timeframe view: the containing display
 * bar, how far through it the entry sits (0..1, so the dash lands time-wise on
 * the candle, e.g. an entry 3h into a 4h bar draws at ¾ of its width), the
 * entry price (the dash's y), and how many display candles the trade covers
 * (drives hover: ≥2 shows the entry→exit overlay, 1 a details tooltip). */
export interface TradeDash {
  index: number; // index into result.trades (highlightTradeSignal key)
  trade: Trade;
  barTs: number; // containing display bar open (ms)
  frac: number; // 0..1 entry position within that bar
  price: number; // entry_price
  spanBars: number; // display candles covered entry→exit, inclusive
}

/** Per-trade dash anchors for the aggregate (coarser-than-native) view. The
 * within-bar fraction divides by the NOMINAL bar interval — `nominalMs` when
 * the caller knows the display interval (preferred: the min-gap fallback is
 * poisoned by one DST-short session or calendar-length bars), else the minimum
 * gap between consecutive loaded bars — not the gap to the next bar, so a
 * session closure after the containing bar can't smear an entry leftward; an
 * entry inside a closure gap clamps to its bar's right edge. Trades entering
 * OUTSIDE the loaded window are dropped on both sides (the cluster pill still
 * counts them; a clamped dash would mark a made-up position). An exit past the
 * loaded window forces spanBars >= 2 — the trade outlives the last candle even
 * though its clamped exit index says otherwise. Fewer than two bars gives no
 * interval to place within -> []. Pure + exported for tests. */
export function tradeDashes(
  clusters: TradeCluster[],
  bars: readonly { timestamp: number }[],
  nominalMs?: number,
): TradeDash[] {
  if (bars.length < 2) return [];
  const barTimes = bars.map((b) => b.timestamp);
  let intervalMs = nominalMs ?? Infinity;
  if (nominalMs == null) {
    for (let i = 1; i < barTimes.length; i++) {
      const d = barTimes[i] - barTimes[i - 1];
      if (d > 0 && d < intervalMs) intervalMs = d;
    }
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return [];
  const last = barTimes[barTimes.length - 1];
  const out: TradeDash[] = [];
  for (const cl of clusters) {
    for (const { trade: t, index } of cl.trades) {
      const entryMs = t.entry_time * 1000;
      if (entryMs < barTimes[0] || entryMs >= last + intervalMs) continue;
      const exitMs = t.exit_time * 1000;
      const entryIdx = barIndexForTs(barTimes, entryMs);
      const exitIdx = barIndexForTs(barTimes, exitMs);
      let spanBars = Math.max(exitIdx - entryIdx, 0) + 1;
      if (exitMs >= last + intervalMs) spanBars = Math.max(spanBars, 2);
      out.push({
        index,
        trade: t,
        barTs: barTimes[entryIdx],
        frac: Math.min((entryMs - barTimes[entryIdx]) / intervalMs, 1),
        price: t.entry_price,
        spanBars,
      });
    }
  }
  return out;
}

/** [start, end) bounds of the dashes whose barTs falls in [fromTs, toTs] — two
 * binary searches over the barTs-ascending dash list, so the per-frame
 * projection touches O(log n + visible) dashes instead of every trade. Pure +
 * exported for tests (the caller, useChartPaint, feeds it the visible range). */
export function dashSliceBounds(
  dashes: readonly { barTs: number }[],
  fromTs: number,
  toTs: number,
): [number, number] {
  let lo = 0;
  let hi = dashes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dashes[mid].barTs < fromTs) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  hi = dashes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dashes[mid].barTs <= toTs) lo = mid + 1;
    else hi = mid;
  }
  return [start, lo];
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

/** Right edge for a trade overlay whose exit happened at `exitExactMs`, rounded
 * UP to the close of the display candle that contains it, so the overlay covers
 * at least the trade's real duration. Floors at one display bar so a first-bar
 * exit still shows. `bars` are the currently loaded candles (ascending). */
export function overlayEndTs(
  exitExactMs: number,
  bars: readonly { timestamp: number }[],
  barMs: number,
  entryTs: number,
): number {
  const floor = entryTs + barMs;
  if (bars.length === 0) return Math.max(floor, exitExactMs);
  // The display candle containing exitExactMs is the last bar whose open <= it.
  let containing = bars[0].timestamp;
  for (const b of bars) {
    if (b.timestamp <= exitExactMs) containing = b.timestamp;
    else break;
  }
  return Math.max(floor, containing + barMs); // round up to that candle's close
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
        styles: { style: 'fill', color: `${BUY_COLOR}26` },
        ignoreEvent: true,
      });
    }
    if (z.hasRisk) {
      figures.push({
        type: "rect",
        attrs: { x: c0.x, y: Math.min(c0.y, c3.y), width: c1.x - c0.x, height: Math.abs(c0.y - c3.y) },
        styles: { style: 'fill', color: `${SELL_COLOR}26` },
        ignoreEvent: true,
      });
    }
    if (z.stopMoved) {
      figures.push({
        type: "line",
        attrs: { coordinates: [{ x: c0.x, y: c4.y }, { x: c1.x, y: c4.y }] },
        styles: { style: 'dashed', dashedValue: [4, 4], color: `${SELL_COLOR}80`, size: 1 },
        ignoreEvent: true,
      });
    }
    // entry -> exit (win/loss colored, like the transient highlight line).
    figures.push({
      type: "line",
      attrs: { coordinates: [{ x: c0.x, y: c0.y }, { x: c5.x, y: c5.y }] },
      styles: { style: 'solid', color: z.win ? BUY_COLOR : SELL_COLOR, size: 1 },
      ignoreEvent: true,
    });
    // entry line (accent), spanning the window.
    figures.push({
      type: "line",
      attrs: { coordinates: [{ x: c0.x, y: c0.y }, { x: c1.x, y: c0.y }] },
      styles: { style: 'solid', color: ACCENT_COLOR, size: 1.5 },
      ignoreEvent: true,
    });
    // entry / exit dots.
    figures.push({ type: "circle", attrs: { x: c0.x, y: c0.y, r: 3 }, styles: { style: 'fill', color: ACCENT_COLOR }, ignoreEvent: true });
    figures.push({ type: "circle", attrs: { x: c5.x, y: c5.y, r: 3 }, styles: { style: 'fill', color: z.win ? BUY_COLOR : SELL_COLOR }, ignoreEvent: true });
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

const STRATEGY_ZONE_OVERLAY = "strategyZone";

// A strategy-attached trade zone (api.ts TradeZone — e.g. BB Regime's broken
// consolidation range): a shaded time×price rect with a small label pill, drawn
// only while its trade is stickily selected. Two points carry the geometry:
// 0 (from_time, top), 1 (to_time, bottom). Same read-only discipline as the
// risk/reward zone above (lock on create, every figure ignoreEvent).
const strategyZoneOverlay: OverlayTemplate = {
  name: STRATEGY_ZONE_OVERLAY,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates }) => {
    if (coordinates.length < 2) return [];
    const [c0, c1] = coordinates;
    const x = Math.min(c0.x, c1.x);
    const y = Math.min(c0.y, c1.y);
    const label = typeof (overlay.extendData as { label?: unknown })?.label === "string"
      ? (overlay.extendData as { label: string }).label
      : "";
    const figures: OverlayFigure[] = [
      {
        type: "rect",
        attrs: { x, y, width: Math.abs(c1.x - c0.x), height: Math.abs(c1.y - c0.y) },
        styles: {
          style: 'stroke_fill',
          color: `${PERIOD_COLOR}1f`,
          borderColor: `${PERIOD_COLOR}66`,
          borderSize: 1,
        },
        ignoreEvent: true,
      },
    ];
    // Label only when the rect is wide enough to carry it — on a zoomed-out
    // view a run's many squeeze windows would otherwise stack dozens of
    // clipped pills; the shading alone marks the narrow ones.
    if (label && Math.abs(c1.x - c0.x) >= 48) {
      figures.push(pillFigure(x + 4, y - 10, label, PERIOD_COLOR, "left"));
    }
    return figures;
  },
};

let strategyZoneOverlayRegistered = false;
function ensureStrategyZoneOverlayRegistered(): void {
  if (strategyZoneOverlayRegistered) return;
  strategyZoneOverlayRegistered = true;
  registerOverlay(strategyZoneOverlay);
}

/** The ms time span to draw a strategy zone over, or null when the zone lies
 * entirely outside the loaded bar window [firstTs, lastTs] — klinecharts would
 * clamp every point onto the edge bar and draw a degenerate sliver (same guard
 * as the risk/reward zone). A PARTIAL overlap still draws: clamping only one
 * edge reads fine. */
export function strategyZoneSpan(
  z: TradeZoneWire,
  firstTs: number,
  lastTs: number,
): { fromTs: number; toTs: number } | null {
  const fromTs = z.from_time * 1000;
  const toTs = z.to_time * 1000;
  if (toTs < firstTs || fromTs > lastTs) return null;
  return { fromTs, toTs };
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
        styles: { style: 'fill', color: `${PERIOD_COLOR}0f` }, // ~6%
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
        styles: { style: 'fill', color: `${PERIOD_COLOR}33` }, // ~20%
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
function drawSelectionZone(
  chart: Chart,
  artifacts: BacktestArtifacts,
  t: Trade,
  scroll = true,
): void {
  ensureZoneOverlayRegistered();
  const z = tradeZones(t);
  const entryTs = t.entry_time * 1000;
  const exitTs = t.exit_time * 1000;
  const hasExact = t.exit_time_exact != null;
  const exitPointTs = hasExact ? (t.exit_time_exact as number) * 1000 : exitTs;
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
  const windowEnd = hasExact
    ? overlayEndTs(exitPointTs, data ?? [], barMs, entryTs)
    : Math.max(Math.max(entryTs, exitTs), entryTs + barMs);
  const id = chart.createOverlay({
    name: ZONE_OVERLAY,
    lock: true,
    points: [
      { timestamp: entryTs, value: t.entry_price },
      { timestamp: windowEnd, value: t.entry_price },
      { timestamp: entryTs, value: z.hasReward ? (t.target as number) : t.entry_price },
      { timestamp: entryTs, value: z.hasRisk ? (t.stop_initial as number) : t.entry_price },
      { timestamp: entryTs, value: z.stopMoved ? (t.stop_final as number) : t.entry_price },
      { timestamp: exitPointTs, value: t.exit_price },
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

/** Map a native-bar equity series onto whatever bars are currently loaded,
 * using equity-at-bar-close semantics so the curve renders correctly on ANY
 * timeframe — not just the native one it was run on.
 *
 * For each displayed bar we carry forward the equity value of the last native
 * point that falls BEFORE the next bar's open — i.e. the equity as of this
 * bar's close. Bars before the first point stay blank; bars after the last
 * point stay blank (so a coarser view never draws a flat line extending to the
 * live edge). On the native timeframe this reproduces the old exact per-bar
 * match; on a coarser timeframe it downsamples to bar-close; on a finer one it
 * steps at native granularity.
 *
 * `bars` and `points` are both ascending by time; `points` are
 * `[timestampMs, value]`. Pure + exported for tests. */
export function equityForBars(
  bars: readonly { timestamp: number }[],
  points: readonly (readonly [number, number])[],
): { equity?: number }[] {
  if (points.length === 0) return bars.map(() => ({}));
  const lastTs = points[points.length - 1][0];
  let pi = 0;
  let carried: number | undefined;
  return bars.map((bar, idx) => {
    const nextTs = idx + 1 < bars.length ? bars[idx + 1].timestamp : Infinity;
    // Consume every native point strictly inside this bar (up to the next bar's
    // open); the last one is this bar's closing equity.
    while (pi < points.length && points[pi][0] < nextTs) {
      carried = points[pi][1];
      pi++;
    }
    if (carried === undefined || bar.timestamp > lastTs) return {};
    return { equity: carried };
  });
}

export function registerBacktestIndicators(): void {
  registerIndicator<{ equity?: number }>({
    name: EQUITY_INDICATOR,
    shortName: "Equity",
    series: 'normal',
    precision: 2,
    figures: [{ key: "equity", title: "Equity: ", type: "line" }],
    // Read THIS instance's equity series off its extendData — never a module
    // global, so each cell's EQUITY pane plots its own backtest (see
    // runAndRender). equityForBars re-anchors the native-bar series onto the
    // currently-loaded bars, so the curve is correct on any timeframe.
    calc: (dataList, indicator) => {
      const points = indicator.extendData as Array<[number, number]> | undefined;
      if (!points) return dataList.map<{ equity?: number }>(() => ({}));
      return equityForBars(dataList, points);
    },
  });
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
      const id = chart.createOverlay({
        name: MARKER_OVERLAY,
        points: [{ timestamp: snappedTs, value: m.price }],
        lock: true, // backtest artifacts: not user-editable
        extendData: {
          label: markerPillLabel(m.side, m.leg, m.reason),
          win: idx !== undefined ? result.trades[idx].pnl >= 0 : null,
          placement: bar ? markerPlacement(m.price, bar.high, bar.low) : "above",
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

/** The stitched equity series as ascending `[timestampMs, value]` pairs, picking
 * the compounded (`equity_scaled`) or summed (`equity`) series per `compounded`.
 * The backend emits `[unixSeconds, equity]`; this carries the ×1000 unit
 * conversion so equityForBars can re-anchor it onto the loaded bars. Pure +
 * exported for tests. */
export function wfoEquityPoints(scheme: WfoScheme, compounded: boolean): Array<[number, number]> {
  const series = compounded ? scheme.stitched.equity_scaled : scheme.stitched.equity;
  return series.map(([s, v]) => [s * 1000, v]);
}

/** The fold shading bands: every SECOND fold's out-of-sample test span, as
 * `{ from, to }` in ms. Alternating (folds 0, 2, 4, …) so adjacent test windows
 * read as distinct tinted stripes rather than one continuous block. Pure +
 * exported for tests. */
export function wfoFoldBandPoints(scheme: WfoScheme): Array<{ from: number; to: number }> {
  const bands: Array<{ from: number; to: number }> = [];
  scheme.folds.forEach((f, i) => {
    if (i % 2 === 0) bands.push({ from: f.test_from * 1000, to: f.test_to * 1000 });
  });
  return bands;
}

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

/** What a SERIES-LOAD path should do with the shared backtest panel.
 *
 * A cell's saved backtest is normally (re)published whenever its series loads
 * (`rehydrateBacktest`). While that cell is REPLAYING it must not be: the whole
 * run would go onto the panel — every trade the strategy is about to take with
 * its P&L, the run's final net P&L, and `period` as a real calendar range
 * straight through a masked session. A replaying cell's backtest belongs to the
 * progressive reveal (chart/useReplay + lib/replayReveal), which publishes only
 * the slice that has already happened.
 *
 * "clear" rather than "leave" when this chart owned the panel: the load path
 * tears its artifacts down BEFORE the bars land, so what the signal still holds
 * is a result nothing on this chart is drawing any more. Leaving it would keep
 * the pre-session run visible behind the session. Callers must therefore capture
 * `stalePanelOwner` with `ownsBacktestPanel` before that teardown.
 *
 * A caller that has torn nothing down (the cross-tab push handler in App) passes
 * `stalePanelOwner: false`: whatever this chart owns there is the reveal's own
 * live slice, and clearing it would blank a session mid-flight. */
export type BacktestPanelAction = "rehydrate" | "clear" | "leave";
export function backtestPanelActionForReplay(args: {
  replaying: boolean;
  stalePanelOwner: boolean;
}): BacktestPanelAction {
  if (!args.replaying) return "rehydrate";
  return args.stalePanelOwner ? "clear" : "leave";
}

/** Why the backtest panel must refuse an action on a REPLAYING cell, or null
 * when it may go ahead. The reason is USER-FACING copy: the same string
 * disables the control (so nothing looks live that isn't) and explains a
 * refusal that got as far as the run, which is why it lives here rather than
 * being written out twice at two call sites.
 *
 * A SIBLING of backtestPanelActionForReplay above, not an extension of it: that
 * one answers "what should a load or a cross-tab push do with a result that
 * already exists", which has three outcomes and a panel-ownership input. This
 * answers "may the user start something", which has two outcomes and neither
 * input. Folding them together would mean one function with a mode flag and
 * two disjoint halves.
 *
 * The two actions:
 *
 * - "run" — a backtest, sweep or walk-forward started from this tab. All three
 *   enter through BacktestButton's run(), so one guard there covers them (and
 *   the agent bridge, which reaches the same request signal). A run publishes
 *   its whole fresh result including `period` as a real calendar range — the
 *   exact field lib/replayReveal drops, because BacktestPanel renders it
 *   unmasked — and then pages real post-cursor history into the chart and fits
 *   the view to the full traded span. This is the third mouth on that leak; the
 *   load effect (chart/useLiveMarketData) and the cross-tab push (App) are the
 *   two already closed, both via backtestPanelActionForReplay.
 *
 * - "render-wfo" — the walk-forward results panel's scheme picker, whose render
 *   tears down the progressive reveal and repaints the chart with fold bands
 *   over real calendar dates. The refusal is only spoken (a toast): the picker
 *   is a row in a results table, not a button with a disabled state, and the
 *   gate itself lives in renderWfoArtifacts so both of its callers get it.
 *
 * - "pick-range" — the chart range picker. Dragging across a replaying chart
 *   converts pixels back to the BAR's real epoch and drops it into two
 *   datetime-local inputs, printing the exact real date and time of the bars
 *   under the cursor with the session still running and resumable. The chart's
 *   own axis reads "Day 3 09:30"; the picker would read the truth. */
export type BacktestReplayAction = "run" | "pick-range" | "render-wfo";
export function backtestActionBlockedByReplay(args: {
  replaying: boolean;
  action: BacktestReplayAction;
}): string | null {
  if (!args.replaying) return null;
  switch (args.action) {
    case "run":
      return "Chart replay is running: exit the session to run a backtest, sweep or walk-forward.";
    case "render-wfo":
      return "Chart replay is running: exit the session to show walk-forward folds on the chart.";
    case "pick-range":
      return "Chart replay is running: the chart's dates are hidden, so a range cannot be picked from it.";
  }
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
  return true;
}

/** User-initiated clear (toolbar ✕): drop the live artifacts AND delete the
 * persisted store so it does NOT come back on the next timeframe switch or
 * reload. */
export function clearBacktest(chart: Chart, scope: string, epic: string): void {
  teardownArtifacts(chart);
  clearBacktestResult(scope, epic);
}

// One ChartController per chart CELL. It bundles everything that is genuinely
// per-chart — the overlay manager and the small UI signals that used to be module
// globals — so two cells mounted at once never cross-talk (selecting an indicator
// in cell A must not light up the same-named indicator in cell B, etc.).
//
// App holds a cellId -> controller map and routes the FOCUSED cell's controller to
// the shared chrome (Toolbar / AlertsSidebar / alert + indicator modals). This
// extends the existing onReady={setChart} binding rather than introducing a React
// context, matching the codebase's module-singleton idiom.

import type { Chart } from "klinecharts";
import { OverlayManager } from "./overlays";
import { Signal } from "./signals";
import type { IndicatorInstance } from "./persist";
import { loadScalePriceOnly, loadSnapshotMeta } from "./persist";

// The selected indicator (TradingView-style): clicking an indicator's curve or its
// legend row selects it (hollow handles appear); clicking empty chart space
// deselects. `name` is the unique INSTANCE id (the klinecharts name); two instances
// of the same type have distinct ids, so this still uniquely identifies one.
export interface SelectedIndicator {
  paneId: string;
  name: string;
}

export class ChartController {
  readonly cellId: string;
  readonly scope: string;
  // This cell's overlay manager (drawings + price-alert lines), scoped to the cell.
  readonly overlays = new OverlayManager();

  // Read-only snapshot view: true while this cell's scope carries snapshotMeta
  // (a tab restored from a snapshot is a frozen study copy). THE single sentinel
  // for "this cell may not be mutated" — App picks the toolbar and mounts the
  // draw sidebar off it, and ChartCore's mutating handlers gate on its ref
  // mirror — rather than each surface re-reading storage. Seeded from the scope
  // here at construction, re-asserted by ChartCore's data-load effect, and
  // cleared by Unlock (which deletes the scope's snapshotMeta).
  readonly readOnly = new Signal<boolean>(false);

  // --- per-cell UI signals (were module globals in signals.ts) ----------------
  // The AVWAP INSTANCE id the user is currently placing ("click a bar to anchor"),
  // or null when not in anchor mode. Carries the id (not just a bool) so multiple
  // AVWAPs each anchor independently.
  readonly avwapAnchorMode = new Signal<string | null>(null);
  // True while the TV-style Measure ruler is armed (ruler button toggled on). The
  // next mousedown on the chart starts a measurement drag, then disarms. Esc also
  // disarms. Shift+drag measures without arming, so this stays a simple bool.
  readonly measureArmed = new Signal<boolean>(false);
  // True while the TV-style Slope tool is armed (angle-ruler button toggled on). Like
  // measureArmed the next two chart clicks place the line; unlike measure it then stays
  // interactive (drag endpoints / midpoint / rotate knob). Esc disarms.
  readonly slopeArmed = new Signal<boolean>(false);
  // True while the backtest "Pick Range" tool is armed: the next press-drag on the
  // chart selects a time range (shaded band, crosshair cursor), and on release the
  // picked [fromMs,toMs] is published on rangePickResult and the tool disarms.
  // Armed from OUTSIDE the chart (the backtest panel), so it also focuses the wrap.
  readonly rangePickArmed = new Signal<boolean>(false);
  // The most recent time range picked on the chart (ms), or null. The backtest
  // panel subscribes and drops it into the Custom from/to. One-shot: consumers may
  // reset it to null after reading.
  readonly rangePickResult = new Signal<{ fromMs: number; toMs: number } | null>(null);
  // TradingView-style price-axis "auto" mode (auto-fit y-axis to visible bars).
  // Starts ON; the toolbar "A" button reflects it and re-asserts auto-fit; the
  // cell turns it OFF when the user manually scales the price axis.
  readonly autoScale = new Signal<boolean>(true);
  // TradingView-style "invert scale" (Alt/Option+I + toolbar "I" button): flips
  // the candle-pane price axis via yAxis.reverse. Session-only — never persisted.
  readonly invertScale = new Signal<boolean>(false);
  // Sidebar eye menu (session-only, per cell): master switches that hide whole
  // categories without touching per-item state.
  readonly indicatorsHidden = new Signal<boolean>(false);
  readonly positionsHidden = new Signal<boolean>(false);
  // Double-click empty chart space (session-only, per cell): collapse just the
  // bottom sub-pane indicators (Volume/MACD/RSI…), leaving price-overlay indicators
  // (EMA…) on the candle pane visible. Orthogonal to indicatorsHidden — both mask
  // the same live `visible` flag, so a single applier (applyIndicatorVisibility)
  // derives effective visibility from both at once rather than fighting over it.
  readonly subPanesHidden = new Signal<boolean>(false);
  // TradingView-style "Scale price chart only": when true, the candle-pane price
  // axis auto-fits to the candle OHLC only — overlay indicators no longer expand it,
  // so adding an overlay never shrinks the candles. Persisted per cell (default on),
  // hydrated in the constructor. Applied to the live chart via chart._scalePriceOnly
  // (read by the patched YAxisImp.calcRange). The right-click price-axis menu toggles it.
  readonly scalePriceOnly = new Signal<boolean>(true);
  // The selected indicator (drives the hollow selection handles on its curve).
  readonly selectedIndicator = new Signal<SelectedIndicator | null>(null);
  // True while the cursor is over this cell's top-left legend strip (hides the
  // crosshair, TV-style). Read into klineStyles(theme, legendHovered).
  readonly legendHovered = new Signal<boolean>(false);
  // Name of the candle-pane indicator whose legend ROW the cursor is over, or null.
  readonly legendHoverName = new Signal<string | null>(null);
  // The indicator (pane + name) whose CURVE the cursor is over (any pane), or null.
  // The inverse of legendHoverName: hovering a curve highlights its legend card AND
  // shows the curve in selected mode (handles), TradingView-style. Carries the pane
  // so paintSelectionDots can target sub-pane curves (RSI/MACD/Volume), not just candle.
  readonly curveHover = new Signal<SelectedIndicator | null>(null);
  // Fired when an indicator INSTANCE is removed from THIS cell (legend trash /
  // context menu), carrying its instance id, so the focused Toolbar can keep its
  // active list in sync.
  readonly indicatorRemoved = new Signal<string | null>(null);

  // Active indicator INSTANCES on this cell (observable so the focused Toolbar
  // re-renders). Maintained by ChartCore's hydration + legend removals and the
  // focused Toolbar's add. Mirrors the persisted per-cell list.
  readonly indicators = new Signal<IndicatorInstance[]>([]);

  // The cell's live klinecharts instance (null until init / after dispose).
  chart: Chart | null = null;

  // DOM-focus this cell's chart wrap (null until mount). Chrome that arms a chart
  // interaction from OUTSIDE the wrap (DrawSidebar's tool buttons) must call this
  // after arming, or keyboard handling (Esc cancel) never reaches the chart —
  // the same reason measure arming focuses the wrap in ChartCore.
  focusChart: (() => void) | null = null;

  // Kick the cell's drawing-anchor coverage walk (null until mount; assigned by
  // ChartCore). Anything that adds drawings + rehydrates from OUTSIDE ChartCore
  // (a template apply in templates.ts) calls this afterwards, so a drawing
  // anchored before the loaded history window pages the older bars in instead of
  // rendering clamped to the first loaded bar.
  // Returns the coverage walk's promise so a caller that needs the older bars
  // loaded before its next step (a fresh backtest fitting the traded range) can
  // await it; void-returning callers (template apply) ignore the result.
  coverDrawingAnchors: (() => void | Promise<void>) | null = null;

  // Page older history in until a specific timestamp is covered (null until mount;
  // assigned by ChartCore). Used by the backtest trades panel: selecting a trade
  // whose entry predates the loaded bars (common on a fine timeframe, whose
  // initial load is recent-only) pages back to it on demand before scrolling.
  // Resolves to whether the oldest loaded bar now reaches `fromTs` (false → older
  // than reachable history, so the caller shows a notice instead of scrolling).
  coverBacktestTradeTo: ((fromTs: number) => Promise<boolean>) | null = null;

  constructor(cellId: string, scope: string) {
    this.cellId = cellId;
    this.scope = scope;
    this.overlays.setScope(scope);
    this.readOnly.set(loadSnapshotMeta(scope) != null);
    this.scalePriceOnly.set(loadScalePriceOnly(scope));
  }
}

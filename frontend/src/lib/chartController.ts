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
import { loadScalePriceOnly, loadPriceStretched, savePriceStretched, loadSnapshotMeta } from "./persist";
import { HistoryManager, registerHistory } from "./history";
import { applyCandleFit, type PriceFitMode } from "../chart/candleFit";
import type { HeatmapView } from "./heatmapController";

// The selected indicator (TradingView-style): clicking an indicator's curve or its
// legend row selects it (hollow handles appear); clicking empty chart space
// deselects. `name` is the unique INSTANCE id (the klinecharts name); two instances
// of the same type have distinct ids, so this still uniquely identifies one.
export interface SelectedIndicator {
  paneId: string;
  name: string;
  // Which of the instance's LINES the click landed on (0-based, in the pane's
  // line order), when the caller knows. Only "pick from chart" sets and reads it
  // — a rule references one line ("SLOPE.50"), where selection is per
  // instance. Absent for a legend-row click, which names no line.
  lineIndex?: number;
  // The legend FIGURE the click landed on (LegendFigure.key), when the row's
  // legend shows more than the plotted line — ATR's "atrPct" readout picks the
  // pane's .to% output. Only "pick from chart" sets and reads it.
  figureKey?: string;
}

/** The focused cell's proximity-heatmap control, as the toolbar needs it. */
export interface HeatmapBinding {
  on: boolean;
  view: HeatmapView;
  /** The chart's resolution sits below the locked base timeframe, so the heatmap
   *  paints nothing. The panel says so rather than looking broken. */
  belowBase: boolean;
  setOn: (on: boolean) => void;
  setView: (patch: Partial<HeatmapView>) => void;
}

/** The focused cell's replay entry point. `available` and `active` are separate
 *  because they read differently to a user: a cell that can never replay
 *  (sub-minute interval, read-only snapshot) is a different refusal from one
 *  already mid-session, and the toolbar says which. */
export interface ReplayEntry {
  available: boolean;
  active: boolean;
  enter: () => void;
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

  // True while THIS cell is inside a chart-replay session. The REACTIVE half of
  // the replay-gating idioms: `handle.replayRef.current?.isActive()` answers
  // inside ChartCore, `isChartReplaying(chart)` answers for module code holding a
  // chart, and `isCellReplaying(cellId)` answers for module code holding a cell
  // id — but all three are imperative reads, so app-level CHROME that has to
  // re-render when a session starts or ends (the order ticket it must stop
  // mounting, the backtest panel's Pick Range and Run buttons it must disable)
  // has nothing to subscribe to. Written by ChartCore's replay-mode effect, in
  // the same commit as setCellReplaying, so the two cannot disagree.
  readonly replaying = new Signal<boolean>(false);

  // The two chart STUDY MODES, published for the toolbar to host.
  //
  // Both used to be chart furniture pinned to the cell's top-right corner, where
  // they overlapped the price axis and duplicated themselves once per cell in a
  // split. They now live in the toolbar, which already acts on the FOCUSED cell —
  // so each cell publishes its own binding here and the toolbar renders whichever
  // one is in focus.
  //
  // State and callbacks travel together in one object rather than as four
  // signals: they are one thing (a toggle whose panel edits the view it
  // reflects), and splitting them invites a render where the panel is showing
  // last cell's view. Written by ChartCore in an EFFECT, never during render — a
  // Signal set mid-render notifies subscribers while React is still rendering.
  // Null until that effect lands, and while no chart is mounted.
  readonly heatmap = new Signal<HeatmapBinding | null>(null);
  readonly replayEntry = new Signal<ReplayEntry | null>(null);

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
  // True while the Zoom-to-range tool is armed (sidebar button toggled on). The
  // next press-drag on the candle pane marks a time range; on release the chart
  // drops one timeframe lower centered on the range midpoint and the band stays
  // visible until a click-away. One-shot: disarms after a pick. Esc also disarms.
  readonly zoomRangeArmed = new Signal<boolean>(false);
  // True while the "Find similar" tool is armed (sidebar button toggled on). The
  // next press-drag on the candle pane marks the candles to match; on release the
  // pattern search runs and the results panel opens. One-shot: disarms after a
  // pick, like zoomRangeArmed. Esc disarms.
  readonly patternRangeArmed = new Signal<boolean>(false);
  // Whether "Find similar" applies to this cell at all: false for synthetic epics,
  // sub-minute (liveOnly) resolutions and read-only snapshot views. Published by
  // ChartCore (which owns the epic/period/snapshot facts) so the draw sidebar can
  // disable the button without those being threaded through as props. Defaults
  // false so a gated cell can't flash an enabled button before ChartCore's effect
  // lands.
  readonly patternSearchAvailable = new Signal<boolean>(false);
  // What the armed range-drag DOES on release. "search" runs the pattern search
  // (the historical behaviour); "copy" puts the selected candles on the pattern
  // clipboard instead. One signal drives both because the gesture, the band and
  // every guard that yields to it are identical — only the finalize differs.
  // Reset to "search" after each pick, so an armed tool always means what the
  // button that armed it said.
  readonly patternRangeMode = new Signal<"search" | "copy">("search");
  // True while "Paste pattern" is armed: the next click on the candle pane drops
  // the clipboard's pattern there as a ghost overlay. One-shot; Esc disarms.
  readonly patternPasteArmed = new Signal<boolean>(false);
  // True while the Time Range highlight tool is armed (from the draw sidebar). The
  // next press-drag places a persistent full-height band marking a time interval; a
  // click with no drag marks the single clicked candle. One-shot: disarms on place.
  // Esc disarms. Uses its own press-drag (not klinecharts interactive draw) so it can
  // support the click=one-candle gesture, so it's armed via a signal like rangePick.
  readonly timeRangeArmed = new Signal<boolean>(false);
  // The most recent time range picked on the chart (ms), or null. The backtest
  // panel subscribes and drops it into the Custom from/to. One-shot: consumers may
  // reset it to null after reading.
  readonly rangePickResult = new Signal<{ fromMs: number; toMs: number } | null>(null);
  // True while an expression rule row is armed to "pick from chart": the next
  // click on an on-chart indicator (curve or legend row) publishes that instance
  // on indicatorPickResult instead of selecting it, and the row disarms. Armed
  // from OUTSIDE the chart (the backtest panel), mirroring rangePickArmed.
  readonly indicatorPickArmed = new Signal<boolean>(false);
  // The indicator instance most recently clicked while indicatorPickArmed. The
  // panel resolves it to an expression token and inserts it. One-shot: the
  // consumer resets it to null after reading.
  readonly indicatorPickResult = new Signal<SelectedIndicator | null>(null);
  // TradingView-style price-axis "auto" mode (auto-fit y-axis to visible bars).
  // Starts ON; the toolbar "A" button reflects it and re-asserts auto-fit; the
  // cell turns it OFF when the user manually scales the price axis.
  readonly autoScale = new Signal<boolean>(true);
  // TradingView-style "invert scale" (Alt/Option+I + toolbar "I" button): flips
  // the candle-pane price axis via yAxis.reverse. Session-only — never persisted.
  readonly invertScale = new Signal<boolean>(false);
  // Where the price-axis double-click cycle sits: the first double-click re-fits
  // to klinecharts' default margins ("refit"), the second trims the y-axis gap so
  // the visible candles fill most of the pane ("stretched"), and they alternate
  // from there. See chart/candleFit.ts. Persisted per cell (stretched or not),
  // hydrated in the constructor; write it through setPriceFit so the signal and
  // storage can never disagree. The toolbar stretch button reflects it.
  readonly priceFitMode = new Signal<PriceFitMode>("default");
  // Logarithmic price scale (toolbar "L" button). Session-only, per cell — lives
  // here (not toolbar-local state) so the button reflects THIS cell's axis after
  // focus switches and toolbar remounts (the Toolbar/SnapshotToolbar swap) instead
  // of a stale local bool that autoFit would then write back to the chart.
  readonly logScale = new Signal<boolean>(false);
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
  // hydrated in the constructor. Applied to the live chart via a supported v10
  // createRange override on the candle pane (see chart/priceOnlyRange.ts); v9's
  // patched YAxisImp.calcRange is retired. The right-click price-axis menu toggles it.
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

  // Run a view-moving call (chart.scrollByDistance / setOffsetRightDistance)
  // flagged as OURS, so the cell's scroll listener doesn't mistake it for a user
  // gesture (null until mount; assigned by ChartCore). Without it, chrome that
  // scrolls the chart from outside — the unpinned backtest panel compensating
  // for the width it covers — silently clears the quick-range pill and, under
  // syncTime, broadcasts the shift to every sibling cell.
  // `layout: true` marks a move that is pure chrome compensation rather than
  // navigation: it additionally suppresses the sibling broadcast (see the flags
  // in ChartCore). Callers must tolerate this being null (chart not mounted yet)
  // by making the call directly — the move still needs to happen.
  programmaticMove: (<T>(fn: () => T, opts?: { layout?: boolean }) => T) | null = null;

  // This cell's undo/redo stacks (Ctrl+Z / Ctrl+Shift+Z on the focused cell).
  // Assigned in the constructor — `scope` isn't available during field init.
  // Registered there too so captures reach it from the persistence choke points;
  // ChartCore unregisters it on unmount.
  readonly history: HistoryManager;

  constructor(cellId: string, scope: string) {
    this.cellId = cellId;
    this.scope = scope;
    this.overlays.setScope(scope);
    this.readOnly.set(loadSnapshotMeta(scope) != null);
    this.scalePriceOnly.set(loadScalePriceOnly(scope));
    // Only the stretched/not distinction survives a reload — see setPriceFit.
    this.priceFitMode.set(loadPriceStretched(scope) ? "stretched" : "default");
    this.history = new HistoryManager(scope);
    // Snapshot cells are frozen study copies: no mutations, no history.
    if (!this.readOnly.value) registerHistory(scope, this.history);
  }

  /**
   * Move the price-axis fit cycle and persist where it landed. The three writers
   * (the axis double-click, the toolbar stretch button, the toolbar "A") all go
   * through here so no path can update the signal without the store, or vice
   * versa. Storage keeps only stretched-or-not: "default" and "refit" render the
   * same and differ only in what the next double-click does, which is a
   * within-session distinction.
   */
  setPriceFit(mode: PriceFitMode): void {
    this.priceFitMode.set(mode);
    savePriceStretched(this.scope, mode === "stretched");
  }

  /**
   * Flip between the stretched and default fits and push it to the live chart.
   * Shared by the toolbar's stretch button and the price-axis context menu so the
   * two can't drift; the axis double-click runs the fuller cycle (it also has a
   * "re-fit" step) through nextFitMode. Off lands on "default" rather than
   * "refit", so the next double-click still re-fits before it stretches.
   */
  toggleStretchFit(): void {
    const next: PriceFitMode = this.priceFitMode.value === "stretched" ? "default" : "stretched";
    if (this.chart) applyCandleFit(this.chart, next);
    this.setPriceFit(next);
    // Writing the gap resets the axis auto-calc flag, so this re-fits too.
    this.autoScale.set(true);
  }
}

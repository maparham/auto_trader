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

  // --- per-cell UI signals (were module globals in signals.ts) ----------------
  // The AVWAP INSTANCE id the user is currently placing ("click a bar to anchor"),
  // or null when not in anchor mode. Carries the id (not just a bool) so multiple
  // AVWAPs each anchor independently.
  readonly avwapAnchorMode = new Signal<string | null>(null);
  // True while the TV-style Measure ruler is armed (ruler button toggled on). The
  // next mousedown on the chart starts a measurement drag, then disarms. Esc also
  // disarms. Shift+drag measures without arming, so this stays a simple bool.
  readonly measureArmed = new Signal<boolean>(false);
  // TradingView-style price-axis "auto" mode (auto-fit y-axis to visible bars).
  // Starts ON; the toolbar "A" button reflects it and re-asserts auto-fit; the
  // cell turns it OFF when the user manually scales the price axis.
  readonly autoScale = new Signal<boolean>(true);
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

  constructor(cellId: string, scope: string) {
    this.cellId = cellId;
    this.scope = scope;
    this.overlays.setScope(scope);
  }
}

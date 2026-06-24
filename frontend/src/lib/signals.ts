// Tiny observable for cross-component UI signals that don't belong in React
// state or props (matches the module-singleton idiom used elsewhere). Toolbar
// flips a signal; ChartCore reacts to it without prop-drilling through App.
//
// Signals defined HERE are genuinely GLOBAL (app-level modals / panels, one at a
// time, routed to the focused cell). Per-CHART state that used to live here
// (avwapAnchorMode, autoScale, selectedIndicator, legendHovered, legendHoverName,
// indicatorRemoved) moved onto ChartController so two cells don't cross-talk —
// the Signal class is exported for that.

type Listener<T> = (value: T) => void;

export class Signal<T> {
  private listeners = new Set<Listener<T>>();
  value: T;
  constructor(initial: T) {
    this.value = initial;
  }
  set(value: T): void {
    this.value = value;
    this.listeners.forEach((l) => l(value));
  }
  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// Request to open the "create alert" modal, prefilled with a price. Set by the
// toolbar bell button (last price) and the chart's "+" axis menu (cursor price);
// the modal (in App) is the single creation path. null = closed.
export const alertModalRequest = new Signal<{ price: number } | null>(null);

// Request to open the alert EDIT modal for an existing alert (by overlay id). Set
// by a double-click on the alert line (ChartCore), a sidebar row double-click, and
// the row's pencil icon. The modal (in App) prefills from overlays.getAlert(id)
// and writes back via overlays.updateAlert. null = closed.
export const alertEditRequest = new Signal<{ id: string } | null>(null);

// True while the alerts sidebar panel is open. Toggled by the toolbar bell's
// companion button; read by App to render the panel beside the chart.
export const alertsPanelOpen = new Signal<boolean>(false);

// Request to open the app Settings modal. Set by the toolbar gear button and the
// chart's right-click context menu; read by App, which owns the modal.
export const settingsRequest = new Signal<number>(0);
export function openSettings(): void {
  settingsRequest.set(settingsRequest.value + 1);
}

// Bumped (monotonic counter) whenever the alert set changes — a price alert is
// created, deleted, or dragged (live list), OR a new alert fires (history list).
// The alerts sidebar subscribes and re-reads overlays.getAlerts() / the persisted
// history. A counter rather than a payload: subscribers always re-pull the source
// of truth, so the only thing that matters is "something changed".
export const alertsChanged = new Signal<number>(0);
export function bumpAlerts(): void {
  alertsChanged.set(alertsChanged.value + 1);
}

// Request to open the symbol-search modal. The modal itself lives in Toolbar
// (local state); App sets this when opening a fresh tab (the new tab starts
// empty and immediately prompts for a symbol, TradingView-style). Bumped counter
// rather than a payload — the only thing that matters is "open it now".
export const symbolSearchRequest = new Signal<number>(0);
export function requestSymbolSearch(): void {
  symbolSearchRequest.set(symbolSearchRequest.value + 1);
}

// Request to open the per-indicator settings modal (TradingView-style gear). Set
// by the indicator legend's gear icon (ChartCore's OnTooltipIconClick handler);
// the modal (in App) reads/writes the live indicator via overrideIndicator.
export const indicatorSettingsRequest = new Signal<{
  paneId: string;
  name: string;
} | null>(null);

// Request to open the TradingView-style drawing settings modal for an overlay
// drawing (by id). Set by the drawing's right-click "Settings…" menu item and a
// double-click on the drawing. The modal (in App, routed to the focused cell's
// OverlayManager) reads/writes the live overlay. null = closed.
export const drawingSettingsRequest = new Signal<{ id: string } | null>(null);

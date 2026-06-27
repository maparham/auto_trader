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

// Request to open the alert EDIT modal for a stored alert that is NOT necessarily on
// the focused chart — used by the alerts panel's all-symbols rows, which key off the
// stable saved id (the alert may be off-screen entirely). Unlike alertEditRequest
// (overlay-id, routed to the focused cell's overlays), this modal reads/writes
// localStorage directly (loadStoredAlert / updateStoredAlert / deleteStoredAlert) and
// bumps alertsChanged, so every cell + the engine reconcile. `precision` quantizes the
// saved level the same way the overlay path does. null = closed.
export const alertGlobalEditRequest = new Signal<
  { epic: string; savedId: string; precision: number } | null
>(null);

// A confirmation dialog request. Any destructive action that wants a "are you sure?"
// gate sets this with a message + an onConfirm callback; App renders one ConfirmDialog
// for it. The callback runs on confirm, then the dialog closes. null = closed. Carrying
// a closure through a signal is fine here — it's an in-memory app-level bus, same as the
// other modal-request signals.
export interface ConfirmRequest {
  title?: string;
  message: string;
  confirmLabel?: string; // default "Delete"
  onConfirm: () => void;
}
export const confirmRequest = new Signal<ConfirmRequest | null>(null);
export function requestConfirm(req: ConfirmRequest): void {
  confirmRequest.set(req);
}

// True while the alerts sidebar panel is open. Toggled by the toolbar bell's
// companion button; read by App to render the panel beside the chart.
export const alertsPanelOpen = new Signal<boolean>(false);

// True while the trading panel (order ticket + positions) is open. Toggled by the
// toolbar's trade button; read by App to render the panel beside the chart.
export const tradePanelOpen = new Signal<boolean>(false);

// Open positions + resting orders (paper env) as a unified TradeView[], kept
// fresh by a single shared poller (see trading.ts subscribeTrades). The trading
// panel AND every chart cell subscribe to this one signal so there's exactly one
// poll, fanned out — a cell draws only the trades whose epic matches its symbol.
import type { TradeView } from "./trading";
export const tradesSignal = new Signal<TradeView[]>([]);

// Pending (un-applied) line drags, keyed by trade id (deal_id or order_id). A
// drag writes the new level here; the panel shows a combined Apply/Cancel; chart
// lines render the pending value merged over the server value so the 3s poll
// can't snap a dragged line back. Cleared on Apply/Cancel.
// A field may be set to `null` to MEAN "remove this level" (e.g. toggling a
// position's stop off while editing in the ticket); `undefined` means "no pending
// change, use the server value". Readers must merge by presence, not `??`.
export interface PendingEdit {
  price?: number | null;
  stop?: number | null;
  takeProfit?: number | null;
}
export const pendingEditsSignal = new Signal<Record<string, PendingEdit>>({});

// The trade (position or resting order) currently being edited in the order
// ticket. Set by clicking a row in PositionsPanel; the ticket replaces its
// new-order form with an edit form pre-filled from this trade (looked up across
// ALL epics, so it works even when the clicked row's instrument isn't the chart
// symbol). null = not editing.
export const editTradeSignal = new Signal<string | null>(null);

// Per-trade chart-line UI state, driven by the positions panel:
//   hidden  — trade ids whose lines the user toggled off (the row's eye icon).
//   hovered — the trade id whose row is currently hovered, if any.
// A hidden trade's lines are skipped on the chart UNLESS it's the hovered trade
// (hover temporarily reveals them); a hovered trade's lines render highlighted.
export interface TradeLineUi {
  hidden: string[];
  hovered: string | null;
}
export const tradeLineUiSignal = new Signal<TradeLineUi>({ hidden: [], hovered: null });

export function toggleTradeHidden(id: string): void {
  const cur = tradeLineUiSignal.value;
  const willHide = !cur.hidden.includes(id);
  const hidden = willHide
    ? [...cur.hidden, id]
    : cur.hidden.filter((x) => x !== id);
  // When hiding, also drop this trade from `hovered`: the eye click happens while
  // the cursor is over the row, and the hover-reveal rule would otherwise keep the
  // lines on screen (highlighted) — making the hide look like a no-op. Clearing
  // hovered hides them at once; re-hovering the row later still peeks them.
  const hovered = willHide && cur.hovered === id ? null : cur.hovered;
  tradeLineUiSignal.set({ ...cur, hidden, hovered });
}
export function setTradeHovered(id: string | null): void {
  if (tradeLineUiSignal.value.hovered === id) return;
  tradeLineUiSignal.set({ ...tradeLineUiSignal.value, hovered: id });
}

// A new order being STAGED on the chart before submit (limit orders always; a
// market order only when the user opts in). Its lines are draggable to set the
// levels; Submit commits, Cancel discards. App-level so the ticket (which submits)
// and the chart drawer (which draws + drags the draft lines) share one draft.
export interface DraftOrder {
  epic: string;
  side: "buy" | "sell";
  quantity: number;
  type: "market" | "limit";
  price: number | null; // entry/limit level (limit only; null for a market draft)
  stop: number | null;
  takeProfit: number | null;
}
export const draftOrderSignal = new Signal<DraftOrder | null>(null);

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

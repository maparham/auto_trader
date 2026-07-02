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
  // Optional key/value rows shown beneath the message (e.g. all the details of a
  // position about to be closed, with the realized P/L toned green/red).
  details?: Array<{ label: string; value: string; tone?: "pos" | "neg" }>;
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

// Mirrors settings.trading.confirmLineEdits so the chart — which doesn't receive the
// settings prop — can decide what a line drag does: in confirm mode a drag SELECTS
// its trade (so the on-chart pill + edit ticket appear with Apply/Discard); in
// no-confirm mode it leaves selection alone so the dock's auto-apply effect commits
// the drag at once (selecting would mark it editId and exclude it from that effect).
// Set by App from the live settings.
export const confirmLineEditsSignal = new Signal<boolean>(true);

// True while the user is actively dragging a trade line on the chart. In no-confirm
// mode the dock auto-applies staged drags; this pauses that until the drag ENDS, so
// a live drag doesn't fire one broker write per pixel. Set by ChartCore's manual
// line drag; read by PositionsPanel's auto-apply effect.
export const draggingLineSignal = new Signal<boolean>(false);

// Per-trade chart-line UI state, driven by BOTH the positions panel and the chart:
//   hidden   — trade ids whose lines the user toggled off (the row's eye icon).
//   hovered  — the trade id under the cursor (a panel row OR a chart line), if any.
//   selected — the trade id click-selected (sticky until cleared), if any.
// A hidden trade's lines are skipped on the chart UNLESS it's hovered OR selected
// (either temporarily reveals them). Hover renders the lines emphasised (dashed,
// thicker); selection renders them solid (a stronger, sticky emphasis). Hovering
// or selecting a chart line mirrors onto the dock row and vice-versa, so the two
// views stay in lockstep. There is at most one selected trade app-wide.
// Which of a selected trade's lines is the ACTIVE one — only that line's pill shows
// on the chart, and a drag makes the dragged line active so Apply/Discard land on it.
export type TradeLineField = "price" | "stop" | "tp";
export interface TradeLineUi {
  hidden: string[];
  hovered: string | null;
  selected: string | null;
  selectedField: TradeLineField | null;
}
export const tradeLineUiSignal = new Signal<TradeLineUi>({
  hidden: [],
  hovered: null,
  selected: null,
  selectedField: null,
});

export function toggleTradeHidden(id: string): void {
  const cur = tradeLineUiSignal.value;
  const willHide = !cur.hidden.includes(id);
  const hidden = willHide
    ? [...cur.hidden, id]
    : cur.hidden.filter((x) => x !== id);
  // When hiding, also drop this trade from `hovered`: the eye click happens while
  // the cursor is over the row, and the hover-reveal rule would otherwise keep the
  // lines on screen — making the hide look like a no-op.
  const hovered = willHide && cur.hovered === id ? null : cur.hovered;
  tradeLineUiSignal.set({ ...cur, hidden, hovered });
  // Hiding the selected trade also deselects it — routed through setTradeSelected so
  // edit mode clears in lockstep (selection is the single writer of editTradeSignal).
  if (willHide && cur.selected === id) setTradeSelected(null);
}
// Drop a single staged field (e.g. the dragged line's Discard) — clearing the whole
// trade's pending only if that was the last staged field.
export function discardPendingField(id: string, key: "price" | "stop" | "takeProfit"): void {
  const cur = pendingEditsSignal.value;
  const entry = cur[id];
  if (!entry || !(key in entry)) return;
  const next = { ...entry };
  delete next[key];
  const all = { ...cur };
  if (Object.keys(next).length === 0) delete all[id];
  else all[id] = next;
  pendingEditsSignal.set(all);
}
export function setTradeHovered(id: string | null): void {
  if (tradeLineUiSignal.value.hovered === id) return;
  tradeLineUiSignal.set({ ...tradeLineUiSignal.value, hovered: id });
}
// Drop a trade's staged (un-applied) drag edits. Exported so the chart pill's
// Discard and the Esc handler can clear them too.
export function discardPendingEdit(id: string): void {
  const cur = pendingEditsSignal.value;
  if (!(id in cur)) return;
  const next = { ...cur };
  delete next[id];
  pendingEditsSignal.set(next);
}
// Selecting a trade is the SINGLE source of truth for "which trade is active": it
// also loads that trade into the order ticket's edit mode (editTradeSignal) and
// reveals the trading panel, so the chart pill, the dock row, and the ticket all
// track one selection. THIS is the only function that writes editTradeSignal — every
// other edit-mode entry/exit routes through here so the two never desync. Switching
// away from a trade with un-applied DRAG edits discards them (never confirmed) — the
// per-switch discard the old dock "Pending changes" bar used to do. Selecting opens
// the trading panel (edit mode); DEselecting closes it (since with single-select a
// deselect means no trade is active — the panel has nothing to edit).
// openPanel = false: visual-only select (highlight + pill) without opening the edit
// ticket. Used by chart-line single-click so the panel is only opened on double-click.
// Deselect (id == null) always closes the panel regardless of this flag.
export function setTradeSelected(id: string | null, field: TradeLineField = "price", openPanel = true): void {
  const cur = tradeLineUiSignal.value;
  const nextField = id ? field : null;
  if (cur.selected === id && cur.selectedField === nextField) return;
  const idChanged = cur.selected !== id;
  if (cur.selected && idChanged) discardPendingEdit(cur.selected);
  tradeLineUiSignal.set({ ...cur, selected: id, selectedField: nextField });
  // Edit-mode + panel only follow the TRADE, not the per-line focus. Selecting opens
  // the panel (unless openPanel=false); deselecting always closes it.
  if (idChanged) {
    editTradeSignal.set(id);
    if (id == null) tradePanelOpen.set(false);
    else if (openPanel) tradePanelOpen.set(true);
  }
}
// Dock-row click — selects/deselects the whole trade (its entry line's pill shows).
export function toggleTradeSelected(id: string): void {
  const cur = tradeLineUiSignal.value;
  if (cur.selected === id) setTradeSelected(null);
  else setTradeSelected(id, "price");
}
// Chart line click — focuses THAT line (its pill shows); clicking the already-active
// line clears the whole selection. Pass openPanel=false for single-click (highlight
// only); double-click uses the default (true) to open the edit ticket.
export function selectTradeLine(id: string, field: TradeLineField, openPanel = true): void {
  const cur = tradeLineUiSignal.value;
  if (cur.selected === id && cur.selectedField === field) setTradeSelected(null);
  else setTradeSelected(id, field, openPanel);
}
// Double-click-to-edit: force the panel open regardless of current selection state.
// A dblclick is preceded by two clicks (which may have toggled selection back and
// forth), so we can't rely on the current state — unconditionally set selected + open.
export function openTradeEditor(id: string, field: TradeLineField): void {
  setTradeSelected(id, field, true);
  // Force open even if setTradeSelected's early-return or openPanel=false left it closed.
  editTradeSignal.set(id);
  tradePanelOpen.set(true);
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

// Request to open the Backtest settings modal. Set by the ⚙ gear next to the
// Backtest button; read by App, which owns the modal.
export const backtestSettingsRequest = new Signal<number>(0);
export function openBacktestSettings(): void {
  backtestSettingsRequest.set(backtestSettingsRequest.value + 1);
}

// Bumped when the settings modal's "Run backtest" is clicked (after saving the
// config as last-used) — BacktestButton owns the actual fetch/run logic and its
// own running/summary/error state, so this just re-triggers the same ▶ Backtest
// action rather than duplicating it here.
export const backtestRunRequest = new Signal<number>(0);
export function requestBacktestRun(): void {
  backtestRunRequest.set(backtestRunRequest.value + 1);
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

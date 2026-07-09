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

// Request to open the "Save as default template" picker. Toolbar sets it with the
// current chart's symbol-agnostic indicators as candidates; App renders one modal.
// onConfirm gets the checked instance ids. null = closed.
export interface SaveDefaultTemplateRequest {
  candidates: Array<{ id: string; label: string; params: string }>;
  onConfirm: (selectedIds: string[]) => void;
}
export const saveDefaultTemplateRequest =
  new Signal<SaveDefaultTemplateRequest | null>(null);

// True while the alerts sidebar panel is open. Toggled by the toolbar bell's
// companion button; read by App to render the panel beside the chart.
export const alertsPanelOpen = new Signal<boolean>(false);

// True while the trading panel (order ticket + positions) is open. Toggled by the
// toolbar's trade button; read by App to render the panel beside the chart.
export const tradePanelOpen = new Signal<boolean>(false);

/** Snapshots gallery modal (global, rendered by App). */
export const snapshotsGalleryOpen = new Signal<boolean>(false);

/** A scope's read-only snapshot view just changed (Unlock deleted its
 *  snapshotMeta). App/Toolbar subscribe to re-render their gating. */
export const snapshotViewChanged = new Signal<string>("");

// Open positions + resting orders (paper env) as a unified TradeView[], kept
// fresh by a single shared poller (see trading.ts subscribeTrades). The trading
// panel AND every chart cell subscribe to this one signal so there's exactly one
// poll, fanned out — a cell draws only the trades whose epic matches its symbol.
import type { TradeView } from "./trading";
import type { StoredBacktestResult } from "./persist";
import type { SignalGlyph } from "./signalGlyphs";
import type { JournalTrade } from "./liveJournal";
export const tradesSignal = new Signal<TradeView[]>([]);

// Backtest run result published after a successful run OR restored on rehydrate
// (timeframe switch / reload). Set by BacktestButton (fresh run) and by
// rehydrateBacktest (restore); cleared when the run is dismissed. Carries the
// stored shape (no candles) — every consumer reads markers/trades/equity/summary,
// never candles, so a full or candle-stripped result works identically.
// Consumers (e.g., trades panel) subscribe to render backtest-specific UI.
export const backtestResultSignal = new Signal<StoredBacktestResult | null>(null);

// Whether the on-chart backtest trading-period shading is shown (global display
// preference, seeded from device-local storage at startup). backtest.ts reads
// this to gate drawing and subscribes to redraw each chart's bands on change.
export const backtestPeriodsShownSignal = new Signal<boolean>(true);

// The backtest trade index (row.i) currently highlighted, or null. Set by the
// trades panel row hover/click AND (Phase C Task 2) the chart's trade markers —
// whichever side the cursor is on drives the other side's highlight.
export const highlightTradeSignal = new Signal<number | null>(null);

// The backtest trade index (row.i) STICKILY selected by clicking a trades-panel
// row, or null. Distinct from the hover-driven highlightTradeSignal above: this
// persists across mouse movement and drives the (Phase 2 Task 2) windowed
// risk/reward zone overlay on the chart. Reset to null on a new run / clearBacktest.
export const selectedTradeSignal = new Signal<number | null>(null);

// The aggregate-marker popover on a higher timeframe: the trades bucketed into
// one bar (a pill the cursor is over) plus the cursor's page position. Set by an
// aggregate pill's onMouseEnter (backtest.ts), cleared on leave / teardown; App
// renders one popover for it. Global + one-at-a-time (only one pill is hovered
// app-wide at a time), matching the modal-request idiom above — no per-cell
// gating needed. Carries the stored trade shape (plain data, no candles).
export const backtestClusterHoverSignal = new Signal<
  { trades: StoredBacktestResult["trades"]; x: number; y: number } | null
>(null);

// The LIVE exit-cluster popover: journaled closes bucketed into one bar (a coarse-
// timeframe live pill the cursor is over) plus the cursor's page position. The live
// analog of backtestClusterHoverSignal — set by a live exit pill's onMouseEnter
// (TradeExitAggMarkers), cleared on leave / teardown; App renders one popover for
// it. Same global one-at-a-time idiom. Carries journal exits (no drill-in target).
export const liveExitClusterHoverSignal = new Signal<
  { exits: JournalTrade[]; x: number; y: number } | null
>(null);

// The signal-candle popover: the glyph the cursor is over (its passing-rule terms
// + header data) plus the cursor's page position. Set by a signal glyph's
// onMouseEnter (backtest.ts), cleared on leave / teardown; App renders one popover
// for it. Same global one-at-a-time idiom as the cluster popover above.
export const backtestSignalHoverSignal = new Signal<
  { glyph: SignalGlyph; x: number; y: number } | null
>(null);

// The LIVE trade-marker label popover: an on-chart entry/exit marker is now a
// compact arrow glyph (tradeMarkers.ts, MARKER_OVERLAY style "live"); its full
// label ("Long 100 @ 72.28" / exit P&L) is a DOM pill shown only while the glyph
// is hovered, so the always-on furniture never covers candles. Set by the glyph's
// onMouseEnter with the cursor's page position + win (for entry-blue/win-green/
// loss-red colouring), cleared on leave / teardown; App renders one pill for it.
// Same global one-at-a-time idiom as the popovers above.
// `tradeId` is set while hovering an ENTRY marker (open position) — ChartCore's
// click handlers read it to select the trade / open its editor and to treat the
// click as on-a-marker rather than empty space; exit markers leave it unset.
export const tradeMarkerHoverSignal = new Signal<
  { label: string; win: boolean | null; x: number; y: number; tradeId?: string } | null
>(null);

// A one-shot "scroll the chart to this trade" request (row.i, or null = no-op),
// set by the trades panel row's onClick. The chart (backtest.ts runAndRender)
// subscribes and pans/zooms to the trade's entry↔exit span — a second signal
// rather than threading a chart handle into the panel, since the panel has no
// direct reference to the per-cell chart instance.
export const focusTradeSignal = new Signal<number | null>(null);

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

// Stage a new LIMIT order from the chart (the price-axis "+" menu's Buy/Sell limit
// items) and open the ticket at the clicked level. Clears any in-progress edit
// first — otherwise the ticket, sitting in edit mode, ignores the injected draft
// (its maintenance effect bails on editId) and the action silently does nothing.
// The draft is set BEFORE opening so a fresh ticket mount reads a populated value.
export function stageChartOrder(o: { epic: string; side: "buy" | "sell"; price: number }): void {
  setTradeSelected(null);
  draftOrderSignal.set({
    epic: o.epic,
    side: o.side,
    quantity: 1,
    type: "limit",
    price: o.price,
    stop: null,
    takeProfit: null,
  });
  tradePanelOpen.set(true);
}

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

// True while a backtest run is in flight (BacktestButton.run owns the state and
// publishes it here). The settings modal disables its "Run backtest" button off
// this — the run guard already dropped mid-run clicks silently; this makes the
// button LOOK unavailable too.
export const backtestRunningSignal = new Signal<boolean>(false);

// Bumped when the results pane's clear (✕) is clicked. Like the run request,
// BacktestButton owns the chart-side teardown (it has the chart/controller/epic),
// so the results pane just asks for a clear rather than duplicating that logic.
export const backtestClearRequest = new Signal<number>(0);
export function requestBacktestClear(): void {
  backtestClearRequest.set(backtestClearRequest.value + 1);
}

// Transient run messages (fetch error / short warm-up warning) published by
// BacktestButton so the results pane can show them alongside the summary — they
// used to render next to the toolbar button. Reset on symbol/timeframe change.
export const backtestMessagesSignal = new Signal<{ error: string | null; warning: string | null }>({
  error: null,
  warning: null,
});

// Parameter-sweep wiring (Task 10). The modal owns the axes (session-only —
// never persisted) and writes them here before bumping backtestRunRequest;
// BacktestButton.run() reads them to decide whether to branch into runSweep
// instead of a normal single run. Kept as a plain module import (not React
// state) for the same reason the other backtest signals are: the modal and
// the button are siblings under App, not parent/child.
import type { SweepAxis } from "./sweep";
export const sweepAxesSignal = new Signal<SweepAxis[]>([]);

// Live sweep progress + landed rows, published by BacktestButton as chunks
// come back; the modal renders <SweepResults> off this. Null = no sweep run
// in flight / completed this session.
export interface SweepRunState {
  rows: import("../api").SweepRow[];
  done: number;
  total: number;
  running: boolean;
  error?: string;
  // Set when the user hit Cancel (as opposed to a real chunk failure) — the
  // modal shows a neutral note instead of the red error box.
  cancelled?: boolean;
}
export const sweepStateSignal = new Signal<SweepRunState | null>(null);

// Bumped by the modal's Cancel button; BacktestButton holds the AbortController
// for the in-flight sweep and aborts it on the next tick after this changes.
export const sweepCancelRequest = new Signal<number>(0);
export function requestSweepCancel(): void {
  sweepCancelRequest.set(sweepCancelRequest.value + 1);
}

// Transient notice shown when selecting a trade row can't navigate the chart to
// it — the trade predates the history reachable at the current timeframe (a fine
// timeframe whose loaded/pageable window doesn't reach that far back). Set by the
// selection subscription in backtest.ts after an on-demand page-back fails to
// cover the trade; cleared on the next selection. Null = no notice.
export const backtestSelectNoticeSignal = new Signal<string | null>(null);

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

// True while the Live trading panel is open. Toggled by the toolbar's live
// button; read by App to render the panel beside the chart. Distinct surface
// from the backtest so "testing" is never confused with "trading real money".
export const livePanelOpen = new Signal<boolean>(false);
export function openLivePanel(): void {
  livePanelOpen.set(true);
}

// "Go live →" from the backtest modal: carries a COPY of the current backtest
// config to seed the Live panel's draft (spec: arm snapshots a copy — editing
// the backtest later never touches a running strategy). null = no pending seed.
import type { BacktestConfig } from "./backtestConfig";
export const goLiveRequest = new Signal<BacktestConfig | null>(null);
export function requestGoLive(cfg: BacktestConfig): void {
  goLiveRequest.set(structuredClone(cfg));
  openLivePanel();
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

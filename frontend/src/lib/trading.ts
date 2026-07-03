// Order-execution API layer (paper now; demo/live in later phases). Mirrors the
// backend ExecutionBroker seam: place orders (market or limit), list and edit
// open positions and resting orders.
//
// Positions and working orders are normalized into one `TradeView` shape and
// published on a single `tradesSignal` poll, so the panel and every chart cell
// render lines/rows for both from one source (one poll, fanned out). Anything
// keyed on a trade (lines, pending edits) uses the unified `id` (deal_id for a
// position, order_id for a resting order).

import { isCapitalBroker, onTradesDirty } from "./persist";
import { tradesSignal } from "./signals";
import { API_BASE as BASE, errorDetail } from "./http";

// A registry account key "{broker}:{env}", e.g. "capital:paper". Opaque to the
// frontend — it comes from GET /api/brokers and routes orders/positions.
export type TradeAccount = string;
export const DEFAULT_ACCOUNT: TradeAccount = "capital:paper";

// The broker id half of a "{broker}:{env}" account key. The single place that knows
// the key shape — callers holding a BrokerAccount object should read its `.broker`
// field instead; this is for the raw-string account (the active-account string).
export function brokerOf(account: TradeAccount): string {
  return account.split(":")[0];
}

// A real-money (live) account moves real funds. The backend enforces the guards
// (confirm=true, no strategy orders), but the frontend also needs this to know an
// account has no server-side push — so its dock must POLL (see the trades feed) —
// and to fetch the account's real balance/currency (see fetchAccountSummary).
export function isRealMoneyAccount(account: TradeAccount): boolean {
  return account.endsWith(":live");
}

// Last-used account per broker (device-local). The tab-bar broker selector picks the
// broker; this map lets it land back on the env you last used for that broker (paper
// / demo / live) instead of always resetting to paper. Keyed by broker id.
const LAST_ACCOUNT_BY_BROKER_KEY = "lastAccountByBroker";
export function loadLastAccountByBroker(): Record<string, TradeAccount> {
  try {
    const raw = localStorage.getItem(LAST_ACCOUNT_BY_BROKER_KEY);
    return raw ? (JSON.parse(raw) as Record<string, TradeAccount>) : {};
  } catch {
    return {};
  }
}
export function saveLastAccountByBroker(map: Record<string, TradeAccount>): void {
  try {
    localStorage.setItem(LAST_ACCOUNT_BY_BROKER_KEY, JSON.stringify(map));
  } catch {
    /* storage full / unavailable — best-effort */
  }
}

const CAPITAL_LIVE_MIGRATION_KEY = "migratedCapitalLiveKeys";

// One-time rename of the real-money Capital account from "capital:live" to
// "capital-live:live" when the live host became its own data feed. Idempotent and
// sentinel-gated. Must run BEFORE App reads activeAccount (else the unknown-account
// fallback bounces the user to paper and swaps their whole workspace).
export function migrateCapitalLiveAccountKeys(): void {
  try {
    if (localStorage.getItem(CAPITAL_LIVE_MIGRATION_KEY)) return;
    if (localStorage.getItem("activeAccount") === "capital:live") {
      localStorage.setItem("activeAccount", "capital-live:live");
    }
    const raw = localStorage.getItem(LAST_ACCOUNT_BY_BROKER_KEY);
    if (raw) {
      const map = JSON.parse(raw) as Record<string, TradeAccount>;
      // ONLY migrate the live entry for a user who actually used the real-money
      // account (their "capital" last-used was "capital:live"). Seeding
      // "capital-live" unconditionally would make a demo-only user land on the
      // real-money account the first time they open the live feed — never default
      // someone into real money they didn't choose.
      if (map["capital"] === "capital:live") {
        delete map["capital"];
        map["capital-live"] = "capital-live:live";
        localStorage.setItem(LAST_ACCOUNT_BY_BROKER_KEY, JSON.stringify(map));
      }
    }
    localStorage.setItem(CAPITAL_LIVE_MIGRATION_KEY, "1");
  } catch {
    /* storage unavailable — best effort, retry next load */
  }
}

// Display name for a broker id (the id is a lowercase opaque key; this is UI only).
// Unknown ids fall back to a capitalized id so a new broker still reads sensibly.
const BROKER_LABELS: Record<string, string> = {
  // Two Capital feeds: demo (default data host) and live (live host). Distinct
  // labels because they're separate data brokers; the env suffix (Paper/Demo/Live)
  // is a different axis shown on the dock account tabs.
  capital: "Capital.com (demo)",
  "capital-live": "Capital.com (live)",
  "ig-demo": "IG (demo)",
  "ig-live": "IG (live)",
};
export function brokerLabel(brokerId: string): string {
  return BROKER_LABELS[brokerId] ?? brokerId.charAt(0).toUpperCase() + brokerId.slice(1);
}

// True for any Capital.com feed (demo or live). Capital's reported account balance
// ALREADY includes unrealized P&L, unlike cash-balance brokers — code that decides
// whether to add `pnl` must treat both Capital feeds the same (see PositionsPanel).
export function isCapital(brokerId: string): boolean {
  return isCapitalBroker(brokerId);
}
export type OrderSide = "buy" | "sell";
type OrderKind = "market" | "limit";

export interface OrderRequest {
  epic: string;
  side: OrderSide;
  quantity: number;
  account?: TradeAccount;
  source?: "manual" | "strategy";
  type?: OrderKind;
  limit_level?: number | null;
  stop_level?: number | null;
  take_profit_level?: number | null;
  confirm?: boolean; // required for real-money (live) orders
}

// Selector payload from GET /api/brokers: registered data brokers + accounts.
export interface BrokerAccount {
  key: TradeAccount; // "capital:paper"
  broker: string; // "capital"
  env: string; // "paper" | "demo" | "live"
  isRealMoney: boolean;
}
export interface BrokerInfo {
  data: string[];
  exec: BrokerAccount[];
}

// The account list is purely descriptive (no broker network call), so it should
// never be the thing that's unavailable. But it shares the browser's per-host
// connection budget with the chart/poll requests, so when a broker is down those
// hanging requests can make this one-shot fetch time out. We therefore (a) bound
// it with an abort timeout and (b) cache the last-good list so a transient failure
// still renders the selector instead of showing "no accounts".
const BROKERS_CACHE_KEY = "brokersCache";
const BROKERS_TIMEOUT_MS = 6_000;

/** Last-good broker list from a previous successful fetch, or null. Lets the
 * selector populate instantly on load and survive a transient backend hiccup. */
export function cachedBrokers(): BrokerInfo | null {
  try {
    const raw = localStorage.getItem(BROKERS_CACHE_KEY);
    return raw ? (JSON.parse(raw) as BrokerInfo) : null;
  } catch {
    return null;
  }
}

/** The selector list: which brokers/accounts the backend has registered. Bounded
 * by a timeout and cached on success (see cachedBrokers). */
export async function fetchBrokers(): Promise<BrokerInfo> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BROKERS_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/brokers`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`brokers failed (${res.status})`);
    const info = (await res.json()) as BrokerInfo;
    try {
      localStorage.setItem(BROKERS_CACHE_KEY, JSON.stringify(info));
    } catch {
      /* storage full / unavailable — caching is best-effort */
    }
    return info;
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`brokers timed out`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface OrderResult {
  client_order_id: string;
  status: "pending" | "filled" | "partially_filled" | "rejected" | "unknown";
  deal_reference: string | null;
  deal_id: string | null;
  filled_quantity: number;
  fill_price: number | null;
  reason: string;
}

interface Position {
  epic: string;
  side: OrderSide;
  quantity: number;
  open_level: number;
  deal_id: string;
  stop_level: number | null;
  take_profit_level: number | null;
  upnl: number | null;
  created_at: string | null;
  leverage: number | null; // broker's real per-position leverage (null for paper)
  margin: number | null; // broker deposit requirement, account currency (null for paper)
}

interface WorkingOrder {
  epic: string;
  side: OrderSide;
  quantity: number;
  limit_level: number;
  order_id: string;
  stop_level: number | null;
  take_profit_level: number | null;
  created_at: string | null;
}

// Normalized view of a position OR a resting order — the one shape the panel and
// chart lines consume.
export interface TradeView {
  kind: "position" | "order";
  id: string; // deal_id (position) | order_id (order)
  epic: string;
  side: OrderSide;
  quantity: number;
  priceLevel: number; // open_level (position) | limit_level (order)
  stop: number | null;
  takeProfit: number | null;
  upnl: number | null; // positions only
  openedAt: number | null; // created_at as epoch ms (position open / order placed)
  leverage: number | null; // broker per-position leverage (null → fall back to configured)
  margin: number | null; // broker deposit requirement, account currency (null → estimate)
}

export interface Quote {
  bid: number | null;
  ask: number | null;
  mid: number | null;
}

// Real per-account figures from the broker (live dealing accounts). null fields when
// the broker omits them; the whole call returns null for accounts with no real
// summary (paper sim), so the dock keeps its configured paper balance.
export interface AccountSummary {
  balance: number | null;
  available: number | null;
  deposit: number | null;
  profitLoss: number | null;
  currency: string | null;
}

/** The account's real balance/available/currency (live dealing accounts). Returns
 *  null for a paper account (no real summary → 404), so the dock falls back to its
 *  configured paper figures. */
export async function fetchAccountSummary(
  account: TradeAccount,
): Promise<AccountSummary | null> {
  const res = await fetch(`${BASE}/api/account?account=${encodeURIComponent(account)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`account summary failed (${res.status})`);
  return res.json();
}

/** The human label for a position or resting order — used identically by the
 *  chart line, the panel row, and the edit-ticket header (one source so they
 *  can't drift). NB: a new-order DRAFT uses a different verb ("Buy"/"Sell"). */
export function tradeLabel(kind: TradeView["kind"], side: OrderSide): string {
  if (kind === "order") return side === "buy" ? "Limit buy" : "Limit sell";
  return side === "buy" ? "Long" : "Short";
}

// A fresh idempotency key per submit so a retried request can't double-fill.
function newClientOrderId(): string {
  return crypto.randomUUID();
}

export async function fetchQuote(
  epic: string,
  account: TradeAccount = DEFAULT_ACCOUNT,
): Promise<Quote> {
  const url = `${BASE}/api/quote/${encodeURIComponent(epic)}?account=${encodeURIComponent(account)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`quote failed (${res.status})`);
  return res.json();
}

export async function placeOrder(req: OrderRequest): Promise<OrderResult> {
  const res = await fetch(`${BASE}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account: DEFAULT_ACCOUNT,
      source: "manual",
      type: "market",
      client_order_id: newClientOrderId(),
      ...req,
    }),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `order failed (${res.status})`));
  return res.json();
}

async function fetchPositions(account: TradeAccount): Promise<Position[]> {
  const res = await fetch(`${BASE}/api/positions?account=${encodeURIComponent(account)}`);
  if (!res.ok) throw new Error(`positions failed (${res.status})`);
  return res.json();
}

async function fetchWorkingOrders(account: TradeAccount): Promise<WorkingOrder[]> {
  const url = `${BASE}/api/orders/working?account=${encodeURIComponent(account)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`working orders failed (${res.status})`);
  return res.json();
}

function toTrades(positions: Position[], orders: WorkingOrder[]): TradeView[] {
  return [
    ...positions.map(
      (p): TradeView => ({
        kind: "position",
        id: p.deal_id,
        epic: p.epic,
        side: p.side,
        quantity: p.quantity,
        priceLevel: p.open_level,
        stop: p.stop_level,
        takeProfit: p.take_profit_level,
        upnl: p.upnl,
        openedAt: p.created_at ? Date.parse(p.created_at) : null,
        leverage: p.leverage,
        margin: p.margin,
      }),
    ),
    ...orders.map(
      (o): TradeView => ({
        kind: "order",
        id: o.order_id,
        epic: o.epic,
        side: o.side,
        quantity: o.quantity,
        priceLevel: o.limit_level,
        stop: o.stop_level,
        takeProfit: o.take_profit_level,
        upnl: null,
        openedAt: o.created_at ? Date.parse(o.created_at) : null,
        leverage: null,
        margin: null,
      }),
    ),
  ];
}

// --- shared trades feed (event-driven, no polling) --------------------------
//
// Positions + working orders are fetched ONCE per change, never on a timer:
//   - on first subscribe and on account switch,
//   - after a user action (place/close/modify → refreshTrades),
//   - when the backend pushes a "trades changed" event (a paper trigger filled or
//     closed) over /ws/state (see onTradesDirty).
// Live P&L doesn't need a fetch: the dock marks positions to market client-side
// from `livePrices`, fed by the chart's price stream (setLivePrice). Together this
// removes the periodic positions/orders poll entirely.

let _refs = 0;
let _unsubDirty: (() => void) | null = null;

// The account the feed fetches. Set by the App when the active broker/account
// changes, so positions/orders follow the selection.
let _account: TradeAccount = DEFAULT_ACCOUNT;

// Real-money accounts get NO server-side push (the onTradesDirty event only fires
// for paper triggers), so a fill / SL-TP hit / close-on-another-device would leave
// the dock stale. For those accounts only, fall back to a light poll (paused when
// the tab is hidden). Paper stays fully event-driven.
const LIVE_POLL_MS = 6_000;
let _pollTimer: ReturnType<typeof setInterval> | null = null;

function _stopPoll(): void {
  if (_pollTimer !== null) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

function _syncPoll(): void {
  _stopPoll();
  if (_refs <= 0 || !isRealMoneyAccount(_account)) return;
  _pollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return; // pause when hidden
    void _refresh();
  }, LIVE_POLL_MS);
}

/** The account the trades feed currently targets. For actions taken from the chart
 *  (the trade pill's Apply / Close / Cancel) that don't receive `account` as a prop —
 *  the selected trade was fetched for this account, so it's the one to act against. */
export function getTradesAccount(): TradeAccount {
  return _account;
}

/** Point the trades feed at a different account and refresh immediately. */
export function setTradesAccount(account: TradeAccount): void {
  if (account === _account) return;
  _account = account;
  // Clear stale trades from the previous account so lines/rows don't linger.
  tradesSignal.set([]);
  void _refresh();
  _syncPoll(); // start/stop the live poll for the new account
}

async function _refresh(): Promise<void> {
  const account = _account;
  try {
    const [positions, orders] = await Promise.all([
      fetchPositions(account),
      fetchWorkingOrders(account),
    ]);
    // A switch mid-flight would publish the wrong account's trades; drop a
    // response whose account is no longer active.
    if (account === _account) tradesSignal.set(toTrades(positions, orders));
  } catch {
    // Transient: keep the last known trades rather than clearing the chart.
  }
}

/** Force an immediate refresh (after a fill / close / edit). */
export function refreshTrades(): void {
  void _refresh();
}

/** Subscribe to the shared trades feed. Fetches once on the first subscriber and
 *  then only on events; the returned unsubscribe detaches the backend push when
 *  the last consumer leaves. */
export function subscribeTrades(fn: (t: TradeView[]) => void): () => void {
  fn(tradesSignal.value); // deliver the current value immediately
  const unsub = tradesSignal.subscribe(fn);
  _refs += 1;
  if (_refs === 1) {
    void _refresh(); // initial load
    // Refetch when the backend reports a server-side change (paper trigger fill)
    // for the active account — event-driven, no polling.
    _unsubDirty = onTradesDirty((account) => {
      if (account === _account) void _refresh();
    });
    _syncPoll(); // plus a light poll while a real-money account is active
  }
  return () => {
    unsub();
    _refs -= 1;
    if (_refs <= 0) {
      _refs = 0;
      _unsubDirty?.();
      _unsubDirty = null;
      _stopPoll();
    }
  };
}

// --- live prices (client-side mark-to-market) -------------------------------
//
// The chart's live feed publishes the latest mid price per epic here; the
// positions dock reads it to update P&L without re-fetching from the server.

const _livePrices = new Map<string, number>();
const _priceListeners = new Set<() => void>();

/** Publish the latest streamed price for an epic (called by the chart feed). */
export function setLivePrice(epic: string, price: number): void {
  _livePrices.set(epic, price);
  for (const fn of _priceListeners) fn();
}

/** Latest streamed price for an epic, or undefined if none is flowing. */
export function getLivePrice(epic: string): number | undefined {
  return _livePrices.get(epic);
}

/** Notify on any live-price change (the dock re-marks P&L). Returns unsubscribe. */
export function subscribeLivePrices(fn: () => void): () => void {
  _priceListeners.add(fn);
  return () => _priceListeners.delete(fn);
}

export async function closePosition(
  dealId: string,
  account: TradeAccount = DEFAULT_ACCOUNT,
  quantity?: number,
): Promise<OrderResult> {
  const qs = new URLSearchParams({ account });
  if (quantity != null) qs.set("quantity", String(quantity));
  const res = await fetch(
    `${BASE}/api/positions/${encodeURIComponent(dealId)}?${qs}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(await errorDetail(res, `close failed (${res.status})`));
  return res.json();
}

export interface LevelEdit {
  limit_level?: number | null;
  stop_level?: number | null;
  take_profit_level?: number | null;
  // Explicitly REMOVE a level (None alone means "leave unchanged", so the edit
  // form's toggle-off sends these to clear an SL/TP).
  clear_stop?: boolean;
  clear_take_profit?: boolean;
}

/** Apply edited levels to a position (SL/TP) or a resting order (price + SL/TP),
 *  picked by trade kind. Used by the combined Apply after dragging lines. */
export async function applyLevels(
  trade: { kind: "position" | "order"; id: string },
  edit: LevelEdit,
  account: TradeAccount = DEFAULT_ACCOUNT,
): Promise<OrderResult> {
  const path =
    trade.kind === "position"
      ? `/api/positions/${encodeURIComponent(trade.id)}`
      : `/api/orders/working/${encodeURIComponent(trade.id)}`;
  const res = await fetch(`${BASE}${path}?account=${encodeURIComponent(account)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edit),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `update failed (${res.status})`));
  return res.json();
}

/** Keep an SL/TP on the valid side of a REFERENCE price: a long's stop must sit BELOW
 *  the reference and its take-profit ABOVE it; a short's are reversed. Clamps `level`
 *  to one `tick` past the reference so a dragged line can't cross (the broker rejects
 *  it anyway). Returns `level` unchanged when it's already on the right side.
 *
 *  The reference is the current market price for an OPEN POSITION (a TP below the
 *  market would already be a loss), but the order's own LIMIT price for a WORKING
 *  ORDER — the order isn't filled yet, so its SL/TP are measured from where it WILL
 *  fill, not from where the market happens to be now. Callers pass the right one. */
export function clampLevelToPrice(
  field: "stop" | "tp",
  side: OrderSide,
  reference: number,
  level: number,
  tick: number,
): number {
  const long = side === "buy";
  const below = field === "stop" ? long : !long; // must this line stay below the reference?
  return below ? Math.min(level, reference - tick) : Math.max(level, reference + tick);
}

/** Merge a trade's pending (un-applied) edits over its server levels, BY PRESENCE
 *  (a field set to `null` means "removed", `undefined` means "unchanged"). Returns
 *  the resolved entry/stop/tp the user currently sees on the chart lines. Shared by
 *  the order ticket's edit form and the chart pill so both read one source of truth. */
export function mergeTradeLevels(
  trade: { priceLevel: number; stop: number | null; takeProfit: number | null },
  pending: { price?: number | null; stop?: number | null; takeProfit?: number | null },
): { price: number | null; stop: number | null; takeProfit: number | null } {
  const has = (k: "price" | "stop" | "takeProfit") => pending[k] !== undefined;
  return {
    price: (has("price") ? pending.price : trade.priceLevel) ?? null,
    stop: (has("stop") ? pending.stop : trade.stop) ?? null,
    takeProfit: (has("takeProfit") ? pending.takeProfit : trade.takeProfit) ?? null,
  };
}

/** Commit the MERGED levels as the trade's authoritative final state: a null SL/TP
 *  here means "remove it" (clear_*), unlike the drag path where null means "leave
 *  unchanged". Used by BOTH the edit ticket's Update and the chart pill's Apply, so
 *  the two can't diverge (e.g. ticket toggles SL off → Apply must actually clear it). */
export async function applyEditedLevels(
  trade: { kind: "position" | "order"; id: string },
  merged: { price: number | null; stop: number | null; takeProfit: number | null },
  account: TradeAccount = DEFAULT_ACCOUNT,
): Promise<OrderResult> {
  return applyLevels(
    trade,
    {
      limit_level: trade.kind === "order" ? merged.price : null,
      stop_level: merged.stop,
      take_profit_level: merged.takeProfit,
      clear_stop: merged.stop == null,
      clear_take_profit: merged.takeProfit == null,
    },
    account,
  );
}

export async function cancelWorkingOrder(
  orderId: string,
  account: TradeAccount = DEFAULT_ACCOUNT,
): Promise<OrderResult> {
  const url = `${BASE}/api/orders/working/${encodeURIComponent(orderId)}?account=${encodeURIComponent(account)}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorDetail(res, `cancel failed (${res.status})`));
  return res.json();
}

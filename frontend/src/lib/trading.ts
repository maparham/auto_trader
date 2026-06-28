// Order-execution API layer (paper now; demo/live in later phases). Mirrors the
// backend ExecutionBroker seam: place orders (market or limit), list and edit
// open positions and resting orders.
//
// Positions and working orders are normalized into one `TradeView` shape and
// published on a single `tradesSignal` poll, so the panel and every chart cell
// render lines/rows for both from one source (one poll, fanned out). Anything
// keyed on a trade (lines, pending edits) uses the unified `id` (deal_id for a
// position, order_id for a resting order).

import { tradesSignal } from "./signals";

const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

// A registry account key "{broker}:{env}", e.g. "capital:paper". Opaque to the
// frontend — it comes from GET /api/brokers and routes orders/positions.
export type TradeAccount = string;
export const DEFAULT_ACCOUNT: TradeAccount = "capital:paper";

// Display name for a broker id (the id is a lowercase opaque key; this is UI only).
// Unknown ids fall back to a capitalized id so a new broker still reads sensibly.
const BROKER_LABELS: Record<string, string> = {
  capital: "Capital.com",
  // IG demo and live are separate data brokers (different host/feed), so they get
  // distinct labels — the env suffix ("· Demo"/"· Paper") is a different axis.
  "ig-demo": "IG (demo)",
  "ig-live": "IG (live)",
};
export function brokerLabel(brokerId: string): string {
  return BROKER_LABELS[brokerId] ?? brokerId.charAt(0).toUpperCase() + brokerId.slice(1);
}
export type OrderSide = "buy" | "sell";
export type OrderKind = "market" | "limit";

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

export interface Position {
  epic: string;
  side: OrderSide;
  quantity: number;
  open_level: number;
  deal_id: string;
  stop_level: number | null;
  take_profit_level: number | null;
  upnl: number | null;
  created_at: string | null;
}

export interface WorkingOrder {
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
}

export interface Quote {
  bid: number | null;
  ask: number | null;
  mid: number | null;
}

/** The human label for a position or resting order — used identically by the
 *  chart line, the panel row, and the edit-ticket header (one source so they
 *  can't drift). NB: a new-order DRAFT uses a different verb ("Buy"/"Sell"). */
export function tradeLabel(kind: TradeView["kind"], side: OrderSide): string {
  if (kind === "order") return side === "buy" ? "Limit buy" : "Limit sell";
  return side === "buy" ? "Long" : "Short";
}

// A fresh idempotency key per submit so a retried request can't double-fill.
export function newClientOrderId(): string {
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
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail ?? `order failed (${res.status})`);
  }
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
      }),
    ),
  ];
}

// --- shared trades poller ---------------------------------------------------
//
// One poll for the whole app fetches positions AND working orders together
// (Promise.all = one fan-out), normalizes to TradeView[], and publishes on
// tradesSignal. Reference-counted: the interval runs while at least one consumer
// is subscribed.

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _pollRefs = 0;
const POLL_MS = 3000;

// The account the shared poll fetches. Set by the App when the user switches the
// active broker/account, so positions/orders follow the selection.
let _pollAccount: TradeAccount = DEFAULT_ACCOUNT;

/** Point the shared trades poll at a different account and refresh immediately.
 *  Call when the active broker/account changes. */
export function setTradesAccount(account: TradeAccount): void {
  if (account === _pollAccount) return;
  _pollAccount = account;
  // Clear stale trades from the previous account so lines/rows don't linger.
  tradesSignal.set([]);
  void _pollOnce();
}

async function _pollOnce(): Promise<void> {
  const account = _pollAccount;
  try {
    const [positions, orders] = await Promise.all([
      fetchPositions(account),
      fetchWorkingOrders(account),
    ]);
    // A switch mid-flight would publish the wrong account's trades; drop a
    // response whose account is no longer active.
    if (account === _pollAccount) tradesSignal.set(toTrades(positions, orders));
  } catch {
    // Transient: keep the last known trades rather than clearing the chart.
  }
}

/** Force an immediate refresh (after a fill / close / edit). */
export function refreshTrades(): void {
  void _pollOnce();
}

/** Subscribe to the shared trades poll; the returned unsubscribe stops the
 *  interval when the last consumer leaves. */
export function subscribeTrades(fn: (t: TradeView[]) => void): () => void {
  fn(tradesSignal.value); // deliver the current value immediately
  const unsub = tradesSignal.subscribe(fn);
  _pollRefs += 1;
  if (_pollTimer === null) {
    void _pollOnce();
    _pollTimer = setInterval(() => void _pollOnce(), POLL_MS);
  }
  return () => {
    unsub();
    _pollRefs -= 1;
    if (_pollRefs <= 0 && _pollTimer !== null) {
      clearInterval(_pollTimer);
      _pollTimer = null;
      _pollRefs = 0;
    }
  };
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
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail ?? `close failed (${res.status})`);
  }
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
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail ?? `update failed (${res.status})`);
  }
  return res.json();
}

export async function cancelWorkingOrder(
  orderId: string,
  account: TradeAccount = DEFAULT_ACCOUNT,
): Promise<OrderResult> {
  const url = `${BASE}/api/orders/working/${encodeURIComponent(orderId)}?account=${encodeURIComponent(account)}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail ?? `cancel failed (${res.status})`);
  }
  return res.json();
}

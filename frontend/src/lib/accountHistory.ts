// Broker-reported account history (spec 2026-10-21-capital-account-history):
// closed trades with realized P&L and the cash ledger, from GET /api/history.
//
// One store entry per (account, days), shared by every subscriber (desktop
// dock, phone view, chart markers). An entry refetches while it has
// subscribers: on a 60 s timer (skipped while the page is hidden), and when a
// position disappears from the trades book (a close just happened). The timer
// is what keeps capital:demo fresh: it has no server push and no trades poll.

import { API_BASE as BASE, apiFetch, errorDetail, throwIfBrokerBlocked } from "./http";
import { tradesSignal } from "./signals";
import {
  accountSupportsHistory,
  getTradesAccount,
  historyAccountsSignal,
  tradesAccountSignal,
  type OrderSide,
} from "./trading";

export type HistoryDays = 7 | 30 | 90;
export const HISTORY_POLL_MS = 60_000;
// Chart markers always read this range, whatever the History tab shows.
export const MARKER_DAYS: HistoryDays = 30;

export interface ClosedTradeView {
  dealId: string;
  epic: string;
  side: OrderSide; // opening side
  size: number;
  entry: number;
  exit: number;
  openedAt: number | null; // epoch ms; null = opened before the fetched range
  closedAt: number; // epoch ms
  closeSource: string; // USER / TP / SL / SYSTEM / CLOSE_OUT / DEALER
  pnl: number | null; // account currency
  currency: string | null;
}
export interface LedgerRow {
  at: number;
  kind: string;
  epic: string | null;
  note: string;
  amount: number;
  currency: string;
  reference: string;
  dealId: string | null;
}
export interface HistoryTotals {
  realized: number;
  funding: number;
  deposits: number;
  withdrawals: number;
  currency: string | null;
}
export interface AccountHistoryData {
  trades: ClosedTradeView[];
  ledger: LedgerRow[];
  totals: HistoryTotals;
}
export interface HistoryState {
  loading: boolean;
  error: string | null;
  data: AccountHistoryData | null;
}
export interface MarkerHistory {
  active: boolean;
  trades: ClosedTradeView[];
}

interface ApiTrade {
  deal_id: string; epic: string; side: OrderSide; size: number; entry_price: number;
  exit_price: number; opened_at: number | null; closed_at: number; close_source: string;
  pnl: number | null; currency: string | null;
}
interface ApiLedger {
  at: number; kind: string; epic: string | null; note: string; amount: number;
  currency: string; reference: string; deal_id: string | null;
}

/** null when the account has no broker history (supported:false). */
export async function fetchAccountHistory(
  account: string,
  days: HistoryDays,
): Promise<AccountHistoryData | null> {
  const res = await apiFetch(`${BASE}/api/history?account=${encodeURIComponent(account)}&days=${days}`);
  if (!res.ok) {
    await throwIfBrokerBlocked(res);
    throw new Error(await errorDetail(res, `history failed (${res.status})`));
  }
  const body = await res.json();
  if (!body.supported) return null;
  return {
    trades: (body.trades as ApiTrade[]).map((t) => ({
      dealId: t.deal_id, epic: t.epic, side: t.side, size: t.size, entry: t.entry_price,
      exit: t.exit_price, openedAt: t.opened_at, closedAt: t.closed_at,
      closeSource: t.close_source, pnl: t.pnl, currency: t.currency,
    })),
    ledger: (body.ledger as ApiLedger[]).map((e) => ({
      at: e.at, kind: e.kind, epic: e.epic, note: e.note, amount: e.amount,
      currency: e.currency, reference: e.reference, dealId: e.deal_id,
    })),
    totals: body.totals,
  };
}

interface Entry {
  account: string;
  days: HistoryDays;
  state: HistoryState;
  listeners: Set<(s: HistoryState) => void>;
  timer: ReturnType<typeof setInterval> | null;
  seq: number; // newest request id; an older response is dropped
}
const entries = new Map<string, Entry>();
const keyOf = (account: string, days: HistoryDays) => `${account}|${days}`;

function publish(e: Entry, next: HistoryState): void {
  e.state = next;
  e.listeners.forEach((l) => l(next));
}

async function load(e: Entry): Promise<void> {
  const seq = ++e.seq;
  publish(e, { ...e.state, loading: true, error: null });
  try {
    const data = await fetchAccountHistory(e.account, e.days);
    if (seq !== e.seq || entries.get(keyOf(e.account, e.days)) !== e) return;
    publish(e, { loading: false, error: null, data });
  } catch (err) {
    if (seq !== e.seq || entries.get(keyOf(e.account, e.days)) !== e) return;
    publish(e, { ...e.state, loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// Refetch every currently-subscribed entry when the tab regains visibility:
// the 60 s timer already skips ticks while hidden, so a long-backgrounded tab
// comes back showing a stale history until the next tick lands. One listener
// for every entry, installed only while something is subscribed and torn
// down again once the last subscriber (of any entry) leaves.
let visibilityListenerOn = false;
function onVisible(): void {
  if (typeof document === "undefined" || document.hidden) return;
  for (const e of entries.values()) if (e.listeners.size > 0) void load(e);
}
function totalSubscribers(): number {
  let n = 0;
  for (const e of entries.values()) n += e.listeners.size;
  return n;
}
function syncVisibilityListener(): void {
  if (typeof document === "undefined") return;
  const want = totalSubscribers() > 0;
  if (want && !visibilityListenerOn) {
    document.addEventListener("visibilitychange", onVisible);
    visibilityListenerOn = true;
  } else if (!want && visibilityListenerOn) {
    document.removeEventListener("visibilitychange", onVisible);
    visibilityListenerOn = false;
  }
}

export function subscribeHistory(
  account: string,
  days: HistoryDays,
  fn: (s: HistoryState) => void,
): () => void {
  const key = keyOf(account, days);
  let e = entries.get(key);
  if (!e) {
    e = { account, days, state: { loading: false, error: null, data: null }, listeners: new Set(), timer: null, seq: 0 };
    entries.set(key, e);
  }
  const entry = e;
  entry.listeners.add(fn);
  fn(entry.state);
  if (entry.listeners.size === 1) {
    void load(entry);
    entry.timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load(entry);
    }, HISTORY_POLL_MS);
  }
  syncVisibilityListener();
  return () => {
    entry.listeners.delete(fn);
    if (entry.listeners.size === 0) {
      if (entry.timer !== null) clearInterval(entry.timer);
      entries.delete(key); // drops any in-flight response (load checks identity)
    }
    syncVisibilityListener();
  };
}

/** Refetch every subscribed range of `account` now. */
export function refreshHistory(account: string): void {
  for (const e of entries.values()) if (e.account === account) void load(e);
}

// A position leaving the book is a close (TP/SL/manual/stop-out): refetch the
// trades account's history so the new closed row and its markers show.
let lastPositionIds = new Set<string>();
tradesSignal.subscribe((trades) => {
  const ids = new Set(trades.filter((t) => t.kind === "position").map((t) => t.id));
  const gone = [...lastPositionIds].some((id) => !ids.has(id));
  lastPositionIds = ids;
  if (gone) refreshHistory(getTradesAccount());
});

/** The chart's marker source: follows the trades account; active (30d closed
 * trades) only while that account has broker history. */
export function subscribeMarkerHistory(fn: (h: MarkerHistory) => void): () => void {
  let inner: (() => void) | null = null;
  // undefined = "not synced yet", distinct from the "no active account" null
  // the computed `want` can also take, so the very first sync always emits.
  let current: string | null | undefined;
  const sync = () => {
    const account = tradesAccountSignal.value;
    const active = accountSupportsHistory(account);
    const want = active ? account : null;
    if (want === current) return;
    inner?.();
    inner = null;
    current = want;
    if (want === null) {
      fn({ active: false, trades: [] });
      return;
    }
    inner = subscribeHistory(want, MARKER_DAYS, (s) => fn({ active: true, trades: s.data?.trades ?? [] }));
  };
  sync();
  const offAccount = tradesAccountSignal.subscribe(sync);
  const offList = historyAccountsSignal.subscribe(sync);
  return () => {
    offAccount();
    offList();
    inner?.();
  };
}

/** Test seam: forget every entry and timer. */
export function _resetHistoryForTests(): void {
  for (const e of entries.values()) if (e.timer !== null) clearInterval(e.timer);
  entries.clear();
  lastPositionIds = new Set();
  if (visibilityListenerOn && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisible);
  }
  visibilityListenerOn = false;
}

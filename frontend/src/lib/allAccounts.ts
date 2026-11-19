// The dock's "All accounts" tab: every dealing account's open positions, read
// without switching broker. Pure helpers plus the per-account fetch; polling
// lives in app/useAllAccounts.ts. Errors are kept per account and never
// reach the app-wide broker outage banners: this is a background glance.
import {
  fetchAccountSummary,
  fetchOpenPositions,
  tradesAccountSignal,
  type AccountSummary,
  type BrokerAccount,
  type TradeAccount,
  type TradeView,
} from "./trading";
import { tradesSignal } from "./signals";
import { accountStats } from "./accountStats";
import { PREFIX } from "./workspaceKeys";
import type { TradingSettings } from "../theme";

export interface AccountSnapshot {
  account: TradeAccount;
  /** null = never loaded. */
  positions: TradeView[] | null;
  /** null = 404 (no summary) or not fetched yet. */
  summary: AccountSummary | null;
  /** Last fetch error, cleared on success. */
  error: string | null;
  /** Epoch ms of the last successful fetch. */
  fetchedAt: number | null;
}

export interface SectionFigures {
  pnl: number;
  equity: number | null;
  marginLevel: number | null;
  currency: string | null;
}

/** Accounts that can hold real positions: no paper sims, no data-only feeds. */
export function dealingAccounts(accounts: BrokerAccount[]): BrokerAccount[] {
  return accounts.filter((a) => a.env !== "paper" && !a.dataOnly);
}

export function visibleAndHidden(
  accounts: BrokerAccount[],
  hidden: string[],
): { visible: BrokerAccount[]; hidden: BrokerAccount[] } {
  const set = new Set(hidden);
  return {
    visible: accounts.filter((a) => !set.has(a.key)),
    hidden: accounts.filter((a) => set.has(a.key)),
  };
}

/** Open positions in the visible accounts other than `active`. null until at
 * least one of them has been tried; an account that only ever failed counts 0
 * so one broker that is down never hides the number. */
export function otherOpenCount(
  snaps: Record<string, AccountSnapshot>,
  visible: BrokerAccount[],
  active: TradeAccount,
): number | null {
  const others = visible.filter((a) => a.key !== active).map((a) => snaps[a.key]);
  if (!others.some((s) => s && (s.fetchedAt != null || s.error != null))) return null;
  return others.reduce((n, s) => n + (s?.positions?.length ?? 0), 0);
}

/** Accounts with positions first, then the rest; the active one leads its group. */
export function orderSections(
  visible: BrokerAccount[],
  snaps: Record<string, AccountSnapshot>,
  active: TradeAccount,
): BrokerAccount[] {
  const has = (a: BrokerAccount) => (snaps[a.key]?.positions?.length ?? 0) > 0;
  const group = (list: BrokerAccount[]) => [
    ...list.filter((a) => a.key === active),
    ...list.filter((a) => a.key !== active),
  ];
  return [...group(visible.filter(has)), ...group(visible.filter((a) => !has(a)))];
}

/** Header figures. Without a summary only the summed P&L is known. Orders are
 * not fetched here, so margin held by resting orders is left out. */
export function sectionFigures(
  snap: AccountSnapshot,
  acct: BrokerAccount,
  trading: TradingSettings,
): SectionFigures {
  const positions = snap.positions ?? [];
  if (!snap.summary) {
    return {
      pnl: positions.reduce((s, p) => s + (p.upnl ?? 0), 0),
      equity: null,
      marginLevel: null,
      currency: null,
    };
  }
  const s = accountStats({
    positions,
    orders: [],
    summary: snap.summary,
    trading,
    broker: acct.broker,
    isLive: acct.isRealMoney,
    // The chart price cache belongs to the active broker; trust broker uPnL.
    livePrice: () => undefined,
  });
  return { pnl: s.pnl, equity: s.equity, marginLevel: s.marginLevel, currency: snap.summary.currency };
}

/** Distance from the current price to SL and TP, in percent of the price. */
export function slTpDistancePct(t: TradeView): { sl: number | null; tp: number | null } {
  const mark = t.mark;
  const dist = (level: number | null) =>
    mark == null || mark === 0 || level == null ? null : (Math.abs(level - mark) / mark) * 100;
  return { sl: dist(t.stop), tp: dist(t.takeProfit) };
}

const HIDDEN_KEY = `${PREFIX}.allAccounts.hidden`;

export function loadHiddenAccounts(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveHiddenAccounts(ids: string[]): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
  } catch {
    /* storage full or blocked: the toggle just won't persist */
  }
}

export async function fetchSnapshot(
  prev: AccountSnapshot | undefined,
  account: TradeAccount,
  withSummary: boolean,
): Promise<AccountSnapshot> {
  const base: AccountSnapshot = prev ?? {
    account,
    positions: null,
    summary: null,
    error: null,
    fetchedAt: null,
  };
  try {
    const [positions, summary] = await Promise.all([
      fetchOpenPositions(account),
      withSummary ? fetchAccountSummary(account) : Promise.resolve(base.summary),
    ]);
    return { account, positions, summary, error: null, fetchedAt: Date.now() };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Resolve `dealId` once the shared trades feed is on `account` and holds that
 * position; null on timeout, or when the feed moves to another account (after
 * reaching `account`, or to a third one before it). The feed may still point
 * at the old account when this starts: the account switch lands a render later. */
export function waitForTrade(
  account: TradeAccount,
  dealId: string,
  timeoutMs = 15_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const start = tradesAccountSignal.value;
    let reached = false;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubAcct();
      unsubTrades();
      resolve(v);
    };
    const check = () => {
      if (
        tradesAccountSignal.value === account &&
        tradesSignal.value.some((t) => t.kind === "position" && t.id === dealId)
      ) {
        finish(dealId);
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const unsubAcct = tradesAccountSignal.subscribe((a) => {
      if (a === account) {
        reached = true;
        check();
      } else if (reached || a !== start) {
        finish(null);
      }
    });
    const unsubTrades = tradesSignal.subscribe(check);
    if (tradesAccountSignal.value === account) reached = true;
    check();
  });
}

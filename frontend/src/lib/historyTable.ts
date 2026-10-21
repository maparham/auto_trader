// Pure helpers for the History tab (HistoryPane): plain-word labels, the
// closed-trades sort and the row-to-chart mapping. Kept apart from lib/positionsTable, whose columns and sort
// keys are tied to OPEN trades.
import type { ClosedTradeView } from "./accountHistory";
import type { SortDir } from "./positionsTable";
import type { TradeRow } from "./tradeList";

const CLOSED_BY: Record<string, string> = {
  TP: "TP",
  SL: "SL",
  USER: "Manual",
  SYSTEM: "System",
  CLOSE_OUT: "Stop-out",
  DEALER: "Dealer",
};
export const closedByLabel = (source: string) => CLOSED_BY[source] ?? source;

const LEDGER_KIND: Record<string, string> = {
  SWAP: "Overnight fee",
  TRADE: "Trade",
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
};
export const ledgerKindLabel = (kind: string) => LEDGER_KIND[kind] ?? kind;

/** Decimals a stored price carries, capped at 6: a precision guess for a
 * symbol with no catalogue precision. */
export function priceDecimals(n: number): number {
  const str = String(n);
  const i = str.indexOf(".");
  return i < 0 ? 0 : Math.min(str.length - i - 1, 6);
}

/** A closed trade as the Trade list panel's row, so a History click can reuse
 * its jump (open the chart, page in history, draw the trade box, scroll).
 * null when the open time is unknown ("before range"): no entry to anchor. */
export function historyTradeRow(t: ClosedTradeView): TradeRow | null {
  if (t.openedAt == null) return null;
  const dir = t.side === "buy" ? 1 : -1;
  return {
    symbol: t.epic,
    side: t.side === "buy" ? "LONG" : "SHORT",
    entryTs: t.openedAt,
    entryPrice: t.entry,
    exitTs: t.closedAt,
    exitPrice: t.exit,
    pctPL: t.entry ? ((t.exit - t.entry) / t.entry) * 100 * dir : undefined,
    dollarPL: t.pnl ?? undefined,
    qty: t.size,
    hasTime: true,
  };
}

export type HistorySortKey =
  | "epic" | "side" | "size" | "entry" | "exit" | "openedAt" | "closedAt" | "closeSource" | "pnl";
export type HistorySort = { key: HistorySortKey; dir: SortDir };
export const DEFAULT_HISTORY_SORT: HistorySort = { key: "closedAt", dir: "desc" };

/** Sorted copy; nulls sink to the bottom in both directions. */
export function sortClosedTrades(rows: ClosedTradeView[], sort: HistorySort): ClosedTradeView[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    // "Closed by" sorts on the label shown, not the raw source code.
    const x = sort.key === "closeSource" ? closedByLabel(a.closeSource) : a[sort.key];
    const y = sort.key === "closeSource" ? closedByLabel(b.closeSource) : b[sort.key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

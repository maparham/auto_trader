// Pure helpers for the History tab (HistoryPane): plain-word labels and the
// closed-trades sort. Kept apart from lib/positionsTable, whose columns and sort
// keys are tied to OPEN trades.
import type { ClosedTradeView } from "./accountHistory";
import type { SortDir } from "./positionsTable";

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
  SWAP: "Funding",
  TRADE: "Trade",
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
};
export const ledgerKindLabel = (kind: string) => LEDGER_KIND[kind] ?? kind;

export type HistorySortKey =
  | "epic" | "side" | "size" | "entry" | "exit" | "openedAt" | "closedAt" | "closeSource" | "pnl";
export type HistorySort = { key: HistorySortKey; dir: SortDir };
export const DEFAULT_HISTORY_SORT: HistorySort = { key: "closedAt", dir: "desc" };

/** Sorted copy; nulls sink to the bottom in both directions. */
export function sortClosedTrades(rows: ClosedTradeView[], sort: HistorySort): ClosedTradeView[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

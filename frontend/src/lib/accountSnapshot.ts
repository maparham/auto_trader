// The dealing account's balance + currency, cached at module level so a chart
// overlay can read it SYNCHRONOUSLY while painting. createPointFigures runs on
// every repaint and must never fetch; App.tsx already polls the summary every
// few seconds, so it pushes the result in here and the trade drawing reads it.
// null = no account known yet (or a paint before the first poll): money labels
// drop out rather than showing a made-up balance.
import type { TradeAccount } from "./tradePlan";

let snapshot: TradeAccount | null = null;

export function setAccountSnapshot(next: TradeAccount | null): void {
  snapshot = next;
}

export function getAccountSnapshot(): TradeAccount | null {
  return snapshot;
}

/** The account a trade drawing should size against: the broker's real figures
 *  where it reports them, the configured paper account otherwise. Same
 *  precedence the order ticket and positions panel use, so a drawing's risk and
 *  a real ticket's risk are measured against the same balance. */
export function accountSnapshotFrom(
  summary: { balance?: number | null; currency?: string | null } | null,
  trading: { accountBalance: number; accountCurrency: string },
): TradeAccount {
  return {
    balance: summary?.balance ?? trading.accountBalance,
    currency: summary?.currency ?? trading.accountCurrency,
  };
}

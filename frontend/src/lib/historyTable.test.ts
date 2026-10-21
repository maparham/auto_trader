import { describe, it, expect } from "vitest";
import { closedByLabel, ledgerKindLabel, sortClosedTrades, DEFAULT_HISTORY_SORT } from "./historyTable";
import type { ClosedTradeView } from "./accountHistory";

const t = (over: Partial<ClosedTradeView>): ClosedTradeView => ({
  dealId: "D", epic: "TSLA", side: "buy", size: 1, entry: 1, exit: 2, openedAt: null,
  closedAt: 0, closeSource: "USER", pnl: null, currency: "EUR", ...over,
});

describe("historyTable", () => {
  it("labels close sources and ledger kinds in plain words", () => {
    expect(["TP", "SL", "USER", "SYSTEM", "CLOSE_OUT", "DEALER", "ODD"].map(closedByLabel))
      .toEqual(["TP", "SL", "Manual", "System", "Stop-out", "Dealer", "ODD"]);
    expect(["SWAP", "TRADE", "DEPOSIT", "WITHDRAWAL", "BONUS"].map(ledgerKindLabel))
      .toEqual(["Funding", "Trade", "Deposit", "Withdrawal", "BONUS"]);
  });

  it("sorts newest close first by default, nulls last on any key", () => {
    const rows = [t({ dealId: "a", closedAt: 1, pnl: 5 }), t({ dealId: "b", closedAt: 3, pnl: null }), t({ dealId: "c", closedAt: 2, pnl: -1 })];
    expect(sortClosedTrades(rows, DEFAULT_HISTORY_SORT).map((r) => r.dealId)).toEqual(["b", "c", "a"]);
    expect(sortClosedTrades(rows, { key: "pnl", dir: "asc" }).map((r) => r.dealId)).toEqual(["c", "a", "b"]);
    expect(sortClosedTrades(rows, { key: "pnl", dir: "desc" }).map((r) => r.dealId)).toEqual(["a", "c", "b"]);
  });
});

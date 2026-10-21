import { describe, it, expect } from "vitest";
import { closedByLabel, historyTradeRow, ledgerKindLabel, priceDecimals, sortClosedTrades, DEFAULT_HISTORY_SORT } from "./historyTable";
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
      .toEqual(["Overnight fee", "Trade", "Deposit", "Withdrawal", "BONUS"]);
  });

  it("sorts newest close first by default, nulls last on any key", () => {
    const rows = [t({ dealId: "a", closedAt: 1, pnl: 5 }), t({ dealId: "b", closedAt: 3, pnl: null }), t({ dealId: "c", closedAt: 2, pnl: -1 })];
    expect(sortClosedTrades(rows, DEFAULT_HISTORY_SORT).map((r) => r.dealId)).toEqual(["b", "c", "a"]);
    expect(sortClosedTrades(rows, { key: "pnl", dir: "asc" }).map((r) => r.dealId)).toEqual(["c", "a", "b"]);
    expect(sortClosedTrades(rows, { key: "pnl", dir: "desc" }).map((r) => r.dealId)).toEqual(["a", "c", "b"]);
  });

  it("sorts Closed by on the label shown, not the raw code", () => {
    const rows = [t({ dealId: "sl", closeSource: "SL" }), t({ dealId: "user", closeSource: "USER" })];
    // Raw codes would put SL before USER; the labels read Manual before SL.
    expect(sortClosedTrades(rows, { key: "closeSource", dir: "asc" }).map((r) => r.dealId)).toEqual(["user", "sl"]);
  });

  it("guesses precision from a price's decimals, capped at 6", () => {
    expect([400, 1.08345, 0.123456789].map(priceDecimals)).toEqual([0, 5, 6]);
  });

  it("maps a closed trade onto the trade-list jump's row, and skips one with no open time", () => {
    expect(historyTradeRow(t({ side: "sell", entry: 100, exit: 90, openedAt: 1_000, closedAt: 5_000, pnl: 12.5, size: 2 })))
      .toEqual({
        symbol: "TSLA", side: "SHORT", entryTs: 1_000, entryPrice: 100, exitTs: 5_000, exitPrice: 90,
        pctPL: 10, dollarPL: 12.5, qty: 2, hasTime: true,
      });
    expect(historyTradeRow(t({ openedAt: null }))).toBeNull();
  });
});

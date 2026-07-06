import { describe, it, expect } from "vitest";
import { journalMetrics, type JournalTrade } from "./liveJournal";

function t(pnl: number): JournalTrade {
  return { ts: 0, epic: "X", leg: "long", entry: 0, exit: 0, quantity: 1, pnl };
}

describe("journalMetrics", () => {
  it("empty set is all-zero", () => {
    expect(journalMetrics([])).toEqual({ net: 0, count: 0, winRate: 0, maxDD: 0 });
  });

  it("net, count and win rate", () => {
    const m = journalMetrics([t(10), t(-4), t(6), t(-2)]);
    expect(m.net).toBe(10);
    expect(m.count).toBe(4);
    expect(m.winRate).toBe(0.5); // 2 of 4 positive
  });

  it("max drawdown is the deepest peak-to-trough dip (<= 0)", () => {
    // equity: +10, +4 (dip 6 from peak 10), +9, +2 (dip 8 from peak 10)
    const m = journalMetrics([t(10), t(-6), t(5), t(-7)]);
    expect(m.maxDD).toBe(-8);
  });
});

// Bootstrap resampling of the closed-trade P&L list: pessimistic net P&L,
// probability of profit, and the drawdown distribution.
import { describe, expect, it } from "vitest";
import { bootstrapPnl } from "./bootstrapStats";

const MIXED = [10, -5, 8, -3, 12, -7, 6, -2, 9, -4];

describe("bootstrapPnl", () => {
  it("is deterministic for a given seed", () => {
    expect(bootstrapPnl(MIXED, 500, 42)).toEqual(bootstrapPnl(MIXED, 500, 42));
  });

  it("differs across seeds (it actually resamples)", () => {
    const a = bootstrapPnl(MIXED, 500, 1)!;
    const b = bootstrapPnl(MIXED, 500, 2)!;
    expect(a.p5Net).not.toBe(b.p5Net);
  });

  it("returns null under 2 trades", () => {
    expect(bootstrapPnl([], 100, 1)).toBeNull();
    expect(bootstrapPnl([5], 100, 1)).toBeNull();
  });

  it("an all-winner list is certain profit with zero drawdown", () => {
    const s = bootstrapPnl([5, 7, 3, 9], 500, 7)!;
    expect(s.probProfit).toBe(1);
    expect(s.p5Net).toBeGreaterThan(0);
    expect(s.ddP95).toBe(0);
  });

  it("an all-loser list is certain loss", () => {
    const s = bootstrapPnl([-5, -7, -3], 500, 7)!;
    expect(s.probProfit).toBe(0);
    expect(s.p5Net).toBeLessThan(0);
    expect(s.ddP95).toBeGreaterThan(0);
  });

  it("orders its percentiles sensibly on a mixed list", () => {
    const s = bootstrapPnl(MIXED, 2000, 7)!;
    const total = MIXED.reduce((a, b) => a + b, 0);
    expect(s.p5Net).toBeLessThan(total);       // pessimistic tail below the point estimate
    expect(s.probProfit).toBeGreaterThan(0.5); // the list is net positive
    expect(s.probProfit).toBeLessThan(1);      // but not immune to bad luck
    expect(s.ddP95).toBeGreaterThanOrEqual(s.ddP50);
    expect(s.ddP50).toBeGreaterThan(0);        // losses exist, so some drawdown always
  });
});

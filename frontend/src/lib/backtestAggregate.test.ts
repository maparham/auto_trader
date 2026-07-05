import { describe, it, expect } from "vitest";
import { aggregateTradesByBar, type TradeCluster } from "./backtest";

// aggregateTradesByBar only reads entry_time/exit_time/pnl; the rest of Trade is
// filled minimally so the cast is honest about what's exercised.
type Trade = Parameters<typeof aggregateTradesByBar>[0][number];
function trade(entrySec: number, exitSec: number, pnl: number): Trade {
  return {
    side: "buy",
    quantity: 1,
    entry_time: entrySec,
    entry_price: 100,
    exit_time: exitSec,
    exit_price: 101,
    pnl,
    leg: "long",
    reason: "target",
    stop_initial: null,
    stop_final: null,
    target: null,
  } as Trade;
}

// Bars an hour apart (ms); high is distinct per bar so anchoring is checkable.
const B = [
  { timestamp: 3_600_000, high: 11 }, // bar 0: [3.6e6, 7.2e6)
  { timestamp: 7_200_000, high: 12 }, // bar 1: [7.2e6, 10.8e6)
  { timestamp: 10_800_000, high: 13 }, // bar 2: [10.8e6, ∞)
];

describe("aggregateTradesByBar", () => {
  it("returns [] when there are no bars", () => {
    expect(aggregateTradesByBar([trade(4000, 5000, 1)], [])).toEqual([]);
  });

  it("buckets multiple trades in one bar into a single cluster", () => {
    // entries at 4000s and 5000s (ms 4e6, 5e6) both fall in bar 0 [3.6e6, 7.2e6).
    const out = aggregateTradesByBar([trade(4000, 4500, 5), trade(5000, 6000, -2)], B);
    expect(out).toHaveLength(1);
    const cl = out[0] as TradeCluster;
    expect(cl.barTs).toBe(3_600_000);
    expect(cl.high).toBe(11);
    expect(cl.trades).toHaveLength(2);
    expect(cl.net).toBe(3);
    expect(cl.fromTs).toBe(4_000_000); // min entry ms
    expect(cl.toTs).toBe(6_000_000); // max exit ms
  });

  it("clamps a trade before the first bar to bar 0", () => {
    const out = aggregateTradesByBar([trade(100, 200, 1)], B);
    expect(out).toHaveLength(1);
    expect(out[0].barTs).toBe(3_600_000);
  });

  it("clamps a trade after the last bar to the last bar", () => {
    const out = aggregateTradesByBar([trade(20_000, 21_000, 1)], B);
    expect(out).toHaveLength(1);
    expect(out[0].barTs).toBe(10_800_000);
  });

  it("assigns a trade whose entry equals a bar's open to that bar", () => {
    // entry at exactly 7200s (ms 7.2e6) = bar 1's open, not bar 0.
    const out = aggregateTradesByBar([trade(7200, 7300, 1)], B);
    expect(out).toHaveLength(1);
    expect(out[0].barTs).toBe(7_200_000);
  });

  it("returns clusters sorted by bar timestamp", () => {
    // one trade in each of bar 2 then bar 0 (out of order in input).
    const out = aggregateTradesByBar([trade(11_000, 11_100, 1), trade(4000, 4100, 1)], B);
    expect(out.map((c) => c.barTs)).toEqual([3_600_000, 10_800_000]);
  });

  it("does not double-count a trade spanning multiple bars (anchors on entry)", () => {
    // entry in bar 0, exit in bar 2: one cluster on bar 0, toTs = exit.
    const out = aggregateTradesByBar([trade(4000, 11_000, 9)], B);
    expect(out).toHaveLength(1);
    expect(out[0].barTs).toBe(3_600_000);
    expect(out[0].net).toBe(9);
    expect(out[0].toTs).toBe(11_000_000);
  });
});

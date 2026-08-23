// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { aggregateTradesByBar, dashSliceBounds, tradeDashes } from "./backtest";

// tradeDashes reads entry_time/exit_time/entry_price/pnl off each cluster trade;
// the rest of Trade is filled minimally so the cast is honest about what's
// exercised (same convention as backtestAggregate.test.ts).
type Trade = Parameters<typeof aggregateTradesByBar>[0][number];
function trade(entrySec: number, exitSec: number, pnl: number, entryPrice = 100): Trade {
  return {
    side: "buy",
    quantity: 1,
    entry_time: entrySec,
    entry_price: entryPrice,
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

// Bars an hour apart (ms).
const B = [
  { timestamp: 3_600_000, high: 11 }, // bar 0: [3.6e6, 7.2e6)
  { timestamp: 7_200_000, high: 12 }, // bar 1: [7.2e6, 10.8e6)
  { timestamp: 10_800_000, high: 13 }, // bar 2: [10.8e6, ∞)
];

function dashesFor(trades: Trade[], bars = B) {
  return tradeDashes(aggregateTradesByBar(trades, bars), bars);
}

describe("tradeDashes", () => {
  it("returns [] when there are no bars", () => {
    expect(tradeDashes(aggregateTradesByBar([trade(4000, 5000, 1)], []), [])).toEqual([]);
  });

  it("anchors a dash on the containing bar at the entry's fraction through it", () => {
    // entry 4500s = 900s into bar 0's 3600s span -> frac 0.25.
    const out = dashesFor([trade(4500, 5000, 1, 42)]);
    expect(out).toHaveLength(1);
    expect(out[0].barTs).toBe(3_600_000);
    expect(out[0].frac).toBeCloseTo(0.25);
    expect(out[0].price).toBe(42);
    expect(out[0].index).toBe(0);
  });

  it("gives frac 0 for an entry exactly at the bar open", () => {
    const out = dashesFor([trade(7200, 7300, 1)]);
    expect(out[0].barTs).toBe(7_200_000);
    expect(out[0].frac).toBe(0);
  });

  it("reports spanBars 1 for a trade contained in one display candle", () => {
    const out = dashesFor([trade(4000, 5000, 1)]);
    expect(out[0].spanBars).toBe(1);
  });

  it("reports the inclusive candle count for a trade spanning bars", () => {
    // entry in bar 0, exit in bar 2 -> covers 3 display candles.
    const out = dashesFor([trade(4000, 11_000, 1)]);
    expect(out[0].spanBars).toBe(3);
  });

  it("keeps per-trade result indices when a cluster holds several trades", () => {
    const out = dashesFor([trade(4000, 4500, 1), trade(5000, 6000, -1)]);
    expect(out.map((d) => d.index)).toEqual([0, 1]);
  });

  it("skips a trade whose entry precedes the first loaded bar", () => {
    // The cluster clamps it to bar 0 for pill discoverability, but a dash at a
    // made-up position would be misleading — drop it.
    const out = dashesFor([trade(100, 200, 1)]);
    expect(out).toEqual([]);
  });

  it("uses the preceding gap to place an entry inside the last (open-ended) bar", () => {
    // entry 11700s = 900s into the last bar; prior bars are 3600s apart -> 0.25.
    const out = dashesFor([trade(11_700, 12_000, 1)]);
    expect(out[0].barTs).toBe(10_800_000);
    expect(out[0].frac).toBeCloseTo(0.25);
  });

  it("drops an entry past the nominal close of the last loaded bar", () => {
    // Mirrors the left-edge rule: the loaded window ends before this trade, so a
    // clamped dash would fabricate a position at the last candle's right edge.
    const out = dashesFor([trade(20_000, 21_000, 1)]);
    expect(out).toEqual([]);
  });

  it("keeps an entry inside the last (open-ended) bar's nominal span", () => {
    // last bar opens 10800s, nominal 3600s -> [10800s, 14400s) is real estate.
    const out = dashesFor([trade(14_000, 14_100, 1)]);
    expect(out).toHaveLength(1);
    expect(out[0].barTs).toBe(10_800_000);
  });

  it("treats an exit beyond the loaded window as spanning at least 2 candles", () => {
    // Entry in the last loaded bar, exit far past it: exitIdx clamps to the same
    // bar, but the trade demonstrably outlives the candle, so the hover must be
    // the entry→exit highlight, not the one-candle popover.
    const out = dashesFor([trade(11_000, 50_000, 1)]);
    expect(out).toHaveLength(1);
    expect(out[0].spanBars).toBeGreaterThanOrEqual(2);
  });

  it("uses an explicit nominal interval over the min-gap heuristic", () => {
    // One anomalous short gap (DST-style) would poison the min-gap: bar 1 → 2
    // are only 1800s apart. Passing the display interval keeps frac faithful.
    const dst = [
      { timestamp: 3_600_000, high: 11 },
      { timestamp: 7_200_000, high: 12 },
      { timestamp: 9_000_000, high: 13 }, // 1800s gap (short session)
      { timestamp: 12_600_000, high: 14 },
    ];
    // entry 4500s = 900s into bar 0. With min-gap (1800s) frac would be 0.5;
    // with the true 3600s interval it is 0.25.
    const out = tradeDashes(aggregateTradesByBar([trade(4500, 5000, 1)], dst), dst, 3_600_000);
    expect(out[0].frac).toBeCloseTo(0.25);
  });

  it("slices the visible window out of a barTs-ascending dash list", () => {
    const ds = [1000, 2000, 2000, 3000, 5000, 8000].map((barTs) => ({ barTs }));
    // Window [2000, 5000]: both 2000s, the 3000 and the 5000 -> indices [1, 5).
    expect(dashSliceBounds(ds, 2000, 5000)).toEqual([1, 5]);
    // Window fully before / after the data -> empty slices at the edges.
    expect(dashSliceBounds(ds, 0, 500)).toEqual([0, 0]);
    expect(dashSliceBounds(ds, 9000, 10_000)).toEqual([6, 6]);
    // Unbounded window covers everything.
    expect(dashSliceBounds(ds, -Infinity, Infinity)).toEqual([0, 6]);
    expect(dashSliceBounds([], 0, 100)).toEqual([0, 0]);
  });

  it("clamps frac to 1 for an entry that falls into a session gap", () => {
    // Bars with a weekend-sized hole: entry lands after bar 0's nominal close
    // but before bar 1 opens. It reads as "late in bar 0", not off in the void.
    const gapped = [
      { timestamp: 3_600_000, high: 11 },
      { timestamp: 7_200_000, high: 12 },
      { timestamp: 100_000_000, high: 13 }, // long closure before this bar
    ];
    // entry 50_000s (ms 5e7): inside bar 1's [7.2e6, 1e8) index window, way past
    // its nominal 3600s span.
    const out = dashesFor([trade(50_000, 50_100, 1)], gapped);
    expect(out[0].barTs).toBe(7_200_000);
    expect(out[0].frac).toBe(1);
  });
});

import { describe, it, expect } from "vitest";
import { backtestRenderFlags } from "./backtest";

describe("backtestRenderFlags", () => {
  it("shows both on the native timeframe", () => {
    expect(backtestRenderFlags("MINUTE_5", "MINUTE_5")).toEqual({
      drawMarkers: true,
      drawEquity: true,
    });
  });

  it("shows markers (not equity) on a finer, evenly-dividing timeframe", () => {
    // 5m backtest viewed on 1m: 300 % 60 === 0 → aligned.
    expect(backtestRenderFlags("MINUTE", "MINUTE_5")).toEqual({
      drawMarkers: true,
      drawEquity: false,
    });
  });

  it("hides markers on a finer timeframe that does NOT evenly divide", () => {
    // 5m backtest viewed on 30m is coarser; but test non-divisible finer:
    // WEEK (604800) viewed on HOUR_4 (14400): 604800 % 14400 === 0 → aligned.
    // Use MINUTE_5 native, HOUR? HOUR is coarser. Pick a true non-divisor:
    // native MINUTE_15 (900), current HOUR? coarser. current MINUTE_5? 900%300=0.
    // A genuine non-divisor finer pair: native WEEK (604800), current WEEK_2? coarser.
    // Simplest real non-divisor: native HOUR_4 (14400), current HOUR (3600): 14400%3600=0 aligned.
    // Non-divisor: native DAY (86400), current HOUR_4 (14400): 86400%14400=0 aligned.
    // Truly non-divisible finer: native MINUTE_5 (300), current... every std TF below divides.
    // Force it with WEEK_3 (1814400) native, DAY (86400) current: 1814400%86400=0 aligned.
    // Use MINUTE_45-style: SECOND_45 (45) native, SECOND_10 (10) current: 45%10=5 → NOT aligned.
    expect(backtestRenderFlags("SECOND_10", "SECOND_45")).toEqual({
      drawMarkers: false,
      drawEquity: false,
    });
  });

  it("hides both on a coarser timeframe", () => {
    // 5m backtest viewed on 1D: 86400 > 300 → coarser.
    expect(backtestRenderFlags("DAY", "MINUTE_5")).toEqual({
      drawMarkers: false,
      drawEquity: false,
    });
  });

  it("hides both for an unknown resolution", () => {
    expect(backtestRenderFlags("BOGUS", "MINUTE_5")).toEqual({
      drawMarkers: false,
      drawEquity: false,
    });
  });
});

import { describe, it, expect } from "vitest";
import { backtestRenderFlags } from "./backtest";

describe("backtestRenderFlags", () => {
  it("native mode + equity on the backtest's own timeframe", () => {
    expect(backtestRenderFlags("MINUTE_5", "MINUTE_5")).toEqual({
      markerMode: "native",
      drawEquity: true,
    });
  });

  it("native mode (no equity) on a finer, evenly-dividing timeframe", () => {
    // 5m backtest viewed on 1m: 300 % 60 === 0 → fills still land on bars.
    expect(backtestRenderFlags("MINUTE", "MINUTE_5")).toEqual({
      markerMode: "native",
      drawEquity: false,
    });
  });

  it("no markers on a finer timeframe that does NOT evenly divide", () => {
    // 45s native / 10s current: 45 % 10 === 5 → a fill can't be anchored to a bar.
    expect(backtestRenderFlags("SECOND_10", "SECOND_45")).toEqual({
      markerMode: "none",
      drawEquity: false,
    });
  });

  it("aggregate mode on a coarser timeframe", () => {
    // 5m backtest viewed on 1D: 86400 > 300 → aggregate per bar.
    expect(backtestRenderFlags("DAY", "MINUTE_5")).toEqual({
      markerMode: "aggregate",
      drawEquity: false,
    });
  });

  it("aggregate mode on a modestly coarser timeframe", () => {
    // 5m backtest viewed on 15m: 900 > 300, and 15m does not divide 5m.
    expect(backtestRenderFlags("MINUTE_15", "MINUTE_5")).toEqual({
      markerMode: "aggregate",
      drawEquity: false,
    });
  });

  it("no markers for an unknown resolution", () => {
    expect(backtestRenderFlags("BOGUS", "MINUTE_5")).toEqual({
      markerMode: "none",
      drawEquity: false,
    });
  });
});

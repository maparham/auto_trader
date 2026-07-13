import { describe, it, expect } from "vitest";
import { backtestRenderFlags, snapNearestBar } from "./backtest";

describe("backtestRenderFlags", () => {
  it("native mode + equity on the backtest's own timeframe", () => {
    expect(backtestRenderFlags("MINUTE_5", "MINUTE_5")).toEqual({
      markerMode: "native",
      drawEquity: true,
    });
  });

  it("native mode + equity on a finer, evenly-dividing timeframe", () => {
    // 5m backtest viewed on 1m: 300 % 60 === 0 → fills still land on bars.
    // Equity re-anchors to a native-granularity step curve.
    expect(backtestRenderFlags("MINUTE", "MINUTE_5")).toEqual({
      markerMode: "native",
      drawEquity: true,
    });
  });

  it("native mode + equity on a finer timeframe that does NOT evenly divide (fills snap to nearest bar)", () => {
    // 3m viewing a 5m run: 180 < 300 and 300 % 180 !== 0 → still per-fill arrows,
    // snapped to the nearest 3m bar rather than dropped.
    expect(backtestRenderFlags("MINUTE_3", "MINUTE_5")).toEqual({
      markerMode: "native",
      drawEquity: true,
    });
    // 45s native / 10s current: same story, no longer "none".
    expect(backtestRenderFlags("SECOND_10", "SECOND_45")).toEqual({
      markerMode: "native",
      drawEquity: true,
    });
  });

  it("3m aggregates a 1m run and shows native arrows for a 15m run", () => {
    // 1m run on 3m view: 180 > 60 → aggregate pills.
    expect(backtestRenderFlags("MINUTE_3", "MINUTE").markerMode).toBe("aggregate");
    // 15m run on 3m view: 900 % 180 === 0 → native arrows.
    expect(backtestRenderFlags("MINUTE_3", "MINUTE_15").markerMode).toBe("native");
  });

  it("aggregate markers + equity on a coarser timeframe", () => {
    // 5m backtest viewed on 1D: 86400 > 300 → aggregate per bar; equity
    // downsamples to each day's closing value.
    expect(backtestRenderFlags("DAY", "MINUTE_5")).toEqual({
      markerMode: "aggregate",
      drawEquity: true,
    });
  });

  it("aggregate markers + equity on a modestly coarser timeframe", () => {
    // 5m backtest viewed on 15m: 900 > 300, and 15m does not divide 5m.
    expect(backtestRenderFlags("MINUTE_15", "MINUTE_5")).toEqual({
      markerMode: "aggregate",
      drawEquity: true,
    });
  });

  it("no markers for an unknown resolution", () => {
    expect(backtestRenderFlags("BOGUS", "MINUTE_5")).toEqual({
      markerMode: "none",
      drawEquity: false,
    });
  });
});

describe("snapNearestBar", () => {
  // 3m bars at :00, :03, :06 (ms).
  const bars = [0, 180_000, 360_000];

  it("returns the input unchanged when it already lands on a bar", () => {
    expect(snapNearestBar(180_000, bars)).toBe(180_000);
  });

  it("snaps a between-bars fill to the nearer bar", () => {
    // A 5m fill at :05 (300s) sits between :03 and :06 — closer to :06.
    expect(snapNearestBar(300_000, bars)).toBe(360_000);
    // :04 is closer to :03.
    expect(snapNearestBar(240_000, bars)).toBe(180_000);
  });

  it("ties go to the earlier bar", () => {
    // :01:30 is equidistant from :00 and :03 → earlier.
    expect(snapNearestBar(90_000, bars)).toBe(0);
  });

  it("clamps outside the loaded range to the edge bars", () => {
    expect(snapNearestBar(-50_000, bars)).toBe(0);
    expect(snapNearestBar(999_000, bars)).toBe(360_000);
  });

  it("returns the input when there are no bars", () => {
    expect(snapNearestBar(123_000, [])).toBe(123_000);
  });
});

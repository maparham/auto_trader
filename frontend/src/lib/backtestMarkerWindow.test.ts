import { describe, it, expect } from "vitest";
import { fillWithinLoadedWindow } from "./backtest";

// A finer timeframe loads far less history than the backtest's own resolution,
// so a trade older than the loaded window can't be anchored to a real candle —
// snapNearestBar would clamp every such fill onto the edge bar, stacking them
// into one misleading pile. fillWithinLoadedWindow gates native markers so only
// in-window fills are drawn.
const BARS = [1000, 2000, 3000, 4000]; // ms, ascending

describe("fillWithinLoadedWindow", () => {
  it("accepts a fill inside the loaded window (inclusive of both edges)", () => {
    expect(fillWithinLoadedWindow(1000, BARS)).toBe(true); // first bar
    expect(fillWithinLoadedWindow(2500, BARS)).toBe(true); // between bars
    expect(fillWithinLoadedWindow(4000, BARS)).toBe(true); // last bar
  });

  it("rejects a fill older than the first loaded bar (the pile case)", () => {
    expect(fillWithinLoadedWindow(999, BARS)).toBe(false);
    expect(fillWithinLoadedWindow(0, BARS)).toBe(false);
  });

  it("rejects a fill newer than the last loaded bar", () => {
    expect(fillWithinLoadedWindow(4001, BARS)).toBe(false);
  });

  it("rejects everything when no bars are loaded", () => {
    expect(fillWithinLoadedWindow(2000, [])).toBe(false);
  });
});

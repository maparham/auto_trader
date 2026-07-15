// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { fillWithinLoadedWindow, oldestBacktestAnchorMs } from "./backtest";
import type { Marker } from "../api";

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

// The history-coverage page-back must load far enough back to draw not just the
// oldest FILL arrow but also its signal caret, which anchors one bar EARLIER at
// signal_time. Covering only the oldest fill leaves that caret's bar just outside
// the window, so the leftmost rule-based entry shows its arrow with no caret.
function mk(time: number, signal_time: number | null): Marker {
  return {
    time,
    side: "buy",
    price: 1,
    reason: "r",
    leg: "long",
    signal_time,
    terms: [],
    combine: "AND",
  } as Marker;
}

describe("oldestBacktestAnchorMs", () => {
  it("returns the oldest signal_time, not just the oldest fill time", () => {
    // Oldest fill is 5000, but its signal fired one bar earlier at 4900 — the
    // caret needs that bar loaded, so coverage must reach 4900 (ms).
    const markers = [mk(5000, 4900), mk(6000, 5900), mk(7000, null)];
    expect(oldestBacktestAnchorMs(markers)).toBe(4900 * 1000);
  });

  it("falls back to fill time when a marker has no signal_time (mechanical exit)", () => {
    const markers = [mk(8000, null), mk(9000, 8900)];
    // Oldest is the 8000 mechanical fill (no earlier signal); 8900 > 8000.
    expect(oldestBacktestAnchorMs(markers)).toBe(8000 * 1000);
  });

  it("returns null for no markers", () => {
    expect(oldestBacktestAnchorMs([])).toBe(null);
  });
});

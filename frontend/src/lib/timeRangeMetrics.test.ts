import { describe, it, expect } from "vitest";
import { timeRangeSpan, bandEdges, timeRangeReadout } from "./timeRangeMetrics";

const H = 3_600_000; // 1h in ms
const M15 = 15 * 60_000;

describe("timeRangeSpan", () => {
  it("single-candle click (null end) spans exactly one bar width", () => {
    expect(timeRangeSpan(1000, null, 4 * H)).toEqual({ from: 1000, to: 1000 + 4 * H });
  });

  it("click with end === start collapses to one candle", () => {
    expect(timeRangeSpan(1000, 1000, 4 * H)).toEqual({ from: 1000, to: 1000 + 4 * H });
  });

  it("drag right is inclusive of the bar under the cursor (to = later open + tf)", () => {
    // start at t=0 (a 15m bar), release two bars later; covers 3 bars.
    expect(timeRangeSpan(0, 2 * M15, M15)).toEqual({ from: 0, to: 3 * M15 });
  });

  it("drag left normalizes so from < to", () => {
    expect(timeRangeSpan(2 * M15, 0, M15)).toEqual({ from: 0, to: 3 * M15 });
  });
});

describe("bandEdges", () => {
  it("shifts both edges left by half a bar (encloses the clicked candle)", () => {
    // one 4H candle on 4H: center0 = 100, next candle center1 = 100 + barWidth(20).
    // Band should be [90, 110] = left edge of clicked to left edge of next.
    expect(bandEdges(100, 120, 20)).toEqual({ left: 90, right: 110 });
  });

  it("orders edges regardless of which coordinate is left", () => {
    expect(bandEdges(120, 100, 20)).toEqual({ left: 90, right: 110 });
  });
});

describe("timeRangeReadout", () => {
  it("4h span on 15m reads 16 bars", () => {
    expect(timeRangeReadout(0, 4 * H, M15)).toBe("4h · 16 bars");
  });

  it("single 4h candle reads 1 bar on its own TF", () => {
    expect(timeRangeReadout(0, 4 * H, 4 * H)).toBe("4h · 1 bar");
  });

  it("multi-day span humanizes to two units", () => {
    expect(timeRangeReadout(0, 3 * 24 * H + 2 * H, 24 * H)).toBe("3d 2h · 3 bars");
  });
});

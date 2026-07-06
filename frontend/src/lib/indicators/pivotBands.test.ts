import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// customIndicators reads LineType/IndicatorSeries at module load; stub klinecharts'
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { computePivotBands } = await import("./pivotBands");
const { isPivotAt } = await import("./pivots");

// Bars with independently controlled high/low. Defaults keep every other bar off
// the extremes: highs 90 (never a higher high), lows 80 (never a lower low).
function bars(highs: Record<number, number>, lows: Record<number, number>, n: number): KLineData[] {
  return Array.from({ length: n }, (_, i) => {
    const high = highs[i] ?? 90;
    const low = lows[i] ?? 80;
    return { timestamp: i, open: high, high, low, close: high, volume: 0 };
  });
}

describe("isPivotAt", () => {
  const vals = [5, 3, 9, 3, 5]; // bar 2 is a strict high, bar 1/3 are strict lows
  it("detects a strict high pivot with balanced window", () => {
    expect(isPivotAt(vals, 2, 1, 1, "high", true)).toBe(true);
    expect(isPivotAt(vals, 2, 1, 1, "low", true)).toBe(false);
  });
  it("rejects flat tops in strict mode but allows them non-strict", () => {
    const flat = [1, 5, 5, 1];
    expect(isPivotAt(flat, 1, 1, 1, "high", true)).toBe(false);
    expect(isPivotAt(flat, 1, 1, 1, "high", false)).toBe(true);
  });
  it("returns false near the array ends (no room to confirm)", () => {
    expect(isPivotAt(vals, 0, 1, 1, "high", true)).toBe(false);
    expect(isPivotAt(vals, 4, 1, 1, "high", true)).toBe(false);
  });
});

describe("computePivotBands", () => {
  const N = 2;

  it("steps to the pivot value only at confirmation (i+N), never before", () => {
    // Pivot high at bar 5 (=100); confirms at bar 7. Pivot low at bar 8 (=70);
    // confirms at bar 10.
    const data = bars({ 5: 100 }, { 8: 70 }, 12);
    const pts = computePivotBands(data, N, 3, { mode: "last" });

    // No-lookahead: nothing on the high line until bar 7.
    for (let i = 0; i <= 6; i++) expect(pts[i].pivotHigh).toBeUndefined();
    expect(pts[7].pivotHigh).toBe(100);
    expect(pts[11].pivotHigh).toBe(100); // carried forward

    // Low line: blank until confirmation at bar 10.
    for (let i = 0; i <= 9; i++) expect(pts[i].pivotLow).toBeUndefined();
    expect(pts[10].pivotLow).toBe(70);
  });

  it("last mode carries the single most recent pivot forward", () => {
    // Two high pivots: bar 5 (100 → confirm 7), bar 12 (110 → confirm 14).
    const data = bars({ 5: 100, 12: 110 }, {}, 18);
    const pts = computePivotBands(data, N, 3, { mode: "last" });
    expect(pts[13].pivotHigh).toBe(100); // still the first pivot
    expect(pts[14].pivotHigh).toBe(110); // steps to the newest
    expect(pts[17].pivotHigh).toBe(110);
  });

  it("avg mode holds the mean of the last K pivots, re-stepping on each new one", () => {
    const data = bars({ 5: 100, 12: 110 }, {}, 18);
    const pts = computePivotBands(data, N, 3, { mode: "avg" });
    expect(pts[7].pivotHigh).toBe(100); // only one pivot so far → its own value
    expect(pts[13].pivotHigh).toBe(100);
    expect(pts[14].pivotHigh).toBe(105); // mean(100, 110)
  });

  it("avg window K caps how many pivots are averaged", () => {
    // Three high pivots at 5(100), 9(120), 13(140); confirm at 7, 11, 15.
    const data = bars({ 5: 100, 9: 120, 13: 140 }, {}, 18);
    const k2 = computePivotBands(data, N, 2, { mode: "avg" });
    expect(k2[15].pivotHigh).toBe(130); // mean of last 2: (120+140)/2
    const k3 = computePivotBands(data, N, 3, { mode: "avg" });
    expect(k3[15].pivotHigh).toBe(120); // mean of all 3: (100+120+140)/3
  });

  it("leaves the trailing N bars flat (no confirmed pivot in the tail)", () => {
    const data = bars({ 5: 100 }, {}, 12);
    const pts = computePivotBands(data, N, 3, { mode: "last" });
    // A would-be pivot in the last N bars can never confirm within the series.
    expect(pts[11].pivotHigh).toBe(100); // unchanged from bar 7
  });
});

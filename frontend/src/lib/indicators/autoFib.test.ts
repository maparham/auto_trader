// frontend/src/lib/indicators/autoFib.test.ts
// Pins the causal pair detector: strict fractal pivots at their confirm bar,
// the latest high + latest low as one pair, dir by bar order, the outside-bar
// tie, and the optional ATR swing filter. Same fixtures as the backend suite
// (tests/test_auto_fib.py).
import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { KLineData } from "klinecharts";
import { autoFibSeries, computeAutoFibPairs } from "./autoFib";
import { autoFibFibConfig } from "./autoFibOutputs";

/** high = close + 1, low = close - 1, open = close. */
function bar(close: number, i: number, open = close): KLineData {
  return { timestamp: 1700000000000 + i * 3600_000, open, high: close + 1, low: close - 1, close, volume: 1 };
}

/** Repeated cycles trough(100) -> peak -> trough, 8 bars per cycle. */
function triangle(peaks: number[]): KLineData[] {
  const closes: number[] = [];
  for (const p of peaks) {
    const up = (p - 100) / 4;
    closes.push(100, 100 + up, 100 + 2 * up, 100 + 3 * up, p, 100 + 3 * up, 100 + 2 * up, 100 + up);
  }
  closes.push(100);
  return closes.map((c, i) => bar(c, i));
}

const CFG = { pivotLen: 2, minSwingAtr: 0 };

describe("computeAutoFibPairs", () => {
  it("forms the first pair only when both a high and a low have confirmed", () => {
    // Peaks at 4, 12, 20, 28; troughs at 8, 16, 24 (bar 0 has no left window).
    const { pairOf, pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), CFG);
    // High at 4 confirms at 6; low at 8 confirms at 10. Nothing before 10.
    expect(pairOf.slice(0, 10).every((p) => p === undefined)).toBe(true);
    // Pair index 0 is a real pair (Review Focus 1).
    expect(pairOf[10]).toBe(0);
    expect(pairs[0]).toEqual({ hiIdx: 4, hiPrice: 111, loIdx: 8, loPrice: 99, dir: -1, startIdx: 10, endIdx: 14 });
  });

  it("replaces the pair at each confirm bar and closes the old one there", () => {
    const { pairOf, pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), CFG);
    // High at 12 confirms at 14: new pair, the high is now later (up-leg).
    expect(pairs[1]).toMatchObject({ hiIdx: 12, loIdx: 8, dir: 1, startIdx: 14, endIdx: 18 });
    expect(pairOf[13]).toBe(0);
    expect(pairOf[14]).toBe(1);
    // The last pair is still current.
    expect(pairs[pairs.length - 1].endIdx).toBeNull();
  });

  it("breaks an outside-bar tie by the bar's own colour", () => {
    // Bar 2 is both a strict pivot high and a strict pivot low.
    const flat = (i: number) => bar(100, i);
    const up = [flat(0), flat(1), { ...bar(100, 2), high: 105, low: 95, open: 96, close: 104 }, flat(3), flat(4)];
    const down = [flat(0), flat(1), { ...bar(100, 2), high: 105, low: 95, open: 104, close: 96 }, flat(3), flat(4)];
    const a = computeAutoFibPairs(up, CFG);
    const b = computeAutoFibPairs(down, CFG);
    // One pair, pushed once even though both kinds changed on the same bar.
    expect(a.pairs).toHaveLength(1);
    expect(a.pairs[0].dir).toBe(1); // green: low first, high later
    expect(b.pairs[0].dir).toBe(-1);
    expect(a.pairOf[4]).toBe(0);
  });

  it("filters small swings and waits for ATR when minSwingAtr is on", () => {
    // ATR(14) is first defined at bar 13, so pivots at 4, 8, 12 are rejected.
    // The low at 16 measures against the RAW high turn at 12 and counts; the
    // high at 20 counts against the low at 16. First pair at 20 + 2 = 22.
    const { pairOf, pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), {
      pivotLen: 2,
      minSwingAtr: 0.01,
    });
    expect(pairOf[21]).toBeUndefined();
    expect(pairs[0]).toMatchObject({ hiIdx: 20, loIdx: 16, dir: 1, startIdx: 22 });
  });

  it("rejects everything when the filter is larger than any swing", () => {
    const { pairs } = computeAutoFibPairs(triangle([110, 110, 110, 110]), { pivotLen: 2, minSwingAtr: 100 });
    expect(pairs).toEqual([]);
  });
});

describe("autoFibSeries", () => {
  it("emits the active pair's high, low, dir and level prices", () => {
    const bars = triangle([110, 110, 110, 110]);
    const fib = autoFibFibConfig({});
    expect(autoFibSeries(bars, CFG, fib, "high")[10]).toBe(111);
    expect(autoFibSeries(bars, CFG, fib, "low")[10]).toBe(99);
    expect(autoFibSeries(bars, CFG, fib, "dir")[10]).toBe(-1);
    // dir -1: level 0 on the later anchor (the low), level 1 on the high.
    expect(autoFibSeries(bars, CFG, fib, "f0")[10]).toBe(99);
    expect(autoFibSeries(bars, CFG, fib, "f0_5")[10]).toBe(105);
    expect(autoFibSeries(bars, CFG, fib, "f0_5")[9]).toBeUndefined();
    // Not an output of this pane: all undefined.
    expect(autoFibSeries(bars, CFG, fib, "fm0_236").every((v) => v === undefined)).toBe(true);
  });
});

import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// customIndicators reads LineType/IndicatorSeries at module load; stub klinecharts'
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
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

  it("source 'close' detects BOTH lines on the close series, ignoring high/low", () => {
    // Flat highs (90) and lows (80) → the default "hl" would find no pivots. The
    // close series carries a strict peak (bar 5 = 100) and trough (bar 8 = 70).
    const closes: Record<number, number> = { 5: 100, 8: 70 };
    const data: KLineData[] = Array.from({ length: 12 }, (_, i) => ({
      timestamp: i,
      open: 90,
      high: 90,
      low: 80,
      close: closes[i] ?? 90,
      volume: 0,
    }));

    // Default hl: flat highs/lows → nothing on either line.
    const hl = computePivotBands(data, N, 3, { mode: "last" });
    expect(hl[11].pivotHigh).toBeUndefined();
    expect(hl[11].pivotLow).toBeUndefined();

    // Source close: swing high confirms at bar 7 (=100), swing low at bar 10 (=70).
    const close = computePivotBands(data, N, 3, { mode: "last", source: "close" });
    for (let i = 0; i <= 6; i++) expect(close[i].pivotHigh).toBeUndefined();
    expect(close[7].pivotHigh).toBe(100);
    expect(close[10].pivotLow).toBe(70);
  });

  it("leaves the trailing N bars flat (no confirmed pivot in the tail)", () => {
    const data = bars({ 5: 100 }, {}, 12);
    const pts = computePivotBands(data, N, 3, { mode: "last" });
    // A would-be pivot in the last N bars can never confirm within the series.
    expect(pts[11].pivotHigh).toBe(100); // unchanged from bar 7
  });
});

describe("computePivotBands MTF alignment", () => {
  // Chart bars every 1ms; a 4ms "higher timeframe" whose pivot values are supplied
  // directly on extendData.mtf. Only timestamps matter for alignment.
  function chartBars(n: number): KLineData[] {
    return Array.from({ length: n }, (_, i) => ({
      timestamp: i,
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      volume: 0,
    }));
  }

  const HTF_MS = 4;
  // Three HTF bars opening at t=0,4,8. htfHigh/htfLow are already carried-forward
  // step values (as computePivotBands would produce on the HTF): dense after the
  // first pivot, undefined before it.
  const mtf = {
    timeframe: "4m",
    htfStarts: [0, 4, 8],
    htfHigh: [undefined, 100, 110] as Array<number | undefined>,
    htfLow: [70, 70, 65] as Array<number | undefined>,
    htfMs: HTF_MS,
  };

  it("takes the most-recent CLOSED HTF bar for each chart bar (no lookahead)", () => {
    const pts = computePivotBands(chartBars(13), 2, 3, { mode: "last", mtf });

    // HTF bar 0 closes at t=4, bar 1 at t=8, bar 2 at t=12.
    // Chart bars 0..3 precede any HTF close → nothing usable yet.
    for (let i = 0; i <= 3; i++) {
      expect(pts[i].pivotHigh).toBeUndefined();
      expect(pts[i].pivotLow).toBeUndefined();
    }
    // At t=4 HTF bar 0 has closed: its high was still pre-first-pivot (undefined),
    // its low was 70.
    for (let i = 4; i <= 7; i++) {
      expect(pts[i].pivotHigh).toBeUndefined();
      expect(pts[i].pivotLow).toBe(70);
    }
    // At t=8 HTF bar 1 has closed → high 100, low 70.
    for (let i = 8; i <= 11; i++) {
      expect(pts[i].pivotHigh).toBe(100);
      expect(pts[i].pivotLow).toBe(70);
    }
    // At t=12 HTF bar 2 has closed → high 110, low 65.
    expect(pts[12].pivotHigh).toBe(110);
    expect(pts[12].pivotLow).toBe(65);
  });

  it("never lets a chart bar see an HTF bar that closes in its future", () => {
    const pts = computePivotBands(chartBars(12), 2, 3, { mode: "last", mtf });
    // Bar at t=11 must NOT yet see HTF bar 2 (closes at t=12).
    expect(pts[11].pivotHigh).toBe(100);
    expect(pts[11].pivotLow).toBe(70);
  });

  it("falls through to chart-timeframe calc when the MTF payload is incomplete", () => {
    // Missing htfLow → not a usable MTF payload; compute on the chart bars instead.
    const data = bars({ 5: 100 }, {}, 12);
    const pts = computePivotBands(data, 2, 3, {
      mode: "last",
      mtf: { timeframe: "4m", htfStarts: [0], htfHigh: [100], htfMs: 4 },
    });
    expect(pts[7].pivotHigh).toBe(100); // chart-TF confirmation at i+N
  });
});

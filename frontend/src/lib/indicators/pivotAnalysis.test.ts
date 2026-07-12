import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// The template reads LineType/IndicatorSeries at module load; stub klinecharts'
// runtime surface like the other indicator tests do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed", Dotted: "dotted" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { computePivotAnalysis, pivotDeltaLabelLines, pivotDeltaLabelRect, pivotDeltaHit } = await import(
  "./pivotAnalysis"
);

// Bars with independently controlled high/low. Defaults keep every other bar off
// the extremes: highs 90 (never a higher high), lows 80 (never a lower low).
function bars(highs: Record<number, number>, lows: Record<number, number>, n: number): KLineData[] {
  return Array.from({ length: n }, (_, i) => {
    const high = highs[i] ?? 90;
    const low = lows[i] ?? 80;
    return { timestamp: i, open: high, high, low, close: high, volume: 0 };
  });
}

const N = 2;

describe("computePivotAnalysis — forward-filled operand values", () => {
  it("steps the pivot-high / pivot-low levels only at confirmation (i+N), never before", () => {
    // High pivots: bar 5 (100 → confirm 7), bar 12 (110 → confirm 14).
    // Low pivot:  bar 8 (70 → confirm 10).
    const data = bars({ 5: 100, 12: 110 }, { 8: 70 }, 18);
    const pts = computePivotAnalysis(data, N);

    for (let i = 0; i <= 6; i++) expect(pts[i].pivotHigh).toBeUndefined();
    for (let i = 7; i <= 13; i++) expect(pts[i].pivotHigh).toBe(100);
    for (let i = 14; i <= 17; i++) expect(pts[i].pivotHigh).toBe(110);

    for (let i = 0; i <= 9; i++) expect(pts[i].pivotLow).toBeUndefined();
    for (let i = 10; i <= 17; i++) expect(pts[i].pivotLow).toBe(70);
  });

  it("Δ%/Δt reflect the most recent pivot's swing vs its prior SAME-type pivot", () => {
    const data = bars({ 5: 100, 12: 110 }, { 8: 70 }, 18);
    const pts = computePivotAnalysis(data, N);

    // The first high (bar 7) and the lone low (bar 10) have no prior same-type
    // pivot → no Δ until the SECOND high confirms at bar 14.
    for (let i = 0; i <= 13; i++) {
      expect(pts[i].deltaPct).toBeUndefined();
      expect(pts[i].deltaT).toBeUndefined();
    }
    // (110-100)/100*100 = 10; bars between the two highs = 12-5 = 7.
    for (let i = 14; i <= 17; i++) {
      expect(pts[i].deltaPct).toBeCloseTo(10, 10);
      expect(pts[i].deltaT).toBe(7);
    }
  });

  it("uses the prior SAME-type pivot for Δt, not an interleaving opposite pivot", () => {
    // A low (bar 8) sits between the two highs (bar 5, bar 12). The second high's
    // Δt must count back to bar 5 (7 bars), not to the low at bar 8 (4 bars).
    const data = bars({ 5: 100, 12: 110 }, { 8: 70 }, 18);
    const pts = computePivotAnalysis(data, N);
    expect(pts[14].deltaT).toBe(7);
  });

  it("tracks Δ across consecutive lows (negative Δ%)", () => {
    const data = bars({}, { 4: 70, 10: 60 }, 16);
    const pts = computePivotAnalysis(data, N);
    // Second low confirms at bar 12: (60-70)/70*100 ≈ -14.2857; Δt = 10-4 = 6.
    for (let i = 0; i <= 11; i++) expect(pts[i].deltaPct).toBeUndefined();
    expect(pts[12].deltaPct).toBeCloseTo(-14.285714, 5);
    expect(pts[12].deltaT).toBe(6);
  });
});

describe("computePivotAnalysis — swing-bar events (for drawing)", () => {
  it("places a high event at the swing bar with prior-pivot geometry", () => {
    const data = bars({ 5: 100, 12: 110 }, { 8: 70 }, 18);
    const pts = computePivotAnalysis(data, N);

    // First high: marker only, no connector (no prior high).
    expect(pts[5].phEvent).toBeDefined();
    expect(pts[5].phEvent!.price).toBe(100);
    expect(pts[5].phEvent!.prevPrice).toBeUndefined();
    expect(pts[5].phEvent!.prevIndex).toBeUndefined();
    expect(pts[5].phEvent!.deltaPct).toBeUndefined();

    // Second high: full connector back to bar 5.
    expect(pts[12].phEvent).toBeDefined();
    expect(pts[12].phEvent!.price).toBe(110);
    expect(pts[12].phEvent!.prevPrice).toBe(100);
    expect(pts[12].phEvent!.prevIndex).toBe(5);
    expect(pts[12].phEvent!.deltaPct).toBeCloseTo(10, 10);
    expect(pts[12].phEvent!.deltaT).toBe(7);
  });

  it("places a low event at the swing bar", () => {
    const data = bars({}, { 8: 70 }, 14);
    const pts = computePivotAnalysis(data, N);
    expect(pts[8].plEvent).toBeDefined();
    expect(pts[8].plEvent!.price).toBe(70);
    expect(pts[8].plEvent!.prevPrice).toBeUndefined();
  });

  it("leaves non-pivot bars without events", () => {
    const data = bars({ 5: 100 }, {}, 12);
    const pts = computePivotAnalysis(data, N);
    expect(pts[4].phEvent).toBeUndefined();
    expect(pts[6].phEvent).toBeUndefined();
    expect(pts[5].phEvent).toBeDefined(); // the swing bar itself
  });
});

describe("pivotDeltaLabelLines", () => {
  it("formats a positive Δ% with an up arrow", () => {
    expect(pivotDeltaLabelLines({ price: 110, prevPrice: 100, prevIndex: 5, deltaPct: 10, deltaT: 7 })).toEqual([
      "Δ% : 10.00 ▲",
      "Δt : 7",
    ]);
  });
  it("formats a negative Δ% with a down arrow", () => {
    expect(pivotDeltaLabelLines({ price: 90, prevPrice: 100, prevIndex: 5, deltaPct: -10, deltaT: 3 })).toEqual([
      "Δ% : -10.00 ▼",
      "Δt : 3",
    ]);
  });
  it("shows no arrow for a flat (zero) Δ%", () => {
    expect(pivotDeltaLabelLines({ price: 100, prevPrice: 100, prevIndex: 5, deltaPct: 0, deltaT: 2 })).toEqual([
      "Δ% : 0.00",
      "Δt : 2",
    ]);
  });
  it("returns null for a first-of-type pivot (no Δ)", () => {
    expect(pivotDeltaLabelLines({ price: 100 })).toBeNull();
  });
});

describe("pivotDeltaLabelRect — the enlarged plate geometry (shared painter/hit-test)", () => {
  // lineH 19, padX 5, padY 3, offX 4, gapY 2 → w = textW+10, h = 19*2+6 = 44,
  // rectX = markerX + offX - padX = markerX - 1.
  it("places a HIGH pivot's plate ABOVE the anchor", () => {
    // y = anchorY - h - gapY = 40 - 44 - 2 = -6
    expect(pivotDeltaLabelRect(100, 40, "high", 40)).toEqual({ x: 99, y: -6, w: 50, h: 44 });
  });
  it("places a LOW pivot's plate BELOW the anchor", () => {
    expect(pivotDeltaLabelRect(100, 60, "low", 40)).toEqual({ x: 99, y: 62, w: 50, h: 44 });
  });
});

describe("pivotDeltaHit — pointer over the marker or the Δ label plate (pixel hit-test)", () => {
  // A high pivot: marker at (100,50) price-level pixel, anchor y 40 (label above).
  const high = { markerX: 100, markerY: 50, anchorY: 40, side: "high" as const, textW: 40, radius: 6 };
  // A low pivot at the same x/marker, anchor y 60 (label below).
  const low = { markerX: 100, markerY: 50, anchorY: 60, side: "low" as const, textW: 40, radius: 6 };

  it("hits when the pointer is inside a HIGH pivot's label rect", () => {
    expect(pivotDeltaHit({ x: 120, y: 20 }, high).hit).toBe(true);
  });
  it("hits when the pointer is inside a LOW pivot's label rect (anchor asymmetry)", () => {
    expect(pivotDeltaHit({ x: 120, y: 80 }, low).hit).toBe(true);
    // The SAME point is NOT over the high pivot's rect (which sits above its anchor).
    expect(pivotDeltaHit({ x: 120, y: 80 }, high).hit).toBe(false);
  });
  it("hits over the marker dot even when off the label", () => {
    expect(pivotDeltaHit({ x: 100, y: 50 }, high).hit).toBe(true);
  });
  it("MISSES near the bar but off both the marker and the label (the loose behavior killed)", () => {
    expect(pivotDeltaHit({ x: 100, y: 100 }, high).hit).toBe(false);
  });
  it("reports distance to the marker for nearest-pick", () => {
    expect(pivotDeltaHit({ x: 103, y: 54 }, high).dist).toBeCloseTo(5, 10);
  });
});

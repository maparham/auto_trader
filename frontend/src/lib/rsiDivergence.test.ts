import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// customIndicators.ts reads LineType at module load (AVWAP line style table);
// stub klinecharts' runtime surface like overlays.test.ts / backtestSeries.test.ts do.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { detectDivergences, RSI_DIVERGENCE_DEFAULTS, divVisual } = await import("./customIndicators");

// Minimal bars: only .high / .low matter to detection. Highs default to 90
// (never a "higher high"); the three peaks that matter are overridden.
function bars(highs: Record<number, number>, n: number): KLineData[] {
  return Array.from({ length: n }, (_, i) => {
    const h = highs[i] ?? 90;
    return { timestamp: i, open: h, high: h, low: h - 5, close: h, volume: 0 };
  });
}
// detectDivergences writes onto out[i].divs; a bare [] of empty objects suffices.
function outFor(n: number) {
  return Array.from({ length: n }, () => ({}) as { divs?: Array<{ kind: string; forming?: boolean; toIndex: number }> });
}
// Small pivot params keep the crafted series short.
const CFG = {
  ...RSI_DIVERGENCE_DEFAULTS,
  on: true,
  lookbackLeft: 2,
  lookbackRight: 3,
  rangeMin: 2,
  rangeMax: 60,
  formingLookbackRight: 1,
};
// RSI with high peaks at 5 (60), 12 (55, lower high), 16 (52, lower high).
const RSI18 = [40, 41, 42, 43, 45, 60, 45, 44, 43, 44, 46, 50, 55, 50, 48, 49, 52, 48];
const HIGHS = { 5: 100, 12: 105, 16: 108 }; // rising highs -> bearish divergence

// Bars with independent high AND low control (low pivots read .low, high read .high).
function barsHL(n: number, highs: Record<number, number>, lows: Record<number, number>): KLineData[] {
  return Array.from({ length: n }, (_, i) => {
    const h = highs[i] ?? 90;
    const l = lows[i] ?? 10;
    return { timestamp: i, open: h, high: h, low: l, close: h, volume: 0 };
  });
}
function kindAt(out: ReturnType<typeof outFor>, idx: number, kind: string) {
  return (out[idx].divs ?? []).filter((s) => s.kind === kind);
}
function bearsAt(out: ReturnType<typeof outFor>, idx: number) {
  return kindAt(out, idx, "bearish");
}

describe("detectDivergences forming pass", () => {
  it("detects a confirmed bearish divergence and no forming when showForming is off", () => {
    const data = bars(HIGHS, 18);
    const out = outFor(18);
    detectDivergences(data, RSI18, out as never, { ...CFG, showForming: false });
    // Confirmed bearish at the confirmed pivot index 12, not forming.
    expect(bearsAt(out, 12).length).toBe(1);
    expect(bearsAt(out, 12)[0].forming).toBeFalsy();
    // Index 16 is in the unconfirmable tail -> no segment without forming.
    expect(bearsAt(out, 16).length).toBe(0);
  });

  it("adds a forming bearish divergence at the latest tail pivot when showForming is on", () => {
    const data = bars(HIGHS, 18);
    const out = outFor(18);
    detectDivergences(data, RSI18, out as never, { ...CFG, showForming: true });
    expect(bearsAt(out, 16).length).toBe(1);
    expect(bearsAt(out, 16)[0].forming).toBe(true);
  });

  it("promotes a forming divergence to confirmed once enough bars follow it", () => {
    const rsi = [...RSI18, 47, 46, 45]; // n=21: index 16 now has 3 bars to its right
    const data = bars(HIGHS, 21);
    const out = outFor(21);
    detectDivergences(data, rsi, out as never, { ...CFG, showForming: true });
    expect(bearsAt(out, 16).length).toBe(1);
    expect(bearsAt(out, 16)[0].forming).toBeFalsy();
  });
});

describe("detectDivergences forming — other kinds & guards", () => {
  // RSI low troughs at 5 (20), 12 (25, higher low), 16 (28, higher low).
  const RSI_LOWS = [50, 49, 48, 47, 45, 20, 45, 46, 47, 46, 44, 30, 25, 30, 32, 31, 28, 33];
  const LOWS = { 5: 100, 12: 95, 16: 92 }; // falling lows -> bullish divergence

  it("adds a forming BULLISH divergence at the latest tail low pivot", () => {
    const data = barsHL(18, {}, LOWS);
    const out = outFor(18);
    detectDivergences(data, RSI_LOWS, out as never, { ...CFG, showForming: true });
    expect(kindAt(out, 12, "bullish")[0]?.forming).toBeFalsy(); // confirmed baseline
    expect(kindAt(out, 16, "bullish").length).toBe(1);
    expect(kindAt(out, 16, "bullish")[0].forming).toBe(true);
  });

  // RSI high peaks at 5 (55), 12 (58), 16 (60, HIGHER high) -> hidden bearish at 16.
  const RSI_HH = [40, 41, 42, 43, 50, 55, 50, 44, 43, 44, 46, 52, 58, 52, 50, 51, 60, 50];
  const HH = { 5: 110, 12: 105, 16: 100 }; // falling highs + rising RSI -> hidden bearish

  it("adds a forming HIDDEN BEARISH divergence when enabled", () => {
    const data = barsHL(18, HH, {});
    const out = outFor(18);
    detectDivergences(data, RSI_HH, out as never, {
      ...CFG,
      showForming: true,
      bearish: false,
      hiddenBearish: true,
    });
    expect(kindAt(out, 16, "hiddenBearish").length).toBe(1);
    expect(kindAt(out, 16, "hiddenBearish")[0].forming).toBe(true);
  });

  it("emits no forming segment when there is no confirmed pivot to compare against", () => {
    // Monotonic rise then a single tail peak at 16: no confirmed high pivot exists,
    // so the forming pass has no baseline and must emit nothing.
    const rsi = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 60, 54];
    const data = barsHL(18, { 16: 200 }, {});
    const out = outFor(18);
    detectDivergences(data, rsi, out as never, { ...CFG, showForming: true });
    expect(out[16].divs ?? []).toHaveLength(0);
  });
});

describe("detectDivergences forming — scan-back option", () => {
  // Two tail high pivots: newest (18) is NOT divergent, older (16) IS. lbL=1, lbR=4,
  // fbR=1, so tail = last 4 bars and both 16 & 18 are forming pivots ("W": 16 high,
  // 17 low, 18 high). Confirmed baseline high at index 8 (rsi 60, price 100).
  const CFG2 = { ...RSI_DIVERGENCE_DEFAULTS, on: true, lookbackLeft: 1, lookbackRight: 4, rangeMin: 2, rangeMax: 60, formingLookbackRight: 1, showForming: true };
  const RSI_W = [40, 41, 42, 43, 44, 45, 46, 50, 60, 50, 46, 45, 44, 45, 46, 48, 55, 45, 50, 44];
  const HIGHS_W = { 8: 100, 16: 105, 18: 95 }; // 16 higher-high vs 8 (bearish); 18 lower-high (not)

  it("shows nothing when the latest tail swing isn't diverging (scanBack off)", () => {
    const out = outFor(20);
    detectDivergences(barsHL(20, HIGHS_W, {}), RSI_W, out as never, { ...CFG2, formingScanBack: false });
    expect(kindAt(out, 18, "bearish").length).toBe(0);
    expect(kindAt(out, 16, "bearish").length).toBe(0);
  });

  it("finds the older diverging tail swing when scanBack is on", () => {
    const out = outFor(20);
    detectDivergences(barsHL(20, HIGHS_W, {}), RSI_W, out as never, { ...CFG2, formingScanBack: true });
    expect(kindAt(out, 16, "bearish").length).toBe(1);
    expect(kindAt(out, 16, "bearish")[0].forming).toBe(true);
  });
});

describe("divVisual", () => {
  it("renders confirmed regular divergences solid at full opacity", () => {
    expect(divVisual({ kind: "bearish" })).toEqual({ label: "Bear", dash: [], alpha: 1 });
  });
  it("renders confirmed hidden divergences dashed", () => {
    expect(divVisual({ kind: "hiddenBearish" })).toEqual({ label: "H Bear", dash: [4, 3], alpha: 1 });
  });
  it("renders forming divergences dotted, faded, with a ? label", () => {
    expect(divVisual({ kind: "bearish", forming: true })).toEqual({ label: "Bear?", dash: [2, 3], alpha: 0.55 });
  });
});

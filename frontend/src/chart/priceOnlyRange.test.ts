import { describe, it, expect } from "vitest";
import { priceOnlyCreateRange } from "./priceOnlyRange";

const bars = [
  { timestamp: 1, open: 10, high: 12, low: 9, close: 11 },
  { timestamp: 2, open: 11, high: 15, low: 10, close: 14 },
];
const chart = {
  getDataList: () => bars,
  getVisibleRange: () => ({ from: 0, to: 2, realFrom: 0, realTo: 2 }),
} as any;
const defaultRange = {
  from: 0,
  to: 100,
  realFrom: 0,
  realTo: 100,
  range: 100,
  realRange: 100,
  displayFrom: 0,
  displayTo: 100,
  displayRange: 100,
};

describe("priceOnlyCreateRange", () => {
  it("spans visible candle low..high with no manual gap (framework gaps once)", () => {
    const r = priceOnlyCreateRange({ chart, paneId: "candle_pane", defaultRange } as any);
    // Raw candle extremes, NOT pre-gapped: the framework applies the pane's
    // 0.2/0.1 gap AFTER this callback, so pre-gapping here would double it.
    expect(r.from).toBeLessThanOrEqual(9);
    expect(r.to).toBeGreaterThanOrEqual(15);
    expect(r.to).toBeLessThan(100); // ignored the inflated default (indicator) range
    // realFrom/realTo are what the framework actually reads; on a normal axis
    // they equal the linear extremes (identity transform).
    expect(r.realFrom).toBeCloseTo(9, 6);
    expect(r.realTo).toBeCloseTo(15, 6);
  });

  it("falls back to defaultRange when no visible candles", () => {
    const empty = { ...chart, getDataList: () => [] };
    const r = priceOnlyCreateRange({ chart: empty, paneId: "candle_pane", defaultRange } as any);
    expect(r).toEqual(defaultRange);
  });

  it("emits log-space realFrom/realTo when the candle axis is logarithmic", () => {
    // A log axis lives in log space: realValueToDisplayValue is 10^x, so the
    // realFrom/realTo we return must be log10(price), not the linear price, or
    // the axis renders garbage. We delegate to the axis's own valueToRealValue
    // rather than reimplement log10.
    const logChart = {
      ...chart,
      getYAxes: () => [{ valueToRealValue: (v: number) => Math.log10(v) }],
    } as any;
    const r = priceOnlyCreateRange({ chart: logChart, paneId: "candle_pane", defaultRange } as any);
    expect(r.realFrom).toBeCloseTo(Math.log10(9), 6);
    expect(r.realTo).toBeCloseTo(Math.log10(15), 6);
  });
});

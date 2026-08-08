import { describe, it, expect, vi } from "vitest";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

import type { Indicator, KLineData } from "klinecharts";
import { ATR_TEMPLATE } from "./atr";
import { atrSeries } from "../atr";

function candles(n: number): KLineData[] {
  const out: KLineData[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = open + (i % 3 === 0 ? 1 : -0.5);
    out.push({
      timestamp: i * 3600_000, open, close,
      high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.25, volume: 1,
    });
  }
  return out;
}

const fakeInd = (calcParams: unknown[], extendData?: unknown) =>
  ({ calcParams, extendData }) as unknown as Indicator;

describe("ATR_TEMPLATE", () => {
  it("is a sub-pane single-line template with TV defaults", () => {
    expect(ATR_TEMPLATE.series).toBe("normal");
    expect(ATR_TEMPLATE.calcParams).toEqual([14]);
    expect(ATR_TEMPLATE.figures?.map((f) => f.key)).toEqual(["atr", "atrPct"]);
    // atrPct is a legend-only readout: no `type`, so klinecharts plots nothing.
    expect(ATR_TEMPLATE.figures?.find((f) => f.key === "atrPct")?.type).toBeUndefined();
  });
  it("computes ATR% against the chosen price source", () => {
    const data = candles(40);
    const calc = ATR_TEMPLATE.calc as (
      d: KLineData[],
      i: Indicator,
    ) => Array<{ atr?: number; atrPct?: number }>;
    const byClose = calc(data, fakeInd([14], {}));
    const byHigh = calc(data, fakeInd([14], { pctSource: "high" }));
    const series = atrSeries(data, 14);
    for (let i = 0; i < data.length; i++) {
      const v = series[i];
      if (v == null) {
        expect(byClose[i].atrPct).toBeUndefined();
        continue;
      }
      expect(byClose[i].atrPct).toBeCloseTo((v / data[i].close) * 100, 10);
      expect(byHigh[i].atrPct).toBeCloseTo((v / data[i].high) * 100, 10);
    }
    // Garbage source falls back to close.
    const junk = calc(data, fakeInd([14], { pctSource: "median" }));
    expect(junk.map((p) => p.atrPct)).toEqual(byClose.map((p) => p.atrPct));
  });
  it("calc maps atrSeries under the pane's settings", () => {
    const data = candles(40);
    const calc = ATR_TEMPLATE.calc as (d: KLineData[], i: Indicator) => Array<{ atr?: number }>;
    const rma = calc(data, fakeInd([14], {}));
    expect(rma.map((p) => p.atr ?? null)).toEqual(atrSeries(data, 14));
    const ema = calc(data, fakeInd([10], { smoothing: "ema" }));
    expect(ema.map((p) => p.atr ?? null)).toEqual(atrSeries(data, 10, "ema"));
    // Garbage settings fall back to length 14 / RMA rather than crashing.
    const junk = calc(data, fakeInd(["x"], { smoothing: "vwma" }));
    expect(junk.map((p) => p.atr ?? null)).toEqual(atrSeries(data, 14));
  });
});

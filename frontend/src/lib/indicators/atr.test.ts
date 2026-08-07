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
    expect(ATR_TEMPLATE.figures?.map((f) => f.key)).toEqual(["atr"]);
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

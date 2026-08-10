import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import { atrSeries, trueRangeSeries, atrLength, atrOutputs, atrWarmup, normalizeAtrSmoothing } from "./atr";

function bars(rows: Array<[number, number, number]>): KLineData[] {
  // [high, low, close]; open unused by ATR
  return rows.map(([high, low, close], i) => ({
    timestamp: i * 60_000, open: close, high, low, close, volume: 0,
  }));
}

describe("atrSeries", () => {
  it("is null until `length` true ranges exist, then Wilder-smooths", () => {
    // Constant $2 range each bar => every warm ATR is exactly 2.
    const data = bars([
      [12, 10, 11], [13, 11, 12], [14, 12, 13], [15, 13, 14], [16, 14, 15],
    ]);
    const out = atrSeries(data, 3);
    expect(out[0]).toBeNull(); // bar 0 seeds TR but ATR needs `length` TRs
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2, 6); // first ATR = mean of first 3 TRs
    expect(out[3]).toBeCloseTo(2, 6); // Wilder: (2*2 + 2)/3 = 2
    expect(out[4]).toBeCloseTo(2, 6);
  });

  it("true range includes gaps vs the previous close", () => {
    // Bar 1 gaps up: prevClose=11, high=30, low=25 => TR = 30-11 = 19.
    const data = bars([[12, 10, 11], [30, 25, 28]]);
    const out = atrSeries(data, 1); // length 1 => ATR == TR each bar
    expect(out[0]).toBeCloseTo(2, 6); // first bar TR = high-low = 2
    expect(out[1]).toBeCloseTo(19, 6);
  });
});

// TRs: [1, 1.5, 1.5, 1.5] — bar0 h-l; later bars dominated by |h-pc| / |l-pc|.
function candles4(): KLineData[] {
  const mk = (high: number, low: number, close: number, i: number): KLineData =>
    ({ timestamp: i * 3600_000, open: close, high, low, close, volume: 1 });
  return [mk(2, 1, 1.5, 0), mk(3, 2, 2.5, 1), mk(4, 3, 3.5, 2), mk(3, 2, 2.5, 3)];
}

describe("atr smoothing", () => {
  it("computes true range with TR[0] = high-low", () => {
    expect(trueRangeSeries(candles4())).toEqual([1, 1.5, 1.5, 1.5]);
  });
  it("rma (default) is byte-identical to the legacy 2-arg call", () => {
    expect(atrSeries(candles4(), 2, "rma")).toEqual(atrSeries(candles4(), 2));
    // seed = (1+1.5)/2 = 1.25; then (1.25*1+1.5)/2 = 1.375; then 1.4375
    expect(atrSeries(candles4(), 2)).toEqual([null, 1.25, 1.375, 1.4375]);
  });
  it("sma is the trailing window mean of TR", () => {
    expect(atrSeries(candles4(), 2, "sma")).toEqual([null, 1.25, 1.5, 1.5]);
  });
  it("ema seeds with the SMA of the first `length` TRs (Pine ta.ema)", () => {
    const out = atrSeries(candles4(), 2, "ema");
    expect(out[0]).toBeNull();
    expect(out[1]).toBe(1.25); // SMA seed
    expect(out[2]).toBeCloseTo((2 / 3) * 1.5 + (1 / 3) * 1.25, 12);
    expect(out[3]).toBeCloseTo((2 / 3) * 1.5 + (1 / 3) * ((2 / 3) * 1.5 + (1 / 3) * 1.25), 12);
  });
  it("wma weights the window length..1, most recent highest", () => {
    // idx1: (1.5*2 + 1*1)/3; idx2..3: window is all 1.5
    const out = atrSeries(candles4(), 2, "wma");
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(4 / 3, 12);
    expect(out[2]).toBe(1.5);
    expect(out[3]).toBe(1.5);
  });
  it("ref helpers: length parse, output naming, warmup", () => {
    expect(atrLength([14])).toBe(14);
    expect(atrLength(undefined)).toBe(14);
    expect(atrLength(["garbage"])).toBe(14);
    expect(atrLength([5.7])).toBe(5); // truncated like Python int()
    expect(atrOutputs([21])).toEqual(["21", "21.to%"]);
    expect(atrWarmup([21], "21")).toBe(21);
    expect(atrWarmup([21], "21.to%")).toBe(21);
    expect(atrWarmup([21], "bogus")).toBe(0);
    expect(normalizeAtrSmoothing("ema")).toBe("ema");
    expect(normalizeAtrSmoothing("vwma")).toBe("rma"); // not an ATR option
    expect(normalizeAtrSmoothing(undefined)).toBe("rma");
  });
});

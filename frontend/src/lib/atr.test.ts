import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import { atrSeries } from "./atr";

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

import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";

import { foldFormingBar, formingOpenMs } from "./mtfForming";

const H = 3_600_000;

const bar = (
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
): KLineData => ({ timestamp, open, high, low, close, volume: 0 });

describe("formingOpenMs", () => {
  it("derives the next bucket open from the last closed start + htfMs", () => {
    expect(formingOpenMs([0, 24 * H], 24 * H)).toBe(48 * H);
  });

  it("prefers the fetched partial bar's own timestamp (calendar buckets)", () => {
    // A month bucket whose true open is NOT lastStart + nominal width.
    const fetched = bar(61 * 24 * H, 1, 1, 1, 1);
    expect(formingOpenMs([0, 31 * 24 * H], 30 * 24 * H, fetched)).toBe(
      61 * 24 * H,
    );
  });

  it("returns null with no closed bars and no fetched partial", () => {
    expect(formingOpenMs([], 24 * H)).toBeNull();
  });
});

describe("foldFormingBar", () => {
  const open = 48 * H; // forming daily bucket
  const chart = [
    bar(46 * H, 9, 9.5, 8.5, 9.2), // before the bucket: excluded
    bar(48 * H, 10, 11, 9, 10.5),
    bar(49 * H, 10.5, 12, 10, 11),
    bar(50 * H, 11, 11.5, 8, 8.5),
  ];

  it("folds chart candles at/after the bucket open into one synthetic bar", () => {
    const b = foldFormingBar(chart, open, 24 * H);
    expect(b).toEqual(bar(open, 10, 12, 8, 8.5));
  });

  it("merges a fetched partial-bar seed (open wins, extremes union)", () => {
    const seed = bar(open, 9.8, 12.5, 9.7, 10);
    const b = foldFormingBar(chart, open, 24 * H, seed);
    expect(b).toEqual(bar(open, 9.8, 12.5, 8, 8.5));
  });

  it("returns the seed alone when no chart candle is inside the bucket yet", () => {
    const seed = bar(open, 9.8, 12.5, 9.7, 10);
    expect(foldFormingBar(chart.slice(0, 1), open, 24 * H, seed)).toEqual(seed);
  });

  it("returns null with neither seed nor in-bucket candles", () => {
    expect(foldFormingBar(chart.slice(0, 1), open, 24 * H)).toBeNull();
  });

  it("clamps to the replay cursor", () => {
    const b = foldFormingBar(chart, open, 24 * H, undefined, 49 * H);
    // 50h candle excluded: cursor sits at 49h.
    expect(b).toEqual(bar(open, 10, 12, 9, 11));
  });

  it("ignores chart candles at/after the bucket close (next bucket started)", () => {
    const withNext = [...chart, bar(72 * H, 20, 21, 19, 20.5)];
    const b = foldFormingBar(withNext, open, 24 * H);
    expect(b).toEqual(bar(open, 10, 12, 8, 8.5));
  });
});

describe("custom intraday buckets reset at 00:00 UTC (short last bar of the day)", () => {
  // 5H buckets open at 00, 05, 10, 15, 20 UTC; the 20:00 bucket ends at midnight.
  const DAY = 24 * H;
  const d20 = 10 * DAY + 20 * H;
  const midnight = 11 * DAY;

  it("formingOpenMs derives the next open from the grammar, not lastStart + htfMs", () => {
    expect(formingOpenMs([10 * DAY + 15 * H, d20], 5 * H, undefined, "HOUR_5")).toBe(midnight);
    // Without a timeframe the nominal width still stands (unchanged behavior).
    expect(formingOpenMs([d20], 5 * H)).toBe(d20 + 5 * H);
  });

  it("foldFormingBar closes the 20:00 bucket at midnight, excluding the new day's bars", () => {
    const chart = [
      bar(d20, 10, 11, 9, 10.5),
      bar(d20 + 3 * H, 10.5, 12, 10, 11),
      bar(midnight, 50, 60, 40, 55), // next day's 00:00 bucket: excluded
    ];
    const b = foldFormingBar(chart, d20, 5 * H, undefined, undefined, "HOUR_5");
    expect(b).toEqual(bar(d20, 10, 12, 9, 11));
  });
});

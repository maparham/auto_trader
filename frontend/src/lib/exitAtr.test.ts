import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import {
  atrFetchBars,
  atrMultiple,
  chartBarsUsable,
  latestAtr,
  levelFromAtr,
  normalizeAtrLength,
} from "./exitAtr";

describe("levelFromAtr / atrMultiple", () => {
  it("puts a long TP above and a long SL below the entry", () => {
    expect(levelFromAtr(100, 1.5, 2, true, 2)).toBe(103);
    expect(levelFromAtr(100, 1.5, 2, false, 2)).toBe(97);
  });

  it("rounds to the instrument precision", () => {
    expect(levelFromAtr(1.1, 1, 0.00123456, true, 5)).toBe(1.10123);
  });

  it("round-trips a level back to its multiple", () => {
    const lvl = levelFromAtr(370.47, 2, 4.2, true, 2);
    expect(atrMultiple(lvl, 370.47, 4.2, true)).toBeCloseTo(2, 2);
  });

  it("reads negative when the level sits on the wrong side", () => {
    expect(atrMultiple(98, 100, 2, true)).toBe(-1);
    expect(atrMultiple(98, 100, 2, false)).toBe(1);
  });
});

describe("normalizeAtrLength", () => {
  it("defaults junk to 14 and clamps", () => {
    expect(normalizeAtrLength(undefined)).toBe(14);
    expect(normalizeAtrLength("abc")).toBe(14);
    expect(normalizeAtrLength(0)).toBe(14);
    expect(normalizeAtrLength(7.9)).toBe(7);
    expect(normalizeAtrLength(9999)).toBe(500);
  });
});

describe("atrFetchBars", () => {
  it("fetches ten lengths with a 500 floor and the 1000 cap", () => {
    expect(atrFetchBars(14)).toBe(500);
    expect(atrFetchBars(50)).toBe(500);
    expect(atrFetchBars(200)).toBe(1000);
  });
});

describe("latestAtr", () => {
  const bar = (i: number, h: number, l: number, c: number): KLineData => ({
    timestamp: i * 60_000, open: c, high: h, low: l, close: c,
  });

  it("is the last ATR value once warmed up", () => {
    const candles = Array.from({ length: 20 }, (_, i) => bar(i, 12, 10, 11));
    expect(latestAtr(candles, 14)).toBeCloseTo(2, 6);
  });

  it("is null with fewer bars than the length", () => {
    const candles = Array.from({ length: 5 }, (_, i) => bar(i, 12, 10, 11));
    expect(latestAtr(candles, 14)).toBeNull();
  });
});

describe("chartBarsUsable", () => {
  const HOUR = 3_600_000;
  const now = 1_790_000_000_000;
  const series = (n: number, stepMs: number, lastMs: number, close = 100): KLineData[] =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: lastMs - (n - 1 - i) * stepMs, open: close, high: close + 1, low: close - 1, close,
    }));
  const opts = { epic: "US100", resolution: "HOUR", length: 14, nowMs: now, livePrice: 100 };

  it("accepts the live series of this epic and timeframe", () => {
    expect(chartBarsUsable({ ticker: "US100", bars: series(100, HOUR, now - HOUR) }, opts)).toBe(true);
  });

  it("rejects another instrument's ticker", () => {
    expect(chartBarsUsable({ ticker: "EURUSD", bars: series(100, HOUR, now) }, opts)).toBe(false);
  });

  it("rejects bars of another timeframe still loaded after a switch", () => {
    expect(chartBarsUsable({ ticker: "US100", bars: series(100, 60_000, now) }, opts)).toBe(false);
  });

  it("rejects a historical window (Go-to-date far in the past)", () => {
    const old = now - 400 * 86_400_000;
    expect(chartBarsUsable({ ticker: "US100", bars: series(100, HOUR, old) }, opts)).toBe(false);
  });

  it("rejects the previous symbol's bars once the new ticker is declared", () => {
    const bars = series(100, HOUR, now, 20_000);
    expect(chartBarsUsable({ ticker: "US100", bars }, opts)).toBe(false);
  });

  it("rejects too few bars for the length", () => {
    expect(chartBarsUsable({ ticker: "US100", bars: series(10, HOUR, now) }, opts)).toBe(false);
  });
});

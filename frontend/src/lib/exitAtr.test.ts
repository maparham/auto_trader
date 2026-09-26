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

  it("keeps a nonzero multiple at least one tick from the reference", () => {
    expect(levelFromAtr(20_000, 1, 0.4, true, 0)).toBe(20_001);
    expect(levelFromAtr(20_000, 1, 0.4, false, 0)).toBe(19_999);
    expect(levelFromAtr(20_000, 0, 0.4, true, 0)).toBe(20_000);
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
  const bars = Array.from({ length: 100 }, (_, i) => ({
    timestamp: i * 3_600_000, open: 100, high: 101, low: 99, close: 100,
  }));
  const opts = { epic: "US100", resolution: "HOUR", length: 14 };
  const live = { epic: "US100", resolution: "HOUR", live: true };

  it("accepts bars stamped as this epic's live series on this timeframe", () => {
    expect(chartBarsUsable({ stamp: live, bars }, opts)).toBe(true);
  });

  it("rejects bars while a load is in flight (no stamp)", () => {
    expect(chartBarsUsable({ stamp: undefined, bars }, opts)).toBe(false);
  });

  it("rejects another epic or timeframe", () => {
    expect(chartBarsUsable({ stamp: { ...live, epic: "EURUSD" }, bars }, opts)).toBe(false);
    expect(chartBarsUsable({ stamp: { ...live, resolution: "MINUTE" }, bars }, opts)).toBe(false);
  });

  it("rejects a replay slice or detached Go-to-date window", () => {
    expect(chartBarsUsable({ stamp: { ...live, live: false }, bars }, opts)).toBe(false);
  });

  it("rejects too few bars for the length", () => {
    expect(chartBarsUsable({ stamp: live, bars: bars.slice(0, 10) }, opts)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { equityForBars } from "./backtest";

// Bars are identified only by their `timestamp` (ms, bar open). Points are
// ascending [timestampMs, value] pairs — the native-bar equity series.
const bar = (t: number) => ({ timestamp: t });

describe("equityForBars", () => {
  it("reproduces an exact per-bar match on the native timeframe", () => {
    const points: [number, number][] = [
      [0, 100],
      [60_000, 110],
      [120_000, 105],
    ];
    const bars = [bar(0), bar(60_000), bar(120_000)];
    expect(equityForBars(bars, points)).toEqual([{ equity: 100 }, { equity: 110 }, { equity: 105 }]);
  });

  it("downsamples to bar-close on a coarser timeframe", () => {
    // Native = 1m points; view = 3m bars. Each 3m bar closes on its last minute.
    const points: [number, number][] = [
      [0, 100],
      [60_000, 101],
      [120_000, 102], // close of first 3m bar
      [180_000, 103],
      [240_000, 104],
      [300_000, 105], // close of second 3m bar
    ];
    const bars = [bar(0), bar(180_000)];
    expect(equityForBars(bars, points)).toEqual([{ equity: 102 }, { equity: 105 }]);
  });

  it("steps at native granularity on a finer timeframe", () => {
    // Native = 3m points; view = 1m bars. Value carries forward between points.
    const points: [number, number][] = [
      [0, 100],
      [180_000, 103],
    ];
    const bars = [bar(0), bar(60_000), bar(120_000), bar(180_000)];
    expect(equityForBars(bars, points)).toEqual([
      { equity: 100 },
      { equity: 100 },
      { equity: 100 },
      { equity: 103 },
    ]);
  });

  it("leaves bars before the first point blank", () => {
    const points: [number, number][] = [[120_000, 100]];
    const bars = [bar(0), bar(60_000), bar(120_000)];
    expect(equityForBars(bars, points)).toEqual([{}, {}, { equity: 100 }]);
  });

  it("does not extend a flat line past the last point", () => {
    // Coarser view whose final bars sit entirely after the backtest ended.
    const points: [number, number][] = [
      [0, 100],
      [60_000, 110],
    ];
    const bars = [bar(0), bar(120_000), bar(240_000)];
    expect(equityForBars(bars, points)).toEqual([{ equity: 110 }, {}, {}]);
  });

  it("returns all-blank when there are no points", () => {
    expect(equityForBars([bar(0), bar(60_000)], [])).toEqual([{}, {}]);
  });
});

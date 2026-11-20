// Trendlines "Log Scale" (calcParams slot 33): the detector on ln prices.
import { describe, expect, it } from "vitest";
import {
  computeTrendlines,
  createTrendlinesSession,
  maxDistanceTol,
  tlPrice,
  tlSpace,
} from "./trendlines";
import { TRENDLINES_DEFAULTS, TRENDLINES_SEED, type TrendlinesConfig } from "./trendlinesOutputs";
import { tlExp, tlLog, tlLogBar, TL_LOG_FLOOR } from "./tlLogMath";
import { alertLineOf } from "./trendlineMarks";
import { lineLevel } from "../lineLevel";
import { synthBars } from "./trendlinesSynth.testutil";

const CFG: TrendlinesConfig = { ...TRENDLINES_DEFAULTS, pivotLen: 3, minSpanBars: 10, maxProjBars: 60, majorPivots: 0 };

describe("tlLog / tlExp", () => {
  it("agree with Math.log / Math.exp to about one ULP", () => {
    for (const x of [1e-6, 0.5, 1, Math.SQRT2, 2, 3.14159, 99.99, 65432.1, 1e9]) {
      expect(tlLog(x)).toBeCloseTo(Math.log(x), 14);
      expect(tlExp(tlLog(x)) / x).toBeCloseTo(1, 14);
    }
  });
  it("reads a non-positive price as the floor", () => {
    expect(tlLog(0)).toBe(tlLog(TL_LOG_FLOOR));
    expect(tlLog(-5)).toBe(tlLog(TL_LOG_FLOOR));
    expect(Number.isFinite(tlLog(NaN))).toBe(true);
  });
});

describe("Log Scale detector", () => {
  const bars = synthBars(600);
  const logBars = bars.map(tlLogBar);

  it("is the linear detector on ln candles, outputs back through exp", () => {
    const log = computeTrendlines(bars, { ...CFG, logScale: 1 });
    const lin = computeTrendlines(logBars, CFG);
    expect(log.lines.length).toBeGreaterThan(0);
    expect(log.points.some((p) => p.tl_1 !== undefined)).toBe(true);
    expect(log.lines).toEqual(lin.lines);
    const back = lin.points.map((p) =>
      Object.fromEntries(Object.entries(p).map(([k, v]) => [k, tlExp(v as number)])),
    );
    expect(log.points).toEqual(back);
  });

  it("differs from the linear detector on the same candles", () => {
    const log = computeTrendlines(bars, { ...CFG, logScale: 1 });
    const lin = computeTrendlines(bars, CFG);
    expect(JSON.stringify(log.points)).not.toBe(JSON.stringify(lin.points));
  });

  it("the incremental session matches a full compute, tick by tick", () => {
    const cfg = { ...TRENDLINES_SEED, logScale: 1 };
    const s = createTrendlinesSession();
    const list = bars.slice(0, 400);
    s.compute(list, cfg);
    for (let n = 400; n < 450; n++) {
      list.push(bars[n]);
      const inc = s.compute(list, cfg);
      const full = computeTrendlines(list, cfg);
      expect(inc.points[n]).toEqual(full.points[n]);
      expect(inc.lines).toEqual(full.lines);
      expect(inc.atr[n - 1]).toBe(full.atr[n - 1]);
    }
  });

  it("turns the percent cut into a fixed log band", () => {
    const cfg = { ...CFG, logScale: 1, maxDistPct: 5 };
    // The same band at any price level.
    expect(maxDistanceTol(cfg, null, tlLog(10))).toBe(maxDistanceTol(cfg, null, tlLog(10_000)));
    expect(maxDistanceTol(cfg, null, 0)).toBeCloseTo(Math.log(1.05), 14);
  });

  it("maps prices into and out of the detector's space", () => {
    expect(tlSpace({ logScale: 0 }, 123)).toBe(123);
    expect(tlPrice({ logScale: 0 }, 123)).toBe(123);
    expect(tlSpace({ logScale: 1 }, 123)).toBe(tlLog(123));
    expect(tlPrice({ logScale: 1 }, tlLog(123)) / 123).toBeCloseTo(1, 14);
  });
});

describe("alertLineOf under Log Scale", () => {
  it("keeps the log line exactly: pRef in price, slope in ln per bar", () => {
    // ln 100 at bar 0 to ln 200 at bar 10: doubling every 10 bars.
    const line = { i1: 0, p1: tlLog(100), i2: 10, p2: tlLog(200) };
    const times = Array.from({ length: 30 }, (_, i) => i * 1000);
    const a = alertLineOf(line, times, 20, true)!;
    expect(a.log).toBe(true);
    expect(a.p1).toBeCloseTo(100, 10);
    expect(a.p2).toBeCloseTo(200, 10);
    expect(a.pRef).toBeCloseTo(400, 9);
    // 10 bars on the line doubles again, and back at anchor 1 it is 100.
    expect(lineLevel(a.pRef, a.slope, 10, a.log)).toBeCloseTo(800, 8);
    expect(lineLevel(a.pRef, a.slope, -20, a.log)).toBeCloseTo(100, 9);
  });
  it("a linear line is unchanged and carries no flag", () => {
    const a = alertLineOf({ i1: 0, p1: 100, i2: 10, p2: 200 }, Array.from({ length: 30 }, (_, i) => i), 20)!;
    expect(a.log).toBeUndefined();
    expect(a.pRef).toBe(300);
    expect(lineLevel(a.pRef, a.slope, 5)).toBe(350);
  });
});

// ACCEPTANCE: KBH daily (Capital.com live, captured 2026-09-23 from
// 2015-01-01). The owner's pane drew the 2020-03-19 low to 2026-05-19 low
// line at Max Projection 100 and lost it at 300: lines revived by the longer
// projection took the Max Trendlines slots before Max Distance hid them.
// Params are the owner's pane, slot for slot, with slots 4 and 22 varied.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import {
  computeTrendlines, mergeTolerance, poolable, selectDrawnLines, trendlineGate, type TrendLine,
} from "./trendlines";
import { parseTrendlinesConfig } from "./trendlinesOutputs";
import fixture from "./trendlinesKbh.fixture.json";

const bars = fixture as unknown as KLineData[];
const PANE = [7, 0, 2, 10, 100, 50, 2, 0, 40, 0, 0, 0.15, -0.15, 0, 0, 0, 6, 0.2, 20, 0, 20, 0, 3, 3, 440, 9, 3, 0];
const day = (i: number) => new Date(bars[i].timestamp).toISOString().slice(0, 10);
const covidLine = (l: TrendLine) =>
  l.k1 === "low" && day(l.i1) === "2020-03-19" && l.k2 === "low" && day(l.i2) === "2026-05-19";

/** The selection on the last bar with the pane's params, `over` replacing
 * calcParams slots by index (4 = Max Projection, 22 = Max Per Pivot). */
function drawnAtLast(over: Record<number, number>): TrendLine[] {
  const cfg = parseTrendlinesConfig(PANE.map((v, k) => over[k] ?? v));
  const { lines, atr } = computeTrendlines(bars, cfg);
  const last = bars.length - 1;
  const close = bars[last].close;
  return selectDrawnLines(poolable(lines, last, cfg), last, close, cfg.maxLines, {
    tol: mergeTolerance(cfg, atr[last], close),
    keep: new Set(),
    perPivot: cfg.maxPerPivot,
    pass: trendlineGate(last, close, atr[last], cfg),
  });
}

describe("TRENDLINES on KBH daily", () => {
  it("holds the fixture it expects", () => {
    expect(day(bars.length - 1)).toBe("2026-09-23");
    expect(bars.some((_, i) => day(i) === "2020-03-19")).toBe(true);
  });
  it("draws the 2020-03-19 low line at Max Projection 100", () => {
    expect(drawnAtLast({ 4: 100 }).some(covidLine)).toBe(true);
  });
  // Fails on the pre-change pipeline: there the line ranked 68 of 245
  // poolable lines, outside the top-50 candidate cut taken before any filter.
  it("draws it at Max Projection 300 with Max Per Pivot off", () => {
    expect(drawnAtLast({ 4: 300, 22: 0 }).some(covidLine)).toBe(true);
  });
  // With the pane's Max Per Pivot 3 it is dropped at 300, and that is correct:
  // five better-ranked levels touch 2026-05-19 and put it sixth there, so Max
  // Per Pivot 6 is the smallest cap that draws it. Three of the five are dead
  // before that touch at Max Projection 100 (their second anchors are in
  // 2025); at 100 only two sit ahead and it draws at 3. Measured 2026-09-23.
  it("at Max Projection 300 it is the per-pivot cap that drops it", () => {
    expect(drawnAtLast({ 4: 300 }).some(covidLine)).toBe(false);
    expect(drawnAtLast({ 4: 300, 22: 5 }).some(covidLine)).toBe(false);
    expect(drawnAtLast({ 4: 300, 22: 6 }).some(covidLine)).toBe(true);
  });
});

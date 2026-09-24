// ACCEPTANCE for Extend Left (spec 2026-09-24): the owner's EURUSD daily
// drawing starts at the 2024-11-29 high. The Trendlines(1D) pane builds the
// same line from the 2025-03-26 low to the 2026-07-28 low; with Extend Left
// on it must start at the 2024-12-06 high, the nearest earlier swing it
// touches (94 bars back, pierced by 0.45 ATR), with the 2025-03-05 break
// counted as a crossing. Old resistance turned support.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { computeTrendlines, isMajor, lineStart, projectAt, type TrendLine } from "./trendlines";
import { parseTrendlinesConfig } from "./trendlinesOutputs";
import fixture from "./trendlinesEurusdDaily.fixture.json";

const bars = fixture as unknown as KLineData[];
const day = (i: number): string => new Date(bars[i].timestamp).toISOString().slice(0, 10);
// The owner's Trendlines(1D) pane on 2026-09-24, slots 0..26; 27 Lookback off.
const PANE = [8, 0, 2, 20, 100, 50, 2, 0, 40, 0, 0, 0.3, -0.3, 0, 0, 0, 2, 0.5, 0, 0, 1, 1, 3, 0, 12, 10, 3, 0];
const cfgWith = (extendLeft: number, patch: Record<number, number> = {}) => {
  const p = [...PANE, extendLeft];
  for (const [k, v] of Object.entries(patch)) p[Number(k)] = v;
  return parseTrendlinesConfig(p);
};
const find = (lines: TrendLine[]): TrendLine | undefined =>
  lines.find((l) => day(l.i1) === "2025-03-26" && day(l.i2) === "2026-07-28");

describe("TRENDLINES Extend Left on EURUSD daily", () => {
  it("holds the fixture it expects", () => {
    expect(day(0)).toBe("2022-09-05");
    expect(day(bars.length - 1)).toBe("2026-09-23");
  });

  it("off: the line starts at its first anchor", () => {
    const l = find(computeTrendlines(bars, cfgWith(0)).lines);
    expect(l).toBeDefined();
    expect(lineStart(l!)).toBe(l!.i1);
  });

  it("on: the line starts at the 2024-12-06 high, one more touch, the break counted", () => {
    const off = find(computeTrendlines(bars, cfgWith(0)).lines)!;
    const on = find(computeTrendlines(bars, cfgWith(1)).lines);
    expect(on).toBeDefined();
    expect(day(lineStart(on!))).toBe("2024-12-06");
    expect(on!.touches).toBe(off.touches + 1);
    expect(on!.crossings).toBe(off.crossings + 1);
    expect((on!.crossIdxs ?? []).map(day)).toContain("2025-03-05");
    const last = bars.length - 1;
    expect(projectAt(on!, last)).toBe(projectAt(off, last));
  });

  it("respects Max Span: an extension that breaks it keeps the line unextended", () => {
    const off = find(computeTrendlines(bars, cfgWith(0)).lines)!;
    const span = off.lastTouchIdx - off.i1;
    // Slot 10 is Max Span: one bar more than the unextended span allows the
    // line but not its 94-bar extension.
    const on = find(computeTrendlines(bars, cfgWith(1, { 10: span + 1 })).lines);
    expect(on).toBeDefined();
    expect(lineStart(on!)).toBe(on!.i1);
  });

  it("falls back to the short line when a later crossing breaks Max Crossings", () => {
    // Slot 16 is Max Crossings. At 1 the extended line (1 crossing at birth,
    // the 2025-03-05 break) is kept until 2026-09-23 crosses it a second time;
    // from then on it is exactly the line Extend Left off builds, and it
    // still counts as major on the last bar instead of being silenced.
    const last = bars.length - 1;
    const beforeCross = bars.findIndex((b) => new Date(b.timestamp).toISOString().startsWith("2026-09-22"));
    const early = find(computeTrendlines(bars.slice(0, beforeCross + 1), cfgWith(1, { 16: 1 })).lines);
    expect(early).toBeDefined();
    expect(day(lineStart(early!))).toBe("2024-12-06");
    const off = find(computeTrendlines(bars, cfgWith(0, { 16: 1 })).lines)!;
    const on = find(computeTrendlines(bars, cfgWith(1, { 16: 1 })).lines);
    expect(on).toEqual(off);
    expect(isMajor(on!, last, cfgWith(1, { 16: 1 }))).toBe(true);
  });
});

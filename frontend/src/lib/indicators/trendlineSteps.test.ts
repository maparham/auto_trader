// The candle to HTF bar map behind coarser-pinned trendline steps, and the
// step pieces built on it. Synthetic stock data: seven one-hour candles a
// day (13:30 to 19:30 UTC opens), Monday to Friday, daily bars opening at
// 00:00 UTC.
import { describe, expect, it } from "vitest";
import {
  buildHtfStepMap,
  buildSteps,
  clipPiece,
  distToSteps,
  rampValueAt,
  stepRange,
  type HtfStepMap,
  type StepPiece,
} from "./trendlineSteps";
import { buildSlotGrid } from "../equalWidthDays";

const H = 3_600_000;
const DAY = 24 * H;
// Monday 2026-11-02 00:00 UTC.
const MON = Date.UTC(2026, 10, 2);

/** Trading days (offsets in days from MON), skipping weekends. */
function tradingDays(nDays: number, from = 0): number[] {
  const out: number[] = [];
  for (let d = from; out.length < nDays; d++) {
    const wd = (d % 7 + 7) % 7; // 0 = Monday
    if (wd < 5) out.push(d);
  }
  return out;
}

/** Hourly candle opens for the given trading days; `skipFirst` drops that
 * many candles from the first day (history starting mid-bar). */
function hourly(days: number[], skipFirst = 0, perDay = 7): number[] {
  const out: number[] = [];
  days.forEach((d, k) => {
    for (let h = k === 0 ? skipFirst : 0; h < perDay; h++) out.push(MON + d * DAY + 13.5 * H + h * H);
  });
  return out;
}

const startsOf = (days: number[]) => days.map((d) => MON + d * DAY);

function mapOf(times: number[], starts: number[]): HtfStepMap {
  return buildHtfStepMap((i) => times[i], times.length, starts, DAY, "DAY");
}

const dayIdx = (t: number, starts: number[]) => {
  let j = -1;
  for (let k = 0; k < starts.length; k++) if (starts[k] <= t) j = k;
  return j;
};

describe("buildHtfStepMap", () => {
  it("history containment", () => {
    const days = tradingDays(10);
    const times = hourly(days);
    const starts = startsOf(days);
    const map = mapOf(times, starts);
    times.forEach((t, c) => expect(map.barOf(c)).toBe(dayIdx(t, starts)));
    expect(map.forming).toBe(starts.length);
    expect(map.perBar).toBe(7);
  });

  it("forming bar after a weekend", () => {
    // Two weeks of closed days ending on a Friday, then Monday's first 3 candles.
    const closed = tradingDays(10);
    const monday = 14;
    const times = [...hourly(closed), ...hourly([monday]).slice(0, 3)];
    const map = mapOf(times, startsOf(closed));
    const n = times.length;
    for (let c = n - 3; c < n; c++) expect(map.barOf(c)).toBe(map.forming);
    expect(map.barOf(n - 4)).toBe(map.forming - 1);
    const next = map.span(map.forming + 1)!;
    expect(next.to - next.from).toBe(7);
    const forming = map.span(map.forming)!;
    expect(forming.from).toBe(n - 3 - 0.5);
  });

  it("day missing from the pin", () => {
    const days = tradingDays(10);
    const times = hourly(days);
    const wed = 2; // the third trading day
    const starts = startsOf(days.filter((_, k) => k !== wed));
    const map = mapOf(times, starts);
    // Wednesday's candles belong to Tuesday (index 1).
    for (let c = 2 * 7; c < 3 * 7; c++) expect(map.barOf(c)).toBe(1);
    for (let j = 0; j < starts.length; j++) expect(map.span(j)).not.toBeNull();
    expect(map.perBar).toBe(7);
  });

  it("partial first bar", () => {
    const days = tradingDays(10);
    const times = hourly(days, 3);
    const map = mapOf(times, startsOf(days));
    expect(map.perBar).toBe(7);
    const first = map.span(0)!;
    expect(first.to - first.from).toBe(4);
  });

  it("stale stash", () => {
    // Pin's starts end on Thursday; candles run through Friday and Monday.
    const days = tradingDays(10); // two weeks
    const thu = days.slice(0, 9); // through the second Thursday
    const times = hourly([...days, 14]);
    const map = mapOf(times, startsOf(thu));
    const n = times.length;
    for (let c = n - 14; c < n - 7; c++) expect(map.barOf(c)).toBe(map.forming);
    for (let c = n - 7; c < n; c++) expect(map.barOf(c)).toBe(map.forming + 1);
  });

  it("a forming bar longer than perBar stays one bar", () => {
    // A long session (nine candles) on the forming day: the pin's bar is
    // decided by time, not by counting perBar candles.
    const closed = tradingDays(10);
    const long = Array.from({ length: 9 }, (_, h) => MON + 14 * DAY + 13.5 * H + h * H);
    const times = [...hourly(closed), ...long];
    const map = mapOf(times, startsOf(closed));
    for (let c = times.length - 9; c < times.length; c++) expect(map.barOf(c)).toBe(map.forming);
  });

  it("DST straddle", () => {
    // The broker's daily open moves from 00:00 to 23:00 the previous day in
    // the second week; 4H candles stay on fixed UTC hours.
    const days = tradingDays(10);
    const starts = days.map((d, k) => MON + d * DAY - (k >= 5 ? H : 0));
    const times: number[] = [];
    for (const d of days) for (let h = 0; h < 24; h += 4) times.push(MON + d * DAY + h * H);
    const map = mapOf(times, starts);
    const counts = new Map<number, number>();
    times.forEach((_, c) => counts.set(map.barOf(c), (counts.get(map.barOf(c)) ?? 0) + 1));
    for (let j = 0; j < starts.length; j++) expect(counts.get(j) ?? 0).toBeGreaterThan(0);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(times.length);
  });

  it("projects bars before the first start by perBar", () => {
    const days = tradingDays(10);
    const map = mapOf(hourly(days), startsOf(days));
    const before = map.span(-1)!;
    expect(before.to).toBe(map.span(0)!.from);
    expect(before.to - before.from).toBe(7);
  });

  it("posOf and jAt invert each other", () => {
    const days = tradingDays(10);
    const map = mapOf(hourly(days), startsOf(days));
    for (const j of [0, 2.5, 7.25, map.forming + 3.5, -2.5]) expect(map.jAt(map.posOf(j))).toBeCloseTo(j, 9);
  });
});

describe("buildSteps", () => {
  const days = tradingDays(10);
  const times = hourly(days);
  const map = mapOf(times, startsOf(days));
  const value = (j: number) => 100 + 2 * j;
  const xOf = (pos: number) => pos * 10;
  const yOf = (p: number) => 1000 - p;
  const all = { xOf, yOf, posMin: -1e9, posMax: 1e9 };

  it("ramps each bar to the next bar's value; the newest candle's bar stays flat", () => {
    expect(map.nowBar).toBe(9);
    const pieces = buildSteps(map, value, 0, 9, all);
    expect(pieces).toHaveLength(10);
    pieces.forEach((p, j) => {
      expect(p.y0).toBe(yOf(value(j)));
      expect(p.y1).toBe(j === 9 ? p.y0 : yOf(value(j + 1)));
      expect(p.x0).toBe(xOf(j * 7 - 0.5));
      expect(p.x1).toBe(xOf(j * 7 + 6.5));
    });
  });

  it("fractional end ramps to the value there", () => {
    const pieces = buildSteps(map, value, 0, 3.5, all);
    const last = pieces[pieces.length - 1];
    expect(last.x1).toBe(xOf(map.posOf(3.5)));
    expect(last.y1).toBeCloseTo(yOf(value(3.5)), 9);
    expect(pieces).toHaveLength(4);
  });

  it("flat: one horizontal per bar (the Steps style)", () => {
    const pieces = buildSteps(map, value, 0, 9, { ...all, flat: true });
    pieces.forEach((p, j) => expect([p.y0, p.y1]).toEqual([yOf(value(j)), yOf(value(j))]));
    expect(rampValueAt(map, value, 17, true)).toBe(value(2));
  });

  it("rampValueAt follows the pieces, flat in the newest candle's bar", () => {
    // Candle 17 is the fourth of bar 2: 3.5 of 7 candle widths in.
    expect(rampValueAt(map, value, 17)).toBeCloseTo(value(2.5), 9);
    expect(rampValueAt(map, value, 66)).toBe(value(9));
    expect(rampValueAt(map, value, 69)).toBe(value(9));
  });

  it("clamps at endPos", () => {
    const pieces = buildSteps(map, value, 0, map.forming + 5, { ...all, endPos: times.length - 0.5 });
    expect(pieces[pieces.length - 1].x1).toBe(xOf(times.length - 0.5));
  });

  it("culling", () => {
    const many = hourly(tradingDays(700));
    const big = mapOf(many, startsOf(tradingDays(700)));
    const pieces = buildSteps(big, value, 0, big.forming + 50, { xOf, yOf, posMin: 2000, posMax: 2100 });
    expect(pieces.length).toBeLessThanOrEqual(Math.ceil(100 / 7) + 2);
    expect(pieces[0].x1).toBeGreaterThanOrEqual(xOf(2000));
  });

  it("merge", () => {
    const pieces = buildSteps(map, value, 0, 9, { ...all, xOf: (pos) => pos * 0.1 });
    for (const p of pieces) expect(p.x1 - p.x0).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(pieces[0].x0).toBeCloseTo(-0.05, 9);
    expect(pieces[pieces.length - 1].x1).toBeCloseTo(6.95, 9);
  });
});

describe("stepRange", () => {
  const days = tradingDays(10);
  const times = hourly(days);
  const map = mapOf(times, startsOf(days));
  const lastIdx = map.forming - 1;

  it("a line reaching the last closed bar runs through the forming bar to the newest candle", () => {
    expect(stepRange(lastIdx, lastIdx, map)).toEqual({ jTo: map.forming, endPos: times.length - 0.5 });
  });

  it("runs to the newest candle's bar when a stale stash leaves several", () => {
    const thu = days.slice(0, 9);
    const stale = mapOf(hourly([...days, 14]), startsOf(thu));
    const r = stepRange(stale.forming - 1, stale.forming - 1, stale);
    expect(r.jTo).toBe(stale.forming + 1);
  });

  it("anything else is unchanged", () => {
    expect(stepRange(lastIdx + 40, lastIdx, map)).toEqual({ jTo: lastIdx + 40 });
    expect(stepRange(lastIdx - 3, lastIdx, map)).toEqual({ jTo: lastIdx - 3 });
  });
});

describe("clipPiece", () => {
  it("interpolates y at the cut", () => {
    expect(clipPiece({ x0: 0, x1: 10, y0: 50, y1: 40 }, 5, 20)).toEqual({ x0: 5, x1: 10, y0: 45, y1: 40 });
    expect(clipPiece({ x0: 0, x1: 10, y0: 50, y1: 40 }, -5, 2)).toEqual({ x0: 0, x1: 2, y0: 50, y1: 48 });
  });
});

describe("distToSteps", () => {
  const pieces: StepPiece[] = [
    { x0: 0, x1: 10, y0: 50, y1: 50 },
    { x0: 10, x1: 20, y0: 40, y1: 40 },
    { x0: 20, x1: 30, y0: 30, y1: 30 },
  ];

  it("is 0 on a step and the vertical gap off it", () => {
    expect(distToSteps(5, 50, pieces)).toBe(0);
    expect(distToSteps(15, 43, pieces)).toBe(3);
  });

  it("measures the riser at a boundary", () => {
    // Just right of x = 10, halfway up the riser from 50 to 40.
    expect(distToSteps(10.5, 45, pieces)).toBeCloseTo(0.5, 9);
  });

  it("is Infinity past the last piece", () => {
    expect(distToSteps(31, 30, pieces)).toBe(Infinity);
  });
});

describe("equal-width days (slots)", () => {
  const days = tradingDays(10);
  // Days 2 and 5 lose their first 3 candles (a late open).
  const hourlyWithHoles = () =>
    hourly(days).filter((t) => {
      const k = days.indexOf(Math.floor((t - MON) / DAY));
      const h = Math.round((t - MON - days[k] * DAY - 13.5 * H) / H);
      return !((k === 2 || k === 5) && h < 3);
    });
  const value = (j: number) => 100 + 2 * j;
  const all = { xOf: (pos: number) => pos * 10, yOf: (p: number) => 1000 - p, posMin: -1e9, posMax: 1e9 };

  it("with slots every day spans perDay and the ramp is one straight line", () => {
    const times = hourlyWithHoles();
    const grid = buildSlotGrid(times)!;
    const map = buildHtfStepMap((i) => times[i], times.length, startsOf(days), DAY, "DAY", grid);
    for (let j = 0; j < map.forming; j++) expect(map.span(j)!.to - map.span(j)!.from).toBe(grid.perDay);
    const pieces = buildSteps(map, value, 0, 8, all);
    const slope = (p: StepPiece) => (p.y1 - p.y0) / (p.x1 - p.x0);
    for (const p of pieces) expect(slope(p)).toBeCloseTo(slope(pieces[0]), 9);
    expect(map.candlePos(times.length - 1)).toBe(grid.pos[times.length - 1]);
    expect(map.toIndex(map.candlePos(4))).toBeCloseTo(4, 9);
  });

  it("jAt inside a day's leading gap reads that day", () => {
    const times = hourlyWithHoles();
    const grid = buildSlotGrid(times)!;
    const map = buildHtfStepMap((i) => times[i], times.length, startsOf(days), DAY, "DAY", grid);
    // Day 2 starts at slot 14 but its first candle sits at slot 17.
    expect(map.jAt(14)).toBeCloseTo(2 + 0.5 / 7, 9);
    expect(map.jAt(15.5)).toBeCloseTo(2 + 2 / 7, 9);
  });

  it("the newest day's span runs a full day past its first candle", () => {
    const times = hourlyWithHoles().slice(0, -4); // the last day holds 3 candles
    const grid = buildSlotGrid(times)!;
    const map = buildHtfStepMap((i) => times[i], times.length, startsOf(days.slice(0, -1)), DAY, "DAY", grid);
    const s = map.span(map.nowBar)!;
    expect(s.to - s.from).toBe(grid.perDay);
    expect(stepRange(map.forming - 1, map.forming - 1, map).endPos).toBe(grid.pos[times.length - 1] + 0.5);
  });

  it("with slots a week pin spans perWeek, even with a Monday holiday", () => {
    // Five weeks of trading days; Monday of week 3 is a holiday.
    const wdays = tradingDays(25).filter((d) => d !== 14);
    const times = hourly(wdays);
    const grid = buildSlotGrid(times)!;
    const weekStarts = [0, 1, 2, 3, 4].map((w) => MON + w * 7 * DAY);
    const map = buildHtfStepMap((i) => times[i], times.length, weekStarts, 7 * DAY, "WEEK", grid);
    for (let j = 0; j < map.forming; j++) expect(map.span(j)!.to - map.span(j)!.from).toBe(grid.perWeek);
    const pieces = buildSteps(map, value, 0, map.nowBar - 1, all); // the newest week stays flat
    const slope = (p: StepPiece) => (p.y1 - p.y0) / (p.x1 - p.x0);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(slope(p)).toBeCloseTo(slope(pieces[0]), 9);
  });

  it("without slots the map is unchanged", () => {
    const map = mapOf(hourly(days), startsOf(days));
    expect(map.candlePos(5)).toBe(5);
    expect(map.toIndex(5.5)).toBe(5.5);
  });
});

import { describe, it, expect } from "vitest";
import { computePeriodBands, type BacktestPeriod } from "./backtestPeriods";
import { isActive } from "./backtestSchedule";

// Hourly bars across two UTC days: 2021-01-01 00:00 .. 2021-01-02 23:00.
const HOUR = 3_600_000;
const DAY_START = Date.UTC(2021, 0, 1, 0, 0, 0); // Fri 2021-01-01
const HOURLY: number[] = [];
for (let i = 0; i < 48; i++) HOURLY.push(DAY_START + i * HOUR);

describe("computePeriodBands", () => {
  it("no mask → one band clamped to the loaded bar range", () => {
    const period: BacktestPeriod = { fromMs: DAY_START - 5 * HOUR, toMs: DAY_START + 10 * HOUR };
    const bands = computePeriodBands(period, HOURLY);
    expect(bands).toEqual([{ fromMs: DAY_START, toMs: DAY_START + 10 * HOUR }]);
  });

  it("no bars loaded → nothing", () => {
    expect(computePeriodBands({ fromMs: 0, toMs: DAY_START + HOUR }, [])).toEqual([]);
  });

  it("window entirely before the loaded bars → nothing", () => {
    expect(computePeriodBands({ fromMs: 0, toMs: DAY_START - HOUR }, HOURLY)).toEqual([]);
  });

  it("mask time-of-day 09:00–12:00 UTC → one band per day (half-open, 12:00 excluded)", () => {
    const period: BacktestPeriod = {
      fromMs: DAY_START,
      toMs: DAY_START + 48 * HOUR,
      mask: { enabled: true, tz: "UTC", timeOfDay: { startMin: 9 * 60, endMin: 12 * 60 } },
    };
    const bands = computePeriodBands(period, HOURLY);
    expect(bands).toEqual([
      { fromMs: DAY_START + 9 * HOUR, toMs: DAY_START + 11 * HOUR },       // day 1: 09,10,11
      { fromMs: DAY_START + (24 + 9) * HOUR, toMs: DAY_START + (24 + 11) * HOUR }, // day 2
    ]);
  });

  it("mask day-of-week that excludes both days → nothing (no fallback band)", () => {
    // 2021-01-01 is Fri(5), 2021-01-02 is Sat(6). Allow only Monday(1).
    const period: BacktestPeriod = {
      fromMs: DAY_START,
      toMs: DAY_START + 48 * HOUR,
      mask: { enabled: true, tz: "UTC", daysOfWeek: [1] },
    };
    expect(computePeriodBands(period, HOURLY)).toEqual([]);
  });

  it("overnight-wrap 22:00–02:00 UTC coalesces across midnight into one run", () => {
    const period: BacktestPeriod = {
      fromMs: DAY_START,
      toMs: DAY_START + 48 * HOUR,
      mask: { enabled: true, tz: "UTC", timeOfDay: { startMin: 22 * 60, endMin: 2 * 60 } },
    };
    const bands = computePeriodBands(period, HOURLY);
    // Active bars: 22,23 (day1) → 00,01 (day2), contiguous; then 22,23 (day2) run to the end.
    expect(bands).toContainEqual({ fromMs: DAY_START + 22 * HOUR, toMs: DAY_START + 25 * HOUR });
    expect(bands[bands.length - 1]).toEqual({
      fromMs: DAY_START + (24 + 22) * HOUR,
      toMs: DAY_START + (24 + 23) * HOUR,
    });
  });
});

describe("period bands invariant", () => {
  it("every active loaded bar lands inside some band (mask on)", () => {
    const HOUR2 = 3_600_000;
    const start = Date.UTC(2021, 5, 1, 0, 0, 0); // Tue 2021-06-01
    const bars: number[] = [];
    for (let i = 0; i < 24 * 5; i++) bars.push(start + i * HOUR2); // 5 days hourly
    const period: BacktestPeriod = {
      fromMs: start,
      toMs: start + 24 * 5 * HOUR2,
      // NYSE-ish weekday session, resolved-style mask.
      mask: { enabled: true, tz: "UTC", daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: { startMin: 13 * 60 + 30, endMin: 20 * 60 } },
    };
    const bands = computePeriodBands(period, bars);
    const inBand = (t: number) => bands.some((b) => t >= b.fromMs && t <= b.toMs);
    for (const t of bars) {
      // The discriminating check: a bar the mask deems active MUST be shaded.
      if (isActive(period.mask, t)) expect(inBand(t)).toBe(true);
    }
  });
});

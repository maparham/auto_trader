import { describe, it, expect } from "vitest";
import { SESSION_PRESETS, resolveMask, isActive } from "./backtestSchedule";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi);

describe("resolveMask", () => {
  it("inlines a session into timeOfDay+tz and drops session", () => {
    const r = resolveMask({ enabled: true, session: "NYSE" });
    expect(r.session).toBeUndefined();
    expect(r.tz).toBe("America/New_York");
    expect(r.timeOfDay).toEqual({ startMin: 9 * 60 + 30, endMin: 16 * 60 });
  });
  it("is idempotent", () => {
    const once = resolveMask({ enabled: true, session: "Tokyo" });
    expect(resolveMask(once)).toEqual(once);
  });
  it("Crypto session applies no clock filter", () => {
    const r = resolveMask({ enabled: true, session: "Crypto" });
    expect(r.timeOfDay).toBeUndefined();
    expect(r.tz).toBe("UTC");
  });
  it("exchange session defaults to Mon–Fri when no weekday chips are set", () => {
    const r = resolveMask({ enabled: true, session: "NYSE" });
    expect(r.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    // Sat/Sun NYSE hours are now inactive; a weekday still passes.
    expect(isActive(r, utc(2024, 1, 6, 15, 0))).toBe(false); // Sat 10:00 NY
    expect(isActive(r, utc(2024, 1, 5, 15, 0))).toBe(true);  // Fri 10:00 NY
  });
  it("explicit weekday chips win over the session default", () => {
    const r = resolveMask({ enabled: true, session: "NYSE", daysOfWeek: [1, 3] });
    expect(r.daysOfWeek).toEqual([1, 3]);
  });
  it("Crypto session keeps every day active (no weekday default)", () => {
    const r = resolveMask({ enabled: true, session: "Crypto" });
    expect(r.daysOfWeek).toBeUndefined();
  });
  it("exposes a preset table", () => {
    expect(SESSION_PRESETS.London.tz).toBe("Europe/London");
  });
});

describe("isActive", () => {
  it("undefined mask is always active", () => {
    expect(isActive(undefined, utc(2024, 1, 1))).toBe(true);
  });
  it("disabled mask is always active", () => {
    expect(isActive({ enabled: false, daysOfWeek: [1] }, utc(2024, 1, 6))).toBe(true);
  });
  it("day-of-week uses JS getDay in tz", () => {
    // 2024-01-01 23:00 UTC = Tue in Tokyo (getDay 2).
    const m = resolveMask({ enabled: true, daysOfWeek: [2], tz: "Asia/Tokyo" });
    expect(isActive(m, utc(2024, 1, 1, 23, 0))).toBe(true);
    expect(isActive(m, utc(2024, 1, 1, 12, 0))).toBe(false); // still Mon in Tokyo
  });
  it("half-open time window", () => {
    const m = { enabled: true, timeOfDay: { startMin: 570, endMin: 660 }, tz: "UTC" };
    expect(isActive(m, utc(2024, 1, 1, 9, 30))).toBe(true);
    expect(isActive(m, utc(2024, 1, 1, 11, 0))).toBe(false);
  });
  it("overnight wrap window", () => {
    const m = { enabled: true, timeOfDay: { startMin: 1320, endMin: 120 }, tz: "UTC" };
    expect(isActive(m, utc(2024, 1, 1, 23, 0))).toBe(true);
    expect(isActive(m, utc(2024, 1, 1, 1, 0))).toBe(true);
    expect(isActive(m, utc(2024, 1, 1, 12, 0))).toBe(false);
  });
  it("filters are ANDed", () => {
    const m = resolveMask({ enabled: true, daysOfWeek: [1], session: "NYSE" });
    expect(isActive(m, utc(2024, 1, 1, 15, 0))).toBe(true);  // Mon 10:00 NY
    expect(isActive(m, utc(2024, 1, 2, 15, 0))).toBe(false); // Tue
  });
});

import { buildRangeChips, coverage } from "./backtestSchedule";

describe("buildRangeChips", () => {
  const now = Date.UTC(2026, 6, 5, 12, 0); // 2026-07-05 (July)
  it("month chips are recent whole calendar months, most-recent first", () => {
    const chips = buildRangeChips("month", now, "UTC");
    expect(chips[0].label).toMatch(/Jul|This month/);
    // Each prior chip spans a whole month: toMs - fromMs is 28..31 days.
    const span = chips[1].toMs - chips[1].fromMs;
    expect(span).toBeGreaterThan(27 * 86400_000);
    expect(span).toBeLessThan(32 * 86400_000);
  });
  it("year chips descend from the current year", () => {
    const chips = buildRangeChips("year", now, "UTC");
    expect(chips.map((c) => c.label)).toContain("2025");
    expect(chips.map((c) => c.label)).toContain("2024");
  });
});

describe("coverage", () => {
  it("counts active vs total bars", () => {
    // Two Mondays + two Tuesdays; mask = Mondays only.
    const bars = [
      Date.UTC(2024, 0, 1, 12), Date.UTC(2024, 0, 2, 12),
      Date.UTC(2024, 0, 8, 12), Date.UTC(2024, 0, 9, 12),
    ];
    const c = coverage(bars, { enabled: true, daysOfWeek: [1], tz: "UTC" });
    expect(c).toEqual({ active: 2, total: 4 });
  });
});

import { defaultBacktestConfig } from "./backtestConfig";

describe("mask persistence", () => {
  it("a config with a mask survives a JSON round-trip", () => {
    const cfg = {
      ...defaultBacktestConfig(),
      range: { mode: "custom" as const, mask: { enabled: true, daysOfWeek: [1, 3], session: "NYSE" as const } },
    };
    const back = JSON.parse(JSON.stringify(cfg));
    expect(back.range.mask).toEqual({ enabled: true, daysOfWeek: [1, 3], session: "NYSE" });
  });
});

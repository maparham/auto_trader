import { describe, it, expect } from "vitest";
import { SESSION_PRESETS, resolveMask, isActive, sessionLocalRange, sessionWindowInTz } from "./backtestSchedule";

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

describe("sessionWindowInTz", () => {
  const now = Date.UTC(2024, 5, 15, 12);
  it("returns null for a 24/7 (null-window) session", () => {
    expect(sessionWindowInTz(null, "UTC", "UTC", now)).toBeNull();
  });
  it("re-expresses Tokyo hours in UTC (Tokyo has no DST, so machine-independent)", () => {
    // Tokyo 09:00-15:00 JST (UTC+9) -> 00:00-06:00 UTC.
    const r = sessionWindowInTz({ startMin: 9 * 60, endMin: 15 * 60 }, "Asia/Tokyo", "UTC", now);
    expect(r).toEqual({ startMin: 0, endMin: 6 * 60 });
  });
  it("is identity when session tz equals target tz", () => {
    const win = { startMin: 9 * 60 + 30, endMin: 16 * 60 };
    expect(sessionWindowInTz(win, "UTC", "UTC", now)).toEqual(win);
  });
});

describe("sessionLocalRange", () => {
  const now = Date.UTC(2024, 5, 15, 12); // fixed date (tz-independent assertions)
  it("returns null for a 24/7 (null-window) session", () => {
    expect(sessionLocalRange(SESSION_PRESETS.Crypto.window, SESSION_PRESETS.Crypto.tz, now)).toBeNull();
  });
  it("renders a HH:MM–HH:MM local window for an exchange session", () => {
    const r = sessionLocalRange(SESSION_PRESETS.NYSE.window, SESSION_PRESETS.NYSE.tz, now);
    expect(r).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
  });
  it("shows a session in its own timezone at its home wall-clock hours", () => {
    // When the viewer's tz IS the session tz, the local range equals the
    // preset's home hours regardless of where the test machine runs.
    const winStart = 9 * 60 + 30, winEnd = 16 * 60;
    const r = sessionLocalRange({ startMin: winStart, endMin: winEnd }, "UTC", now);
    // Compute what UTC start/end look like in the machine's local tz.
    const fmt = (min: number) =>
      new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false })
        .format(Date.UTC(2024, 5, 15, Math.floor(min / 60), min % 60));
    expect(r).toBe(`${fmt(winStart)}–${fmt(winEnd)}`);
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

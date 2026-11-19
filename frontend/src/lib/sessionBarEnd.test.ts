import { describe, expect, it } from "vitest";
import { sessionBarEnd, type WeekSessions } from "./sessionBarEnd";

const D = 1440;
// Capital's OIL_CRUDE: Mon-Thu 00:00-22:00 and 23:00-24:00, Fri 00:00-22:00,
// Sun 23:00-24:00.
const OIL: WeekSessions = [
  [0, 22 * 60], [23 * 60, D + 22 * 60], [D + 23 * 60, 2 * D + 22 * 60],
  [2 * D + 23 * 60, 3 * D + 22 * 60], [3 * D + 23 * 60, 4 * D + 22 * 60],
  [6 * D + 23 * 60, 7 * D],
];
const at = (iso: string): number => Date.parse(iso + "Z");
const H = 3_600_000;

describe("sessionBarEnd", () => {
  const week = at("2026-11-16T00:00:00");
  const weekEnd = at("2026-11-23T00:00:00");

  it("ends a weekly bar at the Friday close", () => {
    expect(sessionBarEnd(OIL, at("2026-11-19T15:16:00"), week, weekEnd)).toBe(at("2026-11-20T22:00:00"));
  });

  it("gives the Sunday-evening hour of a weekly bar its own count", () => {
    expect(sessionBarEnd(OIL, at("2026-11-22T23:10:00"), week, weekEnd)).toBe(weekEnd);
  });

  it("stays at zero over the weekend instead of jumping to the nominal end", () => {
    expect(sessionBarEnd(OIL, at("2026-11-21T10:00:00"), week, weekEnd)).toBe(at("2026-11-20T22:00:00"));
  });

  it("ends Friday's daily and 4H bars at the close, and stays there after it", () => {
    const close = at("2026-11-20T22:00:00");
    const nominal = at("2026-11-21T00:00:00");
    expect(sessionBarEnd(OIL, at("2026-11-20T10:00:00"), at("2026-11-20T00:00:00"), nominal)).toBe(close);
    expect(sessionBarEnd(OIL, at("2026-11-20T21:30:00"), nominal - 4 * H, nominal)).toBe(close);
    expect(sessionBarEnd(OIL, at("2026-11-20T22:01:00"), nominal - 4 * H, nominal)).toBe(close);
  });

  it("keeps the nominal end when the bar trades up to it", () => {
    const now = at("2026-11-19T15:16:00");
    // Thursday's daily bar trades 23:00-24:00 after the daily pause.
    expect(sessionBarEnd(OIL, now, at("2026-11-19T00:00:00"), at("2026-11-20T00:00:00"))).toBe(at("2026-11-20T00:00:00"));
    expect(sessionBarEnd(OIL, now, at("2026-11-19T15:00:00"), at("2026-11-19T16:00:00"))).toBe(at("2026-11-19T16:00:00"));
    // A monthly bar that ends mid-week.
    expect(sessionBarEnd(OIL, now, at("2026-11-01T00:00:00"), at("2026-12-01T00:00:00"))).toBe(at("2026-12-01T00:00:00"));
  });

  it("does not step a Sunday bar back past its own open", () => {
    // The Sunday daily bar only trades 23:00-24:00.
    const sun = at("2026-11-22T00:00:00");
    expect(sessionBarEnd(OIL, at("2026-11-22T23:30:00"), sun, weekEnd)).toBe(weekEnd);
    expect(sessionBarEnd(OIL, at("2026-11-22T20:00:00"), sun, weekEnd)).toBe(weekEnd);
  });

  it("stops other bars that end on a Monday at the weekend close too", () => {
    // A 2W bar in its second week.
    expect(sessionBarEnd(OIL, at("2026-11-19T15:16:00"), at("2026-11-09T00:00:00"), weekEnd)).toBe(at("2026-11-20T22:00:00"));
    // A monthly bar whose nominal end, 2027-03-01, is a Monday.
    expect(sessionBarEnd(OIL, at("2027-02-24T12:00:00"), at("2027-02-01T00:00:00"), at("2027-03-01T00:00:00"))).toBe(at("2027-02-26T22:00:00"));
  });

  it("ends a bar whose nominal end is in the daily pause at the pause", () => {
    expect(sessionBarEnd(OIL, at("2026-11-19T21:00:00"), at("2026-11-19T21:00:00"), at("2026-11-19T22:30:00"))).toBe(at("2026-11-19T22:00:00"));
  });

  it("falls back to the nominal end", () => {
    const now = at("2026-11-19T15:16:00");
    expect(sessionBarEnd(null, now, week, weekEnd)).toBe(weekEnd);
    expect(sessionBarEnd([], now, week, weekEnd)).toBe(weekEnd);
    // Nothing inside the bar trades.
    expect(sessionBarEnd(OIL, at("2026-11-21T10:00:00"), at("2026-11-21T08:00:00"), at("2026-11-21T12:00:00"))).toBe(at("2026-11-21T12:00:00"));
    // A market with no breaks.
    expect(sessionBarEnd([[0, 7 * D]], now, week, weekEnd)).toBe(weekEnd);
  });
});

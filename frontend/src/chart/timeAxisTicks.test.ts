// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MIN_TICK_PX, buildTimeTicks, pickStep } from "./timeAxisTicks";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 5); // a Monday, UTC midnight

// A gapless series of `barMs` bars in UTC, `barSpace` px apart, scrolled by `shift` bars.
function ticks(barMs: number, barSpace: number, bars: number, shift = 0, plotPx = 1200) {
  return buildTimeTicks({
    from: shift,
    to: shift + plotPx / barSpace,
    barSpace,
    barMs,
    tsAt: (i) => (i < bars ? T0 + i * barMs : null),
    offsetAt: () => 0,
    pxAt: (i) => (i - shift) * barSpace,
    format: (ts, tpl) => `${tpl}@${new Date(ts).toISOString().slice(0, 16)}`,
    textWidth: () => 40,
  });
}

describe("pickStep", () => {
  it("is the finest step at least MIN_TICK_PX apart, never finer than a bar", () => {
    expect(pickStep(10, HOUR).ms).toBe(12 * HOUR); // 8 bars = 80px -> 12h is the first >= 8h
    expect(pickStep(80, HOUR).ms).toBe(HOUR);
    expect(pickStep(200, HOUR).ms).toBe(HOUR);
    expect(pickStep(MIN_TICK_PX / 4, 15 * MIN).ms).toBe(HOUR);
  });
});

describe("buildTimeTicks", () => {
  it("pins labels to the same timestamps as bar space changes within a step", () => {
    const a = ticks(HOUR, 21, 2000).map((t) => t.value);
    const b = ticks(HOUR, 23, 2000).map((t) => t.value);
    const shared = a.filter((v) => b.includes(v));
    expect(shared.length).toBeGreaterThanOrEqual(Math.min(a.length, b.length) - 1);
  });

  it("keeps the same timestamps when the view scrolls", () => {
    const a = ticks(HOUR, 20, 2000, 100).map((t) => t.value);
    const b = ticks(HOUR, 20, 2000, 107).map((t) => t.value);
    expect(a.slice(2).every((v) => b.includes(v))).toBe(true);
  });

  it("ticks on step boundaries, with the date at day starts", () => {
    const out = ticks(HOUR, 20, 2000); // 4h step at 20px/h
    for (const t of out) expect(new Date(t.value).getUTCHours() % 4).toBe(0);
    const midnight = out.find((t) => new Date(t.value).getUTCHours() === 0)!;
    expect(midnight.text.startsWith("MM-DD@")).toBe(true);
    expect(out.some((t) => t.text.startsWith("HH:mm@"))).toBe(true);
  });

  it("labels month and year starts and drops colliding ticks", () => {
    const out = ticks(DAY, 4, 800, 200); // daily bars, 4px each, Jul 2026 to May 2027
    expect(out.some((t) => t.text.startsWith("YYYY-MM@"))).toBe(true);
    expect(out.some((t) => t.text.startsWith("YYYY@2027"))).toBe(true);
    for (let k = 1; k < out.length; k++) expect(out[k].coord - out[k - 1].coord).toBeGreaterThanOrEqual(52);
  });

  it("never prints a clock time on daily bars", () => {
    expect(ticks(DAY, 30, 400).every((t) => !t.text.startsWith("HH:mm"))).toBe(true);
  });

  it("follows the display timezone for day starts", () => {
    const out = buildTimeTicks({
      from: 0,
      to: 60,
      barSpace: 20,
      barMs: HOUR,
      tsAt: (i) => T0 + i * HOUR,
      offsetAt: () => 2 * HOUR, // UTC+2: local midnight is 22:00 UTC
      pxAt: (i) => i * 20,
      format: (ts, tpl) => `${tpl}@${ts}`,
      textWidth: () => 40,
    });
    const day = out.find((t) => t.text.startsWith("MM-DD@"))!;
    expect(new Date(day.value).getUTCHours()).toBe(22);
  });
});

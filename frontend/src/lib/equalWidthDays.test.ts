import { describe, expect, it } from "vitest";
import { buildSlotGrid, inferDayStartOffset, setEqualWidthDays, slotGridFor } from "./equalWidthDays";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const day = (d: number, hours: number[]) => hours.map((h) => d * DAY + h * HOUR);

describe("buildSlotGrid", () => {
  it("one slot per hour from the earliest to the latest hour seen", () => {
    // Day 0 13:00..19:00, day 1 14:00..17:00 (late open, early close).
    const g = buildSlotGrid([...day(0, [13, 14, 15, 16, 17, 18, 19]), ...day(1, [14, 15, 16, 17])])!;
    expect(g.perDay).toBe(7);
    expect(g.pos).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11]);
  });

  it("days without candles take no room (weekend)", () => {
    const g = buildSlotGrid([...day(4, [13, 14]), ...day(7, [13, 14])])!;
    expect(g.pos).toEqual([0, 1, 2, 3]);
  });

  it("posOf and idxOf invert, across gaps and past both ends", () => {
    const g = buildSlotGrid([...day(0, [13, 14, 15, 16, 17, 18, 19]), ...day(1, [14, 15, 16, 17])])!;
    for (const i of [-2, 0, 3.5, 6.5, 7, 9.25, 10, 13]) expect(g.idxOf(g.posOf(i))).toBeCloseTo(i, 9);
    expect(g.count()).toBe(12);
  });

  it("prepending days with the same slots shifts every position by a constant", () => {
    const later = [...day(1, [13, 14, 15]), ...day(2, [13, 15])];
    const a = buildSlotGrid(later)!;
    const b = buildSlotGrid([...day(0, [13, 14, 15]), ...later])!;
    const shift = b.pos[3] - a.pos[0];
    a.pos.forEach((p, k) => expect(b.pos[k + 3] - p).toBe(shift));
  });

  it("two candles in one slot still get increasing positions", () => {
    // Mostly hourly, with one extra stamp inside the 13:00 slot.
    const t = day(0, [13, 14, 15, 16, 17]);
    const g = buildSlotGrid([t[0], t[0] + 1_800_000, ...t.slice(1)])!;
    for (let k = 1; k < g.n; k++) expect(g.pos[k]).toBeGreaterThan(g.pos[k - 1]);
  });

  it("a stray stamp on a 24h market does not shift later candles", () => {
    // 4H bars round the clock for three days, plus one extra 21:00 stamp on day 0.
    const four = (d: number) => day(d, [0, 4, 8, 12, 16, 20]);
    const g = buildSlotGrid([...four(0), 0 * DAY + 21 * HOUR, ...four(1), ...four(2)])!;
    expect(g.perDay).toBe(6);
    expect(g.pos[7]).toBe(6); // day 1's 00:00 candle starts day 1
    expect(g.pos[g.n - 1]).toBe(17);
    expect(g.pos[6]).toBeGreaterThan(g.pos[5]);
    expect(g.pos[6]).toBeLessThan(6);
  });

  it("no grid for one candle or a daily chart", () => {
    expect(buildSlotGrid(day(0, [13]))).toBeNull();
    expect(buildSlotGrid([0, DAY, 2 * DAY])).toBeNull();
  });
});

describe("broker days and equal weeks", () => {
  const D0 = Date.UTC(2026, 10, 2); // Monday
  const at = (d: number, h: number) => D0 + d * DAY + h * HOUR;
  const hrs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k);
  const stock = (days: number[]) => days.flatMap((d) => hrs(14, 20).map((h) => at(d, h)));
  const weekdays = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
  // Hourly round the clock except 22:00, Sun 23:00 to Fri `endH`.
  const fx = (endH = 21) => {
    const out: number[] = [];
    for (let t = at(-1, 23); t <= at(4, endH); t += HOUR) if (new Date(t).getUTCHours() !== 22) out.push(t);
    return out;
  };

  it("stock days with no holidays keep today's positions", () => {
    const g = buildSlotGrid(stock(weekdays))!;
    expect(g.perDay).toBe(7);
    expect(g.perWeek).toBe(35);
    expect(g.pos).toEqual(Array.from({ length: 70 }, (_, k) => k));
  });

  it("a holiday is an empty column", () => {
    const t = stock(weekdays.filter((d) => d !== 7));
    const g = buildSlotGrid(t)!;
    expect(g.pos[t.indexOf(at(8, 14))]).toBe(5 * 7 + 7);
  });

  it("FX days start at the daily pause", () => {
    const t = fx();
    expect(inferDayStartOffset(t, HOUR)).toBe(22 * HOUR);
    const g = buildSlotGrid(t)!;
    expect(g.perDay).toBe(23);
    expect(g.perWeek).toBe(5 * 23);
    // Sunday 23:00 opens Monday's column, Monday 00:00 is the next slot.
    expect(g.pos[0]).toBe(0);
    expect(g.pos[t.indexOf(at(0, 0))]).toBe(1);
    expect(g.pos[t.indexOf(at(0, 23))]).toBe(23); // Tuesday's first slot
  });

  it("24/7 data falls back to 00:00 and seven columns", () => {
    const t: number[] = [];
    for (let x = at(0, 0); x < at(14, 0); x += HOUR) t.push(x);
    expect(inferDayStartOffset(t, HOUR)).toBe(0);
    expect(buildSlotGrid(t)!.perWeek).toBe(7 * 24);
  });

  it("a session crossing midnight UTC stays one day", () => {
    // 23:00 to 05:00 sessions opening Sun..Thu. The emptiest bin closest to
    // 00:00 is 22:00, so each session is one day (Mon..Fri).
    const t = [-1, 0, 1, 2, 3].flatMap((d) => [23, 24, 25, 26, 27, 28, 29].map((h) => at(d, h)));
    expect(inferDayStartOffset(t, HOUR)).toBe(22 * HOUR);
    const g = buildSlotGrid(t)!;
    expect(g.perDay).toBe(7);
    expect(g.pos).toEqual(Array.from({ length: 35 }, (_, k) => k));
  });

  it("given day starts win, older candles fall back to inference", () => {
    const t = fx(20);
    // The broker's last three days start at 21:00, an hour before the pause.
    const g = buildSlotGrid(t, { dayStarts: [at(1, 21), at(2, 21), at(3, 21)] })!;
    expect(g.perDay).toBe(24);
    expect(g.pos[t.indexOf(at(1, 21))]).toBe(2 * 24); // opens Wednesday
    expect(g.pos[t.indexOf(at(1, 20))]).toBe(24 + 22); // still Tuesday (inferred)
    for (let k = 1; k < g.n; k++) expect(g.pos[k]).toBeGreaterThan(g.pos[k - 1]);
  });

  it("given week starts set the weeks", () => {
    const t = stock(weekdays);
    const g = buildSlotGrid(t, { weekStarts: [at(0, 0), at(7, 0)] })!;
    expect(g.pos).toEqual(buildSlotGrid(t)!.pos);
  });
});

describe("slotGridFor", () => {
  it("follows the switch and a live candle", () => {
    const list = [...day(0, [13, 14, 15]), ...day(1, [13])].map((timestamp) => ({ timestamp }));
    setEqualWidthDays(false);
    expect(slotGridFor(list)).toBeNull();
    setEqualWidthDays(true);
    expect(slotGridFor(list)!.pos).toEqual([0, 1, 2, 3]);
    list.push({ timestamp: day(1, [15])[0] }); // same array, new last candle
    expect(slotGridFor(list)!.pos).toEqual([0, 1, 2, 3, 5]);
    setEqualWidthDays(false);
  });

  it("the installed provider never throws and falls back to null", () => {
    setEqualWidthDays(true);
    const provider = (globalThis as { __chartkarSlots?: (l: unknown) => unknown }).__chartkarSlots!;
    expect(provider(null)).toBeNull();
    expect(provider([{ timestamp: NaN }, { timestamp: NaN }])).toBeNull();
    expect(provider([null, null, null])).toBeNull();
    const bad = { get timestamp(): number { throw new Error("boom"); } };
    expect(provider([bad, bad])).toBeNull();
    setEqualWidthDays(false);
    expect((globalThis as { __chartkarSlots?: unknown }).__chartkarSlots).toBeUndefined();
  });
});

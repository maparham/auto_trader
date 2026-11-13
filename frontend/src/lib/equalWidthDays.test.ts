import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSlotGrid,
  relayoutSlots,
  setEqualWidthDays,
  setSlotAnchors,
  setSlotSource,
  slotAnchorsOf,
  slotGridFor,
  type SlotAnchors,
} from "./equalWidthDays";
import { utcAnchors } from "./equalWidthDays.testUtil";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const day = (d: number, hours: number[]) => hours.map((h) => d * DAY + h * HOUR);
/** A grid with UTC days and Monday weeks, as a UTC broker's bars give. */
const grid = (t: number[]) => buildSlotGrid(t, utcAnchors(t));

describe("buildSlotGrid", () => {
  it("one slot per hour from the earliest to the latest hour seen", () => {
    // Day 0 13:00..19:00, day 1 14:00..17:00 (late open, early close).
    const g = grid([...day(0, [13, 14, 15, 16, 17, 18, 19]), ...day(1, [14, 15, 16, 17])])!;
    expect(g.perDay).toBe(7);
    expect(g.pos).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11]);
  });

  it("days without candles take no room (weekend)", () => {
    const g = grid([...day(4, [13, 14]), ...day(7, [13, 14])])!;
    expect(g.pos).toEqual([0, 1, 2, 3]);
  });

  it("posOf and idxOf invert, across gaps and past both ends", () => {
    const g = grid([...day(0, [13, 14, 15, 16, 17, 18, 19]), ...day(1, [14, 15, 16, 17])])!;
    for (const i of [-2, 0, 3.5, 6.5, 7, 9.25, 10, 13]) expect(g.idxOf(g.posOf(i))).toBeCloseTo(i, 9);
    expect(g.count()).toBe(12);
  });

  it("prepending days with the same slots shifts every position by a constant", () => {
    const later = [...day(1, [13, 14, 15]), ...day(2, [13, 15])];
    const all = [...day(0, [13, 14, 15]), ...later];
    const a = buildSlotGrid(later, utcAnchors(all))!;
    const b = buildSlotGrid(all, utcAnchors(all))!;
    const shift = b.pos[3] - a.pos[0];
    a.pos.forEach((p, k) => expect(b.pos[k + 3] - p).toBe(shift));
  });

  it("two candles in one slot still get increasing positions", () => {
    // Mostly hourly, with one extra stamp inside the 13:00 slot.
    const t = day(0, [13, 14, 15, 16, 17]);
    const g = grid([t[0], t[0] + 1_800_000, ...t.slice(1)])!;
    for (let k = 1; k < g.n; k++) expect(g.pos[k]).toBeGreaterThan(g.pos[k - 1]);
  });

  it("a stray stamp on a 24h market does not shift later candles", () => {
    // 4H bars round the clock for three days, plus one extra 21:00 stamp on day 0.
    const four = (d: number) => day(d, [0, 4, 8, 12, 16, 20]);
    const g = grid([...four(0), 0 * DAY + 21 * HOUR, ...four(1), ...four(2)])!;
    expect(g.perDay).toBe(6);
    expect(g.pos[7]).toBe(6); // day 1's 00:00 candle starts day 1
    expect(g.pos[g.n - 1]).toBe(17);
    expect(g.pos[6]).toBeGreaterThan(g.pos[5]);
    expect(g.pos[6]).toBeLessThan(6);
  });

  it("no grid for one candle or a daily chart", () => {
    expect(grid(day(0, [13]))).toBeNull();
    expect(grid([0, DAY, 2 * DAY])).toBeNull();
  });

  it("no grid without the broker's day and week starts", () => {
    const t = day(0, [13, 14, 15]);
    expect(buildSlotGrid(t)).toBeNull();
    expect(buildSlotGrid(t, { dayStarts: [0] })).toBeNull();
    expect(buildSlotGrid(t, { weekStarts: [0] })).toBeNull();
  });
});

describe("broker days and equal weeks", () => {
  const D0 = Date.UTC(2026, 10, 2); // Monday
  const at = (d: number, h: number) => D0 + d * DAY + h * HOUR;
  const hrs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k);
  const stock = (days: number[]) => days.flatMap((d) => hrs(14, 20).map((h) => at(d, h)));
  const weekdays = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
  const mondays = [at(0, 0), at(7, 0)];
  // Hourly round the clock except 22:00, Sun 23:00 to Fri `endH`; the
  // broker's days start at 22:00 the evening before.
  const fx = (endH = 21) => {
    const out: number[] = [];
    for (let t = at(-1, 23); t <= at(4, endH); t += HOUR) if (new Date(t).getUTCHours() !== 22) out.push(t);
    return out;
  };
  const fxDays = [-1, 0, 1, 2, 3].map((d) => at(d, 22));

  it("stock days with no holidays keep today's positions", () => {
    const g = buildSlotGrid(stock(weekdays), { dayStarts: weekdays.map((d) => at(d, 0)), weekStarts: mondays })!;
    expect(g.perDay).toBe(7);
    expect(g.perWeek).toBe(35);
    expect(g.pos).toEqual(Array.from({ length: 70 }, (_, k) => k));
  });

  it("a holiday is an empty column", () => {
    const days = weekdays.filter((d) => d !== 7);
    const t = stock(days);
    const g = buildSlotGrid(t, { dayStarts: days.map((d) => at(d, 0)), weekStarts: mondays })!;
    expect(g.pos[t.indexOf(at(8, 14))]).toBe(5 * 7 + 7);
  });

  it("FX days follow the broker's 22:00 starts", () => {
    const t = fx();
    const g = buildSlotGrid(t, { dayStarts: fxDays, weekStarts: [at(-1, 22)] })!;
    expect(g.perDay).toBe(23);
    expect(g.perWeek).toBe(5 * 23);
    // Sunday 23:00 opens Monday's column, Monday 00:00 is the next slot.
    expect(g.pos[0]).toBe(0);
    expect(g.pos[t.indexOf(at(0, 0))]).toBe(1);
    expect(g.pos[t.indexOf(at(0, 23))]).toBe(23); // Tuesday's first slot
  });

  it("a weekly bar stamped Monday 00:00 still holds Monday's day that began Sunday 22:00", () => {
    const t = fx();
    const a = buildSlotGrid(t, { dayStarts: fxDays, weekStarts: [at(-1, 22)] })!;
    const b = buildSlotGrid(t, { dayStarts: fxDays, weekStarts: [at(0, 0)] })!;
    expect(b.pos).toEqual(a.pos);
  });

  it("candles past the last day start step on in whole days, older ones step back", () => {
    const t = stock(weekdays);
    // The broker's bars cover only Tuesday to Thursday of week 1.
    const g = buildSlotGrid(t, { dayStarts: [at(1, 0), at(2, 0), at(3, 0)], weekStarts: [at(0, 0)] })!;
    const full = buildSlotGrid(t, { dayStarts: weekdays.map((d) => at(d, 0)), weekStarts: mondays })!;
    expect(g.pos).toEqual(full.pos);
  });

  it("timeAt gives the time of an empty slot, null on a candle's own slot", () => {
    const days = weekdays.filter((d) => d !== 7); // Monday of week 2 is a holiday
    const t = stock(days).filter((x) => x !== at(1, 16)); // a missing hour on Tuesday
    const g = buildSlotGrid(t, { dayStarts: days.map((d) => at(d, 0)), weekStarts: mondays })!;
    expect(g.timeAt(g.pos[0])).toBeNull();
    expect(g.timeAt(7 + 2)).toBe(at(1, 16)); // Tuesday's empty 16:00 slot
    expect(g.timeAt(35 + 3)).toBe(at(7, 17)); // the holiday column
    expect(g.timeAt(-1)).toBeNull(); // before the first candle: left to the chart
    expect(g.timeAt(g.pos[g.n - 1] + 1)).toBeNull(); // after the last
  });

  it("timeAt on FX follows the broker's 22:00 day starts", () => {
    const t = fx().filter((x) => x !== at(1, 5));
    const g = buildSlotGrid(t, { dayStarts: fxDays, weekStarts: [at(-1, 22)] })!;
    // Tuesday's column starts Monday 22:00 (first slot 23:00); 05:00 is slot 6.
    expect(g.timeAt(23 + 6)).toBe(at(1, 5));
  });

  it("a first week opening mid-week keeps weeks on multiples of perWeek", () => {
    const days = [2, 3, 4, 7, 8];
    const g = buildSlotGrid(stock(days), { dayStarts: weekdays.map((d) => at(d, 0)), weekStarts: mondays })!;
    expect(g.pos[0]).toBe(2 * 7);
    expect(g.pos[3 * 7]).toBe(g.perWeek); // Monday of week 2
  });
});

describe("slotGridFor and the chart's source", () => {
  afterEach(() => {
    setEqualWidthDays(false);
    vi.useRealTimers();
  });
  const provider = () =>
    (globalThis as { __chartkarSlots?: (l: unknown, c?: unknown) => unknown }).__chartkarSlots!;
  const listOf = (t: number[]) => t.map((timestamp) => ({ timestamp }));
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("no grid until the chart's starts arrive, then the grid", async () => {
    setEqualWidthDays(true);
    const chart = {};
    const t = [...day(0, [13, 14, 15]), ...day(1, [13])];
    const list = listOf(t);
    const source = vi.fn(async () => utcAnchors(t));
    setSlotSource(chart, source);
    expect(provider()(list, chart)).toBeNull();
    expect(provider()(list, chart)).toBeNull(); // still in flight: asked once
    expect(source).toHaveBeenCalledTimes(1);
    const [fromMs, toMs] = source.mock.calls[0] as unknown as [number, number];
    expect(fromMs).toBeLessThanOrEqual(t[0]);
    expect(toMs).toBeGreaterThanOrEqual(t[t.length - 1]);
    await flush();
    expect(slotGridFor(list)!.pos).toEqual([0, 1, 2, 3]);
  });

  it("an answer reaching before the first candle does not ask again", async () => {
    setEqualWidthDays(true);
    const chart = {};
    const t = day(14, [13, 14, 15]);
    const list = listOf(t);
    // The broker answers with every day in the asked range (some before the
    // first candle), but none for the candles' own newest day.
    const source = vi.fn(async (f: number) => {
      const days: number[] = [];
      for (let d = Math.ceil(f / DAY); d <= 13; d++) days.push(d * DAY);
      return { dayStarts: days, weekStarts: days.filter((d) => (d / DAY + 3) % 7 === 0) };
    });
    setSlotSource(chart, source);
    for (let k = 0; k < 5; k++) {
      provider()(list, chart);
      await flush();
    }
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("a failed load is not asked again within a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setEqualWidthDays(true);
    const chart = {};
    const list = listOf(day(0, [13, 14, 15]));
    const source = vi.fn(async (): Promise<SlotAnchors | null> => null);
    setSlotSource(chart, source);
    provider()(list, chart);
    await flush();
    expect(provider()(list, chart)).toBeNull();
    expect(source).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    provider()(list, chart);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("older candles than the known starts ask for more, and the starts merge", async () => {
    setEqualWidthDays(true);
    const chart = {};
    const newer = day(7, [13, 14]);
    const older = day(-14, [13, 14]);
    const source = vi.fn(async (f: number, to: number) => utcAnchors([...older, ...newer].filter((x) => x >= f && x <= to)));
    setSlotSource(chart, source);
    provider()(listOf(newer), chart);
    await flush();
    const both = listOf([...older, ...newer]);
    provider()(both, chart);
    expect(source).toHaveBeenCalledTimes(2);
    expect((source.mock.calls[1] as unknown as [number])[0]).toBeLessThanOrEqual(older[0]);
    await flush();
    expect(slotAnchorsOf(chart)?.dayStarts).toEqual([-14 * DAY, 7 * DAY]);
  });

  it("a range the broker answered is not asked again as live candles arrive", async () => {
    setEqualWidthDays(true);
    const chart = {};
    // The broker's daily history starts after the first loaded candle, so the
    // starts can never cover every candle.
    const t = [...day(0, [13, 14]), ...day(5, [13, 14])];
    const source = vi.fn(async () => utcAnchors(day(5, [13])));
    setSlotSource(chart, source);
    provider()(listOf(t), chart);
    await flush();
    for (let h = 15; h < 20; h++) {
      provider()(listOf([...t, ...day(5, [h])]), chart);
      await flush();
    }
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("relayout on a chart with no candles only runs the change", () => {
    const relayout = vi.fn();
    const chart = { _chartStore: { chartkarRelayoutSlots: relayout, getDataList: () => [] } };
    const change = vi.fn();
    relayoutSlots(chart, change);
    expect(change).toHaveBeenCalledTimes(1);
    expect(relayout).not.toHaveBeenCalled();
  });

  it("a new source (symbol change) drops the old starts", () => {
    const chart = {};
    setSlotAnchors(chart, "x", { dayStarts: [1], weekStarts: [1] });
    setSlotSource(chart, async () => null);
    expect(slotAnchorsOf(chart)).toBeUndefined();
  });

  it("anchors of one chart never reach another", () => {
    const a = {};
    setSlotAnchors(a, "x", { dayStarts: [10], weekStarts: [10] });
    expect(slotAnchorsOf({})).toBeUndefined();
  });

  it("the installed provider never throws and falls back to null", () => {
    setEqualWidthDays(true);
    const p = provider();
    expect(p(null)).toBeNull();
    expect(p([{ timestamp: NaN }, { timestamp: NaN }])).toBeNull();
    expect(p([null, null, null])).toBeNull();
    const bad = { get timestamp(): number { throw new Error("boom"); } };
    expect(p([bad, bad])).toBeNull();
    expect(p([bad, bad], {})).toBeNull();
    setEqualWidthDays(false);
    expect((globalThis as { __chartkarSlots?: unknown }).__chartkarSlots).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { buildSlotGrid, setEqualWidthDays, slotGridFor } from "./equalWidthDays";

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

  it("no grid for one candle or a daily chart", () => {
    expect(buildSlotGrid(day(0, [13]))).toBeNull();
    expect(buildSlotGrid([0, DAY, 2 * DAY])).toBeNull();
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
});

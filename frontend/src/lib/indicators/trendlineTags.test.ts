import { describe, expect, it } from "vitest";
import {
  clearTagRow, fanInnerLines, fanMerge, fanTolerance, selectLevels, strengthRank, trendlineStatsLabel, type TrendLine,
} from "./trendlines";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";

describe("clearTagRow", () => {
  it("keeps the requested row when nothing is there", () => {
    expect(clearTagRow([], 100, 50, 40)).toBe(50);
  });

  it("drops below a tag that shares the row and x range", () => {
    const placed = [{ x: 100, y: 50, w: 40 }];
    expect(clearTagRow(placed, 105, 52, 40)).toBe(66);
  });

  it("does not move for a tag on a different x range", () => {
    const placed = [{ x: 100, y: 50, w: 40 }];
    expect(clearTagRow(placed, 200, 52, 40)).toBe(52);
  });

  it("takes the nearest free row, above when that is closer", () => {
    const placed = [
      { x: 100, y: 50, w: 40 },
      { x: 100, y: 64, w: 40 },
    ];
    expect(clearTagRow(placed, 100, 50, 40)).toBe(36);
  });

  it("still spells the tag", () => {
    expect(trendlineStatsLabel(3, 1)).toBe("3 ○ 1 ●");
  });

  it("appends the strength rank when given one", () => {
    expect(trendlineStatsLabel(3, 1, 5)).toBe("3 ○ 1 ● #5");
    expect(trendlineStatsLabel(2, 0, 1)).toBe("2 ○ #1");
  });
});

describe("clearTagRow near the pane bottom", () => {
  it("moves up when the rows below run past the pane", () => {
    const placed = [{ x: 100, y: 95, w: 40 }];
    expect(clearTagRow(placed, 100, 95, 40, 100)).toBe(81);
  });
  it("keeps its own y when nothing is free", () => {
    const placed = Array.from({ length: 20 }, (_, i) => ({ x: 100, y: i * 14, w: 40 }));
    expect(clearTagRow(placed, 100, 48, 40, 200)).toBe(48);
  });
});

describe("strengthRank", () => {
  const line = (touches: number, i1: number, crossings: number): TrendLine =>
    ({ i1, p1: 100, i2: i1 + 10, p2: 100, touches, lastTouchIdx: 200, crossings, touchIdxs: [] }) as unknown as TrendLine;

  it("orders by pivots, then span, then fewest crossings", () => {
    const strong = line(4, 0, 5);
    const long = line(2, 0, 9);
    const clean = line(2, 100, 1);
    const pool = [clean, long, strong];
    expect(strengthRank(pool, strong)).toBe(1);
    expect(strengthRank(pool, long)).toBe(2);
    expect(strengthRank(pool, clean)).toBe(3);
  });

  it("gives a line outside the pool the place it would take", () => {
    expect(strengthRank([line(3, 0, 0)], line(5, 0, 0))).toBe(1);
  });
});

describe("fanMerge", () => {
  // A line from (i1, p1) to the shared pivot at bar 100, price 50.
  const ray = (i1: number, p1: number, touches = 2, extra: number[] = []): TrendLine =>
    ({
      i1, p1, i2: 100, p2: 50, touches, lastTouchIdx: 100, crossings: 0, touchIdxs: [i1, 100, ...extra],
    }) as unknown as TrendLine;
  const band = (over: Partial<typeof TRENDLINES_DEFAULTS>) =>
    fanTolerance({ ...TRENDLINES_DEFAULTS, ...over }, 1)!;

  it("is off when both boxes are", () => {
    expect(fanTolerance(TRENDLINES_DEFAULTS, 1)).toBeNull();
  });

  it("keeps the strongest of lines through one pivot at nearly one angle", () => {
    // Slopes -0.5 and -0.52 per bar: 0.02 apart, inside a 0.05 band.
    const weak = ray(0, 100);
    const strong = ray(50, 76, 3, [70]);
    expect(fanMerge([weak, strong], 100, 50, band({ fanAtr: 0.05 }))).toEqual([strong]);
  });

  it("keeps the nearest instead when asked", () => {
    const a = ray(0, 100);
    const b = ray(50, 76, 3, [70]);
    // At bar 110 a is at 45 and b at 44.8: with the close at 46, a is nearer.
    expect(fanMerge([b, a], 110, 46, band({ fanAtr: 0.05, fanKeep: 1 }))).toEqual([a]);
  });

  it("leaves lines meeting at a pivot from different angles", () => {
    const steep = ray(0, 150);
    const flat = ray(0, 60);
    expect(fanMerge([steep, flat], 100, 50, band({ fanAtr: 0.05 }))).toEqual([steep, flat]);
  });

  it("never merges lines with no bar in common", () => {
    const a = ray(0, 100);
    const b = { ...ray(0, 100), touchIdxs: [1, 99] } as TrendLine;
    expect(fanMerge([a, b], 100, 50, band({ fanAtr: 1 }))).toEqual([a, b]);
  });

  it("measures the percent band against the kept line's slope", () => {
    const strong = ray(50, 75, 3); // -0.5 per bar
    const near = ray(0, 110); // -0.6 per bar: 20% off
    expect(fanMerge([strong, near], 100, 50, band({ fanPct: 25 }))).toEqual([strong]);
    expect(fanMerge([strong, near], 100, 50, band({ fanPct: 15 }))).toEqual([strong, near]);
  });
});

describe("fanInnerLines", () => {
  const ray = (i1: number, p1: number): TrendLine =>
    ({ i1, p1, i2: 100, p2: 50, touchIdxs: [i1, 100] }) as unknown as TrendLine;

  it("dims the lines between a fan's steepest and flattest member", () => {
    const steep = ray(0, 150);
    const mid = ray(0, 100);
    const flat = ray(0, 60);
    expect([...fanInnerLines([mid, steep, flat])]).toEqual([mid]);
  });

  it("leaves two lines alone: both are edges", () => {
    expect(fanInnerLines([ray(0, 150), ray(0, 60)]).size).toBe(0);
  });
});

describe("selectLevels with Keep the strongest at a pivot", () => {
  // Three lines through bar 100: the nearest is the weakest.
  const at = (i1: number, p1: number, touches: number): TrendLine =>
    ({ i1, p1, i2: 100, p2: 50, touches, lastTouchIdx: 100, crossings: 0, touchIdxs: [i1, 100] }) as unknown as TrendLine;
  const near = at(90, 51, 2);
  const mid = at(50, 70, 3);
  const strong = at(0, 120, 5);

  it("keeps the nearest by default and the strongest when asked", () => {
    const walk = [near, mid, strong];
    expect(selectLevels(walk, 100, 0, 1, 0)).toEqual([near]);
    expect(selectLevels(walk, 100, 0, 1, 0, undefined, true)).toEqual([strong]);
    expect(selectLevels(walk, 100, 0, 2, 0, undefined, true)).toEqual([mid, strong]);
  });
});

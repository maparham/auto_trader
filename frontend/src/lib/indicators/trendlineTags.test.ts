import { describe, expect, it } from "vitest";
import { clearTagRow, strengthRank, trendlineStatsLabel, type TrendLine } from "./trendlines";

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

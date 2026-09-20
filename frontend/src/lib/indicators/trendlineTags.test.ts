import { describe, expect, it } from "vitest";
import { clearTagRow, trendlineStatsLabel } from "./trendlines";

describe("clearTagRow", () => {
  it("keeps the requested row when nothing is there", () => {
    expect(clearTagRow([], 100, 50, 40)).toBe(50);
  });

  it("drops below a tag that shares the row and x range", () => {
    const placed = [{ x: 100, y: 50, w: 40 }];
    expect(clearTagRow(placed, 105, 52, 40)).toBe(64);
  });

  it("does not move for a tag on a different x range", () => {
    const placed = [{ x: 100, y: 50, w: 40 }];
    expect(clearTagRow(placed, 200, 52, 40)).toBe(52);
  });

  it("skips past a stack of tags", () => {
    const placed = [
      { x: 100, y: 50, w: 40 },
      { x: 100, y: 62, w: 40 },
    ];
    expect(clearTagRow(placed, 100, 50, 40)).toBe(74);
  });

  it("still spells the tag", () => {
    expect(trendlineStatsLabel(3, 1)).toBe("3 Pivots 1 Crossing");
  });
});

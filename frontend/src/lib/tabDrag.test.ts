import { describe, expect, it } from "vitest";
import {
  dropTarget,
  flowPositions,
  moveItem,
  previewDeltas,
  type Rect,
} from "./tabDrag";

const chip = (left: number, top: number, width = 60, height = 26): Rect => ({
  left,
  top,
  width,
  height,
});

describe("flowPositions", () => {
  it("lays a fitting row out at x offsets separated by the gap", () => {
    expect(flowPositions([60, 80, 40], 500, 6)).toEqual([
      { x: 0, row: 0 },
      { x: 66, row: 0 },
      { x: 152, row: 0 },
    ]);
  });

  it("wraps when the next chip would overflow the container", () => {
    // 60 + 6 + 80 = 146 > 140 → the second chip starts row 1.
    expect(flowPositions([60, 80], 140, 6)).toEqual([
      { x: 0, row: 0 },
      { x: 0, row: 1 },
    ]);
  });

  it("gives a chip wider than the container a row of its own", () => {
    expect(flowPositions([200, 60], 140, 6)).toEqual([
      { x: 0, row: 0 },
      { x: 0, row: 1 },
    ]);
  });
});

describe("moveItem", () => {
  it("moves rightward using original-array slots (App.reorderTab semantics)", () => {
    expect(moveItem(["a", "b", "c"], 0, 3)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "a", "c"]);
  });

  it("moves leftward", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("treats from and from+1 as no-op slots", () => {
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 2)).toEqual(["a", "b", "c"]);
  });
});

describe("previewDeltas", () => {
  // Three 60-wide chips in one row at x = 0 / 66 / 132 (gap 6).
  const rects = [chip(0, 0), chip(66, 0), chip(132, 0)];

  it("slides chips between the source and a rightward gap left by chip+gap", () => {
    // Move chip 0 past the end: chips 1 and 2 each slide left 66; the (hidden)
    // moved chip's own slot previews at the far right.
    expect(previewDeltas(rects, 500, 6, 0, 3)).toEqual([
      { dx: 132, dy: 0 },
      { dx: -66, dy: 0 },
      { dx: -66, dy: 0 },
    ]);
  });

  it("is all-zero for the no-op slots around the source chip", () => {
    expect(previewDeltas(rects, 500, 6, 1, 1)).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
    expect(previewDeltas(rects, 500, 6, 1, 2)).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });

  it("moves chips across a row boundary vertically by the row pitch", () => {
    // Container fits two 60-chips per row (60+6+60 = 126 ≤ 130); chip 2 sits
    // on row 1 at measured top 32 → row pitch = 26 + 6 = 32.
    const wrapped = [chip(0, 0), chip(66, 0), chip(0, 32)];
    // Move chip 2 to the front: chip 0 slides right, chip 1 wraps down.
    expect(previewDeltas(wrapped, 130, 6, 2, 0)).toEqual([
      { dx: 66, dy: 0 },
      { dx: -66, dy: 32 },
      { dx: 0, dy: -32 },
    ]);
  });
});

describe("dropTarget", () => {
  // Three 100-wide chips in one row at x = 0 / 106 / 212 (gap 6).
  const rects = [chip(0, 0, 100), chip(106, 0, 100), chip(212, 0, 100)];
  const never = () => false;
  const always = () => true;

  it("merges on the middle ~40% of another chip when allowed", () => {
    // x=156 is the exact center of chip 1 (frac 0.5).
    expect(dropTarget(rects, 156, 13, 0, always)).toEqual({ kind: "merge", index: 1 });
  });

  it("falls back to insertion when merge is not allowed", () => {
    // Center of chip 1 is at its midpoint → not left of it → insert after.
    expect(dropTarget(rects, 156, 13, 0, never)).toEqual({ kind: "insert", index: 2 });
  });

  it("never merges into the dragged chip itself", () => {
    // x=50 is the center of chip 0, which is the drag source.
    expect(dropTarget(rects, 50, 13, 0, always)).toEqual({ kind: "insert", index: 1 });
  });

  it("picks the nearest gap by chip midpoints, including past the last chip", () => {
    expect(dropTarget(rects, 10, 13, 2, never)).toEqual({ kind: "insert", index: 0 });
    expect(dropTarget(rects, 300, 13, 0, never)).toEqual({ kind: "insert", index: 3 });
  });

  it("targets the row under the cursor when the bar wraps", () => {
    const wrapped = [chip(0, 0, 100), chip(106, 0, 100), chip(0, 32, 100)];
    // y=45 is row 1's vertical center; x=200 is past chip 2's midpoint →
    // insert after the last chip of that row (slot 3 = the very end).
    expect(dropTarget(wrapped, 200, 45, 0, never)).toEqual({ kind: "insert", index: 3 });
  });
});

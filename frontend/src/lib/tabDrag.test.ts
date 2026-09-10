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
  // The floating clone of chip 0 with its center at cx (chips are 100x26).
  const float = (cx: number, cy = 13): Rect => chip(cx - 50, cy - 13, 100, 26);

  it("merges when the dragged chip lands aligned on another chip", () => {
    // Clone centered on chip 1 (center x = 156), cursor with it.
    expect(dropTarget(rects, 156, 13, 0, always, { drag: float(156) })).toEqual({
      kind: "merge",
      index: 1,
    });
  });

  it("does not merge on a chip the dragged one is only passing over", () => {
    // 20px off chip 1's center — the old middle-40% zone merged here, which is
    // what made reordering across the bar snap into a merge.
    expect(dropTarget(rects, 176, 13, 0, always, { drag: float(176) })).toEqual({
      kind: "insert",
      index: 2,
    });
  });

  it("holds an active merge through the looser tolerance", () => {
    // Clone 20px off center: outside the enter tolerance (14), inside the
    // hold (26). Cursor left on the chip, as it is once a merge is armed.
    const cur = { kind: "merge", index: 1 } as const;
    expect(dropTarget(rects, 156, 13, 0, always, { drag: float(176), current: cur })).toEqual({
      kind: "merge",
      index: 1,
    });
    // 30px off releases it.
    expect(dropTarget(rects, 156, 13, 0, always, { drag: float(186), current: cur })).toEqual({
      kind: "insert",
      index: 2,
    });
  });

  it("reads a cursor near a chip's border as an insertion beside it", () => {
    // Clone aligned on chip 1, but the cursor is up against chip 1's left
    // border — the user is pointing at the seam, so drop it there instead.
    expect(dropTarget(rects, 112, 13, 0, always, { drag: float(156) })).toEqual({
      kind: "insert",
      index: 1,
    });
  });

  it("keeps the merge band to the middle tenth of the chip", () => {
    // Clone aligned on chip 1, cursor at frac 0.42 — outside the band.
    expect(dropTarget(rects, 148, 13, 0, always, { drag: float(156) })).toEqual({
      kind: "insert",
      index: 1,
    });
    // Dead center is inside it.
    expect(dropTarget(rects, 156, 13, 0, always, { drag: float(156) })).toEqual({
      kind: "merge",
      index: 1,
    });
  });

  it("compares against chips at their drawn position when a preview shifted them", () => {
    const four = [chip(0, 0, 100), chip(106, 0, 100), chip(212, 0, 100), chip(318, 0, 100)];
    const deltas = previewDeltas(four, 1000, 6, 0, 3);
    // Chip 2 is drawn 106 left of its cached rect; aligning on where it is
    // DRAWN merges, aligning on its stale cached rect does not.
    const drawn = four[2].left + deltas[2].dx + 50;
    expect(dropTarget(four, drawn, 13, 0, always, { drag: float(drawn), deltas })).toEqual({
      kind: "merge",
      index: 2,
    });
    const cached = four[2].left + 50;
    expect(dropTarget(four, cached, 13, 0, always, { drag: float(cached), deltas })).toEqual({
      kind: "insert",
      index: 3,
    });
  });

  it("never merges without a floating chip rect", () => {
    expect(dropTarget(rects, 156, 13, 0, always)).toEqual({ kind: "insert", index: 2 });
  });

  it("falls back to insertion when merge is not allowed", () => {
    expect(dropTarget(rects, 156, 13, 0, never, { drag: float(156) })).toEqual({
      kind: "insert",
      index: 2,
    });
  });

  it("never merges into the dragged chip itself", () => {
    // The clone sits exactly on its own source chip at the start of a drag.
    expect(dropTarget(rects, 50, 13, 0, always, { drag: float(50) })).toEqual({
      kind: "insert",
      index: 1,
    });
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

  it("does not merge into a chip on another row the clone only overlaps sideways", () => {
    const wrapped = [chip(0, 0, 100), chip(106, 0, 100), chip(0, 32, 100)];
    // Cursor on row 1 inside chip 2, but the clone is still up on row 0.
    expect(dropTarget(wrapped, 40, 45, 1, always, { drag: chip(0, 0, 100, 26) })).toEqual({
      kind: "insert",
      index: 2,
    });
  });
});

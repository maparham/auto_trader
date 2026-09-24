// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { distToSegment, drawSelectGlow, isGrabDot, nearDot, nearLine, SELECT_GLOW_KEY, TOUCH_HANDLE_PX, TOUCH_SLOP_PX } from "./touchHitSlop";
import { cloneStyles } from "./overlays";

describe("touchHitSlop", () => {
  it("measures distance to the segment, clamped to its ends", () => {
    expect(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  it("accepts a finger within the slop of a horizontal line, rejects beyond it", () => {
    const line = { coordinates: [{ x: 0, y: 100 }, { x: 300, y: 100 }] };
    expect(nearLine({ x: 150, y: 100 + TOUCH_SLOP_PX }, line, TOUCH_SLOP_PX)).toBe(true);
    expect(nearLine({ x: 150, y: 100 + TOUCH_SLOP_PX + 1 }, line, TOUCH_SLOP_PX)).toBe(false);
  });

  it("checks every segment of every line in an array", () => {
    const lines = [
      { coordinates: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { coordinates: [{ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 100 }] },
    ];
    expect(nearLine({ x: 58, y: 80 }, lines, TOUCH_SLOP_PX)).toBe(true);
    expect(nearLine({ x: 80, y: 80 }, lines, TOUCH_SLOP_PX)).toBe(false);
  });

  it("tells klinecharts' bare-styled grab dots from overlay-drawn circles", () => {
    expect(isGrabDot({ color: "#1677ff" })).toBe(true);
    expect(isGrabDot({ style: "fill", color: "#1677ff" })).toBe(false);
    expect(isGrabDot(undefined)).toBe(false);
  });

  it("widens a small dot to the handle radius, keeps a bigger one as is", () => {
    const dot = { x: 100, y: 100, r: 6 };
    expect(nearDot({ x: 100 + TOUCH_HANDLE_PX, y: 100 }, dot, TOUCH_HANDLE_PX)).toBe(true);
    expect(nearDot({ x: 100 + TOUCH_HANDLE_PX + 1, y: 100 }, dot, TOUCH_HANDLE_PX)).toBe(false);
    expect(nearDot({ x: 130, y: 100 }, { x: 100, y: 100, r: 30 }, TOUCH_HANDLE_PX)).toBe(true);
  });

  it("paints the selection glow only on a flagged line", () => {
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      setLineDash: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => calls.push("stroke"),
    } as unknown as CanvasRenderingContext2D;
    const attrs = { coordinates: [{ x: 0, y: 0 }, { x: 10, y: 10 }] };
    drawSelectGlow(ctx, attrs, { color: "#f00", size: 1 });
    expect(calls).toEqual([]);
    drawSelectGlow(ctx, attrs, { color: "#f00", size: 1, [SELECT_GLOW_KEY]: true });
    expect(calls).toEqual(["save", "stroke", "restore"]);
    expect(ctx.lineWidth).toBe(7);
  });

  it("never lets the glow marker into a style snapshot", () => {
    expect(cloneStyles({ line: { color: "#f00", [SELECT_GLOW_KEY]: true } })).toEqual({ line: { color: "#f00" } });
  });
});

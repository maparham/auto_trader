import { describe, it, expect } from "vitest";
import { slopeHandles, hitSlopeHandle, STEM_PX } from "./slopeHandles";

// The knob/midpoint geometry is shared between the overlay PAINTER (customOverlays)
// and the ChartCore HIT-TESTER. If they ever computed it differently the click target
// wouldn't line up with the drawn knob, so both go through this one helper — tested here.
describe("slopeHandles", () => {
  it("puts the midpoint at the line center", () => {
    const h = slopeHandles({ x: 0, y: 100 }, { x: 100, y: 100 });
    expect(h.mid).toEqual({ x: 50, y: 100 });
  });

  it("offsets the rotate knob up a perpendicular stem", () => {
    // Horizontal line → stem points straight up (screen up = negative y).
    const h = slopeHandles({ x: 0, y: 100 }, { x: 100, y: 100 });
    expect(h.knob.x).toBeCloseTo(50, 5);
    expect(h.knob.y).toBeCloseTo(100 - STEM_PX, 5);
  });

  it("keeps the stem pointing up regardless of point order", () => {
    const a = slopeHandles({ x: 0, y: 100 }, { x: 100, y: 100 }).knob;
    const b = slopeHandles({ x: 100, y: 100 }, { x: 0, y: 100 }).knob;
    expect(a.y).toBeLessThan(100); // above the line
    expect(b.y).toBeLessThan(100);
    expect(a).toEqual(b);
  });

  it("stem length is STEM_PX from the midpoint", () => {
    const h = slopeHandles({ x: 0, y: 0 }, { x: 100, y: 100 });
    const d = Math.hypot(h.knob.x - h.mid.x, h.knob.y - h.mid.y);
    expect(d).toBeCloseTo(STEM_PX, 5);
  });

  it("hit-tests each handle by proximity", () => {
    const a = { x: 0, y: 100 };
    const b = { x: 100, y: 100 };
    const h = slopeHandles(a, b);
    expect(hitSlopeHandle(a, b, a)).toBe("a");
    expect(hitSlopeHandle(a, b, b)).toBe("b");
    expect(hitSlopeHandle(a, b, h.mid)).toBe("mid");
    expect(hitSlopeHandle(a, b, h.knob)).toBe("knob");
    expect(hitSlopeHandle(a, b, { x: 500, y: 500 })).toBe(null);
  });

  it("prioritizes the knob when handles are within tolerance of a point", () => {
    // A tiny line where mid and endpoints nearly coincide: knob still wins at its spot.
    const a = { x: 50, y: 100 };
    const b = { x: 51, y: 100 };
    const h = slopeHandles(a, b);
    expect(hitSlopeHandle(a, b, h.knob)).toBe("knob");
  });
});

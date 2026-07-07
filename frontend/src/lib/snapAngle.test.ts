import { describe, it, expect } from "vitest";
import { snapScreenAngle, snapSquare } from "./snapAngle";

const F = { x: 0, y: 0 };

describe("snapScreenAngle", () => {
  it("snaps a near-horizontal drag to a flat line (y unchanged from anchor)", () => {
    const r = snapScreenAngle(F, { x: 100, y: 10 });
    expect(r.y).toBeCloseTo(0, 6);
    // length preserved along the horizontal
    expect(r.x).toBeCloseTo(Math.hypot(100, 10), 6);
  });

  it("snaps a near-vertical drag to a vertical line (x back to anchor)", () => {
    const r = snapScreenAngle(F, { x: 5, y: 100 });
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo(Math.hypot(5, 100), 6);
  });

  it("snaps a ~45° drag to an exact diagonal (equal components)", () => {
    const r = snapScreenAngle(F, { x: 100, y: 90 });
    expect(r.x).toBeCloseTo(r.y, 6);
  });

  it("preserves the cursor distance from the anchor", () => {
    const moving = { x: 73, y: 41 };
    const r = snapScreenAngle(F, moving);
    expect(Math.hypot(r.x, r.y)).toBeCloseTo(Math.hypot(moving.x, moving.y), 6);
  });

  it("handles the negative diagonal quadrant", () => {
    const r = snapScreenAngle(F, { x: -80, y: -90 });
    expect(r.x).toBeCloseTo(r.y, 6);
    expect(r.x).toBeLessThan(0);
  });

  it("returns the anchor when there is no movement", () => {
    expect(snapScreenAngle(F, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("snaps about a non-origin anchor", () => {
    const fixed = { x: 50, y: 20 };
    const r = snapScreenAngle(fixed, { x: 150, y: 25 });
    expect(r.y).toBeCloseTo(20, 6); // flat relative to the anchor
  });
});

describe("snapSquare", () => {
  it("expands the smaller axis to match the larger (encloses the cursor)", () => {
    expect(snapSquare(F, { x: 100, y: 40 })).toEqual({ x: 100, y: 100 });
    expect(snapSquare(F, { x: 30, y: 80 })).toEqual({ x: 80, y: 80 });
  });

  it("keeps the drag direction in each axis", () => {
    expect(snapSquare(F, { x: -100, y: 40 })).toEqual({ x: -100, y: 100 });
    expect(snapSquare(F, { x: 30, y: -80 })).toEqual({ x: 80, y: -80 });
    expect(snapSquare(F, { x: -60, y: -20 })).toEqual({ x: -60, y: -60 });
  });

  it("snaps about a non-origin anchor", () => {
    expect(snapSquare({ x: 10, y: 10 }, { x: 110, y: 50 })).toEqual({ x: 110, y: 110 });
  });
});

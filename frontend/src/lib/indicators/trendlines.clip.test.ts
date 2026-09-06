// The draw-path segment clip: a ray pinned to a much higher timeframe projects
// maxProjBars in ITS timeframe, which on a 1m chart under a 1D pin is ~360k
// chart bars — endpoint coordinates millions of pixels off-canvas. Stroking
// that unclipped is what dropped pan/zoom to ~20fps (giant antialiased paths
// rasterized every frame), so the stroke must be clipped to the pane first.
import { describe, expect, it } from "vitest";
import { clipSegmentToRect } from "./trendlines";

describe("clipSegmentToRect", () => {
  it("returns a fully inside segment unchanged", () => {
    expect(clipSegmentToRect(10, 20, 300, 40, 0, 0, 900, 400)).toEqual([10, 20, 300, 40]);
  });

  it("clips a far-off-canvas ray endpoint onto the boundary with exact interpolation", () => {
    // From (100, 100) heading right-down; at x=900 the line's y is
    // 100 + (900-100) * slope. slope = (2_000_100-100)/(2_000_100-100) = 1.
    const seg = clipSegmentToRect(100, 100, 2_000_100, 2_000_100, 0, 0, 900, 400);
    expect(seg).not.toBeNull();
    const [ax, ay, bx, by] = seg as [number, number, number, number];
    expect([ax, ay]).toEqual([100, 100]);
    // Exits through y=400 first (y hits 400 at x=400, before x hits 900).
    expect(by).toBeCloseTo(400, 10);
    expect(bx).toBeCloseTo(400, 10);
  });

  it("clips both ends of a segment crossing the rect", () => {
    const seg = clipSegmentToRect(-1000, 200, 2000, 200, 0, 0, 900, 400);
    expect(seg).toEqual([0, 200, 900, 200]);
  });

  it("returns null for a segment that misses the rect entirely", () => {
    expect(clipSegmentToRect(-50, -1_000_000, 2_000_000, -5_000, 0, 0, 900, 400)).toBeNull();
    expect(clipSegmentToRect(1000, 0, 2000, 400, 0, 0, 900, 400)).toBeNull();
  });

  it("handles vertical and horizontal segments", () => {
    expect(clipSegmentToRect(100, -50, 100, 1000, 0, 0, 900, 400)).toEqual([100, 0, 100, 400]);
    expect(clipSegmentToRect(100, 100, 100, 200, 0, 0, 900, 400)).toEqual([100, 100, 100, 200]);
  });

  it("returns null for a degenerate point outside, the point for one inside", () => {
    expect(clipSegmentToRect(50, 50, 50, 50, 0, 0, 900, 400)).toEqual([50, 50, 50, 50]);
    expect(clipSegmentToRect(-5, 50, -5, 50, 0, 0, 900, 400)).toBeNull();
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { handleSpot, segAnchor, segPoint, spotNear } from "./MobileDrawingHandle";

describe("spotNear", () => {
  it("sits above the anchor", () => {
    expect(spotNear({ x: 200, y: 150 }, 400, 600)).toEqual({ x: 200, y: 106 });
  });
  it("drops below the anchor near the chart top", () => {
    expect(spotNear({ x: 200, y: 40 }, 400, 600)).toEqual({ x: 200, y: 84 });
  });
  it("clamps x inside the chart and hides off screen", () => {
    expect(spotNear({ x: 395, y: 300 }, 400, 600)).toEqual({ x: 382, y: 256 });
    expect(spotNear({ x: NaN, y: NaN }, 400, 600)).toBeNull();
    expect(spotNear({ x: 100, y: 700 }, 400, 600)).toBeNull();
    expect(spotNear({ x: 10, y: 10 }, 400, 60)).toBeNull();
  });
});

describe("handleSpot", () => {
  it("uses the topmost point that is on screen", () => {
    expect(handleSpot([{ x: 100, y: 300 }, { x: 200, y: 150 }, { x: 500, y: 100 }], 400, 600)).toEqual({ x: 200, y: 106 });
    expect(handleSpot([{ x: -5, y: 300 }], 400, 600)).toBeNull();
  });
});

describe("segment anchor", () => {
  it("rides the same fraction of the line when the line moves or one end moves", () => {
    const a = segAnchor({ x: 25, y: 2 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(a).toEqual({ i: 0, t: 0.25 });
    expect(segPoint(a, [{ x: 10, y: 50 }, { x: 110, y: 50 }])).toEqual({ x: 35, y: 50 });
    expect(segPoint(a, [{ x: 0, y: 0 }, { x: 200, y: 0 }])).toEqual({ x: 50, y: 0 });
  });
  it("picks the nearest segment and keeps a spot past the end (a ray's extension)", () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(segAnchor({ x: 98, y: 60 }, pts)).toEqual({ i: 1, t: 0.6 });
    expect(segAnchor({ x: 150, y: -40 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }]).t).toBe(1.5);
  });
});

import { describe, it, expect } from "vitest";
import { lineLevelNow } from "./lineAlertLevel";

const p = { tRef: 30, pRef: 13, slope: 0.5, anchors: { t1: 10, p1: 10, t2: 20, p2: 12 } };

describe("lineLevelNow", () => {
  it("projects from the reference bar to the newest bar", () => {
    expect(lineLevelNow(p, [10, 20, 30, 40, 50])).toBe(14);
  });
  it("falls back to the second anchor when the reference is not loaded", () => {
    expect(lineLevelNow({ ...p, tRef: 99 }, [10, 20, 30])).toBe(12.5);
  });
  it("null when nothing maps", () => {
    expect(lineLevelNow({ ...p, tRef: 99, anchors: { t1: 1, p1: 1, t2: 2, p2: 2 } }, [10, 20])).toBeNull();
  });
});

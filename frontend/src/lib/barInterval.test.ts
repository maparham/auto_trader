import { describe, it, expect } from "vitest";
import { minPositiveGap } from "./barInterval";

const MIN = 5 * 60_000; // 5-minute bars

describe("minPositiveGap", () => {
  it("returns the regular bar interval for evenly-spaced bars", () => {
    const times = [0, MIN, 2 * MIN, 3 * MIN];
    expect(minPositiveGap(times)).toBe(MIN);
  });

  it("ignores a huge trailing gap (the last-two-bars fragility)", () => {
    // The final two bars straddle a ~4h session break. The naive
    // `last - secondLast` gap would be 4h; the robust interval is still 5m.
    const times = [0, MIN, 2 * MIN, 2 * MIN + 4 * 60 * 60_000];
    const naiveLastGap = times[times.length - 1] - times[times.length - 2];
    expect(naiveLastGap).toBe(4 * 60 * 60_000);
    expect(minPositiveGap(times)).toBe(MIN);
  });

  it("ignores an interior weekend gap too", () => {
    const times = [0, MIN, MIN + 2 * 24 * 60 * 60_000, MIN + 2 * 24 * 60 * 60_000 + MIN];
    expect(minPositiveGap(times)).toBe(MIN);
  });

  it("returns null when there is no positive gap", () => {
    expect(minPositiveGap([])).toBeNull();
    expect(minPositiveGap([42])).toBeNull();
    expect(minPositiveGap([10, 10, 10])).toBeNull();
  });
});

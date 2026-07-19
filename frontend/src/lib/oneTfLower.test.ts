import { describe, it, expect } from "vitest";
import { oneTfLower } from "./feed";

describe("oneTfLower", () => {
  // Defaults span 1m,5m,15m,30m,1H,4H,1D,1W (no favorites needed).
  it("returns the next finer default below the current TF", () => {
    expect(oneTfLower("HOUR_4", [])?.resolution).toBe("HOUR"); // 4H -> 1H
    expect(oneTfLower("HOUR", [])?.resolution).toBe("MINUTE_30"); // 1H -> 30m
    expect(oneTfLower("MINUTE_5", [])?.resolution).toBe("MINUTE"); // 5m -> 1m
  });

  it("returns null at the floor (lowest enabled TF)", () => {
    expect(oneTfLower("MINUTE", [])).toBeNull(); // 1m is the default floor
  });

  it("includes pinned favorites in the ladder", () => {
    // Pin 3m (MINUTE_3): now 5m -> 3m instead of 5m -> 1m.
    expect(oneTfLower("MINUTE_5", ["MINUTE_3"])?.resolution).toBe("MINUTE_3");
    // And 3m -> 1m.
    expect(oneTfLower("MINUTE_3", ["MINUTE_3"])?.resolution).toBe("MINUTE");
  });

  it("skips live-only seconds favorites (no history to zoom into)", () => {
    // Pinning 30s (SECOND_30, liveOnly) must NOT make it the zoom target below 1m.
    expect(oneTfLower("MINUTE", ["SECOND_30"])).toBeNull();
  });

  it("finds the largest finer TF even when current is off the quick bar", () => {
    // 2W (WEEK_2) not a default and not pinned: still step down to the largest
    // enabled period shorter than 2W, i.e. 1W.
    expect(oneTfLower("WEEK_2", [])?.resolution).toBe("WEEK");
  });
});

import { describe, expect, it } from "vitest";
import {
  PIVOT_BANDS_OUTPUTS,
  PIVOT_BANDS_REF_DEFAULTS,
  parsePivotBandsRefConfig,
  pivotBandsWarmup,
} from "./pivotBandsOutputs";

describe("PIVOT_BANDS_OUTPUTS", () => {
  it("pins the fixed output names, pivotHigh first", () => {
    expect(PIVOT_BANDS_OUTPUTS).toEqual([
      "pivotHigh",
      "pivotLow",
      "barsSinceHigh",
      "barsSinceLow",
    ]);
  });
});

describe("parsePivotBandsRefConfig", () => {
  it("takes every default from an empty params list", () => {
    expect(parsePivotBandsRefConfig([], {})).toEqual(PIVOT_BANDS_REF_DEFAULTS);
  });

  it("reads N/K positionally and mode from extendData", () => {
    expect(parsePivotBandsRefConfig([10, 3], { mode: "avg" })).toEqual({ n: 10, k: 3, mode: "avg" });
  });

  it("falls back on falsy/garbage params, mirroring Number(x) || default", () => {
    expect(parsePivotBandsRefConfig(["x", 0], {})).toEqual({ n: 5, k: 3, mode: "last" });
  });

  it("clamps to a floor of 1", () => {
    expect(parsePivotBandsRefConfig([-2, -5], {})).toEqual({ n: 1, k: 1, mode: "last" });
  });

  it("treats any non-'avg' mode as last", () => {
    expect(parsePivotBandsRefConfig([], { mode: "bogus" })).toEqual(PIVOT_BANDS_REF_DEFAULTS);
    expect(parsePivotBandsRefConfig([], null)).toEqual(PIVOT_BANDS_REF_DEFAULTS);
  });
});

describe("pivotBandsWarmup", () => {
  it("is the confirm lag N", () => {
    expect(pivotBandsWarmup({ n: 7, k: 3, mode: "last" })).toBe(7);
  });
});

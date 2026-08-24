import { describe, expect, it } from "vitest";
import {
  PIVOT_ANALYSIS_OUTPUTS,
  PIVOT_ANALYSIS_REF_DEFAULTS,
  parsePivotAnalysisRefConfig,
  pivotAnalysisWarmup,
} from "./pivotAnalysisOutputs";

describe("PIVOT_ANALYSIS_OUTPUTS", () => {
  it("pins the fixed output names, pivotHigh first", () => {
    expect(PIVOT_ANALYSIS_OUTPUTS).toEqual(["pivotHigh", "pivotLow", "deltaPct", "deltaT"]);
  });
});

describe("parsePivotAnalysisRefConfig", () => {
  it("defaults both lengths to 50 from an empty params list", () => {
    expect(parsePivotAnalysisRefConfig([])).toEqual(PIVOT_ANALYSIS_REF_DEFAULTS);
  });

  it("reads highLength/lowLength positionally, independently", () => {
    expect(parsePivotAnalysisRefConfig([34, 21])).toEqual({ nHigh: 34, nLow: 21 });
  });

  it("falls back on falsy/garbage params, mirroring Number(x) || default", () => {
    expect(parsePivotAnalysisRefConfig(["x", "y"])).toEqual({ nHigh: 50, nLow: 50 });
    expect(parsePivotAnalysisRefConfig([0, 0])).toEqual({ nHigh: 50, nLow: 50 });
  });

  it("clamps each side to a floor of 1", () => {
    expect(parsePivotAnalysisRefConfig([-5, -9])).toEqual({ nHigh: 1, nLow: 1 });
  });
});

describe("pivotAnalysisWarmup", () => {
  it("is the larger of the two confirm lags", () => {
    expect(pivotAnalysisWarmup({ nHigh: 34, nLow: 21 })).toBe(34);
    expect(pivotAnalysisWarmup({ nHigh: 21, nLow: 34 })).toBe(34);
  });
});

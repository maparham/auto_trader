import { describe, it, expect } from "vitest";
import {
  autoFibFibConfig,
  autoFibOutputs,
  autoFibWarmup,
  fibLevelPrice,
  fibOutputName,
  parseAutoFibConfig,
} from "./autoFibOutputs";
import { defaultFibConfig } from "../fibConfig";

describe("parseAutoFibConfig", () => {
  it("takes the defaults for missing or garbage slots", () => {
    expect(parseAutoFibConfig(undefined)).toEqual({ pivotLen: 5, minSwingAtr: 0 });
    expect(parseAutoFibConfig([0, -1])).toEqual({ pivotLen: 5, minSwingAtr: 0 });
    expect(parseAutoFibConfig(["x", NaN])).toEqual({ pivotLen: 5, minSwingAtr: 0 });
  });
  it("floors the pivot length and keeps a zero swing filter", () => {
    expect(parseAutoFibConfig([7.9, 0])).toEqual({ pivotLen: 7, minSwingAtr: 0 });
    expect(parseAutoFibConfig([3, 1.5])).toEqual({ pivotLen: 3, minSwingAtr: 1.5 });
  });
});

describe("fibOutputName", () => {
  // Same table as backend tests/test_auto_fib.py::test_fib_output_name.
  it.each([
    [0, "f0"],
    [0.236, "f0_236"],
    [0.5, "f0_5"],
    [0.618, "f0_618"],
    [1, "f1"],
    [1.618, "f1_618"],
    [-0.236, "fm0_236"],
    [10, "f10"],
    [0.03125, "f0_0313"],
    [1.005, "f1_005"],
    [-0.00001, "fm0"],
  ])("%s -> %s", (v, name) => {
    expect(fibOutputName(v)).toBe(name);
  });
  it("gives no name to huge or non-finite ratios", () => {
    expect(fibOutputName(1e6)).toBeNull();
    expect(fibOutputName(Infinity)).toBeNull();
    expect(fibOutputName(NaN)).toBeNull();
  });
});

describe("autoFibOutputs", () => {
  it("reads a pane with no fib key as the default levels, extended right", () => {
    expect(autoFibFibConfig({}).extend).toBe("right");
    expect(autoFibOutputs({})).toEqual([
      "high", "low", "dir", "f0", "f0_236", "f0_382", "f0_5", "f0_618", "f0_786", "f1",
    ]);
    expect(autoFibOutputs(undefined)).not.toContain("fm0_236");
  });
  it("reads a nulled fib (Cancel's removal) as no fib key", () => {
    expect(autoFibFibConfig({ fib: null }).extend).toBe("right");
    expect(autoFibFibConfig({ fib: null })).toEqual(autoFibFibConfig({}));
  });
  it("lists enabled levels only, in level order, first duplicate wins", () => {
    const fib = defaultFibConfig();
    fib.levels = [
      { value: 0.618, enabled: true, color: "#000" },
      { value: 0.618, enabled: true, color: "#111" },
      { value: 0.5, enabled: false, color: "#222" },
      { value: -0.236, enabled: true, color: "#333" },
    ];
    expect(autoFibOutputs({ fib })).toEqual(["high", "low", "dir", "f0_618", "fm0_236"]);
  });
});

describe("fibLevelPrice", () => {
  it("puts level 0 on the later anchor and level 1 on the earlier one", () => {
    // dir +1: the high is later (an up-leg), so 0 = high, 1 = low.
    expect(fibLevelPrice(110, 90, 1, false, 0)).toBe(110);
    expect(fibLevelPrice(110, 90, 1, false, 1)).toBe(90);
    expect(fibLevelPrice(110, 90, 1, false, 0.5)).toBe(100);
    // dir -1: the low is later.
    expect(fibLevelPrice(110, 90, -1, false, 0)).toBe(90);
    // reverse swaps the ends.
    expect(fibLevelPrice(110, 90, 1, true, 0)).toBe(90);
  });
});

describe("autoFibWarmup", () => {
  it("is ATR(14), one full pivot window and the pair reach", () => {
    expect(autoFibWarmup({ pivotLen: 5, minSwingAtr: 0 })).toBe(14 + 10 + 200);
  });
});

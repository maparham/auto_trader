import { describe, it, expect } from "vitest";
import { LR_OUTPUTS, lrSeries, lrWarmup, parseLrConfig } from "./lrOutputs";
import { EXPR_INSTANCE_TYPES, exprInstancesFor, exprWarmupByRef, synthesizeExprInstances } from "../exprInstances";
import { chartIndicatorToExprToken } from "../exprChartToken";
import { INDICATOR_SPECS } from "../expr/catalog";

const bar = (i: number, close: number) => ({ timestamp: i * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 1 });

describe("LR config", () => {
  it("mirrors the template defaults and ignores display keys", () => {
    expect(parseLrConfig([], {})).toEqual({ length: 100, mult: 2, source: "close" });
    expect(parseLrConfig([20, 1.5], { source: "hl2", lineHidden: { up: true } })).toEqual({ length: 20, mult: 1.5, source: "hl2" });
    expect(parseLrConfig([1, 0], { source: "bogus" })).toEqual({ length: 2, mult: 2, source: "close" });
  });
  it("falls back to defaults on a non-finite or boolean entry, like Python's _num", () => {
    expect(parseLrConfig(["Infinity"], {})).toEqual({ length: 100, mult: 2, source: "close" });
    expect(parseLrConfig([true], {})).toEqual({ length: 100, mult: 2, source: "close" });
  });
});

describe("LR rolling series", () => {
  it("is the endpoint of the fit over the trailing window", () => {
    const bars = [1, 2, 3, 4, 10].map((c, i) => bar(i, c));
    const cfg = parseLrConfig([3, 1], {});
    const lr = lrSeries(bars, cfg, "lr");
    expect(lr.slice(0, 2)).toEqual([null, null]);
    expect(lr[2]).toBeCloseTo(3, 12);
    expect(lr[3]).toBeCloseTo(4, 12);
    // window 3,4,10: slope 3.5, intercept 13/6, endpoint 13/6 + 7 = 55/6
    expect(lr[4]).toBeCloseTo(55 / 6, 12);
    expect(lrSeries(bars, cfg, "up")[3]).toBeCloseTo(4, 12); // a straight line has no residual
  });
  it("is blank for an output the pane does not expose, or a window longer than the bar count", () => {
    const bars = [1, 2, 3, 4, 10].map((c, i) => bar(i, c));
    expect(lrSeries(bars, parseLrConfig([3, 1], {}), "bogus")).toEqual(new Array(bars.length).fill(null));
    expect(lrSeries(bars, parseLrConfig([bars.length + 1, 1], {}), "lr")).toEqual(new Array(bars.length).fill(null));
  });
  it("warms up for `length` bars", () => {
    expect(lrWarmup(parseLrConfig([50], {}), "lr")).toBe(50);
    expect(lrWarmup(parseLrConfig([50], {}), "bogus")).toBe(0);
  });
});

describe("LR as a rule instance", () => {
  const live = [{ id: "LR", type: "LR", calcParams: [50, 2], extendData: { source: "hl2" } }];
  it("is referenceable with a bare id (not an expr function name)", () => {
    expect(EXPR_INSTANCE_TYPES.has("LR")).toBe(true);
    expect(Object.hasOwn(INDICATOR_SPECS, "LR")).toBe(false);
  });
  it("lists its three outputs and warms up per output", () => {
    expect(exprInstancesFor(live)).toEqual([
      { id: "LR", outputs: [...LR_OUTPUTS], timeframe: null, detail: "length 50 · 2x deviation · hl2" },
    ]);
    expect(exprWarmupByRef(live)("LR", "up")).toBe(50);
  });
  it("re-creates a missing pane with the template defaults, not a length", () => {
    expect(synthesizeExprInstances(["LR.lr > 0"], new Set())).toEqual({ LR: { type: "LR", calcParams: [], extendData: {} } });
  });
  it("turns a legend click into an instance ref", () => {
    expect(chartIndicatorToExprToken("LR", [50, 2], {}, { instanceId: "LR", figureKey: "dn" })).toBe("LR.dn");
    expect(chartIndicatorToExprToken("LR", [50, 2], {}, { instanceId: "LR" })).toBe("LR.lr");
  });
});

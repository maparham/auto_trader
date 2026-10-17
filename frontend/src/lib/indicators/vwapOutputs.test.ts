import { describe, it, expect } from "vitest";
import { VWAP_OUTPUTS, parseVwapRefConfig, vwapWarmup } from "./vwapOutputs";
import { EXPR_INSTANCE_TYPES, exprInstancesFor, exprWarmupByRef, synthesizeExprInstances } from "../exprInstances";
import { chartIndicatorToExprToken } from "../exprChartToken";
import { INDICATOR_SPECS } from "../expr/catalog";

describe("VWAP as a rule instance", () => {
  const live = [{ id: "VWAP", type: "VWAP", calcParams: [], extendData: { slopeColor: { enabled: true } } }];
  it("is referenceable with a bare id", () => {
    expect(EXPR_INSTANCE_TYPES.has("VWAP")).toBe(true);
    expect(Object.hasOwn(INDICATOR_SPECS, "VWAP")).toBe(false);
  });
  it("plain VWAP has fixed settings whatever extendData says", () => {
    const fixed = {
      source: "hlc3", bandMode: "stdev",
      bands: [{ on: true, mult: 1 }, { on: false, mult: 2 }, { on: false, mult: 3 }], anchorMs: 0,
    };
    expect(parseVwapRefConfig()).toEqual(fixed);
    // A hostile payload (the template never reads any of this): still ignored.
    expect(parseVwapRefConfig({
      source: "close", bandMode: "percentage", anchorTs: 123,
      bands: [{ on: true, mult: 99 }], evil: () => {},
    })).toEqual(fixed);
  });
  it("lists one output with no bar-count warm-up", () => {
    expect(exprInstancesFor(live)).toEqual([
      { id: "VWAP", outputs: [...VWAP_OUTPUTS], timeframe: null, detail: "hlc3 · from the first loaded bar" },
    ]);
    expect(vwapWarmup("vwap")).toBe(0);
    expect(exprWarmupByRef(live)("VWAP", "vwap")).toBe(0);
  });
  it("re-creates a missing pane with defaults", () => {
    expect(synthesizeExprInstances(["VWAP.vwap > 0"], new Set())).toEqual({ VWAP: { type: "VWAP", calcParams: [], extendData: {} } });
  });
  it("turns a click into an instance ref", () => {
    expect(chartIndicatorToExprToken("VWAP", [], {}, { instanceId: "VWAP" })).toBe("VWAP.vwap");
  });
});

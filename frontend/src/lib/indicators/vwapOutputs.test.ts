import { describe, it, expect } from "vitest";
import { VWAP_OUTPUTS, avwapOutputs, parseAvwapRefConfig, parseVwapRefConfig, vwapWarmup } from "./vwapOutputs";
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

describe("AVWAP", () => {
  it("stays out of the rule instance list so new panes keep the bare AVWAP id", () => {
    expect(EXPR_INSTANCE_TYPES.has("AVWAP")).toBe(false);
    expect(exprInstancesFor([{ id: "AVWAP", type: "AVWAP", calcParams: [1_700_000_000_000], extendData: {} }])).toEqual([]);
  });
  it("reads the anchor from calcParams[0] and the bands from extendData", () => {
    const cfg = parseAvwapRefConfig([1_700_000_000_000], {
      source: "close", bandMode: "percentage",
      bands: [{ on: true, mult: 1 }, { on: true, mult: 2.5 }, { on: false, mult: 3 }],
      lineHidden: { up1: true },
    });
    expect(cfg).toEqual({
      source: "close", bandMode: "percentage",
      bands: [{ on: true, mult: 1 }, { on: true, mult: 2.5 }, { on: false, mult: 3 }], anchorMs: 1_700_000_000_000,
    });
    expect(avwapOutputs(cfg)).toEqual(["vwap", "up1", "dn1", "up2", "dn2"]);
  });
  it("reads bands the way vwapFrom does", () => {
    // Any length; a missing index is off; `on` is truthy.
    expect(avwapOutputs(parseAvwapRefConfig([1], { bands: [] }))).toEqual(["vwap"]);
    expect(avwapOutputs(parseAvwapRefConfig([1], { bands: [{ on: 1, mult: 2 }] }))).toEqual(["vwap", "up1", "dn1"]);
    expect(parseAvwapRefConfig([1], { bands: [{ on: false, mult: 9 }] }).bands[0]).toEqual({ on: false, mult: 1 });
    // Not an array: the defaults (band 1 on).
    expect(avwapOutputs(parseAvwapRefConfig([1], { bands: "x" }))).toEqual(["vwap", "up1", "dn1"]);
  });
  it("treats a null mult as off, same as Python's _num (Ruling F3)", () => {
    const cfg = parseAvwapRefConfig([1], { bands: [{ on: true, mult: null }] });
    expect(cfg.bands[0]).toEqual({ on: false, mult: 1 });
    expect(avwapOutputs(cfg)).toEqual(["vwap"]);
  });
  it("falls back to the template defaults", () => {
    expect(parseAvwapRefConfig(undefined, undefined)).toEqual({
      source: "hlc3", bandMode: "stdev",
      bands: [{ on: true, mult: 1 }, { on: false, mult: 2 }, { on: false, mult: 3 }], anchorMs: 0,
    });
  });
});

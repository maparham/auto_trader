import { describe, it, expect } from "vitest";
import {
  collectExprInstances,
  exprInstancesFor,
  exprWarmupByRef,
  referencedInstanceIds,
} from "./exprInstances";

const LIVE = [
  { id: "SLOPE", type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctBar" } },
  { id: "SLOPE#a1b", type: "SLOPE", calcParams: [50], extendData: {} },
  { id: "EMA", type: "EMA", calcParams: [9], extendData: {} },
];

describe("referencedInstanceIds", () => {
  it("finds ids used in any row", () => {
    expect(referencedInstanceIds(["SLOPE.9 > 0", "SLOPE#a1b.50 < 0"]))
      .toEqual(new Set(["SLOPE", "SLOPE#a1b"]));
  });

  it("ignores registered function names", () => {
    expect(referencedInstanceIds(["EMA(9) > candle.close"])).toEqual(new Set());
  });

  it("ignores a bare instance name with no output", () => {
    expect(referencedInstanceIds(["SLOPE > 0"])).toEqual(new Set());
  });

  it("ignores a field read off a call result", () => {
    // The char before the dot is ")", so the id part can never match across it.
    expect(referencedInstanceIds(["EMA(9).signal > 0"])).toEqual(new Set());
  });

  it("ignores a decimal literal", () => {
    expect(referencedInstanceIds(["SLOPE.9 > 0.5"])).toEqual(new Set(["SLOPE"]));
  });

  it("ignores a dotted name that is itself a call", () => {
    expect(referencedInstanceIds(["SLOPE.rising(3)"])).toEqual(new Set());
  });

  it("reads through @tf and offsets", () => {
    // Grammatical input: offsets are backwards-only ([-1] = the previous bar),
    // and "1H" is the timeframe alias the catalog lists.
    expect(referencedInstanceIds(["SLOPE.21[-1]@1H > 0"])).toEqual(new Set(["SLOPE"]));
  });
});

describe("collectExprInstances", () => {
  it("ships only the instances the rows reference", () => {
    const out = collectExprInstances(LIVE, ["SLOPE.9 > 0"]);
    expect(Object.keys(out)).toEqual(["SLOPE"]);
    expect(out.SLOPE).toEqual({
      type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctBar" },
    });
  });

  it("ships nothing when no row references an instance", () => {
    expect(collectExprInstances(LIVE, ["EMA(9) > candle.close"])).toEqual({});
  });

  it("skips a referenced id that is not on the chart", () => {
    // The editor already flags this as unknown_indicator_ref; the request must
    // not invent an entry for it.
    expect(collectExprInstances(LIVE, ["GONE.9 > 0"])).toEqual({});
  });

  it("defaults missing calcParams / extendData", () => {
    const out = collectExprInstances([{ id: "SLOPE", type: "SLOPE" }], ["SLOPE.9 > 0"]);
    expect(out.SLOPE).toEqual({ type: "SLOPE", calcParams: [], extendData: {} });
  });
});

describe("exprInstancesFor (the editor's lint/completion list)", () => {
  it("derives a Slope pane's outputs from its live settings", () => {
    expect(exprInstancesFor([LIVE[0]])).toEqual([
      { id: "SLOPE", outputs: ["9", "21"], timeframe: null, detail: "EMA · % / bar" },
    ]);
  });

  it("adds the accel outputs to the PARENT when the companion is on", () => {
    expect(
      exprInstancesFor([
        { id: "SLOPE", type: "SLOPE", calcParams: [9], extendData: { showAccel: true } },
      ]),
    ).toEqual([{ id: "SLOPE", outputs: ["9", "accel9"], timeframe: null, detail: "EMA · % / hour" }]);
  });

  it("carries the pane's pinned timeframe", () => {
    expect(
      exprInstancesFor([
        { id: "SLOPE", type: "SLOPE", calcParams: [9], extendData: { mtf: { timeframe: "HOUR" } } },
      ]),
    ).toEqual([{ id: "SLOPE", outputs: ["9"], timeframe: "HOUR", detail: "EMA · % / hour" }]);
  });

  it("drops a pane that is not referenced by instance at all", () => {
    // An EMA is spelled EMA(9) in a rule, not EMA.something.
    expect(exprInstancesFor([LIVE[2]])).toEqual([]);
  });
});

describe("ATR instances", () => {
  const live = [
    { id: "ATR", type: "ATR", calcParams: [14], extendData: {} },
    { id: "ATR#b2", type: "ATR", calcParams: [21], extendData: { smoothing: "ema" } },
  ];
  it("exprInstancesFor lists ATR panes with their length-named output", () => {
    const out = exprInstancesFor(live);
    expect(out.map((i) => [i.id, i.outputs, i.timeframe, i.detail])).toEqual([
      ["ATR", ["14", "14.to%"], null, "RMA"],
      ["ATR#b2", ["21", "21.to%"], null, "EMA"],
    ]);
  });
  it("exprWarmupByRef costs the length for the real output, 0 otherwise", () => {
    const warm = exprWarmupByRef(live);
    expect(warm("ATR", "14")).toBe(14);
    expect(warm("ATR#b2", "21")).toBe(21);
    expect(warm("ATR", "9")).toBe(0);
    expect(warm("GONE", "14")).toBe(0);
  });
});

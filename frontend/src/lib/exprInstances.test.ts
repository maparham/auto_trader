import { describe, it, expect } from "vitest";
import {
  collectExprInstances,
  exprInstancesFor,
  exprWarmupByRef,
  missingExprInstances,
  referencedInstanceIds,
  rewriteInstanceRefs,
  synthesizeExprInstances,
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
    { id: "ATR#b2", type: "ATR", calcParams: [21], extendData: { smoothing: "ema", pctSource: "hl2" } },
  ];
  it("exprInstancesFor lists ATR panes with their length-named output", () => {
    const out = exprInstancesFor(live);
    expect(out.map((i) => [i.id, i.outputs, i.timeframe, i.detail])).toEqual([
      ["ATR", ["14", "14.to%"], null, "RMA · % of close"],
      ["ATR#b2", ["21", "21.to%"], null, "EMA · % of hl2"],
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

describe("rewriteInstanceRefs", () => {
  it("rewrites mapped instance refs, leaving output and the rest of the expression intact", () => {
    expect(rewriteInstanceRefs("SLOPE.9 > 0 and SLOPE.accel9 < 1", { SLOPE: "SLOPE2" }))
      .toBe("SLOPE2.9 > 0 and SLOPE2.accel9 < 1");
    expect(rewriteInstanceRefs("ATR1.to14 > 0.5", { ATR1: "ATR3" })).toBe("ATR3.to14 > 0.5");
  });
  it("leaves unmapped ids, candle fields, calls and decimals untouched", () => {
    const expr = "candle.close > EMA(9) + 0.5 and SLOPE#a1b.50 > 0";
    expect(rewriteInstanceRefs(expr, { OTHER: "X", candle: "nope" })).toBe(expr);
  });
  it("identity mappings are a no-op", () => {
    expect(rewriteInstanceRefs("SLOPE.9 > 0", { SLOPE: "SLOPE" })).toBe("SLOPE.9 > 0");
  });
});

describe("synthesizeExprInstances (legacy presets with no pane snapshot)", () => {
  it("builds a SLOPE payload with the referenced lengths as calcParams", () => {
    expect(synthesizeExprInstances(["SLOPE.9 > 0", "SLOPE.21 < 0"], new Set()))
      .toEqual({ SLOPE: { type: "SLOPE", calcParams: [9, 21], extendData: {} } });
  });

  it("an accel ref adds its length and turns the companion on", () => {
    expect(synthesizeExprInstances(["SLOPE.accel50 > 0"], new Set()))
      .toEqual({ SLOPE: { type: "SLOPE", calcParams: [50], extendData: { showAccel: true } } });
  });

  it("infers the type from suffixed and numbered ids", () => {
    expect(synthesizeExprInstances(["SLOPE#a1b.9 > 0", "ATR1.21 > 5"], new Set())).toEqual({
      "SLOPE#a1b": { type: "SLOPE", calcParams: [9], extendData: {} },
      ATR1: { type: "ATR", calcParams: [21], extendData: {} },
    });
  });

  it("falls back to the type defaults when no output names a length", () => {
    expect(synthesizeExprInstances(["SLOPE.accelfoo > 0"], new Set()))
      .toEqual({ SLOPE: { type: "SLOPE", calcParams: [9], extendData: {} } });
  });

  it("skips excluded ids, unknown types and candle", () => {
    expect(synthesizeExprInstances(
      ["SLOPE.9 > 0", "FOO.9 > 0", "candle.close > 0", "ATR1.14 > 1"],
      new Set(["SLOPE"]),
    )).toEqual({ ATR1: { type: "ATR", calcParams: [14], extendData: {} } });
  });

  it("dedupes repeated lengths and keeps reference order", () => {
    expect(synthesizeExprInstances(["SLOPE.21 > 0 and SLOPE.9 > 0 and SLOPE.accel21 < 1"], new Set()))
      .toEqual({ SLOPE: { type: "SLOPE", calcParams: [21, 9], extendData: { showAccel: true } } });
  });
});

describe("missingExprInstances (panes a run has to re-create)", () => {
  it("is empty when every referenced pane is live", () => {
    expect(missingExprInstances(LIVE, ["SLOPE.9 > 0", "SLOPE#a1b.50 < 0"])).toEqual({});
  });

  it("synthesizes only the referenced panes the chart no longer has", () => {
    expect(missingExprInstances(LIVE, ["SLOPE.9 > 0 and SLOPE2.50 > SLOPE2.100"])).toEqual({
      SLOPE2: { type: "SLOPE", calcParams: [50, 100], extendData: {} },
    });
  });

  it("a live pane of the same TYPE does not cover a different id", () => {
    expect(missingExprInstances(LIVE, ["ATR1.14 > 1"]))
      .toEqual({ ATR1: { type: "ATR", calcParams: [14], extendData: {} } });
  });

  it("skips refs whose id names no known indicator type", () => {
    expect(missingExprInstances(LIVE, ["SLOP2.9 > 0", "candle.close > 0"])).toEqual({});
  });

  it("an empty chart re-creates every referenced pane", () => {
    expect(missingExprInstances([], ["SLOPE.accel50 > 0"]))
      .toEqual({ SLOPE: { type: "SLOPE", calcParams: [50], extendData: { showAccel: true } } });
  });
});

describe("FVG instances", () => {
  const live = [
    { id: "FVG", type: "FVG", calcParams: [0.25, 500, 10], extendData: {} },
    {
      id: "FVG2",
      type: "FVG",
      calcParams: [0, 200, 3],
      extendData: { mtf: { timeframe: "HOUR" } },
    },
  ];

  it("lists FVG panes with their four fixed outputs and pinned timeframe", () => {
    expect(exprInstancesFor(live).map((i) => [i.id, i.outputs, i.timeframe, i.detail])).toEqual([
      [
        "FVG",
        ["bull_top", "bull_bottom", "bear_top", "bear_bottom"],
        null,
        "min 0.25x ATR · newest 10/side",
      ],
      [
        "FVG2",
        ["bull_top", "bull_bottom", "bear_top", "bear_bottom"],
        "HOUR",
        "min 0x ATR · newest 3/side",
      ],
    ]);
  });

  it("costs every real output the same warm-up floor, 0 for an unknown one", () => {
    const warm = exprWarmupByRef(live);
    expect(warm("FVG", "bull_top")).toBe(16);
    expect(warm("FVG", "bear_bottom")).toBe(16);
    expect(warm("FVG", "nope")).toBe(0);
    expect(warm("nosuch", "bull_top")).toBe(0);
  });

  it("synthesizes a default pane for a ref with no stored snapshot", () => {
    // FVG outputs are fixed names, so nothing about the params is recoverable —
    // an empty calcParams list makes the backend take every default.
    expect(synthesizeExprInstances(["FVG.bull_top > candle.close"], new Set())).toEqual({
      FVG: { type: "FVG", calcParams: [], extendData: {} },
    });
  });
});

describe("SR_LEVELS instances", () => {
  const live = [
    { id: "SR_LEVELS", type: "SR_LEVELS", calcParams: [11, 0.5, 2, 8, 500], extendData: {} },
    {
      id: "SR_LEVELS2",
      type: "SR_LEVELS",
      calcParams: [30, 1.5, 4, 3, 200],
      extendData: { mtf: { timeframe: "HOUR_4" } },
    },
  ];

  it("lists S/R panes with their two fixed outputs and pinned timeframe", () => {
    expect(exprInstancesFor(live).map((i) => [i.id, i.outputs, i.timeframe, i.detail])).toEqual([
      ["SR_LEVELS", ["support", "resistance"], null, "pivot 11 · 0.5x ATR · touches 2+"],
      ["SR_LEVELS2", ["support", "resistance"], "HOUR_4", "pivot 30 · 1.5x ATR · touches 4+"],
    ]);
  });

  it("costs both outputs the pane's own floor (ATR(14) + a full pivot window)", () => {
    const warm = exprWarmupByRef(live);
    expect(warm("SR_LEVELS", "support")).toBe(14 + 2 * 11);
    expect(warm("SR_LEVELS", "resistance")).toBe(14 + 2 * 11);
    expect(warm("SR_LEVELS2", "support")).toBe(14 + 2 * 30);
    expect(warm("SR_LEVELS", "nope")).toBe(0);
  });

  it("synthesizes a default pane for a ref with no stored snapshot", () => {
    // Fixed output names, so nothing about the params is recoverable from the
    // ref — an empty calcParams list makes the backend take every default.
    expect(synthesizeExprInstances(["candle.close > SR_LEVELS.support"], new Set())).toEqual({
      SR_LEVELS: { type: "SR_LEVELS", calcParams: [], extendData: {} },
    });
  });
});

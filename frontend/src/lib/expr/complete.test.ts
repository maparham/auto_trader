import { describe, it, expect } from "vitest";
import { completionAnchor, completionsFor } from "./complete";
import type { ExprInstance } from "./catalog";

describe("completionsFor", () => {
  it("suggests candle fields after 'candle.'", () => {
    const opts = completionsFor("candle.", 7).map((o) => o.label);
    expect(opts).toContain("close");
    expect(opts).toContain("wickTop");
    expect(opts).not.toContain("EMA");
  });
  it("suggests timeframes after '@'", () => {
    const opts = completionsFor("EMA(9)@", 7).map((o) => o.label);
    expect(opts).toContain("4H");
    expect(opts).toContain("D");
  });
  it("ranks indicators by prefix on a bare word", () => {
    const opts = completionsFor("EM", 2).map((o) => o.label);
    expect(opts[0]).toBe("EMA");
  });
  it("offers conditions on a bare prefix", () => {
    const labels = completionsFor("cou", 3).map((o) => o.label);
    expect(labels).toContain("count");
  });
  it("offers barsSinceEntry", () => {
    const labels = completionsFor("bars", 4).map((o) => o.label);
    expect(labels).toContain("barsSinceEntry");
  });
});

describe("infix cross completions", () => {
  it("offers x> and x< on the x prefix, ranked first", () => {
    const opts = completionsFor("EMA(9) x", 8);
    const labels = opts.map((o) => o.label);
    // prefix rank 3 beats everything; localeCompare tie-break puts x< first
    expect(labels[0]).toBe("x<");
    expect(labels[1]).toBe("x>");
  });

  it("keeps the infix operators in the bare-word candidate set", () => {
    const labels = completionsFor("", 0).map((o) => o.label);
    expect(labels).toContain("x>");
    expect(labels).toContain("crossAbove");
  });
});

describe("chart indicator instance references", () => {
  const instances: ExprInstance[] = [
    { id: "SLOPE", outputs: ["slope0", "accel0"], timeframe: null },
  ];

  it("completes instance references from the live chart", () => {
    const opts = completionsFor("SLO", 3, { instances }).map((c) => c.label);
    expect(opts).toContain("SLOPE.slope0");
    expect(opts).toContain("SLOPE.accel0");
  });

  it("offers no instance references when the chart has none", () => {
    const opts = completionsFor("SLO", 3, { instances: [] }).map((c) => c.label);
    expect(opts.every((l) => !l.includes("."))).toBe(true);
  });

  it("ranks chart instances below the static catalog", () => {
    const opts = completionsFor("slo", 3, { instances });
    // `slope` (the wrapper) is a catalog prefix match and must outrank a ref.
    expect(opts[0].label).toBe("slope");
    const ref = opts.find((c) => c.label === "SLOPE.slope0");
    expect(ref?.section).toEqual({ name: "Chart indicators", rank: 2 });
    expect(ref!.boost!).toBeLessThan(0);
  });

  it("filters outputs after the dot, keeping the whole ref as the label", () => {
    const opts = completionsFor("SLOPE.acc", 9, { instances }).map((c) => c.label);
    expect(opts).toEqual(["SLOPE.accel0"]);
  });

  it("offers a #-bearing instance id", () => {
    const withHash: ExprInstance[] = [
      { id: "SLOPE#a1b2c3", outputs: ["slope0"], timeframe: "4H" },
    ];
    const opts = completionsFor("SLOPE#a1b2c3.", 13, { instances: withHash });
    expect(opts.map((c) => c.label)).toEqual(["SLOPE#a1b2c3.slope0"]);
  });
});

describe("completionAnchor", () => {
  const instances: ExprInstance[] = [
    { id: "SLOPE#a1b2c3", outputs: ["slope0"], timeframe: null },
  ];

  it("anchors a dotted ref at the start of the instance id", () => {
    expect(completionAnchor("SLOPE#a1b2c3.slo", 16, { instances })).toBe(0);
  });

  it("anchors a partially typed #-bearing id at its start", () => {
    expect(completionAnchor("EMA(9) > SLOPE#a1", 17, { instances })).toBe(9);
  });

  it("still anchors a plain word at the word start", () => {
    expect(completionAnchor("EMA(9) > sl", 11)).toBe(9);
  });

  it("still anchors candle fields after the dot", () => {
    expect(completionAnchor("candle.cl", 9)).toBe(7);
  });

  it("still anchors a timeframe after the @", () => {
    expect(completionAnchor("EMA(9)@4", 8)).toBe(7);
  });
});

describe("instance-vs-candle precedence in the dot branch", () => {
  // The `candle.` branch matches on a bare suffix, so a pane whose id ENDS in
  // "candle" would otherwise be served candle fields instead of its outputs.
  // The instance branch runs first, and only when the base is a real pane.
  const instances: ExprInstance[] = [
    { id: "MYcandle", outputs: ["slope0"], timeframe: null },
  ];

  it("prefers the pane's outputs when the base names a real instance", () => {
    const opts = completionsFor("MYcandle.", 9, { instances }).map((c) => c.label);
    expect(opts).toEqual(["MYcandle.slope0"]);
    expect(opts).not.toContain("close");
  });

  it("anchors that ref at the start of the pane id, not after the dot", () => {
    expect(completionAnchor("MYcandle.", 9, { instances })).toBe(0);
  });

  it("still falls through to candle fields when the base is not an instance", () => {
    const opts = completionsFor("MYcandle.cl", 11, { instances: [] }).map((c) => c.label);
    expect(opts).toContain("close");
    expect(completionAnchor("MYcandle.cl", 11, { instances: [] })).toBe(9);
  });
});

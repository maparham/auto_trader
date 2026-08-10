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
  it("offers ATR% for the prefix ATR and keeps matching after the %", () => {
    expect(completionsFor("ATR", 3).map((o) => o.label)).toEqual(
      expect.arrayContaining(["ATR", "ATR%"]),
    );
    // Typing the % must keep the word anchored at 0 (replace, not append) and
    // rank the now-exact ATR% first instead of dropping to the empty prefix.
    expect(completionAnchor("ATR%", 4)).toBe(0);
    expect(completionsFor("ATR%", 4)[0].label).toBe("ATR%");
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

  it("selects the placeholder operand of the inserted operator", () => {
    // Regression pin for the anchor: it is derived from the operator's own
    // length, so accepting "x>" always lands the selection on "EMA(50)".
    const from = completionAnchor("EMA(9) x", 8)!;
    const cand = completionsFor("EMA(9) x", 8).find((c) => c.label === "x>")!;
    let spec: {
      changes: { from: number; to: number; insert: string };
      selection: { anchor: number; head: number };
    } | undefined;
    const view = { dispatch: (s: typeof spec) => { spec = s; } };
    // `apply` is a CM6 dispatch callback; drive it with a stub view rather than
    // standing up a live EditorView just to read back the selection.
    (cand.apply as (v: unknown, c: unknown, f: number, t: number) => void)(view, cand, from, 8);
    expect(spec!.changes.insert).toBe("x> EMA(50)");
    expect(
      spec!.changes.insert.slice(
        spec!.selection.anchor - from,
        spec!.selection.head - from,
      ),
    ).toBe("EMA(50)");
  });

  it("offers the boolean keywords after a complete condition", () => {
    // Trailing space -> no word prefix -> every candidate is offered; the
    // point is that and/or/not are IN the candidate set at all.
    const labels = completionsFor("candle.close > EMA(9) ", 22).map((o) => o.label);
    expect(labels).toContain("AND");
    expect(labels).toContain("OR");
    expect(labels).toContain("NOT");
  });

  it("ranks AND first on the bare prefix 'an' (case-insensitive)", () => {
    const opts = completionsFor("an", 2);
    expect(opts[0].label).toBe("AND");
    expect(opts[0].detail).toBe("Both conditions must hold");
  });

  it("inserts a boolean keyword with a trailing space and no selection", () => {
    const cand = completionsFor("an", 2).find((c) => c.label === "AND")!;
    expect(cand.apply).toBe("AND ");
  });

  it("keeps the infix operators in the bare-word candidate set", () => {
    const labels = completionsFor("", 0).map((o) => o.label);
    expect(labels).toContain("x>");
    expect(labels).toContain("crossAbove");
  });
});

describe("chart indicator instance references", () => {
  const instances: ExprInstance[] = [
    { id: "SLOPE", outputs: ["9", "accel9"], timeframe: null, detail: "SMA · % / hour" },
  ];

  it("completes instance references from the live chart", () => {
    const opts = completionsFor("SLO", 3, { instances }).map((c) => c.label);
    expect(opts).toContain("SLOPE.9");
    expect(opts).toContain("SLOPE.accel9");
  });

  it("offers no instance references when the chart has none", () => {
    const opts = completionsFor("SLO", 3, { instances: [] }).map((c) => c.label);
    expect(opts.every((l) => !l.includes("."))).toBe(true);
  });

  it("ranks chart instances below the static catalog", () => {
    const opts = completionsFor("slo", 3, { instances });
    // `slope` (the wrapper) is a catalog prefix match and must outrank a ref.
    expect(opts[0].label).toBe("slope");
    const ref = opts.find((c) => c.label === "SLOPE.9");
    expect(ref?.section).toEqual({ name: "Chart indicators", rank: 2 });
    expect(ref!.boost!).toBeLessThan(0);
  });

  it("filters outputs after the dot, keeping the whole ref as the label", () => {
    const opts = completionsFor("SLOPE.acc", 9, { instances }).map((c) => c.label);
    expect(opts).toEqual(["SLOPE.accel9"]);
  });

  // The label already carries the LENGTH, so the detail spends itself on what
  // the label cannot show: the MA kind and the units, in the same words the
  // chart legend and the settings modal use.
  it("shows the pane's MA kind and units as the detail, not a constant string", () => {
    const opts = completionsFor("SLOPE.", 6, { instances });
    expect(opts.map((c) => c.detail)).toEqual(["SMA · % / hour", "SMA · % / hour"]);
  });

  it("keeps a pinned pane's timeframe visible alongside the settings summary", () => {
    const pinned: ExprInstance[] = [
      { id: "SLOPE", outputs: ["9"], timeframe: "4H", detail: "EMA · Price / bar" },
    ];
    const opts = completionsFor("SLOPE.", 6, { instances: pinned });
    expect(opts.map((c) => c.detail)).toEqual(["EMA · Price / bar @4H"]);
  });

  it("offers a #-bearing instance id", () => {
    const withHash: ExprInstance[] = [
      { id: "SLOPE#a1b2c3", outputs: ["9"], timeframe: "4H", detail: "EMA · % / bar" },
    ];
    const opts = completionsFor("SLOPE#a1b2c3.", 13, { instances: withHash });
    expect(opts.map((c) => c.label)).toEqual(["SLOPE#a1b2c3.9"]);
  });
});

describe("completionAnchor", () => {
  const instances: ExprInstance[] = [
    { id: "SLOPE#a1b2c3", outputs: ["9"], timeframe: null },
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

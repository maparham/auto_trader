import { describe, it, expect } from "vitest";
import { literalAxisLabel, patchExprLiterals, reanchorRanges, sweepLiteralTarget } from "./sweepLiterals";

describe("sweep literals", () => {
  it("builds a lit: target path", () => {
    expect(sweepLiteralTarget("long", "entry", 0, 2)).toBe("lit:long.entry.0.2");
  });
  it("drops ranges on ordinals that vanished after an edit", () => {
    const prev = [{ ordinal: 0 }, { ordinal: 1 }] as any;
    const next = [{ ordinal: 0 }] as any;
    const ranges = { "lit:long.entry.0.0": {}, "lit:long.entry.0.1": {} };
    const { kept, dropped } = reanchorRanges(prev, next, ranges, "long", "entry", 0);
    expect(Object.keys(kept)).toEqual(["lit:long.entry.0.0"]);
    expect(dropped).toEqual(["lit:long.entry.0.1"]);
  });
  it("preserves ranges from other rows when editing one row", () => {
    const prev = [{ ordinal: 0 }, { ordinal: 1 }] as any;
    const next = [{ ordinal: 0 }] as any;
    const ranges = {
      "lit:long.entry.0.0": {},
      "lit:long.entry.0.1": {},
      "lit:short.exit.2.1": {},
    };
    const { kept, dropped } = reanchorRanges(prev, next, ranges, "long", "entry", 0);
    expect(Object.keys(kept)).toEqual([
      "lit:long.entry.0.0",
      "lit:short.exit.2.1",
    ]);
    expect(dropped).toEqual(["lit:long.entry.0.1"]);
  });
});

describe("literalAxisLabel", () => {
  it("renders the expression with the addressed literal as x", () => {
    expect(literalAxisLabel("EMA(50) > 30", 0)).toBe("EMA(x) > 30");
    expect(literalAxisLabel("EMA(50) > 30", 1)).toBe("EMA(50) > x");
  });
  it("tolerates a semantic (unknown chart indicator) error", () => {
    expect(literalAxisLabel("SLOPE.14>0.1", 0)).toBe("SLOPE.14>x");
  });
  it("returns empty for a missing ordinal or unparseable expression", () => {
    expect(literalAxisLabel("EMA(50) > 30", 5)).toBe("");
    expect(literalAxisLabel("EMA(50 >", 0)).toBe("");
  });
});

describe("patchExprLiterals", () => {
  it("substitutes a single literal by ordinal", () => {
    expect(patchExprLiterals("EMA(50) > 30", [{ ordinal: 0, value: 20 }])).toBe("EMA(20) > 30");
    expect(patchExprLiterals("EMA(50) > 30", [{ ordinal: 1, value: 45 }])).toBe("EMA(50) > 45");
  });
  it("substitutes multiple literals in one pass, spans staying aligned", () => {
    expect(
      patchExprLiterals("EMA(50) > 30", [
        { ordinal: 0, value: 200 },
        { ordinal: 1, value: 5 },
      ]),
    ).toBe("EMA(200) > 5");
  });
  it("writes decimals and negatives cleanly", () => {
    expect(patchExprLiterals("RSI(14) < 30.5", [{ ordinal: 1, value: 27.25 }])).toBe("RSI(14) < 27.25");
    // Float-noise near-zero flushes to 0 (same convention as fmtAxisValue).
    expect(patchExprLiterals("slope(EMA(20), 3) > 0.1", [{ ordinal: 2, value: 2.77e-17 }])).toBe(
      "slope(EMA(20), 3) > 0",
    );
  });
  it("patches despite a semantic (unknown chart indicator) error", () => {
    // A bare analyze() lacks the chart's indicator instances, so this valid
    // rule reports unknown_indicator_ref — spans are still extracted and the
    // patch must land (the browser apply-path regression).
    expect(patchExprLiterals("SLOPE.14>0.1", [{ ordinal: 0, value: -0.4 }])).toBe("SLOPE.14>-0.4");
  });
  it("keeps a wrapping unary minus for a positive value", () => {
    // The backend's substitute() replaces only the Num under the Unary node, so
    // the minus still applies to the swept value — the text must match that.
    expect(patchExprLiterals("SLOPE.14>-0.4", [{ ordinal: 0, value: 0.6 }])).toBe("SLOPE.14>-0.6");
  });
  it("folds a negative value into a wrapping unary minus", () => {
    // -(-0.8) evaluates to +0.8; write the folded form, not "--0.8"/"-(-0.8)".
    expect(patchExprLiterals("SLOPE.14>-0.4", [{ ordinal: 0, value: -0.8 }])).toBe("SLOPE.14>0.8");
    expect(patchExprLiterals("SLOPE.50<-1", [{ ordinal: 0, value: -1 }])).toBe("SLOPE.50<1");
    // Spaced unary minus folds too.
    expect(patchExprLiterals("RSI(14) < - 30", [{ ordinal: 1, value: -25 }])).toBe("RSI(14) < 25");
  });
  it("does not fold binary subtraction — parenthesizes instead", () => {
    expect(
      patchExprLiterals("candle.close - 0.4 > 0", [{ ordinal: 0, value: -0.8 }]),
    ).toBe("candle.close - (-0.8) > 0");
  });
  it("patches a bar offset with a positive value, skips a negative one", () => {
    // The offset's bracket minus is syntax, not a negation — a positive value
    // splices under it; a negative offset has no valid text form, so the
    // re-parse check reverts that patch (the backend would run int(-3), but a
    // corrupted expression in the editor is worse than skipping).
    expect(patchExprLiterals("EMA(20)[-2] > 30", [{ ordinal: 1, value: 3 }])).toBe("EMA(20)[-3] > 30");
    expect(patchExprLiterals("EMA(20)[-2] > 30", [{ ordinal: 1, value: -3 }])).toBe("EMA(20)[-2] > 30");
  });
  it("skips a spaced bar offset whose synthesized span is misaligned", () => {
    // "[ -2 ]": literalsOf synthesizes the span from the Offset node's end,
    // which points at the wrong characters when spaces precede "]" — splicing
    // there would corrupt the expression mid-token, so no NUMBER token matches
    // and the patch is skipped.
    expect(patchExprLiterals("EMA(20)[ -2 ] > 30", [{ ordinal: 1, value: 3 }])).toBe("EMA(20)[ -2 ] > 30");
  });
  it("applies valid patches even when another patch on the row is reverted", () => {
    expect(
      patchExprLiterals("EMA(20)[-2] > 30", [
        { ordinal: 0, value: 50 },
        { ordinal: 1, value: -3 },
      ]),
    ).toBe("EMA(50)[-2] > 30");
  });
  it("writes tiny values as plain decimals, never exponent notation", () => {
    // The expression lexer has no exponent syntax — "5e-7" would break the rule.
    expect(patchExprLiterals("candle.close > 0.001", [{ ordinal: 0, value: 5e-7 }])).toBe(
      "candle.close > 0.0000005",
    );
  });
  it("ignores an ordinal that no longer exists", () => {
    expect(patchExprLiterals("EMA(50) > 30", [{ ordinal: 5, value: 9 }])).toBe("EMA(50) > 30");
  });
  it("leaves an unparseable expression untouched", () => {
    expect(patchExprLiterals("EMA(50 >", [{ ordinal: 0, value: 9 }])).toBe("EMA(50 >");
  });
});

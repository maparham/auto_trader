import { describe, it, expect } from "vitest";
import { analyze, warmupOf } from "./parser";

describe("analyze", () => {
  it("finds numeric literals with ordinals and spans", () => {
    const { literals, error } = analyze("EMA(50) > candle.high + 3 * ATR(14)");
    expect(error).toBeNull();
    expect(literals.map((l) => [l.ordinal, l.value])).toEqual([
      [0, 50], [1, 3], [2, 14],
    ]);
    // span of the first literal (the "50") is [4,6)
    expect([literals[0].from, literals[0].to]).toEqual([4, 6]);
  });

  it("reports an unknown name with a span and matching code", () => {
    const { error } = analyze("FOO(9) > 0");
    expect(error?.code).toBe("unknown_name");
    expect([error?.from, error?.to]).toEqual([0, 6]);
  });

  it("reports nested @tf as a parse error", () => {
    expect(analyze("EMA(9)@4H@D > 0").error?.code).toBe("nested_tf");
  });

  it("reports entry in an implicit entry context only when asked", () => {
    // analyze is context-free for tokens; entry placement is validated with a flag
    expect(analyze("entry > candle.close", { isExit: false }).error?.code).toBe("entry_in_entry_rule");
    expect(analyze("candle.close < entry", { isExit: true }).error).toBeNull();
  });
});

describe("warmupOf", () => {
  it("takes an indicator's length", () => {
    expect(warmupOf("EMA(200) > candle.close")).toBe(200);
  });

  it("is 0 when only raw candle fields are compared", () => {
    expect(warmupOf("candle.close > candle.open")).toBe(0);
  });

  it("maxes across a cross's two sides", () => {
    expect(warmupOf("crossAbove(EMA(9), EMA(21))")).toBe(21);
  });

  it("adds a wrapper's window to its inner term", () => {
    // slope(x, n): inner EMA(9) = 9, window literal = 3, so 9 + 3 = 12.
    expect(warmupOf("slope(EMA(9), 3) > 0")).toBe(12);
  });

  it("adds a bar offset to its base and maxes against the other side", () => {
    // candle[-3] = 0 + 3 = 3, EMA(9) = 9, max = 9.
    expect(warmupOf("candle[-3].close > EMA(9)")).toBe(9);
  });

  it("returns 0 for empty or unparseable input without throwing", () => {
    expect(warmupOf("")).toBe(0);
    expect(warmupOf("EMA(")).toBe(0);
  });
});

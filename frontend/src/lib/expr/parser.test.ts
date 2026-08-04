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

  // @tf pins, mirroring warmup.py: with baseSeconds known a pin contributes
  // ZERO base bars — its series comes from backend-sourced (and sufficiency-
  // checked) higher-timeframe candles, never from the base history. Only terms
  // operating on the base-aligned series count.
  it("needs no base history for an @tf pin when baseSeconds is known", () => {
    expect(warmupOf("EMA(50)@1H > 0", 300)).toBe(0);
  });

  it("still counts the base side of a cross against a pin", () => {
    expect(warmupOf("crossAbove(EMA(9), EMA(50)@1H)", 300)).toBe(9);
  });

  it("passes an @tf pin through unscaled without baseSeconds (legacy callers)", () => {
    expect(warmupOf("EMA(50)@1H > 0")).toBe(50);
  });

  it("keeps an offset OUTSIDE a pin in base bars", () => {
    // candle@D.close[-1]: the offset shifts the base-aligned series -> 1 bar.
    expect(warmupOf("candle@D.close[-1] > 0", 300)).toBe(1);
  });

  it("keeps a wrapper OUTSIDE a pin in base bars", () => {
    expect(warmupOf("slope(EMA(50)@1H, 3) > 0", 300)).toBe(3);
  });
});

describe("timeframe pins", () => {
  it("rejects an unknown timeframe alias", () => {
    const res = analyze("EMA(9)@BOGUS > 0");
    expect(res.error?.code).toBe("unknown_tf");
  });

  it("accepts every catalog alias", () => {
    for (const tf of ["5m", "15m", "30m", "1H", "4H", "D", "W"]) {
      expect(analyze(`EMA(9)@${tf} > 0`).error).toBeNull();
    }
  });
});

describe("chained comparisons", () => {
  it("accepts a chain without a diagnostic", () => {
    const res = analyze("candle.close > EMA(9) > EMA(50)");
    expect(res.error).toBeNull();
  });

  it("still flags a single-comparison typo", () => {
    const res = analyze("candle.close > EMA(9) >");
    expect(res.error).not.toBeNull();
  });

  it("accepts a mixed-operator chain", () => {
    expect(analyze("candle.close > EMA(9) < EMA(50)").error).toBeNull();
  });

  it("extracts each chain operand's literals once", () => {
    const res = analyze("candle.close > EMA(9) > EMA(50)");
    expect(res.literals.map((l) => l.value)).toEqual([9, 50]);
  });

  it("warms up to the largest link", () => {
    expect(warmupOf("candle.close > EMA(9) > EMA(50)")).toBe(50);
  });
});

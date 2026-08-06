import { describe, it, expect } from "vitest";
import { analyze, warmupOf } from "./parser";
import { PATTERNS, PREDICATE_FNS } from "./catalog";
import { PATTERN_PREDICATE_FNS } from "../indicators/candlePatterns";

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

describe("count / predicates / barsSinceEntry", () => {
  it("parses the canonical exit rule", () => {
    const r = analyze("count(bearish(candle), barsSinceEntry) >= 3", { isExit: true });
    expect(r.error).toBeNull();
    expect(r.literals.map((l) => [l.value, l.label])).toEqual([[3, "threshold"]]);
  });
  it("labels the count window", () => {
    const r = analyze("count(candle.open > candle.close, 10) >= 3");
    expect(r.literals.map((l) => [l.value, l.label])).toEqual([[10, "count window"], [3, "threshold"]]);
  });
  it("rejects a non-condition first argument", () => {
    const r = analyze("count(candle.close, 10) > 3");
    expect(r.error?.code).toBe("count_needs_condition");
  });
  it("accepts a bare predicate row", () => {
    expect(analyze("bearish(candle[-1])").error).toBeNull();
  });
  it("rejects a predicate used as a value", () => {
    expect(analyze("bullish(candle) + 1 > 0").error?.code).toBe("predicate_as_value");
  });
  it("rejects a fielded candle in a predicate", () => {
    expect(analyze("bullish(candle.close)").error?.code).toBe("bad_predicate_arg");
  });
  it("gates barsSinceEntry to exit rules", () => {
    expect(analyze("barsSinceEntry > 5").error?.code).toBe("entry_in_entry_rule");
    expect(analyze("barsSinceEntry > 5", { isExit: true }).error).toBeNull();
  });
  it("warm-up: count literal window + cond warmup", () => {
    expect(warmupOf("count(candle.close > EMA(9), 10) >= 3")).toBe(19);
    expect(warmupOf("count(bearish(candle), barsSinceEntry) >= 3")).toBe(0);
    expect(warmupOf("bearish(candle[-2])")).toBe(2);
  });
  it("rejects entry/barsSinceEntry inside a wrapper or indicator arg", () => {
    expect(analyze("highest(barsSinceEntry, 3) > 2", { isExit: true }).error?.code).toBe("entry_in_wrapper");
    expect(
      analyze("avg(count(bearish(candle), barsSinceEntry), 2) > 1", { isExit: true }).error?.code,
    ).toBe("entry_in_wrapper");
    expect(analyze("highest(entry, 3) > 2", { isExit: true }).error?.code).toBe("entry_in_wrapper");
  });
  it("still allows entry directly inside count(...)'s condition", () => {
    expect(analyze("count(candle.close < entry, 10) >= 3", { isExit: true }).error).toBeNull();
  });
});

// `analyze` is the public entry point; the brief's tests are written against a
// throwing `parse`, so wrap it. The thrown message carries the error code and
// text so `.toThrow(/…/)` can match on either.
function parse(src: string): void {
  const { error } = analyze(src);
  if (error) throw new Error(`${error.code}: ${error.message}`);
}

describe("candle pattern predicates", () => {
  it("parses every catalog pattern name as a predicate row", () => {
    for (const name of Object.keys(PATTERN_PREDICATE_FNS)) {
      expect(() => parse(`${name}(candle)`)).not.toThrow();
    }
  });

  it("accepts an offset and a timeframe pin on the candle base", () => {
    expect(() => parse("bullEngulfing(candle[-1])")).not.toThrow();
    expect(() => parse("bearPattern(candle@4H)")).not.toThrow();
  });

  it("rejects a non-candle base", () => {
    expect(() => parse("doji(candle.close)")).toThrow(/takes a candle/);
  });

  it("rejects an unknown pattern name", () => {
    // A bare non-predicate call isn't a row at all, so it fails earlier; the
    // comparison form is what reaches name validation.
    expect(() => parse("notAPattern(candle)")).toThrow();
    expect(analyze("notAPattern(candle) > 0").error?.code).toBe("unknown_name");
  });

  // PATTERN_PREDICATE_FNS is a plain object literal, so it inherits
  // Object.prototype. Any validation written as `name in MAP` would wrongly
  // accept `toString`/`valueOf`/`constructor`. Asserting the *code* (not just
  // that it throws) is what discriminates: with the hole open these come back
  // as `bad_arity` from the inherited-member branch.
  it("rejects inherited Object.prototype names as predicates", () => {
    expect(() => parse("toString(candle)")).toThrow();
    for (const name of ["toString", "valueOf", "constructor", "hasOwnProperty"]) {
      expect(analyze(`${name}(candle) > 0`).error?.code).toBe("unknown_name");
    }
  });

  it("wraps in count() like any other predicate", () => {
    expect(() => parse("count(doji(candle), 5) >= 2")).not.toThrow();
  });

  it("warms up 18 bars, plus the offset", () => {
    expect(warmupOf("bullEngulfing(candle)")).toBe(18);
    expect(warmupOf("bullEngulfing(candle[-3])")).toBe(21);
  });

  it("keeps its 18 bars through an @tf pin", () => {
    // The pin contributes zero BASE bars, but the pattern's warm-up is added
    // outside the Tf and survives as a floor charged to the BASE. It is not
    // the pinned series' own warm-up: the backend hoists
    // Predicate(fn, Tf(...)) -> Tf(Predicate(fn, ...)), so the base series
    // never computes the pattern. The pin's real 18 bars of HTF history come
    // from the backend's expr.py::_tf_inner_warmup / _ensure_htf. Mirrors the
    // backend's
    // test_a_tf_pinned_pattern_costs_no_base_bars_beyond_the_pattern_itself.
    expect(warmupOf("bullEngulfing(candle@4H)", 300)).toBe(18);
  });

  it("leaves bullish/bearish warm-up at zero", () => {
    expect(warmupOf("bullish(candle)")).toBe(0);
  });

  it("catalog entries and the detector's name map agree", () => {
    // Absolute pin: both sides below derive from PATTERN_PREDICATE_FNS, so on
    // their own they would agree even if the map lost half its entries.
    // 24 pattern fns + the bullPattern/bearPattern aggregates.
    expect(PATTERNS).toHaveLength(26);
    expect(PATTERNS.map((e) => e.name).sort()).toEqual(
      Object.keys(PATTERN_PREDICATE_FNS).sort(),
    );
    for (const name of Object.keys(PATTERN_PREDICATE_FNS)) {
      expect((PREDICATE_FNS as readonly string[]).includes(name)).toBe(true);
    }
  });
});

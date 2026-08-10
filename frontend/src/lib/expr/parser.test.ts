import { describe, it, expect } from "vitest";
import { analyze, warmupOf, parseRowForTests } from "./parser";
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

  it("parses ATR% as an indicator call with a length literal", () => {
    const { literals, error } = analyze("ATR%(14) < 0.8");
    expect(error).toBeNull();
    expect(literals.map((l) => [l.value, l.label])).toEqual([
      [14, "ATR% length"], [0.8, "threshold"],
    ]);
  });

  it("keeps a leading % a lex error", () => {
    expect(analyze("% > 1").error?.code).toBe("bad_char");
  });

  it("accepts body% as a candle field", () => {
    expect(analyze("candle.body% > 0.5").error).toBeNull();
    expect(analyze("candle[-1].body% > 0.5").error).toBeNull();
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

const INSTANCES = [
  { id: "SLOPE", outputs: ["9", "21", "accel9"], timeframe: null },
  { id: "SLOPE#p1n", outputs: ["50"], timeframe: "1H" },
];

describe("indicator references", () => {
  it("accepts a ref to a known instance and output", () => {
    expect(analyze("SLOPE.9 > 0.5", { instances: INSTANCES }).errors).toEqual([]);
    expect(analyze("SLOPE#p1n.50 > 0", { instances: INSTANCES }).errors).toEqual([]);
  });

  it("reports a missing instance with its own code", () => {
    const [err] = analyze("NOPE.9 > 0", { instances: INSTANCES }).errors;
    expect(err.code).toBe("unknown_indicator_ref");
  });

  it("reports an unknown output and lists what is available", () => {
    const [err] = analyze("SLOPE.13 > 0", { instances: INSTANCES }).errors;
    expect(err.code).toBe("unknown_indicator_output");
    expect(err.message).toContain("9");
  });

  it("asks for an output when only the instance is named", () => {
    const [err] = analyze("SLOPE > 0", { instances: INSTANCES }).errors;
    expect(err.code).toBe("indicator_ref_needs_output");
  });

  it("rejects pinning an instance that is already pinned in its settings", () => {
    const [err] = analyze("SLOPE#p1n.50 @4H > 0", { instances: INSTANCES }).errors;
    expect(err.code).toBe("nested_tf");
  });

  it("allows pinning an unpinned instance", () => {
    expect(analyze("SLOPE.9 @4H > 0", { instances: INSTANCES }).errors).toEqual([]);
  });

  it("still reports field_on_call for a registered indicator", () => {
    const [err] = analyze("EMA(9).signal > 0", { instances: INSTANCES }).errors;
    expect(err.code).toBe("field_on_call");
  });

  it("lexes # inside a name but not as a leading character", () => {
    expect(analyze("SLOPE#p1n.50 > 0", { instances: INSTANCES }).errors).toEqual([]);
    expect(analyze("#SLOPE > 0", { instances: INSTANCES }).errors[0].code).toBe("bad_char");
  });

  it("takes warm-up from the caller's lookup, plus offsets", () => {
    const warmupByRef = () => 8;
    expect(warmupOf("SLOPE.9 > 0", 3600, INSTANCES, warmupByRef)).toBe(8);
    expect(warmupOf("SLOPE.9[-4] > 0", 3600, INSTANCES, warmupByRef)).toBe(12);
  });

  it("charges zero base bars for an instance pinned in its own settings", () => {
    expect(warmupOf("SLOPE#p1n.50 > 0", 3600, INSTANCES, () => 8)).toBe(0);
  });

  // --- beyond the brief: the four exclusion categories parse_postfix checks,
  // each of which must keep its OWN pre-existing error code rather than being
  // rewritten into an IndicatorRef.
  it("keeps registered indicators, wrappers, crosses and predicates out of refs", () => {
    const at = (src: string) => analyze(src, { instances: INSTANCES }).errors[0]?.code;
    expect(at("VOL.foo > 0")).toBe("field_on_call"); // INDICATORS (arity 0)
    expect(at("slope.x > 0")).toBe("field_on_call"); // WRAPPERS
    expect(at("crossAbove.x > 0")).toBe("cross_not_toplevel"); // CROSS_FNS
    expect(at("bullish.x > 0")).toBe("unknown_name"); // PREDICATE_FNS
  });

  it("does not treat inherited Object.prototype names as registered", () => {
    // `name in MAP` would say toString is an indicator; Object.hasOwn does not.
    expect(analyze("toString.foo > 0", { instances: INSTANCES }).errors[0].code)
      .toBe("unknown_indicator_ref");
  });

  it("fuses one dotted sub-name and rejects deeper chains", () => {
    // SLOPE.9.foo fuses to output "9.foo" — an unknown output now, not a field.
    expect(analyze("SLOPE.9.foo > 0", { instances: INSTANCES }).errors[0].code)
      .toBe("unknown_indicator_output");
    // An offset breaks the chain: the field hangs off the Offset, not the ref.
    expect(analyze("SLOPE.9[-1].foo > 0", { instances: INSTANCES }).errors[0].code)
      .toBe("field_on_indicator_ref");
    // A fused output takes no second level.
    expect(analyze("SLOPE.9.foo.x > 0", { instances: INSTANCES }).errors[0].code)
      .toBe("field_on_indicator_ref");
  });

  it("only asks for an output on a BARE instance name", () => {
    // SLOPE(9) carries args, so it is an unknown call, not a ref missing its output.
    expect(analyze("SLOPE(9) > 0", { instances: INSTANCES }).errors[0].code).toBe("unknown_name");
  });

  it("checks the timeframe alias before the nested-pin rule", () => {
    expect(analyze("SLOPE#p1n.50 @BOGUS > 0", { instances: INSTANCES }).errors[0].code)
      .toBe("unknown_tf");
  });

  it("validates refs nested inside wrappers and count()", () => {
    expect(analyze("slope(SLOPE.9, 3) > 0", { instances: INSTANCES }).errors).toEqual([]);
    expect(analyze("count(SLOPE.9 > 0, 10) >= 1", { instances: INSTANCES }).errors).toEqual([]);
    expect(analyze("slope(NOPE.9, 3) > 0", { instances: INSTANCES }).errors[0].code)
      .toBe("unknown_indicator_ref");
    expect(analyze("count(NOPE.9 > 0, 10) >= 1", { instances: INSTANCES }).errors[0].code)
      .toBe("unknown_indicator_ref");
    expect(analyze("-SLOPE.9 + 1 > 0", { instances: INSTANCES }).errors).toEqual([]);
  });

  it("reports a ref with no instance list at all", () => {
    expect(analyze("SLOPE.9 > 0").errors[0].code).toBe("unknown_indicator_ref");
  });

  it("still rejects # as a leading name character in the digit branch too", () => {
    // 4H#x must not lex as one NAME: the backend's digit branch has no '#'.
    expect(analyze("EMA(9)@4H#x > 0").errors[0].code).toBe("bad_char");
  });

  it("labels a numeric factor on a ref as a multiplier", () => {
    const { literals } = analyze("2 * SLOPE.9 > 0", { instances: INSTANCES });
    expect(literals.map((l) => l.label)).toEqual(["multiplier of SLOPE.9", "threshold"]);
  });

  // `pinnedInstance` mirrors `containsTf` case for case (backend
  // validate.py::_pinned_instance). A missing arm is invisible — the rule lints
  // clean here and 422s at the backend — so every reachable arm gets its own
  // row. Each was verified to pin by deleting that arm and re-running.
  describe("pinnedInstance arms", () => {
    const code = (src: string) => analyze(src, { instances: INSTANCES }).errors[0]?.code;

    it("Call args", () => {
      expect(code("slope(SLOPE#p1n.50, 3) @4H > 0")).toBe("nested_tf");
    });
    it("Binary", () => {
      expect(code("(SLOPE#p1n.50 + 1) @4H > 0")).toBe("nested_tf");
    });
    it("Unary", () => {
      expect(code("(-SLOPE#p1n.50) @4H > 0")).toBe("nested_tf");
    });
    it("Offset", () => {
      expect(code("SLOPE#p1n.50[-1] @4H > 0")).toBe("nested_tf");
    });
    it("Field", () => {
      // The nested-pin check runs before walk(base), so nested_tf wins over the
      // field_on_indicator_ref this expression would otherwise report.
      expect(code("SLOPE#p1n.50.foo @4H > 0")).toBe("nested_tf");
    });
    it("Count window", () => {
      expect(code("count(candle.open > candle.close, SLOPE#p1n.50) @4H >= 1")).toBe("nested_tf");
    });
    it("Compare (inside a count condition)", () => {
      // Compare is only ever a row or a count condition, so this necessarily
      // goes through the Count arm too.
      expect(code("count(SLOPE#p1n.50 > 0, 10) @4H >= 1")).toBe("nested_tf");
    });
    it("Cross (inside a count condition)", () => {
      expect(code("count(SLOPE#p1n.50 x> EMA(9), 10) @4H >= 1")).toBe("nested_tf");
    });
    it("BoolOp (inside a count condition)", () => {
      // The only way a boolean node lands INSIDE another node's subtree is
      // count(); without the BoolOp arm the pinned ref is invisible here.
      expect(code("count(SLOPE#p1n.50 > 0 and candle.close > 0, 10) @4H >= 1")).toBe("nested_tf");
    });
    it("Not (inside a count condition)", () => {
      expect(code("count(not SLOPE#p1n.50 > 0, 10) @4H >= 1")).toBe("nested_tf");
    });
    it("Predicate (inside a count condition)", () => {
      // Reachable because the pin check precedes the predicate's own arg check.
      expect(code("count(bullish(SLOPE#p1n.50), 10) @4H >= 1")).toBe("nested_tf");
    });
    // No row for the Tf arm (or Chain): reaching pinnedInstance's Tf arm needs a
    // Tf under a Tf, which the parser's own containsTf rejects at parse time —
    // `slope(SLOPE#p1n.50 @4H, 3) > 0` reaches the IndicatorRef arm instead.
    it("still catches a pin on a pinned instance nested in a wrapper arg", () => {
      expect(code("slope(SLOPE#p1n.50 @4H, 3) > 0")).toBe("nested_tf");
    });
  });

  // analyze extracts literals on the ERROR path too, so a half-typed wrapper
  // must not throw out of the collector — lint.ts calls this on every keystroke.
  // Mirrored by the backend's test_underfilled_wrapper_does_not_crash.
  it("returns a typed error for a bare wrapper name instead of throwing", () => {
    const r = analyze("slope.x > 0");
    expect(r.error?.code).toBe("field_on_call");
    expect(r.literals.map((l) => [l.value, l.label])).toEqual([[0, "threshold"]]);
  });

  it("keeps collecting an under-filled wrapper's inner literals", () => {
    const r = analyze("avg(EMA(9)) > 0");
    expect(r.error?.code).toBe("bad_arity");
    expect(r.literals.map((l) => [l.value, l.label])).toEqual([[9, "EMA length"], [0, "threshold"]]);
  });

  it("charges zero warm-up for a ref with no lookup supplied", () => {
    expect(warmupOf("SLOPE.9 > 0", 3600, INSTANCES)).toBe(0);
    expect(warmupOf("SLOPE.9 > 0")).toBe(0);
  });
});

describe("infix cross operators", () => {
  it("parses a lone x> row with backend-identical literals", () => {
    const { error, literals } = analyze("EMA(9) x> EMA(50)");
    expect(error).toBeNull();
    expect(literals.map((l) => [l.ordinal, l.value, l.from, l.to, l.label])).toEqual([
      [0, 9, 4, 5, "EMA length"],
      [1, 50, 14, 16, "EMA length"],
    ]);
  });

  it("emits XGT/XLT tokens for the highlighter", () => {
    const { tokens } = analyze("EMA(9) x> EMA(50)");
    expect(tokens.some((t) => t.type === "XGT" && t.from === 7 && t.to === 9)).toBe(true);
    expect(analyze("a x< b").tokens.some((t) => t.type === "XLT")).toBe(true);
  });

  it("accepts one cross inside a chain", () => {
    expect(analyze("EMA(9) x> EMA(50) > EMA(200)").error).toBeNull();
    expect(analyze("EMA(9) > EMA(50) x> EMA(200)").error).toBeNull();
  });

  // multiple_crosses is gone: the boolean layer replaced the "one cross per
  // row" rule (a user who wants two crosses now writes `a x> b and c x> d`),
  // and a chain of crosses is simply a chain. Mirrors the backend parser,
  // whose _ROW_OPS loop no longer counts crosses.
  it("accepts two crosses in a row as a plain chain", () => {
    const { error, literals } = analyze("EMA(9) x> EMA(50) x< EMA(20)");
    expect(error).toBeNull();
    expect(literals.map((l) => l.value)).toEqual([9, 50, 20]);
  });

  // A parenthesized infix cross now PARSES (the paren body is a full orExpr);
  // it is validate that rejects it in value position, over the whole
  // paren-expression span. Mirrors the backend's cross_not_toplevel arm in
  // validate.py's CONDITION_KINDS check.
  it("rejects a nested infix cross as cross_not_toplevel", () => {
    const { error } = analyze("EMA(9) > (EMA(9) x> EMA(50))");
    expect(error?.code).toBe("cross_not_toplevel");
    expect([error?.from, error?.to]).toEqual([9, 28]);
    expect(error?.message).toBe("A comparison or cross can't be used as a value.");
  });

  // Keeps `expect()`'s XGT/XLT branch pinned now that the parenthesized form
  // above no longer reaches it: a cross inside a call argument still hits it,
  // because the argument is parsed as arith and the ")" the grammar wants is
  // met by an "x>" instead.
  it("rejects an infix cross inside a call argument at parse time", () => {
    const { error } = analyze("slope(EMA(9) x> EMA(50), 3) > 0");
    expect(error?.code).toBe("cross_not_toplevel");
    expect([error?.from, error?.to]).toEqual([13, 15]);
    expect(error?.message).toBe("A comparison or cross can't be used as a value.");
  });

  it("flags spaced and uppercase x as bad_cross_op", () => {
    const spaced = analyze("EMA(9) x > EMA(50)");
    expect(spaced.error?.code).toBe("bad_cross_op");
    expect([spaced.error?.from, spaced.error?.to]).toEqual([7, 8]);
    const upper = analyze("X> EMA(9)");
    expect(upper.error?.code).toBe("bad_cross_op");
    expect([upper.error?.from, upper.error?.to]).toEqual([0, 1]);
  });

  it("flags x>= as bad_cross_op over the whole operator", () => {
    const { error } = analyze("EMA(9) x>= 2");
    expect(error?.code).toBe("bad_cross_op");
    expect([error?.from, error?.to]).toEqual([7, 10]);
    // The copy is shared with every other spelling (byte-identical to the
    // backend's errors.BAD_CROSS_MSG).
    expect(error?.message).toBe("Write the cross operator as x> or x< — lowercase, no space.");
  });

  it("flags a trailing bare x as bad_cross_op", () => {
    const { error } = analyze("EMA(9) x> EMA(50) x");
    expect(error?.code).toBe("bad_cross_op");
    expect([error?.from, error?.to]).toEqual([18, 19]);
  });

  it("leaves a bare x operand to the unknown-name check", () => {
    // Not followed by a comparison bracket, so it is a variable, not a cross.
    const { error } = analyze("count(candle.close > 2, x) >= 1");
    expect(error?.code).toBe("unknown_name");
    expect([error?.from, error?.to]).toEqual([24, 25]);
  });

  it("still parses the no-space fuse EMA(9)x>EMA(50)", () => {
    expect(analyze("EMA(9)x>EMA(50)").error).toBeNull();
  });

  it("accepts x> inside count()", () => {
    expect(analyze("count(EMA(9) x> EMA(50), 10) >= 2").error).toBeNull();
  });

  it("warms up across a cross part in a chain", () => {
    expect(warmupOf("EMA(9) x> EMA(50) > EMA(200)")).toBe(200);
    expect(warmupOf("EMA(9) x> EMA(50)")).toBe(50);
  });
});

describe("== equality operator", () => {
  it("lexes == as EQ", () => {
    const src = "count(candle.close > candle.open, 5) == 3";
    const { tokens, error } = analyze(src);
    expect(error).toBeNull();
    expect(tokens.map((t) => [t.type, src.slice(t.from, t.to)])).toContainEqual(["EQ", "=="]);
  });

  it("rejects a bare = with the equality message", () => {
    const { error } = analyze("EMA(9) = 1");
    expect(error?.code).toBe("bad_eq_op");
    expect(error?.message).toBe("Use == for equality.");
    expect([error?.from, error?.to]).toEqual([7, 8]);
  });

  it("parses == at top level and inside count", () => {
    expect(analyze("count(candle.close > candle.open, 5) == 3").error).toBeNull();
    expect(analyze("count(EMA(9) == EMA(21), 20) > 0").error).toBeNull();
    // Pins SYM_OF's EQ -> "==" mapping: Compare.op reaches the user through
    // render() in the literal label, so a missing entry renders "undefined"
    // in the sweep axis rather than failing loudly.
    const r = analyze("2 * count(1 == 2, 3) > 1", {});
    expect(r.literals[0].label).toBe("multiplier of count(1 == 2, 3)");
  });

  it("lists == in the expected-operator message", () => {
    const { error } = analyze("EMA(9) EMA(21)");
    expect(error?.code).toBe("expected_operator");
    expect(error?.message).toBe("Expected a comparison operator (> < >= <= == x> x<).");
  });
});

// --- the lexer's dot rule ------------------------------------------------------
//
// `SLOPE.9` only reaches the parser because tokenize stopped treating a "." that
// follows a NAME / ")" / "]" as the start of a decimal literal. These pin both
// halves of that rule: the new spelling works, and the leading-dot decimals that
// always worked still do. Mirrored term for term by
// backend/tests/test_indicator_ref_parse.py, and corpus.json runs all three
// expressions through BOTH stacks.
describe("a dot starts a decimal only where no field can follow", () => {
  const typesOf = (src: string) => analyze(src).tokens.map((t) => t.type);
  const spansOf = (src: string) =>
    analyze(src).tokens.map((t) => [t.type, src.slice(t.from, t.to)]);

  it("reads the dot after a name as field access, not as the decimal 0.9", () => {
    expect(spansOf("SLOPE.9 > 0")).toEqual([
      ["NAME", "SLOPE"], ["DOT", "."], ["NUMBER", "9"], ["GT", ">"], ["NUMBER", "0"],
    ]);
  });

  it("still reads a decimal after an operator", () => {
    expect(spansOf("2 + .5")).toEqual([["NUMBER", "2"], ["PLUS", "+"], ["NUMBER", ".5"]]);
  });

  it("still reads a leading decimal", () => {
    expect(spansOf(".5 > 0")).toEqual([["NUMBER", ".5"], ["GT", ">"], ["NUMBER", "0"]]);
  });

  it("treats a dot after a closing bracket as field access too", () => {
    expect(typesOf("SLOPE.9[-1] > 0")).toEqual([
      "NAME", "DOT", "NUMBER", "LBRACKET", "MINUS", "NUMBER", "RBRACKET", "GT", "NUMBER",
    ]);
  });

  it("does not let a numeric output swallow a following field", () => {
    // The timeframe fusion ("1.5H" is one NAME) must not apply straight after a
    // ".", or `SLOPE.9.foo` would lex as a single NAME "9.foo".
    expect(typesOf("SLOPE.9.foo")).toEqual(["NAME", "DOT", "NUMBER", "DOT", "NAME"]);
    expect(spansOf("EMA(9)@1.5H > 0")).toContainEqual(["NAME", "1.5H"]);   // still fused
  });
});

describe("a NUMBER output is accepted only where an indicator ref is built", () => {
  // The four-category exclusion set plus `candle`: only a bare UNREGISTERED
  // zero-arg name may take a number as its field, because only there is a
  // number a name (a pane's outputs are named by its MA lengths).
  it.each([
    ["candle.9 > 0"],      // Candle root
    ["EMA(9).9 > 0"],      // a call WITH args
    ["VOL.9 > 0"],         // a registered zero-arg indicator
    ["slope.9 > 0"],       // a registered wrapper name
    ["doji.9 > 0"],        // a registered predicate name
    ["crossAbove.9 > 0"],  // a registered cross fn name
  ])("rejects %s", (src) => {
    expect(analyze(src).error?.code).toBe("unexpected_token");
  });

  it("accepts it for an unregistered instance name, through offset and pin", () => {
    const instances = [{ id: "SLOPE", outputs: ["9"], timeframe: null }];
    expect(analyze("SLOPE.9[-2] @1H > 0", { instances }).error).toBeNull();
  });
});

// --- boolean operators ---------------------------------------------------------
//
// The and/or/not layer, mirrored case for case from the backend
// (lexer.py::_KEYWORDS, parser.py::parse_or/parse_and/parse_not, validate.py's
// BoolOp/Not recursion, warmup.py, literals.py::_collect_row). Every span and
// code below was read off the Python before being written here.
describe("boolean operators", () => {
  it("accepts an or of two comparisons and numbers its literals in source order", () => {
    const { error, literals } = analyze("RSI(14) > 70 or RSI(14) < 30");
    expect(error).toBeNull();
    expect(literals.map((l) => [l.ordinal, l.value])).toEqual([
      [0, 14], [1, 70], [2, 14], [3, 30],
    ]);
    expect(literals.map((l) => l.label)).toEqual([
      "RSI length", "threshold", "RSI length", "threshold",
    ]);
  });

  it("accepts not on a predicate row", () => {
    expect(analyze("not bullish(candle)").error).toBeNull();
  });

  it("accepts a parenthesized group combined with and", () => {
    const src = "(candle.close > EMA(9) or bullish(candle)) and RSI(14) < 70";
    const { error, literals } = analyze(src);
    expect(error).toBeNull();
    expect(literals.map((l) => [l.value, l.from, l.to])).toEqual([
      [9, 20, 21], [14, 51, 53], [70, 57, 59],
    ]);
  });

  it("rejects a non-condition operand of and, pointing at the offending part", () => {
    const { error } = analyze("candle.close and EMA(9)");
    expect(error?.code).toBe("expected_condition");
    expect([error?.from, error?.to]).toEqual([0, 12]);
    expect(error?.message).toBe("and, or and not need a condition, like candle.close > EMA(9).");
  });

  it("rejects a non-condition operand of not, spanning the operand", () => {
    // The ERROR span is the operand (what the user must fix); the Not node's
    // own span still opens at the `not` keyword.
    const { error } = analyze("not candle.close");
    expect(error?.code).toBe("expected_condition");
    expect([error?.from, error?.to]).toEqual([4, 16]);
  });

  it("rejects a parenthesized condition used as a value", () => {
    const { error } = analyze("(candle.close > EMA(9))[-1]");
    expect(error?.code).toBe("bool_as_value");
    expect([error?.from, error?.to]).toEqual([23, 24]);
    expect(error?.message).toBe("A condition can't be used as a value here.");
  });

  it("reports a boolean node in value position as cross_not_toplevel", () => {
    // validate.py's CONDITION_KINDS arm, not unknown_name: the multiplied group
    // parses as a BoolOp and is rejected over its whole span.
    const { error } = analyze("2 * (EMA(9) > 1 and EMA(2) > 1) > 0");
    expect(error?.code).toBe("cross_not_toplevel");
    expect([error?.from, error?.to]).toEqual([4, 31]);
    expect(error?.message).toBe("A comparison or cross can't be used as a value.");
  });

  it("binds not tighter than the comparison it contains", () => {
    // `not` takes a whole conditionUnit, so this is not(EMA... > 1), and the 1
    // is still the comparison's threshold.
    const { error, literals } = analyze("not candle.close > 1");
    expect(error).toBeNull();
    expect(literals.map((l) => [l.value, l.label])).toEqual([[1, "threshold"]]);
  });

  it("still reports expected_operator for two adjacent values", () => {
    const { error } = analyze("EMA(9) EMA(21)");
    expect(error?.code).toBe("expected_operator");
    expect([error?.from, error?.to]).toEqual([7, 10]);
  });

  it("takes the lowercase and the all-uppercase keyword spellings", () => {
    expect(analyze("EMA(9) > 1 OR EMA(2) > 1").error).toBeNull();
    expect(analyze("EMA(9) > 1 AND NOT bullish(candle)").error).toBeNull();
  });

  it("keeps a MIXED-case spelling a plain name", () => {
    // "And"/"Or"/"Not" are plain names, so they reach the unknown-name check.
    expect(analyze("And > 1").error?.code).toBe("unknown_name");
    expect(analyze("EMA(9) > 1 Or EMA(2) > 1").error?.code).toBe("unexpected_token");
    expect(analyze("Not bullish(candle)").error?.code).toBe("expected_operator");
  });

  it("takes count's condition as a full boolean expression", () => {
    expect(analyze("count(candle.close > EMA(9) or bullish(candle), 10) >= 3").error).toBeNull();
    const { error, literals } = analyze("count(candle.close > EMA(9) and bullish(candle), 10) >= 3");
    expect(error).toBeNull();
    expect(literals.map((l) => [l.value, l.label])).toEqual([
      [9, "EMA length"], [10, "count window"], [3, "threshold"],
    ]);
  });

  it("still rejects a non-condition count argument", () => {
    expect(analyze("count(candle.close, 10) > 3").error?.code).toBe("count_needs_condition");
  });

  it("sees entry-based values through a boolean count condition", () => {
    // containsEntryKind's BoolOp arm: without it the wrapper guard misses the
    // barsSinceEntry buried under the `and`.
    const { error } = analyze(
      "highest(count(bullish(candle) and barsSinceEntry > 1, 3), 2) > 0",
      { isExit: true },
    );
    expect(error?.code).toBe("entry_in_wrapper");
    expect([error?.from, error?.to]).toEqual([0, 60]);
  });

  it("warms up to the largest part of an or, and passes not through", () => {
    expect(warmupOf("EMA(50) > 0 or EMA(9) > 0")).toBe(50);
    expect(warmupOf("not EMA(21) > 0")).toBe(21);
  });
});

// The shared corpus pins error codes, spans and literals — none of which change
// if `and`/`or` associated the wrong way, so a precedence divergence from the
// backend would pass every other gate. These mirror the backend's
// test_expr_parser_bool.py (test_precedence_and_binds_tighter_than_or,
// test_chained_same_op_flattens, test_not_wraps_the_whole_comparison).
describe("boolean AST shape", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parse = (src: string): any => parseRowForTests(src);

  it("binds and tighter than or", () => {
    const row = parse("candle.close > 1 or candle.close > 2 and candle.close > 3");
    expect(row.kind).toBe("BoolOp");
    expect(row.op).toBe("or");
    expect(row.parts).toHaveLength(2);
    expect(row.parts[0].kind).toBe("Compare");
    expect(row.parts[1].kind).toBe("BoolOp");
    expect(row.parts[1].op).toBe("and");
    expect(row.parts[1].parts).toHaveLength(2);
  });

  it("flattens a same-operator chain instead of nesting pairs", () => {
    const row = parse("candle.close > 1 and candle.close > 2 and candle.close > 3");
    expect(row.kind).toBe("BoolOp");
    expect(row.op).toBe("and");
    expect(row.parts).toHaveLength(3);
    expect(row.parts.map((p: { kind: string }) => p.kind)).toEqual([
      "Compare", "Compare", "Compare",
    ]);
  });

  it("binds not tighter than and, over the whole comparison", () => {
    const row = parse("not candle.close > 1 and candle.close > 2");
    expect(row.kind).toBe("BoolOp");
    expect(row.op).toBe("and");
    expect(row.parts[0].kind).toBe("Not");
    expect(row.parts[0].operand.kind).toBe("Compare");
    expect(row.parts[1].kind).toBe("Compare");
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CANDLE_PATTERNS_WARMUP, candlePatternSeries, candlePatternsOutputs, candlePatternsWarmup } from "./candlePatternsOutputs";
import { CANDLE_PATTERN_DEFS, type PatternBar } from "./candlePatterns";

const BARS = new URL("../../../../backend/tests/fixtures/candle_patterns_golden.json", import.meta.url);
import { EXPR_INSTANCE_TYPES, exprInstancesFor, exprWarmupByRef, synthesizeExprInstances } from "../exprInstances";
import { chartIndicatorToExprToken } from "../exprChartToken";
import { INDICATOR_SPECS, PATTERN_WARMUP } from "../expr/catalog";

describe("CANDLE_PATTERNS outputs", () => {
  it("lists every pattern id then the two aggregates", () => {
    expect(candlePatternsOutputs({})).toEqual([...CANDLE_PATTERN_DEFS.map((d) => d.id), "bullPattern", "bearPattern"]);
  });
  it("drops the patterns of a disabled toggle", () => {
    const outs = candlePatternsOutputs({ disabled: { engulfing: true, star: false } });
    expect(outs).not.toContain("bull_engulfing");
    expect(outs).not.toContain("bear_engulfing");
    expect(outs).toContain("morning_star");
  });
  it("shares the rule predicates' warm-up", () => {
    expect(CANDLE_PATTERNS_WARMUP).toBe(PATTERN_WARMUP);
    expect(candlePatternsWarmup({}, "doji")).toBe(PATTERN_WARMUP);
    expect(candlePatternsWarmup({ disabled: { doji: true } }, "doji")).toBe(0);
  });
  it("aggregates only enabled patterns", () => {
    const bars = (JSON.parse(readFileSync(BARS, "utf8")) as { bars: PatternBar[] }).bars;
    const ext = { disabled: { engulfing: true } };
    const bullIds = CANDLE_PATTERN_DEFS.filter((d) => d.polarity === "bull" && d.toggle !== "engulfing").map((d) => d.id);
    const each = bullIds.map((id) => candlePatternSeries(bars, ext, id));
    const agg = candlePatternSeries(bars, ext, "bullPattern");
    expect(agg).toEqual(bars.map((_, i) => (each.some((s) => s[i] === 1) ? 1 : 0)));
    // Non-vacuous: the detector fixture fires every pattern at least once.
    expect(candlePatternSeries(bars, {}, "bull_engulfing")).toContain(1);
  });
});

describe("CANDLE_PATTERNS as a rule instance", () => {
  const live = [{ id: "CANDLE_PATTERNS", type: "CANDLE_PATTERNS", calcParams: [], extendData: { disabled: { doji: true } } }];
  it("is referenceable with a bare id", () => {
    expect(EXPR_INSTANCE_TYPES.has("CANDLE_PATTERNS")).toBe(true);
    expect(Object.hasOwn(INDICATOR_SPECS, "CANDLE_PATTERNS")).toBe(false);
  });
  it("lists the enabled outputs and the warm-up", () => {
    const [inst] = exprInstancesFor(live);
    expect(inst.outputs).not.toContain("doji");
    expect(inst.detail).toBe("23 of 24 patterns · 1 when the pattern completes on that bar");
    expect(exprWarmupByRef(live)("CANDLE_PATTERNS", "bullPattern")).toBe(PATTERN_WARMUP);
  });
  it("re-creates a missing pane with defaults", () => {
    expect(synthesizeExprInstances(["CANDLE_PATTERNS.doji > 0"], new Set()))
      .toEqual({ CANDLE_PATTERNS: { type: "CANDLE_PATTERNS", calcParams: [], extendData: {} } });
  });
  it("a click names the bullish aggregate", () => {
    expect(chartIndicatorToExprToken("CANDLE_PATTERNS", [], {}, { instanceId: "CANDLE_PATTERNS" })).toBe("CANDLE_PATTERNS.bullPattern");
  });
});

import { describe, it, expect } from "vitest";
import {
  seriesName,
  collectSeriesOperands,
  cloneRule,
  longestIndicatorLength,
  operandBaseLen,
  defaultBacktestConfig,
  normalizeBacktestConfig,
  riskAtrLengths,
  scalingAtrLengths,
  recipeKey,
  swapSides,
  invertRule,
  ruleFromChartOperand,
  activeGroup,
  OP_REVERSE,
  type BacktestConfig,
  type Operand,
  type SeriesOperand,
  type Rule,
  type SeriesRecipe,
} from "./backtestConfig";

const EMPTY_GROUP = { combine: "AND" as const, rules: [] };

describe("seriesName", () => {
  it("keys MA/RSI/VOLMA by indicator_length", () => {
    expect(seriesName({ kind: "indicator", indicator: "EMA", length: 9 })).toBe("EMA_9");
    expect(seriesName({ kind: "indicator", indicator: "SMA", length: 50 })).toBe("SMA_50");
    expect(seriesName({ kind: "indicator", indicator: "RSI", length: 14 })).toBe("RSI_14");
    expect(seriesName({ kind: "indicator", indicator: "VOLMA", length: 20 })).toBe("VOLMA_20");
  });

  it("keys AVWAP/VOL by name alone (no length)", () => {
    expect(seriesName({ kind: "indicator", indicator: "AVWAP" })).toBe("AVWAP_0");
    expect(seriesName({ kind: "indicator", indicator: "AVWAP", anchor: 1_700_000_000_000 })).toBe(
      "AVWAP_1700000000000",
    );
    expect(seriesName({ kind: "indicator", indicator: "VOL" })).toBe("VOL");
  });

  it("returns null for price/const (no series, read off the candle)", () => {
    expect(seriesName({ kind: "price", field: "close" })).toBeNull();
    expect(seriesName({ kind: "const", value: 5 })).toBeNull();
  });

  it("returns null for the entry-price operand (read off the position)", () => {
    expect(seriesName({ kind: "entry" })).toBeNull();
  });
});

describe("seriesName slope suffix", () => {
  it("appends ~len for a sloped indicator, before any @tf", () => {
    expect(seriesName({ kind: "indicator", indicator: "EMA", length: 9, slope: { len: 3 } })).toBe("EMA_9~3");
    expect(
      seriesName({ kind: "indicator", indicator: "EMA", length: 9, timeframe: "HOUR", slope: { len: 3 } }),
    ).toBe("EMA_9~3@HOUR");
  });

  it("gives a sloped price its own series key (plain price still has none)", () => {
    expect(seriesName({ kind: "price", field: "close" })).toBeNull();
    expect(seriesName({ kind: "price", field: "close", slope: { len: 1 } })).toBe("close~1");
  });

  it("keeps a curve and its slope as distinct series", () => {
    const base = seriesName({ kind: "indicator", indicator: "EMA", length: 9 });
    const slope = seriesName({ kind: "indicator", indicator: "EMA", length: 9, slope: { len: 3 } });
    expect(base).not.toBe(slope);
  });
});

describe("cloneRule", () => {
  it("preserves the count modifier and the entry-price operand", () => {
    const rule = {
      left: { kind: "price" as const, field: "close" as const },
      op: "crosses" as const,
      right: { kind: "entry" as const },
      count: 3,
    };
    const copy = cloneRule(rule);
    expect(copy).toEqual(rule);
    expect(copy.right).not.toBe(rule.right); // deep copy, not shared ref
  });
});

describe("activeGroup", () => {
  const rule = (count?: number, enabled?: boolean): Rule => ({
    left: { kind: "price", field: "close" },
    op: "gt",
    right: { kind: "const", value: 0 },
    ...(count !== undefined ? { count } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  });

  it("drops disabled rules", () => {
    const g = { combine: "AND" as const, rules: [rule(undefined, false), rule(3)] };
    expect(activeGroup(g).rules).toEqual([rule(3)]);
  });

  it("omits an out-of-range count (0) the backend would 422 on", () => {
    // The UI reads count 0/undefined/1 all as "fire on first", but the backend
    // requires count >= 1 — a stale 0 must be sent as absent, not literal 0.
    const [out] = activeGroup({ combine: "AND", rules: [rule(0)] }).rules;
    expect(out.count).toBeUndefined();
  });

  it("keeps a real Nth-occurrence count", () => {
    const [out] = activeGroup({ combine: "AND", rules: [rule(3)] }).rules;
    expect(out.count).toBe(3);
  });
});

describe("collectSeriesOperands", () => {
  it("dedupes the same indicator referenced across long/short entry/exit", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 9 },
            op: "crossesAbove",
            right: { kind: "indicator", indicator: "EMA", length: 21 },
          },
        ],
      },
      longExit: EMPTY_GROUP,
      shortEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 9 },
            op: "crossesBelow",
            right: { kind: "indicator", indicator: "EMA", length: 21 },
          },
        ],
      },
      shortExit: EMPTY_GROUP,
      longEnabled: true,
      shortEnabled: true,
      costs: { quantity: 1, commissionPerSide: 0, slippage: { kind: "fixed", value: 0, atrMult: 0 }, startingCash: 10_000 },
    };
    const names = collectSeriesOperands(cfg).map(seriesName).sort();
    expect(names).toEqual(["EMA_21", "EMA_9"]);
  });

  it("excludes price/const operands", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      longEntry: {
        combine: "AND",
        rules: [{ left: { kind: "price", field: "close" }, op: "gt", right: { kind: "const", value: 1 } }],
      },
      longExit: EMPTY_GROUP,
      shortEntry: EMPTY_GROUP,
      shortExit: EMPTY_GROUP,
      longEnabled: true,
      shortEnabled: true,
      costs: { quantity: 1, commissionPerSide: 0, slippage: { kind: "fixed", value: 0, atrMult: 0 }, startingCash: 10_000 },
    };
    expect(collectSeriesOperands(cfg)).toEqual([]);
  });

  it("keeps two AVWAPs with different anchors as distinct series, dedupes equal anchors", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "price", field: "close" }, op: "gt", right: { kind: "indicator", indicator: "AVWAP", anchor: 1000 } },
          { left: { kind: "price", field: "close" }, op: "gt", right: { kind: "indicator", indicator: "AVWAP", anchor: 2000 } },
          { left: { kind: "price", field: "close" }, op: "gt", right: { kind: "indicator", indicator: "AVWAP", anchor: 1000 } },
        ],
      },
      longExit: { combine: "AND", rules: [] },
      shortEntry: { combine: "AND", rules: [] },
      shortExit: { combine: "AND", rules: [] },
      costs: { quantity: 1, commissionPerSide: 0, slippage: { kind: "fixed", value: 0, atrMult: 0 }, startingCash: 10_000 },
    };
    const names = collectSeriesOperands(cfg).map(seriesName).sort();
    expect(names).toEqual(["AVWAP_1000", "AVWAP_2000"]);
  });
});

const EMA9_RECIPE: SeriesRecipe = { source: "indicator", indicatorType: "EMA", calcParams: [9], line: 0 };
const TREND_RECIPE: SeriesRecipe = {
  source: "drawing",
  drawingKind: "segment",
  anchors: [{ timestamp: 1000, value: 10 }, { timestamp: 2000, value: 20 }],
};

function ser(recipe: SeriesRecipe, extra: Partial<Operand> = {}): SeriesOperand {
  return { kind: "series", seriesKey: recipeKey(recipe), label: "chip", recipe, ...extra } as SeriesOperand;
}

function cfgWith(...rules: { left: Operand; op: "gt"; right: Operand }[]): BacktestConfig {
  return {
    range: { mode: "bars", bars: 500 },
    longEntry: { combine: "AND", rules },
    longExit: EMPTY_GROUP,
    shortEntry: EMPTY_GROUP,
    shortExit: EMPTY_GROUP,
    longEnabled: true,
    shortEnabled: true,
    costs: { quantity: 1, commissionPerSide: 0, slippage: { kind: "fixed", value: 0, atrMult: 0 }, startingCash: 10_000 },
  };
}

describe("recipeKey", () => {
  it("is deterministic and stable for the same recipe", () => {
    expect(recipeKey(EMA9_RECIPE)).toBe(recipeKey({ ...EMA9_RECIPE }));
    expect(recipeKey(EMA9_RECIPE)).toMatch(/^EMA_/);
    expect(recipeKey(TREND_RECIPE)).toMatch(/^segment_/);
  });
  it("distinguishes recipes that differ in any compute field", () => {
    const keys = new Set([
      recipeKey(EMA9_RECIPE),
      recipeKey({ ...EMA9_RECIPE, calcParams: [21] }),
      recipeKey({ ...EMA9_RECIPE, indicatorType: "MA" }),
      recipeKey({ ...EMA9_RECIPE, line: 1 }),
      recipeKey({ source: "indicator", indicatorType: "AVWAP", calcParams: [111], line: 0 }),
      recipeKey({ source: "indicator", indicatorType: "AVWAP", calcParams: [222], line: 0 }),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe("seriesName for a series operand", () => {
  it("returns the seriesKey verbatim", () => {
    const op = ser(EMA9_RECIPE);
    expect(seriesName(op)).toBe(op.seriesKey);
  });
  it("appends ~len for slope, then @tf — slope before timeframe", () => {
    const key = recipeKey(EMA9_RECIPE);
    expect(seriesName(ser(EMA9_RECIPE, { slope: { len: 3 } }))).toBe(`${key}~3`);
    expect(seriesName(ser(EMA9_RECIPE, { slope: { len: 3 }, timeframe: "HOUR" }))).toBe(`${key}~3@HOUR`);
    expect(seriesName(ser(EMA9_RECIPE, { timeframe: "HOUR" }))).toBe(`${key}@HOUR`);
  });
});

describe("collectSeriesOperands with series operands", () => {
  it("collects series operands and dedups identical recipes", () => {
    const cfg = cfgWith(
      { left: ser(EMA9_RECIPE), op: "gt", right: { kind: "const", value: 0 } },
      { left: ser(EMA9_RECIPE), op: "gt", right: { kind: "const", value: 1 } }, // identical recipe -> dedup
      { left: ser(TREND_RECIPE), op: "gt", right: { kind: "const", value: 0 } },
    );
    const names = collectSeriesOperands(cfg).map(seriesName).sort();
    expect(names).toEqual([recipeKey(EMA9_RECIPE), recipeKey(TREND_RECIPE)].sort());
  });
  it("keeps the same recipe on two timeframes as distinct series", () => {
    const cfg = cfgWith(
      { left: ser(EMA9_RECIPE), op: "gt", right: { kind: "const", value: 0 } },
      { left: ser(EMA9_RECIPE, { timeframe: "HOUR" }), op: "gt", right: { kind: "const", value: 0 } },
    );
    expect(collectSeriesOperands(cfg).length).toBe(2);
  });
});

describe("cloneRule with a series operand", () => {
  it("deep-copies the recipe so edits don't alias", () => {
    const rule = { left: ser(EMA9_RECIPE), op: "gt" as const, right: ser(TREND_RECIPE) };
    const copy = cloneRule(rule);
    const left = copy.left as Extract<Operand, { kind: "series" }>;
    const orig = rule.left as Extract<Operand, { kind: "series" }>;
    expect(left.recipe).not.toBe(orig.recipe);
    if (left.recipe.source === "indicator" && orig.recipe.source === "indicator") {
      expect(left.recipe.calcParams).not.toBe(orig.recipe.calcParams);
    }
  });
});

describe("collectSeriesOperands with slope", () => {
  it("collects a sloped price operand (which now keys a series)", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "price", field: "close", slope: { len: 2 } }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
      longExit: EMPTY_GROUP,
      shortEntry: EMPTY_GROUP,
      shortExit: EMPTY_GROUP,
      longEnabled: true,
      shortEnabled: true,
      costs: { quantity: 1, commissionPerSide: 0, slippage: { kind: "fixed", value: 0, atrMult: 0 }, startingCash: 10_000 },
    };
    expect(collectSeriesOperands(cfg).map(seriesName)).toEqual(["close~2"]);
  });
});

describe("longestIndicatorLength with slope", () => {
  it("adds the slope lookback to the operand's own length", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "indicator", indicator: "EMA", length: 50, slope: { len: 5 } }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
      longExit: EMPTY_GROUP,
      shortEntry: EMPTY_GROUP,
      shortExit: EMPTY_GROUP,
      longEnabled: true,
      shortEnabled: true,
      costs: { quantity: 1, commissionPerSide: 0, slippage: { kind: "fixed", value: 0, atrMult: 0 }, startingCash: 10_000 },
    };
    expect(longestIndicatorLength(cfg)).toBe(55);
  });

  it("uses a series operand's length param, but never AVWAP's anchor as a length", () => {
    // EMA(50) series operand -> 50 warm-up bars.
    const ema = cfgWith({
      left: ser({ source: "indicator", indicatorType: "EMA", calcParams: [50], line: 0 }),
      op: "gt",
      right: { kind: "const", value: 0 },
    });
    expect(longestIndicatorLength(ema)).toBe(50);
    // AVWAP's calcParams[0] is an anchor epoch-ms, NOT a bar count — warm-up must
    // not balloon to ~1.7e12 bars.
    const avwap = cfgWith({
      left: ser({ source: "indicator", indicatorType: "AVWAP", calcParams: [1_700_000_000_000], line: 0 }),
      op: "gt",
      right: { kind: "const", value: 0 },
    });
    expect(longestIndicatorLength(avwap)).toBe(1);
  });

  it("operandBaseLen warms a raw (unsmoothed) SLOPE operand by MA length + slope lookback", () => {
    // Rate-only encoding: line < K is the raw slope — the series is built with
    // smoothing UNDEFINED (backtestSeries.ts), so its warm-up is len + n only. The
    // configured smoothing must NOT be added here (that would over-warm the raw line).
    const op = ser({
      source: "indicator",
      indicatorType: "SLOPE",
      calcParams: [9, 21],
      line: 0, // < K (=2): raw slope for lengths[0]=9
      extend: { slopePeriod: 3, smoothing: { type: "sma", length: 5 } },
    });
    expect(operandBaseLen(op)).toBe(9 + 3); // len + n, smoothing excluded
  });

  it("operandBaseLen warms a smoothed SLOPE operand by MA length + slope lookback + smoothing window", () => {
    // line >= K is the SMOOTHED slope — the series is built WITH smoothing, so its
    // warm-up must also cover the smoothing window: len + n + smoothingLength.
    const op = ser({
      source: "indicator",
      indicatorType: "SLOPE",
      calcParams: [9, 21],
      line: 2, // = K: smoothed slope for lengths[2-K]=lengths[0]=9
      extend: { slopePeriod: 3, smoothing: { type: "sma", length: 5 } },
    });
    expect(operandBaseLen(op)).toBe(9 + 3 + 5); // len + n + smoothing
  });

  it("operandBaseLen caps SLOPE's length list at 5, matching the series (K agreement)", () => {
    // 6 configured lengths; slopeLengths() caps to the first 5 → [9,21,50,100,200],
    // so K=5. line 5 = K indexes the smoothed slope for the FIRST kept length
    // (5-K=0), lengths[0]=9. No smoothing configured, so it degenerates to len + n
    // (9+3). Without the cap K would be 6 and line 5 would read lengths[5]=300.
    const op = ser({
      source: "indicator",
      indicatorType: "SLOPE",
      calcParams: [9, 21, 50, 100, 200, 300],
      line: 5,
    });
    expect(operandBaseLen(op)).toBe(9 + 3);
  });

  it("SLOPE accel warm-up reaches back far enough per block", () => {
    const op = (line: number, extend: object) =>
      ser({ source: "indicator" as const, indicatorType: "SLOPE" as const,
            calcParams: [9, 21], line, extend } as SeriesRecipe);
    const base = { slopePeriod: 3, accelPeriod: 4 };
    const K = 2;
    // Block 0: len + n
    expect(operandBaseLen(op(0, base))).toBe(9 + 3);
    // Block 1: len + n + smoothing window
    expect(operandBaseLen(op(K + 0, { ...base, smoothing: { type: "sma", length: 5 } })))
      .toBe(9 + 3 + 5);
    // Block 2: len + n + n2
    expect(operandBaseLen(op(2 * K + 0, base))).toBe(9 + 3 + 4);
    // Block 2 with slope smoothing on: accel differentiates the SMOOTHED slope,
    // so the smoothing window counts too.
    expect(operandBaseLen(op(2 * K + 0, { ...base, smoothing: { type: "sma", length: 5 } })))
      .toBe(9 + 3 + 4 + 5);
    // Block 3: block 2 + accel smoothing window
    expect(operandBaseLen(op(3 * K + 1, { ...base, accelSmoothing: { type: "sma", length: 2 } })))
      .toBe(21 + 3 + 4 + 2);
  });
});

describe("defaultBacktestConfig", () => {
  it("has four populated groups: long entry/exit + short entry/exit (mirror)", () => {
    const cfg = defaultBacktestConfig();
    expect(cfg.range).toEqual({ mode: "bars", bars: 500, history: "minimal" });
    expect(cfg.longEntry.rules[0].op).toBe("crossesAbove");
    expect(cfg.longExit.rules[0].op).toBe("crossesBelow");
    expect(cfg.shortEntry.rules[0].op).toBe("crossesBelow"); // mirror of long entry
    expect(cfg.shortExit.rules[0].op).toBe("crossesAbove");
    expect(cfg.longEnabled).toBe(true); // both sides trade by default
    expect(cfg.shortEnabled).toBe(true);
    expect(cfg.costs).toEqual({
      quantity: 1,
      commissionPerSide: 0,
      slippage: { kind: "fixed", value: 0, atrMult: 0 },
      spread: 0,
      finLongDailyPct: 0,
      finShortDailyPct: 0,
      startingCash: 10_000,
    });
  });
});

describe("normalizeBacktestConfig", () => {
  it("coerces a persisted numeric slippage into the fixed model", () => {
    const stored = {
      ...defaultBacktestConfig(),
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0.4, startingCash: 1000 },
    };
    const cfg = normalizeBacktestConfig(stored as unknown as BacktestConfig);
    expect(cfg.costs.slippage).toEqual({ kind: "fixed", value: 0.4, atrMult: 0 });
    expect(cfg.costs.spread).toBe(0);
    expect(cfg.costs.finLongDailyPct).toBe(0);
    expect(cfg.costs.finShortDailyPct).toBe(0);
  });

  it("leaves a well-formed object slippage untouched and fills missing fields", () => {
    const stored = {
      ...defaultBacktestConfig(),
      costs: {
        quantity: 2,
        commissionPerSide: 1,
        slippage: { kind: "atr" as const, value: 0.1, atrMult: 1.5 },
        startingCash: 5000,
      },
    };
    const cfg = normalizeBacktestConfig(stored as unknown as BacktestConfig);
    expect(cfg.costs.slippage).toEqual({ kind: "atr", value: 0.1, atrMult: 1.5 });
    expect(cfg.costs.quantity).toBe(2);
    expect(cfg.costs.startingCash).toBe(5000);
    expect(cfg.costs.spread).toBe(0);
    expect(cfg.costs.finLongDailyPct).toBe(0);
  });
});

describe("longestIndicatorLength", () => {
  it("is the longest length across all four groups, defaulting length-less indicators to 1", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 9 },
            op: "gt",
            right: { kind: "indicator", indicator: "SMA", length: 200 },
          },
        ],
      },
      longExit: {
        combine: "AND",
        rules: [{ left: { kind: "indicator", indicator: "AVWAP" }, op: "gt", right: { kind: "const", value: 0 } }],
      },
      shortEntry: EMPTY_GROUP,
      shortExit: EMPTY_GROUP,
      longEnabled: true,
      shortEnabled: true,
      costs: { quantity: 1, commissionPerSide: 0, slippage: { kind: "fixed", value: 0, atrMult: 0 }, startingCash: 10_000 },
    };
    expect(longestIndicatorLength(cfg)).toBe(200);
  });

  it("is 1 when there are no indicator operands", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      longEntry: { combine: "AND", rules: [{ left: { kind: "price", field: "close" }, op: "gt", right: { kind: "const", value: 1 } }] },
      longExit: EMPTY_GROUP,
      shortEntry: EMPTY_GROUP,
      shortExit: EMPTY_GROUP,
      longEnabled: true,
      shortEnabled: true,
      costs: { quantity: 1, commissionPerSide: 0, slippage: { kind: "fixed", value: 0, atrMult: 0 }, startingCash: 10_000 },
    };
    expect(longestIndicatorLength(cfg)).toBe(1);
  });
});

describe("risk ATR collection", () => {
  it("collects ATR lengths from stop and target of both sides, deduped", () => {
    const cfg = {
      ...defaultBacktestConfig(),
      longRisk: { stop: { kind: "trailAtr" as const, mult: 2, length: 14 },
                  target: { kind: "atr" as const, mult: 3, length: 14 } },
      shortRisk: { stop: { kind: "atr" as const, mult: 2, length: 20 },
                   target: { kind: "none" as const } },
    };
    expect(riskAtrLengths(cfg).sort((a, b) => a - b)).toEqual([14, 20]);
  });

  it("ignores non-ATR stop kinds", () => {
    const cfg = {
      ...defaultBacktestConfig(),
      longRisk: { stop: { kind: "pct" as const, value: 2 }, target: { kind: "none" as const } },
    };
    expect(riskAtrLengths(cfg)).toEqual([]);
  });

  it("longestIndicatorLength counts a risk ATR length larger than any rule", () => {
    const cfg = {
      ...defaultBacktestConfig(), // rules use EMA 9/21
      longRisk: { stop: { kind: "atr" as const, mult: 2, length: 50 }, target: { kind: "none" as const } },
    };
    expect(longestIndicatorLength(cfg)).toBe(50);
  });
});

describe("scaling ATR", () => {
  it("collects spacing ATR lengths and folds into warm-up", () => {
    const cfg = { ...defaultBacktestConfig(),
      longScaling: { maxConcurrent: 3, spacing: { kind: "atr" as const, mult: 2, length: 40 } } };
    expect(scalingAtrLengths(cfg)).toEqual([40]);
    expect(longestIndicatorLength(cfg)).toBe(40);
  });
  it("no ATR when spacing is pct/absent", () => {
    const cfg = { ...defaultBacktestConfig(),
      longScaling: { maxConcurrent: 3, spacing: { kind: "pct" as const, value: 1 } } };
    expect(scalingAtrLengths(cfg)).toEqual([]);
  });
});

const series: Operand = { kind: "series", seriesKey: "k", label: "EMA(9)", recipe: { source: "indicator", indicatorType: "EMA", calcParams: [9], line: 0 } };

describe("swapSides", () => {
  it("A gt B -> B lt A (operands swapped, operator mirrored, truth preserved)", () => {
    const rule: Rule = { left: { kind: "price", field: "close" }, op: "gt", right: { kind: "const", value: 5 } };
    expect(swapSides(rule)).toEqual({ left: { kind: "const", value: 5 }, op: "lt", right: { kind: "price", field: "close" } });
  });
  it("crosses self-mirrors", () => {
    const rule: Rule = { left: series, op: "crosses", right: { kind: "const", value: 0 } };
    expect(swapSides(rule).op).toBe("crosses");
  });
  it("a full round-trip returns the original rule", () => {
    const rule: Rule = { left: series, op: "crossesAbove", right: { kind: "const", value: 1 }, enabled: false, count: 3 };
    expect(swapSides(swapSides(rule))).toEqual(rule);
  });
  it("OP_REVERSE is a complete involution", () => {
    for (const [k, v] of Object.entries(OP_REVERSE)) expect(OP_REVERSE[v]).toBe(k);
  });
});

describe("invertRule", () => {
  it("EMA(50) < low -> EMA(50) > high (operand mirrored in place, operator flipped)", () => {
    const rule: Rule = { left: { kind: "indicator", indicator: "EMA", length: 50 }, op: "lt", right: { kind: "price", field: "low" } };
    expect(invertRule(rule)).toEqual({ left: { kind: "indicator", indicator: "EMA", length: 50 }, op: "gt", right: { kind: "price", field: "high" } });
  });
  it("X < 1 -> X > -1 (constant negated, operator flipped)", () => {
    const rule: Rule = { left: series, op: "lt", right: { kind: "const", value: 1 } };
    expect(invertRule(rule)).toEqual({ left: series, op: "gt", right: { kind: "const", value: -1 } });
  });
  it("high↔low both directions; open/close are not extremes and stay put", () => {
    const highLow: Rule = { left: { kind: "price", field: "high" }, op: "gt", right: { kind: "price", field: "low" } };
    expect(invertRule(highLow)).toEqual({ left: { kind: "price", field: "low" }, op: "lt", right: { kind: "price", field: "high" } });
    const closeOpen: Rule = { left: { kind: "price", field: "close" }, op: "gt", right: { kind: "price", field: "open" } };
    expect(invertRule(closeOpen)).toEqual({ left: { kind: "price", field: "close" }, op: "lt", right: { kind: "price", field: "open" } });
  });
  it("preserves enabled/count and is its own inverse (round-trip)", () => {
    const rule: Rule = { left: { kind: "price", field: "high" }, op: "crossesAbove", right: { kind: "const", value: 30 }, enabled: false, count: 3 };
    expect(invertRule(invertRule(rule))).toEqual(rule);
  });
  it("does not mutate the input rule", () => {
    const rule: Rule = { left: { kind: "price", field: "low" }, op: "lt", right: { kind: "const", value: 5 } };
    invertRule(rule);
    expect(rule).toEqual({ left: { kind: "price", field: "low" }, op: "lt", right: { kind: "const", value: 5 } });
  });
});

describe("ruleFromChartOperand", () => {
  it("seeds { left: series, op: gt, right: const 0 }", () => {
    expect(ruleFromChartOperand(series)).toEqual({ left: series, op: "gt", right: { kind: "const", value: 0 } });
  });
});

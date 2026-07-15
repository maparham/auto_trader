import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// indicatorOutputs (below) now pulls in backtestSeries -> customIndicators, which
// reads LineType at module load (AVWAP line style table); stub klinecharts' runtime
// surface like backtestSeries.test.ts / overlays.test.ts do.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

import {
  indicatorToRecipe,
  drawingToRecipe,
  recipeLabel,
  isSupportedIndicatorType,
  isSupportedDrawingName,
  indicatorOutputs,
  chartOperandSources,
} from "./chartOperand";

const candles = (n: number): KLineData[] =>
  Array.from({ length: n }, (_, i) => ({ timestamp: i * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 0 }));

describe("supported-type gates", () => {
  it("accepts the 7 custom indicator types, rejects SESSIONS and stock built-ins", () => {
    for (const t of ["EMA", "MA", "LR", "VWAP", "AVWAP", "PREV_HL", "RSI"]) expect(isSupportedIndicatorType(t)).toBe(true);
    for (const t of ["SESSIONS", "MACD", "BOLL", "KDJ"]) expect(isSupportedIndicatorType(t)).toBe(false);
  });
  it("accepts the straight-line drawing family, rejects channels/fibs/vertical", () => {
    for (const d of ["segment", "rayLine", "straightLine", "horizontalStraightLine", "priceLine"]) {
      expect(isSupportedDrawingName(d)).toBe(true);
    }
    for (const d of ["priceChannelLine", "fibonacciLine", "verticalStraightLine"]) {
      expect(isSupportedDrawingName(d)).toBe(false);
    }
  });
});

describe("indicatorToRecipe", () => {
  it("returns null for an unsupported type", () => {
    expect(indicatorToRecipe("MACD", [12, 26, 9], {})).toBeNull();
  });

  it("captures calcParams + line and strips non-compute extend keys", () => {
    const built = indicatorToRecipe("LR", [100, 2], {
      source: "hl2",
      indType: "LR",
      userVisible: true,
      lineHidden: { up: true },
      visibility: { mode: "all" },
    });
    expect(built).not.toBeNull();
    expect(built!.recipe).toMatchObject({ source: "indicator", indicatorType: "LR", calcParams: [100, 2], line: 0 });
    // Keeps the compute input (source), drops bookkeeping/render-state keys.
    expect(built!.recipe.extend).toEqual({ source: "hl2" });
  });

  it("captures the instance's MTF timeframe", () => {
    const built = indicatorToRecipe("EMA", [9], { mtf: { timeframe: "HOUR" } });
    expect(built!.timeframe).toBe("HOUR");
    // mtf is stripped from the recipe extend (not a compute input for the operand path).
    expect(built!.recipe.extend).toBeUndefined();
  });
});

describe("drawingToRecipe", () => {
  it("returns null for an unsupported drawing", () => {
    expect(drawingToRecipe("fibonacciLine", [{ timestamp: 0, value: 1 }], candles(5))).toBeNull();
  });

  it("keeps absolute timestamps as-is", () => {
    const r = drawingToRecipe(
      "segment",
      [{ timestamp: 60_000, value: 10 }, { timestamp: 180_000, value: 30 }],
      candles(5),
    );
    expect(r).toEqual({
      source: "drawing",
      drawingKind: "segment",
      anchors: [{ timestamp: 60_000, value: 10 }, { timestamp: 180_000, value: 30 }],
    });
  });

  it("resolves in-range dataIndex points and extrapolates beyond the last bar", () => {
    const r = drawingToRecipe(
      "rayLine",
      [{ dataIndex: 2, value: 5 }, { dataIndex: 12, value: 15 }], // index 12 is 8 bars past the last (idx 4)
      candles(5),
    )!;
    expect(r.anchors[0].timestamp).toBe(2 * 60_000); // in range
    expect(r.anchors[1].timestamp).toBe(4 * 60_000 + (12 - 4) * 60_000); // extrapolated
  });

  it("drops anchors with no resolvable timestamp or value", () => {
    const r = drawingToRecipe("straightLine", [{ value: 5 }, { timestamp: 60_000, value: 10 }], candles(3));
    expect(r!.anchors).toEqual([{ timestamp: 60_000, value: 10 }]);
  });
});

describe("recipeLabel", () => {
  it("labels indicators and drawings legibly", () => {
    expect(recipeLabel({ source: "indicator", indicatorType: "EMA", calcParams: [9], line: 0 })).toBe("EMA(9)");
    expect(recipeLabel({ source: "indicator", indicatorType: "LR", calcParams: [100, 2], line: 0 })).toBe("LR(100, 2)");
    expect(recipeLabel({ source: "indicator", indicatorType: "VWAP", calcParams: [], line: 0 })).toBe("VWAP");
    expect(recipeLabel({ source: "indicator", indicatorType: "PREV_HL", calcParams: [], line: 0 })).toBe("Prev H/L");
    expect(recipeLabel({ source: "drawing", drawingKind: "segment", anchors: [] })).toBe("Trendline");
    expect(recipeLabel({ source: "drawing", drawingKind: "priceLine", anchors: [] })).toBe("Horizontal line");
  });
});

describe("indicatorOutputs", () => {
  it("EMA/MA: base only, plus Smoothing when the smoothing MA is enabled", () => {
    expect(indicatorOutputs("EMA", {}, [9])).toEqual([{ lineIndex: 0, label: "Value", base: true }]);
    expect(indicatorOutputs("EMA", { smoothing: { type: "none", length: 9 } }, [9])).toEqual([
      { lineIndex: 0, label: "Value", base: true },
    ]);
    expect(indicatorOutputs("MA", { smoothing: { type: "ema", length: 5 } }, [20])).toEqual([
      { lineIndex: 0, label: "Value", base: true },
      { lineIndex: 1, label: "Smoothing" },
    ]);
  });

  it("LR: regression + bands, gated by lineHidden (index matches LINE_KEYS.LR)", () => {
    expect(indicatorOutputs("LR", {}, [100, 2])).toEqual([
      { lineIndex: 0, label: "Regression", base: true },
      { lineIndex: 1, label: "Upper" },
      { lineIndex: 2, label: "Lower" },
    ]);
    expect(indicatorOutputs("LR", { lineHidden: { up: true, dn: true } }, [100, 2])).toEqual([
      { lineIndex: 0, label: "Regression", base: true },
    ]);
    // All hidden -> fall back to the primary so the row stays pickable.
    expect(indicatorOutputs("LR", { lineHidden: { lr: true, up: true, dn: true } }, [100, 2])).toEqual([
      { lineIndex: 0, label: "Regression", base: true },
    ]);
  });

  it("PREV_HL: active boundary lines only; anchor needs a placed anchorTs", () => {
    // Default (nothing hidden, no anchor) -> rolling+day+week highs & lows, no anchor.
    expect(indicatorOutputs("PREV_HL", {}, [])).toEqual([
      { lineIndex: 0, label: "Rolling High" },
      { lineIndex: 1, label: "Rolling Low" },
      { lineIndex: 2, label: "Day High" },
      { lineIndex: 3, label: "Day Low" },
      { lineIndex: 4, label: "Week High" },
      { lineIndex: 5, label: "Week Low" },
    ]);
    // Only day & week visible.
    expect(
      indicatorOutputs("PREV_HL", { lineHidden: { rollingHigh: true, rollingLow: true } }, []),
    ).toEqual([
      { lineIndex: 2, label: "Day High" },
      { lineIndex: 3, label: "Day Low" },
      { lineIndex: 4, label: "Week High" },
      { lineIndex: 5, label: "Week Low" },
    ]);
    // A placed anchor exposes anchor high/low (indices 6/7).
    const withAnchor = indicatorOutputs("PREV_HL", { anchorTs: 1700000000000 }, []);
    expect(withAnchor).toContainEqual({ lineIndex: 6, label: "Anchor High" });
    expect(withAnchor).toContainEqual({ lineIndex: 7, label: "Anchor Low" });
  });

  it("VWAP/AVWAP: single output (matches computeIndicatorRecipe resolving line 0 only)", () => {
    expect(indicatorOutputs("VWAP", {}, [])).toEqual([{ lineIndex: 0, label: "Value", base: true }]);
    expect(indicatorOutputs("AVWAP", { bands: [{ on: true }] }, [120000])).toEqual([
      { lineIndex: 0, label: "Value", base: true },
    ]);
  });

  it("RSI: value line + all four divergence outputs, regardless of the instance's divergence flags", () => {
    const value = { lineIndex: 0, label: "Value", base: true };
    const divs = [
      { lineIndex: 1, label: "Bullish divergence" },
      { lineIndex: 2, label: "Bearish divergence" },
      { lineIndex: 3, label: "Hidden bullish divergence" },
      { lineIndex: 4, label: "Hidden bearish divergence" },
    ];
    // No divergence config at all → still all four.
    expect(indicatorOutputs("RSI", {}, [14])).toEqual([value, ...divs]);
    // Divergence on but only bullish toggled → still all four (compute force-detects).
    expect(
      indicatorOutputs("RSI", { divergence: { on: true, bullish: true, bearish: false, hiddenBullish: false, hiddenBearish: false } }, [14]),
    ).toEqual([value, ...divs]);
  });

  it("SLOPE: one output per length, each with a fused chipLabel (no base line)", () => {
    expect(indicatorOutputs("SLOPE", {}, [9, 21])).toEqual([
      { lineIndex: 0, label: "Slope MA 9", chipLabel: "MA Slope 9" },
      { lineIndex: 1, label: "Slope MA 21", chipLabel: "MA Slope 21" },
    ]);
  });

  it("SLOPE: smoothing adds a second block of outputs with the smoothing suffix folded into both labels", () => {
    expect(indicatorOutputs("SLOPE", { smoothing: { type: "sma", length: 4 } }, [9])).toEqual([
      { lineIndex: 0, label: "Slope MA 9", chipLabel: "MA Slope 9" },
      { lineIndex: 1, label: "Slope MA 9 · SMA 4", chipLabel: "MA Slope 9 · SMA 4" },
    ]);
  });

  it("offers accel outputs only when showAccel is on", () => {
    const cp = [9, 21];
    expect(indicatorOutputs("SLOPE", { slopePeriod: 3 }, cp).map((o) => o.lineIndex))
      .toEqual([0, 1]);
    const withAccel = indicatorOutputs("SLOPE", { slopePeriod: 3, showAccel: true }, cp);
    expect(withAccel.map((o) => o.lineIndex)).toEqual([0, 1, 4, 5]);
    expect(withAccel[2].label).toBe("Accel MA 9");
    // Block 3 only when accel smoothing is active.
    const smoothed = indicatorOutputs(
      "SLOPE",
      { slopePeriod: 3, showAccel: true, accelSmoothing: { type: "ema", length: 4 } },
      cp,
    );
    expect(smoothed.map((o) => o.lineIndex)).toEqual([0, 1, 4, 5, 6, 7]);
  });

  it("unsupported types return []", () => {
    expect(indicatorOutputs("MACD", {}, [12, 26, 9])).toEqual([]);
    expect(indicatorOutputs("SESSIONS", {}, [])).toEqual([]);
  });
});

describe("chartOperandSources", () => {
  it("single-output indicator: one output, chip label = base label, no suffix", () => {
    const s = chartOperandSources({ kind: "indicator", paneId: "candle_pane", id: "EMA#1", indType: "EMA", calcParams: [200], extendData: {} });
    expect(s.baseLabel).toBe("EMA(200)");
    expect(s.disabled).toBeFalsy();
    expect(s.outputs).toHaveLength(1);
    expect(s.outputs[0].operand).toMatchObject({ kind: "series", label: "EMA(200)" });
    expect(s.outputs[0].operand.recipe).toMatchObject({ source: "indicator", indicatorType: "EMA", line: 0 });
  });

  it("multi-output indicator: base unsuffixed, siblings suffixed; distinct recipe.line + seriesKey", () => {
    const s = chartOperandSources({
      kind: "indicator", paneId: "candle_pane", id: "LR#1", indType: "LR", calcParams: [100, 2], extendData: {},
    });
    expect(s.outputs.map((o) => o.operand.label)).toEqual(["LR(100, 2)", "LR(100, 2): Upper", "LR(100, 2): Lower"]);
    expect(s.outputs.map((o) => o.operand.recipe.source === "indicator" && o.operand.recipe.line)).toEqual([0, 1, 2]);
    const keys = s.outputs.map((o) => o.operand.seriesKey);
    expect(new Set(keys).size).toBe(3); // distinct outputs => distinct series
  });

  it("RSI: 5 outputs (Value + 4 divergences) with base/suffixed labels and distinct seriesKeys", () => {
    const s = chartOperandSources({ kind: "indicator", paneId: "candle_pane", id: "RSI#1", indType: "RSI", calcParams: [14], extendData: {} });
    expect(s.outputs.map((o) => o.operand.label)).toEqual([
      "RSI(14)",
      "RSI(14): Bullish divergence",
      "RSI(14): Bearish divergence",
      "RSI(14): Hidden bullish divergence",
      "RSI(14): Hidden bearish divergence",
    ]);
    expect(s.outputs.map((o) => o.operand.recipe.source === "indicator" && o.operand.recipe.line)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(s.outputs.map((o) => o.operand.seriesKey)).size).toBe(5);
    // A divergence recipe snapshots the pivot/range params and omits per-kind flags.
    const bull = s.outputs[1].operand.recipe;
    expect(bull.source === "indicator" && bull.extend).toMatchObject({
      divergence: { lookbackLeft: 5, lookbackRight: 5, rangeMin: 5, rangeMax: 60 },
    });
    const div = (bull.source === "indicator" && bull.extend?.divergence) as Record<string, unknown>;
    expect(div).not.toHaveProperty("bullish");
    expect(div).not.toHaveProperty("on");
  });

  it("RSI divergence seriesKey dedups across per-kind-flag/style/smoothing differences, but varies with source & pivot params", () => {
    const keyFor = (extendData: unknown, line: number) => {
      const src = chartOperandSources({ kind: "indicator", paneId: "candle_pane", id: "R", indType: "RSI", calcParams: [14], extendData });
      return src.outputs[line].operand.seriesKey;
    };
    const baseline = keyFor({ divergence: { on: true, bullish: true, bearish: false } }, 1);
    // Same pivots, different toggled kinds / style / smoothing → SAME key (dedup).
    expect(keyFor({ divergence: { on: true, bullish: false, bearish: true, hiddenBullish: true } }, 1)).toBe(baseline);
    expect(keyFor({ divergence: { on: true }, style: { bull: "#123456" } }, 1)).toBe(baseline);
    expect(keyFor({ divergence: { on: true }, smoothing: { type: "ema", length: 9 } }, 1)).toBe(baseline);
    // Different price source → DIFFERENT key (changes the RSI the pivots sit on).
    expect(keyFor({ divergence: { on: true }, source: "hl2" }, 1)).not.toBe(baseline);
    // Different pivot params → DIFFERENT key.
    expect(keyFor({ divergence: { on: true, rangeMax: 30 } }, 1)).not.toBe(baseline);
    // Different kind (line) → DIFFERENT key.
    expect(keyFor({ divergence: { on: true } }, 2)).not.toBe(baseline);
  });

  it("SLOPE: chip labels fuse the length (chipLabel overrides the parent:child composition)", () => {
    const s = chartOperandSources({ kind: "indicator", paneId: "candle_pane", id: "SLOPE#1", indType: "SLOPE", calcParams: [9, 21], extendData: {} });
    expect(s.baseLabel).toBe("MA Slope");
    expect(s.outputs.map((o) => o.operand.label)).toEqual(["MA Slope 9", "MA Slope 21"]);
    expect(new Set(s.outputs.map((o) => o.operand.seriesKey)).size).toBe(2);
  });

  it("PREV_HL sub-item labels read 'Prev H/L: Day High' etc.", () => {
    const s = chartOperandSources({ kind: "indicator", paneId: "candle_pane", id: "PH#1", indType: "PREV_HL", calcParams: [], extendData: {} });
    expect(s.outputs.map((o) => o.operand.label)).toContain("Prev H/L: Day High");
  });

  it("carries the instance MTF timeframe onto the operand", () => {
    const s = chartOperandSources({ kind: "indicator", paneId: "candle_pane", id: "EMA#2", indType: "EMA", calcParams: [9], extendData: { mtf: { timeframe: "HOUR" } } });
    expect(s.outputs[0].operand).toMatchObject({ timeframe: "HOUR" });
  });

  it("unsupported indicator: disabled + reason, no outputs", () => {
    const s = chartOperandSources({ kind: "indicator", paneId: "candle_pane", id: "MACD#1", indType: "MACD", calcParams: [12, 26, 9], extendData: {} });
    expect(s.disabled).toBe(true);
    expect(s.disabledReason).toBe("MACD isn't supported in rules yet");
    expect(s.outputs).toEqual([]);
  });

  it("drawing: single output, label via recipeLabel", () => {
    const candles = Array.from({ length: 3 }, (_, i) => ({ timestamp: i * 60000, open: 1, high: 1, low: 1, close: 1, volume: 0 }));
    const s = chartOperandSources({
      kind: "drawing", id: "d1", name: "segment",
      points: [{ timestamp: 0, value: 1 }, { timestamp: 120000, value: 2 }], candles,
    });
    expect(s.baseLabel).toBe("Trendline");
    expect(s.outputs).toHaveLength(1);
    expect(s.outputs[0].operand.recipe).toMatchObject({ source: "drawing", drawingKind: "segment" });
  });

  it("drawing: custom text + color disambiguate same-type drawings (label + operand + swatch)", () => {
    const candles = Array.from({ length: 3 }, (_, i) => ({ timestamp: i * 60000, open: 1, high: 1, low: 1, close: 1, volume: 0 }));
    const s = chartOperandSources({
      kind: "drawing", id: "d1", name: "segment",
      points: [{ timestamp: 0, value: 1 }, { timestamp: 120000, value: 2 }], candles,
      text: "daily uptrend", color: "#ff0000",
    });
    expect(s.baseLabel).toBe("Trendline 'daily uptrend'");
    expect(s.color).toBe("#ff0000");
    expect(s.outputs[0].operand.label).toBe("Trendline 'daily uptrend'");
  });

  it("unsupported drawing: disabled + reason, still carries text + color", () => {
    const s = chartOperandSources({ kind: "drawing", id: "d2", name: "fibonacciLine", points: [], candles: [], text: "fib 1", color: "#00f" });
    expect(s.disabled).toBe(true);
    expect(s.disabledReason).toBe("Fibonacci tools aren't supported in rules yet");
    expect(s.baseLabel).toBe("fibonacciLine 'fib 1'");
    expect(s.color).toBe("#00f");
  });
});

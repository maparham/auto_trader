import { describe, it, expect } from "vitest";
import { chartIndicatorToExprToken } from "./exprChartToken";

describe("chartIndicatorToExprToken", () => {
  it("maps a plain EMA template to EMA(length)", () => {
    expect(chartIndicatorToExprToken("EMA", [9], undefined)).toBe("EMA(9)");
    expect(chartIndicatorToExprToken("EMA", [21], { maType: "ema" })).toBe("EMA(21)");
  });

  it("maps a plain MA template to SMA(length)", () => {
    expect(chartIndicatorToExprToken("MA", [20], undefined)).toBe("SMA(20)");
    expect(chartIndicatorToExprToken("MA", [50], { maType: "sma" })).toBe("SMA(50)");
  });

  it("honors a flipped maType (EMA template set to SMA and vice versa)", () => {
    expect(chartIndicatorToExprToken("EMA", [9], { maType: "sma" })).toBe("SMA(9)");
    expect(chartIndicatorToExprToken("MA", [20], { maType: "ema" })).toBe("EMA(20)");
  });

  it("refuses volume-weighted moving averages (no expression equivalent)", () => {
    expect(chartIndicatorToExprToken("EMA", [9], { maType: "vwma" })).toBeNull();
    expect(chartIndicatorToExprToken("MA", [20], { maType: "evwma" })).toBeNull();
  });

  it("maps RSI / ATR / VOLMA with their length", () => {
    expect(chartIndicatorToExprToken("RSI", [14], undefined)).toBe("RSI(14)");
    expect(chartIndicatorToExprToken("ATR", [14], undefined)).toBe("ATR(14)");
    expect(chartIndicatorToExprToken("VOLMA", [20], undefined)).toBe("VOLMA(20)");
  });

  it("maps VOL with no length (arity 0)", () => {
    expect(chartIndicatorToExprToken("VOL", [], undefined)).toBe("VOL");
    expect(chartIndicatorToExprToken("VOL", undefined, undefined)).toBe("VOL");
  });

  it("returns null for a length-bearing indicator with no usable length", () => {
    expect(chartIndicatorToExprToken("EMA", [], undefined)).toBeNull();
    expect(chartIndicatorToExprToken("RSI", [0], undefined)).toBeNull();
    expect(chartIndicatorToExprToken("ATR", undefined, undefined)).toBeNull();
  });

  it("returns null for unsupported indicator types", () => {
    for (const t of ["MACD", "BOLL", "KDJ", "CCI", "AVWAP", "VWAP", "PIVOT_BANDS"]) {
      expect(chartIndicatorToExprToken(t, [12], undefined)).toBeNull();
    }
  });
});

describe("ATR instance references", () => {
  it("emits an instance ref when the clicked pane's id is passed", () => {
    expect(
      chartIndicatorToExprToken("ATR", [21], {}, { instanceId: "ATR#a1b2c3" }),
    ).toBe("ATR#a1b2c3.21");
  });

  it("references the pane, not its smoothing — an EMA-smoothed pane emits the same ref", () => {
    expect(
      chartIndicatorToExprToken("ATR", [14], { smoothing: "ema" }, { instanceId: "ATR#a1b2c3" }),
    ).toBe("ATR#a1b2c3.14");
  });

  it("garbage length falls back to the same 14 both parser stacks derive", () => {
    expect(
      chartIndicatorToExprToken("ATR", undefined, {}, { instanceId: "ATR#a1b2c3" }),
    ).toBe("ATR#a1b2c3.14");
  });

  it("a numbered id (the current minting scheme) emits an instance ref", () => {
    expect(chartIndicatorToExprToken("ATR", [21], {}, { instanceId: "ATR1" })).toBe("ATR1.21");
    expect(
      chartIndicatorToExprToken("ATR", [14], { smoothing: "sma" }, { instanceId: "ATR2" }),
    ).toBe("ATR2.14");
  });

  it("a bare type-name id cannot parse as a ref, so it falls back to the ATR(length) call", () => {
    expect(chartIndicatorToExprToken("ATR", [14], {}, { instanceId: "ATR" })).toBe("ATR(14)");
  });

  it("the ATR% figure emits the pct output ref", () => {
    expect(
      chartIndicatorToExprToken("ATR", [21], {}, { instanceId: "ATR1", figureKey: "atrPct" }),
    ).toBe("ATR1.21.to%");
  });

  it("the ATR% figure falls back to the ATR%(length) call without a ref-able id", () => {
    expect(chartIndicatorToExprToken("ATR", [14], {}, { figureKey: "atrPct" })).toBe("ATR%(14)");
    expect(
      chartIndicatorToExprToken("ATR", [14], {}, { instanceId: "ATR", figureKey: "atrPct" }),
    ).toBe("ATR%(14)");
  });

  it("other figure keys keep the value output", () => {
    expect(
      chartIndicatorToExprToken("ATR", [21], {}, { instanceId: "ATR1", figureKey: "atr" }),
    ).toBe("ATR1.21");
  });

  it("non-ATR types ignore figureKey", () => {
    expect(chartIndicatorToExprToken("RSI", [14], undefined, { figureKey: "atrPct" })).toBe("RSI(14)");
  });
});

describe("SLOPE instance references", () => {
  it("emits an instance ref for a clicked slope line", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [9, 21], {}, { instanceId: "SLOPE", lineIndex: 1 }),
    ).toBe("SLOPE.21");
  });

  it("emits an accel ref for the companion pane", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [9], { showAccel: true },
        { instanceId: "SLOPE#a1b", lineIndex: 0, output: "accel" }),
    ).toBe("SLOPE#a1b.accel9");
  });

  it("refuses an accel ref when the companion is off", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [9], {},
        { instanceId: "SLOPE", lineIndex: 0, output: "accel" }),
    ).toBeNull();
  });

  it("refuses a line index the pane does not have", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [9], {}, { instanceId: "SLOPE", lineIndex: 3 }),
    ).toBeNull();
  });

  it("refuses when no instance id is supplied", () => {
    expect(chartIndicatorToExprToken("SLOPE", [9], {})).toBeNull();
  });

  // slopeLengths slices to 5, so a sixth configured length draws no line — the
  // backend's slope_outputs would 422 on the 200 line, so the bridge must refuse it.
  it("refuses a line past the five-line cap", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [5, 9, 21, 50, 100, 200], {},
        { instanceId: "SLOPE", lineIndex: 5 }),      // the 200 line, sliced off
    ).toBeNull();
    expect(
      chartIndicatorToExprToken("SLOPE", [5, 9, 21, 50, 100, 200], {},
        { instanceId: "SLOPE", lineIndex: 4 }),
    ).toBe("SLOPE.100");
  });

  // Garbage calcParams normalize to the default single line, so the only token
  // the bridge can emit is the one the backend also derives.
  it("falls back to the default line when calcParams are unusable", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [0], {}, { instanceId: "SLOPE", lineIndex: 0 }),
    ).toBe("SLOPE.9");
    expect(
      chartIndicatorToExprToken("SLOPE", [0], {}, { instanceId: "SLOPE", lineIndex: 1 }),
    ).toBeNull();
  });

  it("defaults to line 0 when no lineIndex is given", () => {
    expect(
      chartIndicatorToExprToken("SLOPE", [9, 21], {}, { instanceId: "SLOPE" }),
    ).toBe("SLOPE.9");
  });
});

describe("FVG panes", () => {
  it("emits the clicked legend figure as the output", () => {
    expect(
      chartIndicatorToExprToken("FVG", [0.25, 500, 10], {}, {
        instanceId: "FVG",
        figureKey: "bear_bottom",
      }),
    ).toBe("FVG.bear_bottom");
  });

  it("falls back to bull_top for a row click with no figure", () => {
    expect(
      chartIndicatorToExprToken("FVG", [0.25, 500, 10], {}, { instanceId: "FVG#a1b" }),
    ).toBe("FVG#a1b.bull_top");
    // An unknown figure key behaves like absence, as the option doc promises.
    expect(
      chartIndicatorToExprToken("FVG", [0.25, 500, 10], {}, { instanceId: "FVG", figureKey: "nope" }),
    ).toBe("FVG.bull_top");
  });

  it("refuses without an instance id — there is nothing to reference", () => {
    expect(chartIndicatorToExprToken("FVG", [0.25, 500, 10], {}, {})).toBeNull();
  });

  it("keeps the ref valid across a retune (params reshape the same outputs)", () => {
    expect(
      chartIndicatorToExprToken("FVG", [0, 50, 2], {}, { instanceId: "FVG", figureKey: "bull_top" }),
    ).toBe("FVG.bull_top");
  });
});

// TRENDLINES declares `figures: []` (it paints its own canvas), so a legend row
// click NEVER carries a figureKey and the fallback is the whole story in
// practice. Without a case here the type falls through to `default: null` and
// BacktestSettingsModal toasts "That indicator has no expression equivalent."
// on a pane that exposes four operands.
const TL_PARAMS = [5, 0.25, 0.75, 2, 20, 250, 30, 3];

describe("TRENDLINES panes", () => {
  it("falls back to tl_support for a row click with no figure", () => {
    expect(chartIndicatorToExprToken("TRENDLINES", TL_PARAMS, {}, { instanceId: "TRENDLINES" })).toBe(
      "TRENDLINES.tl_support",
    );
    expect(
      chartIndicatorToExprToken("TRENDLINES", TL_PARAMS, {}, { instanceId: "TRENDLINES#a1b" }),
    ).toBe("TRENDLINES#a1b.tl_support");
  });

  it("emits a named output when one is passed", () => {
    expect(
      chartIndicatorToExprToken("TRENDLINES", TL_PARAMS, {}, {
        instanceId: "TRENDLINES",
        figureKey: "tl_broken_resistance",
      }),
    ).toBe("TRENDLINES.tl_broken_resistance");
    // An unknown key behaves like absence, as the option doc promises.
    expect(
      chartIndicatorToExprToken("TRENDLINES", TL_PARAMS, {}, {
        instanceId: "TRENDLINES",
        figureKey: "nope",
      }),
    ).toBe("TRENDLINES.tl_support");
  });

  it("refuses without an instance id — there is nothing to reference", () => {
    expect(chartIndicatorToExprToken("TRENDLINES", TL_PARAMS, {}, {})).toBeNull();
  });

  it("keeps the ref valid across a retune (params reshape the same outputs)", () => {
    expect(
      chartIndicatorToExprToken("TRENDLINES", [9, 0, 1.5, 3, 40, 100, 10, 6], { extend: "segment" }, {
        instanceId: "TRENDLINES",
      }),
    ).toBe("TRENDLINES.tl_support");
  });
});

describe("PIVOT_BANDS panes", () => {
  it("emits the clicked legend figure as the output", () => {
    expect(
      chartIndicatorToExprToken("PIVOT_BANDS", [10, 3], {}, {
        instanceId: "PIVOT_BANDS",
        figureKey: "pivotLow",
      }),
    ).toBe("PIVOT_BANDS.pivotLow");
  });

  it("falls back to pivotHigh for a row click with no figure", () => {
    expect(
      chartIndicatorToExprToken("PIVOT_BANDS", [10, 3], {}, { instanceId: "PIVOT_BANDS#a1b" }),
    ).toBe("PIVOT_BANDS#a1b.pivotHigh");
    expect(
      chartIndicatorToExprToken("PIVOT_BANDS", [10, 3], {}, {
        instanceId: "PIVOT_BANDS",
        figureKey: "nope",
      }),
    ).toBe("PIVOT_BANDS.pivotHigh");
  });

  it("refuses without an instance id — there is nothing to reference", () => {
    expect(chartIndicatorToExprToken("PIVOT_BANDS", [10, 3], {}, {})).toBeNull();
  });

  it("keeps the ref valid across a retune (params reshape the same outputs)", () => {
    expect(
      chartIndicatorToExprToken("PIVOT_BANDS", [5, 1], { mode: "avg" }, { instanceId: "PIVOT_BANDS" }),
    ).toBe("PIVOT_BANDS.pivotHigh");
  });
});

describe("PIVOT_ANALYSIS panes", () => {
  it("emits the clicked legend figure as the output", () => {
    expect(
      chartIndicatorToExprToken("PIVOT_ANALYSIS", [34], {}, {
        instanceId: "PIVOT_ANALYSIS",
        figureKey: "pivotLow",
      }),
    ).toBe("PIVOT_ANALYSIS.pivotLow");
  });

  it("falls back to pivotHigh for a row click with no figure", () => {
    expect(
      chartIndicatorToExprToken("PIVOT_ANALYSIS", [34], {}, { instanceId: "PIVOT_ANALYSIS#a1b" }),
    ).toBe("PIVOT_ANALYSIS#a1b.pivotHigh");
    // deltaPct/deltaT have no clickable figure in practice, but the mapping
    // itself is by output name, not click origin: a passed key still resolves
    // if it's one of the four valid outputs.
    expect(
      chartIndicatorToExprToken("PIVOT_ANALYSIS", [34], {}, {
        instanceId: "PIVOT_ANALYSIS",
        figureKey: "deltaPct",
      }),
    ).toBe("PIVOT_ANALYSIS.deltaPct");
    // An unrecognised key behaves like absence.
    expect(
      chartIndicatorToExprToken("PIVOT_ANALYSIS", [34], {}, {
        instanceId: "PIVOT_ANALYSIS",
        figureKey: "nope",
      }),
    ).toBe("PIVOT_ANALYSIS.pivotHigh");
  });

  it("refuses without an instance id — there is nothing to reference", () => {
    expect(chartIndicatorToExprToken("PIVOT_ANALYSIS", [34], {}, {})).toBeNull();
  });
});

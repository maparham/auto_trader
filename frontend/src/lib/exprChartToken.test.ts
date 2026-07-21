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
    for (const t of ["MACD", "BOLL", "KDJ", "CCI", "AVWAP", "VWAP", "SLOPE", "PIVOT_BANDS"]) {
      expect(chartIndicatorToExprToken(t, [12], undefined)).toBeNull();
    }
  });
});

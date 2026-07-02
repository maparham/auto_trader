import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";
import type { BacktestConfig } from "./backtestConfig";

// customIndicators.ts reads LineType at module load (AVWAP line style table);
// stub klinecharts' runtime surface like overlays.test.ts does.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
}));

const { buildSeries } = await import("./backtestSeries");

function candles(closes: number[], volumes?: number[]): KLineData[] {
  return closes.map((c, i) => ({
    timestamp: i * 60_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: volumes?.[i] ?? 0,
  }));
}

function cfg(overrides: Partial<BacktestConfig>): BacktestConfig {
  return {
    range: { mode: "bars", bars: 500 },
    longEntry: { combine: "AND", rules: [] },
    longExit: { combine: "AND", rules: [] },
    shortEntry: { combine: "AND", rules: [] },
    shortExit: { combine: "AND", rules: [] },
    longEnabled: true,
    shortEnabled: true,
    costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
    ...overrides,
  };
}

describe("buildSeries", () => {
  it("keys the output by the seriesName contract", () => {
    const bars = candles([1, 2, 3, 4, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 3 },
            op: "gt",
            right: { kind: "indicator", indicator: "RSI", length: 14 },
          },
        ],
      },
    });
    const series = buildSeries(bars, config);
    expect(Object.keys(series).sort()).toEqual(["EMA_3", "RSI_14"]);
  });

  it("every series has the same length as the candles, with null warmup", () => {
    const bars = candles([1, 2, 3, 4, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "SMA", length: 3 },
            op: "gt",
            right: { kind: "const", value: 0 },
          },
        ],
      },
    });
    const series = buildSeries(bars, config);
    expect(series["SMA_3"]).toHaveLength(5);
    expect(series["SMA_3"][0]).toBeNull();
    expect(series["SMA_3"][1]).toBeNull();
    expect(series["SMA_3"][2]).not.toBeNull();
  });

  it("uses .val for RSI (not .rsi, which is omitted when the line is hidden)", () => {
    const bars = candles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "RSI", length: 14 },
            op: "gt",
            right: { kind: "const", value: 0 },
          },
        ],
      },
    });
    const series = buildSeries(bars, config);
    // RSI(14) needs 15 bars of run-up; the 16th (index 15) should be defined.
    expect(series["RSI_14"][15]).not.toBeNull();
    expect(typeof series["RSI_14"][15]).toBe("number");
  });

  it("VOL reads raw volume, VOLMA smooths it", () => {
    const bars = candles([1, 1, 1, 1], [10, 20, 30, 40]);
    const config = cfg({
      longEntry: {
        combine: "OR",
        rules: [
          { left: { kind: "indicator", indicator: "VOL" }, op: "gt", right: { kind: "const", value: 0 } },
          {
            left: { kind: "indicator", indicator: "VOLMA", length: 2 },
            op: "gt",
            right: { kind: "const", value: 0 },
          },
        ],
      },
    });
    const series = buildSeries(bars, config);
    expect(series["VOL"]).toEqual([10, 20, 30, 40]);
    expect(series["VOLMA_2"][0]).toBeNull();
    expect(series["VOLMA_2"][1]).toBe(15);
  });

  it("AVWAP anchors at index 0", () => {
    const bars = candles([10, 10, 10], [5, 5, 5]);
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "indicator", indicator: "AVWAP" }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    const series = buildSeries(bars, config);
    expect(series["AVWAP"]).toHaveLength(3);
    expect(series["AVWAP"][0]).not.toBeNull();
  });
});

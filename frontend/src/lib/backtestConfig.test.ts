import { describe, it, expect } from "vitest";
import {
  seriesName,
  collectSeriesOperands,
  longestIndicatorLength,
  defaultBacktestConfig,
  type BacktestConfig,
} from "./backtestConfig";

describe("seriesName", () => {
  it("keys MA/RSI/VOLMA by indicator_length", () => {
    expect(seriesName({ kind: "indicator", indicator: "EMA", length: 9 })).toBe("EMA_9");
    expect(seriesName({ kind: "indicator", indicator: "SMA", length: 50 })).toBe("SMA_50");
    expect(seriesName({ kind: "indicator", indicator: "RSI", length: 14 })).toBe("RSI_14");
    expect(seriesName({ kind: "indicator", indicator: "VOLMA", length: 20 })).toBe("VOLMA_20");
  });

  it("keys AVWAP/VOL by name alone (no length)", () => {
    expect(seriesName({ kind: "indicator", indicator: "AVWAP" })).toBe("AVWAP");
    expect(seriesName({ kind: "indicator", indicator: "VOL" })).toBe("VOL");
  });

  it("returns null for price/const (no series, read off the candle)", () => {
    expect(seriesName({ kind: "price", field: "close" })).toBeNull();
    expect(seriesName({ kind: "const", value: 5 })).toBeNull();
  });
});

describe("collectSeriesOperands", () => {
  it("dedupes the same indicator referenced in both entry and exit", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      entry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 9 },
            op: "crossesAbove",
            right: { kind: "indicator", indicator: "EMA", length: 21 },
          },
        ],
      },
      exit: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 9 },
            op: "crossesBelow",
            right: { kind: "indicator", indicator: "EMA", length: 21 },
          },
        ],
      },
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
    };
    const names = collectSeriesOperands(cfg).map(seriesName).sort();
    expect(names).toEqual(["EMA_21", "EMA_9"]);
  });

  it("excludes price/const operands", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      entry: {
        combine: "AND",
        rules: [{ left: { kind: "price", field: "close" }, op: "gt", right: { kind: "const", value: 1 } }],
      },
      exit: { combine: "AND", rules: [] },
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
    };
    expect(collectSeriesOperands(cfg)).toEqual([]);
  });
});

describe("defaultBacktestConfig", () => {
  it("is EMA-9 crossesAbove EMA-21 entry, crossesBelow exit, bars=500, zero costs", () => {
    const cfg = defaultBacktestConfig();
    expect(cfg.range).toEqual({ mode: "bars", bars: 500, history: "full" });
    expect(cfg.entry.rules[0].op).toBe("crossesAbove");
    expect(cfg.exit.rules[0].op).toBe("crossesBelow");
    expect(cfg.costs).toEqual({ quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 });
  });
});

describe("longestIndicatorLength", () => {
  it("is the longest length across entry and exit, defaulting length-less indicators to 1", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      entry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 9 },
            op: "gt",
            right: { kind: "indicator", indicator: "SMA", length: 200 },
          },
        ],
      },
      exit: {
        combine: "AND",
        rules: [{ left: { kind: "indicator", indicator: "AVWAP" }, op: "gt", right: { kind: "const", value: 0 } }],
      },
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
    };
    expect(longestIndicatorLength(cfg)).toBe(200);
  });

  it("is 1 when there are no indicator operands", () => {
    const cfg: BacktestConfig = {
      range: { mode: "bars", bars: 500 },
      entry: { combine: "AND", rules: [{ left: { kind: "price", field: "close" }, op: "gt", right: { kind: "const", value: 1 } }] },
      exit: { combine: "AND", rules: [] },
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
    };
    expect(longestIndicatorLength(cfg)).toBe(1);
  });
});

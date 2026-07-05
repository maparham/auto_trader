import { describe, it, expect } from "vitest";
import {
  seriesName,
  collectSeriesOperands,
  longestIndicatorLength,
  defaultBacktestConfig,
  riskAtrLengths,
  scalingAtrLengths,
  type BacktestConfig,
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
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
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
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
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
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
    };
    const names = collectSeriesOperands(cfg).map(seriesName).sort();
    expect(names).toEqual(["AVWAP_1000", "AVWAP_2000"]);
  });
});

describe("defaultBacktestConfig", () => {
  it("has four populated groups: long entry/exit + short entry/exit (mirror)", () => {
    const cfg = defaultBacktestConfig();
    expect(cfg.range).toEqual({ mode: "bars", bars: 500, history: "full" });
    expect(cfg.longEntry.rules[0].op).toBe("crossesAbove");
    expect(cfg.longExit.rules[0].op).toBe("crossesBelow");
    expect(cfg.shortEntry.rules[0].op).toBe("crossesBelow"); // mirror of long entry
    expect(cfg.shortExit.rules[0].op).toBe("crossesAbove");
    expect(cfg.longEnabled).toBe(true); // both sides trade by default
    expect(cfg.shortEnabled).toBe(true);
    expect(cfg.costs).toEqual({ quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 });
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
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
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
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
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

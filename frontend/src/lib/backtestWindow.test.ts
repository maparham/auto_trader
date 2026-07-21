import { describe, it, expect } from "vitest";
import {
  resolveWindow,
  resolveHistoryStart,
  minimalHistoryStart,
  requiredWarmupBars,
  warmupBarCount,
  longestWarmupBars,
} from "./backtestWindow";
import type { BacktestConfig } from "./backtestConfig";

const DAY_MS = 86_400_000;

function cfg(overrides: Partial<BacktestConfig>): BacktestConfig {
  return {
    range: { mode: "bars", bars: 500 },
    longEntry: { combine: "AND", rules: [] },
    longExit: { combine: "AND", rules: [] },
    shortEntry: { combine: "AND", rules: [] },
    shortExit: { combine: "AND", rules: [] },
    longEnabled: true,
    shortEnabled: true,
    costs: { quantity: 1, commissionPerSide: 0, slippage: { kind: "fixed", value: 0, atrMult: 0 }, startingCash: 10_000 },
    ...overrides,
  };
}

// Warm-up now comes from ATR risk/scaling lengths and expression rows only (the
// structured operand model is gone). An ATR stop of length N drives an N-bar
// warm-up, which these tests use to exercise the window math deterministically.
const atrRisk = (length: number): Partial<BacktestConfig> => ({
  longRisk: { stop: { kind: "atr", mult: 2, length }, target: { kind: "none" } },
});

describe("resolveWindow", () => {
  const now = 1_700_000_000_000;

  it("bars mode: window is the last N bars by resolution seconds", () => {
    const { fromMs, toMs } = resolveWindow(cfg({ range: { mode: "bars", bars: 10 } }), 60, now);
    expect(toMs).toBe(now);
    expect(fromMs).toBe(now - 10 * 60 * 1000);
  });

  it("lastWeek mode: window is the trailing 7 days", () => {
    const { fromMs, toMs } = resolveWindow(cfg({ range: { mode: "lastWeek" } }), 3600, now);
    expect(toMs).toBe(now);
    expect(fromMs).toBe(now - 7 * DAY_MS);
  });

  it("custom mode: window is exactly fromMs/toMs", () => {
    const { fromMs, toMs } = resolveWindow(
      cfg({ range: { mode: "custom", fromMs: 100, toMs: 200 } }),
      60,
      now,
    );
    expect(fromMs).toBe(100);
    expect(toMs).toBe(200);
  });
});

describe("resolveHistoryStart / minimalHistoryStart — weekend padding", () => {
  const windowFromMs = 1_700_000_000_000;

  it("pads sub-week resolutions so a weekend inside the lookback doesn't undercount real bars", () => {
    // "minimal" depth, warm-up needs 200 bars on DAY resolution (86400s). A flat
    // 200*86400s calendar subtraction would land ~28% short of 200 REAL trading-
    // day candles (weekends have none) — the padded start must reach further back
    // than the naive calculation to compensate.
    const config = cfg(atrRisk(200));
    const naiveStart = windowFromMs - 200 * 86_400 * 1000;
    const paddedStart = minimalHistoryStart(config, windowFromMs, 86_400);
    expect(paddedStart).toBeLessThan(naiveStart);
  });

  it("does not pad resolutions at/above a week (no weekend gap to compensate for)", () => {
    const config = cfg(atrRisk(20));
    const weekSeconds = 604_800;
    const naiveStart = windowFromMs - 20 * weekSeconds * 1000;
    expect(minimalHistoryStart(config, windowFromMs, weekSeconds)).toBe(naiveStart);
  });

  it("bars depth pads the user-typed history bar count the same way", () => {
    const config = cfg({ range: { mode: "bars", bars: 500, history: "bars", historyBars: 100 } });
    const naiveStart = windowFromMs - 100 * 86_400 * 1000;
    expect(resolveHistoryStart(config, windowFromMs, 86_400)).toBeLessThan(naiveStart);
  });
});

describe("requiredWarmupBars", () => {
  const config = (history: "full" | "bars" | "minimal", historyBars?: number) =>
    cfg({
      range: { mode: "bars", bars: 500, history, historyBars },
      ...atrRisk(21),
    });

  it("minimal: the longest ATR length", () => {
    expect(requiredWarmupBars(config("minimal"))).toBe(21);
  });

  it("bars: the user-typed history bar count", () => {
    expect(requiredWarmupBars(config("bars", 300))).toBe(300);
  });

  it("full: the longest ATR length is still the floor (can't ask for less than that)", () => {
    expect(requiredWarmupBars(config("full"))).toBe(21);
  });
});

describe("expression-row warmup", () => {
  it("sizes warmup from an all-expression config", () => {
    const c = cfg({
      longEntry: { combine: "AND", rules: [{ expr: "EMA(200) > candle.close", enabled: true }] },
    });
    expect(longestWarmupBars(c, 60)).toBeGreaterThanOrEqual(200);
    expect(requiredWarmupBars(c, 60)).toBeGreaterThanOrEqual(200);
  });

  it("ignores a disabled expression row", () => {
    const c = cfg({
      longEntry: { combine: "AND", rules: [{ expr: "EMA(200) > candle.close", enabled: false }] },
    });
    expect(longestWarmupBars(c, 60)).toBe(1);
  });
});

describe("warmupBarCount", () => {
  it("counts bars strictly before the window start", () => {
    const bars = [{ timestamp: 0 }, { timestamp: 1000 }, { timestamp: 2000 }, { timestamp: 3000 }];
    expect(warmupBarCount(bars, 2000)).toBe(2);
  });

  it("is 0 when every bar is inside the window", () => {
    const bars = [{ timestamp: 5000 }, { timestamp: 6000 }];
    expect(warmupBarCount(bars, 2000)).toBe(0);
  });
});

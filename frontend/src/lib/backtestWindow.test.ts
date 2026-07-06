import { describe, it, expect } from "vitest";
import {
  resolveWindow,
  resolveHistoryStart,
  minimalHistoryStart,
  requiredWarmupBars,
  warmupBarCount,
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
    costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
    ...overrides,
  };
}

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
    // "minimal" depth, indicator needs 200 bars on DAY resolution (86400s).
    // A flat 200*86400s calendar subtraction would land ~28% short of 200 REAL
    // trading-day candles (weekends have none) — the padded start must reach
    // further back than the naive calculation to compensate.
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "SMA", length: 200 },
            op: "gt",
            right: { kind: "const", value: 0 },
          },
        ],
      },
    });
    const naiveStart = windowFromMs - 200 * 86_400 * 1000;
    const paddedStart = minimalHistoryStart(config, windowFromMs, 86_400);
    expect(paddedStart).toBeLessThan(naiveStart);
  });

  it("does not pad resolutions at/above a week (no weekend gap to compensate for)", () => {
    const config = cfg({
      longEntry: {
        combine: "AND",
        rules: [{ left: { kind: "indicator", indicator: "SMA", length: 20 }, op: "gt", right: { kind: "const", value: 0 } }],
      },
    });
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
      longEntry: {
        combine: "AND",
        rules: [{ left: { kind: "indicator", indicator: "EMA", length: 21 }, op: "gt", right: { kind: "const", value: 0 } }],
      },
    });

  it("minimal: the longest indicator length", () => {
    expect(requiredWarmupBars(config("minimal"))).toBe(21);
  });

  it("bars: the user-typed history bar count", () => {
    expect(requiredWarmupBars(config("bars", 300))).toBe(300);
  });

  it("full: the longest indicator length is still the floor (can't ask for less than that)", () => {
    expect(requiredWarmupBars(config("full"))).toBe(21);
  });

  it("scales an operand's warm-up by its timeframe when baseSeconds is given", () => {
    // EMA(10) on a 5-minute timeframe over a 1-minute base needs 10 × 5 = 50
    // base bars of warm-up, not 10.
    const c = cfg({
      range: { mode: "bars", bars: 500, history: "minimal" },
      longEntry: {
        combine: "AND",
        rules: [{ left: { kind: "indicator", indicator: "EMA", length: 10, timeframe: "MINUTE_5" }, op: "gt", right: { kind: "const", value: 0 } }],
      },
    });
    expect(requiredWarmupBars(c, 60)).toBe(50); // 1-minute base
    expect(requiredWarmupBars(c)).toBe(10); // no baseSeconds ⇒ unscaled
  });

  it("adds the slope lookback in the operand's OWN timeframe, then scales", () => {
    // EMA(10)@5m sloped over 3 bars needs (10+3) 5-minute bars warm = 13 × 5 = 65
    // base bars, not (10×5)+3.
    const c = cfg({
      range: { mode: "bars", bars: 500, history: "minimal" },
      longEntry: {
        combine: "AND",
        rules: [
          { left: { kind: "indicator", indicator: "EMA", length: 10, timeframe: "MINUTE_5", slope: { len: 3 } }, op: "gt", right: { kind: "const", value: 0 } },
        ],
      },
    });
    expect(requiredWarmupBars(c, 60)).toBe(65);
  });

  it("bars depth: a higher-timeframe operand can raise the requirement above the asked N", () => {
    // Asking 30 base bars, but EMA(20)@5m needs 20 × 5 = 100 base bars warm.
    const c = cfg({
      range: { mode: "bars", bars: 500, history: "bars", historyBars: 30 },
      longEntry: {
        combine: "AND",
        rules: [{ left: { kind: "indicator", indicator: "EMA", length: 20, timeframe: "MINUTE_5" }, op: "gt", right: { kind: "const", value: 0 } }],
      },
    });
    expect(requiredWarmupBars(c, 60)).toBe(100);
    expect(requiredWarmupBars(c)).toBe(30); // unscaled falls back to the asked N
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

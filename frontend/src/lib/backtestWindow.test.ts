import { describe, it, expect } from "vitest";
import {
  resolveWindow,
  resolveHistoryStart,
  minimalHistoryStart,
  requiredWarmupBars,
  warmupBarCount,
  longestWarmupBars,
  widenedHistoryStart,
  widenUntilWarm,
  warmupWalkFloor,
  MAX_WARMUP_PASSES,
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

describe("widenedHistoryStart — reaching warm-up across a session gap", () => {
  // The US100 case this was written for: 5m bars, window opens Mon 2026-08-03
  // 00:00Z, EMA(50) wants 50 warm-up bars. The padded ask (50*300s*1.5 = 6h15m)
  // starts 2026-08-02 17:45Z — inside the weekend — and the weekly open at
  // 22:00Z leaves only 24 real bars in that span.
  const RES = 300;
  const windowFromMs = Date.UTC(2026, 7, 3, 0, 0);
  const weeklyOpenMs = Date.UTC(2026, 7, 2, 22, 0);
  const fridayCloseMs = Date.UTC(2026, 6, 31, 20, 55);

  it("doubles the span so each pass reaches strictly further back", () => {
    const first = windowFromMs - 6.25 * 3_600_000;
    const second = widenedHistoryStart(first, windowFromMs, RES);
    const third = widenedHistoryStart(second, windowFromMs, RES);
    expect(second).toBe(windowFromMs - 12.5 * 3_600_000);
    expect(third).toBe(windowFromMs - 25 * 3_600_000);
  });

  it("clears the weekend gap within MAX_WARMUP_PASSES", () => {
    // Bars only exist [.., fridayClose] and [weeklyOpen, ..]. A start still
    // inside the gap yields the 24 bars from the weekly open; only a start at or
    // before Friday's close can supply the remaining 26.
    let start = windowFromMs - 6.25 * 3_600_000;
    // The ask this replaces reaches back past the weekly open but nowhere near
    // Friday's session, so it can only ever collect the 24 post-open bars.
    expect(start).toBeLessThan(weeklyOpenMs);
    expect(start).toBeGreaterThan(fridayCloseMs);
    let passes = 0;
    while (start > fridayCloseMs && passes < MAX_WARMUP_PASSES) {
      start = widenedHistoryStart(start, windowFromMs, RES);
      passes++;
    }
    expect(start).toBeLessThanOrEqual(fridayCloseMs);
    expect(passes).toBeLessThan(MAX_WARMUP_PASSES);
  });

  it("never returns a start at or after the one it was given", () => {
    // The run loop breaks on non-progress, so a degenerate input must not stall
    // it: a zero-width or inverted lookback still steps back by a whole bar.
    expect(widenedHistoryStart(windowFromMs, windowFromMs, RES)).toBeLessThan(windowFromMs);
    expect(widenedHistoryStart(windowFromMs + 5_000, windowFromMs, RES)).toBeLessThan(windowFromMs);
  });
});

describe("widenUntilWarm — the walk", () => {
  const RES = 300;
  const RES_MS = RES * 1000;
  const windowFromMs = Date.UTC(2026, 7, 3, 0, 0);
  const weeklyOpenMs = Date.UTC(2026, 7, 2, 22, 0);
  const fridayCloseMs = Date.UTC(2026, 6, 31, 20, 55);
  const floorMs = warmupWalkFloor(cfg(atrRisk(50)), windowFromMs, RES);

  // Bars exist in two sessions with the weekend between them. A fetch returns
  // every bar at/after `fromMs` — so an ask landing in the gap yields only the
  // 24 post-weekly-open bars, no matter how much deeper into the gap it reaches.
  const session = (startMs: number, endMs: number) => {
    const out: Array<{ timestamp: number }> = [];
    for (let t = startMs; t <= endMs; t += RES_MS) out.push({ timestamp: t });
    return out;
  };
  const ALL = [
    ...session(fridayCloseMs - 500 * RES_MS, fridayCloseMs),
    ...session(weeklyOpenMs, windowFromMs + 100 * RES_MS),
  ];
  const gapFetch = (calls: number[]) => async (fromMs: number) => {
    calls.push(fromMs);
    return ALL.filter((b) => b.timestamp >= fromMs);
  };

  it("keeps walking past passes that add nothing, and clears the gap", () => {
    // The regression this exists for: an early version bailed on the first
    // no-progress pass, which is every ask still inside the weekend — it left
    // the run on 24 bars and silently changed nothing.
    const calls: number[] = [];
    const start = windowFromMs - 6.25 * 3_600_000;
    const initial = ALL.filter((b) => b.timestamp >= start);
    expect(warmupBarCount(initial, windowFromMs)).toBe(24); // the short ask
    return widenUntilWarm(
      initial,
      start,
      { windowFromMs, resSeconds: RES, required: 50, floorMs },
      gapFetch(calls),
    ).then((bars) => {
      expect(warmupBarCount(bars, windowFromMs)).toBeGreaterThanOrEqual(50);
      expect(calls.length).toBeGreaterThan(1); // more than one pass was needed
    });
  });

  it("stops as soon as the requirement is met", async () => {
    const calls: number[] = [];
    const start = windowFromMs - 6.25 * 3_600_000;
    const initial = ALL.filter((b) => b.timestamp >= start);
    await widenUntilWarm(
      initial,
      start,
      { windowFromMs, resSeconds: RES, required: 10, floorMs },
      gapFetch(calls),
    );
    expect(calls).toEqual([]); // already had 24 >= 10, never fetched
  });

  it("stops early on a completely empty fetch (broker refused the ask)", async () => {
    const calls: number[] = [];
    const bars = await widenUntilWarm(
      [{ timestamp: weeklyOpenMs }],
      windowFromMs - 6.25 * 3_600_000,
      { windowFromMs, resSeconds: RES, required: 50, floorMs },
      async (fromMs) => {
        calls.push(fromMs);
        return [];
      },
    );
    expect(calls).toHaveLength(1);
    expect(bars).toHaveLength(1); // kept the original, didn't adopt the empty
  });

  it("declines to walk when the config already reaches deeper than the floor", async () => {
    // "full" depth starts 5 years back. Doubling that would ask for centuries;
    // a shortfall there isn't a session gap, so the walk must not run.
    const calls: number[] = [];
    const fullStart = windowFromMs - 5 * 365 * DAY_MS;
    await widenUntilWarm(
      [],
      fullStart,
      { windowFromMs, resSeconds: RES, required: 50, floorMs },
      gapFetch(calls),
    );
    expect(fullStart).toBeLessThan(floorMs);
    expect(calls).toEqual([]);
  });

  it("never asks deeper than the floor", async () => {
    const calls: number[] = [];
    await widenUntilWarm(
      [],
      windowFromMs - RES_MS,
      { windowFromMs, resSeconds: RES, required: 100_000, floorMs },
      gapFetch(calls),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toBeGreaterThanOrEqual(floorMs);
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

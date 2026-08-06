import { describe, it, expect } from "vitest";
import {
  cloneRule,
  longestIndicatorLength,
  defaultBacktestConfig,
  normalizeBacktestConfig,
  riskAtrLengths,
  scalingAtrLengths,
  activeGroup,
  type BacktestConfig,
  type Rule,
} from "./backtestConfig";

describe("cloneRule", () => {
  it("preserves the expression, enabled flag, and count modifier as an independent copy", () => {
    const rule: Rule = { expr: "EMA(9) > EMA(21)", enabled: false, count: 3 };
    const copy = cloneRule(rule);
    expect(copy).toEqual(rule);
    expect(copy).not.toBe(rule); // a fresh object, not the same ref
  });
});

describe("activeGroup", () => {
  const rule = (count?: number, enabled?: boolean): Rule => ({
    expr: "candle.close > 0",
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

describe("defaultBacktestConfig", () => {
  it("seeds four expression groups: long entry/exit + short entry/exit (mirror)", () => {
    const cfg = defaultBacktestConfig();
    expect(cfg.range).toEqual({ mode: "bars", bars: 500, history: "minimal" });
    expect(cfg.longEntry.rules[0].expr).toBe("EMA(9) x> EMA(21)");
    expect(cfg.longExit.rules[0].expr).toBe("EMA(9) x< EMA(21)");
    expect(cfg.shortEntry.rules[0].expr).toBe("EMA(9) x< EMA(21)"); // mirror of long entry
    expect(cfg.shortExit.rules[0].expr).toBe("EMA(9) x> EMA(21)");
    expect(cfg.longEntry.rules[0].enabled).toBe(true);
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

  it("longestIndicatorLength counts a risk ATR length", () => {
    const cfg = {
      ...defaultBacktestConfig(),
      longRisk: { stop: { kind: "atr" as const, mult: 2, length: 50 }, target: { kind: "none" as const } },
    };
    expect(longestIndicatorLength(cfg)).toBe(50);
  });

  it("is 1 when no ATR risk/scaling is configured", () => {
    expect(longestIndicatorLength(defaultBacktestConfig())).toBe(1);
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

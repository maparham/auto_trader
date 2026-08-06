import { describe, it, expect } from "vitest";
import {
  cloneRule,
  longestIndicatorLength,
  defaultBacktestConfig,
  normalizeBacktestConfig,
  riskAtrLengths,
  scalingAtrLengths,
  activeGroup,
  backtestConfigEquals,
  type BacktestConfig,
  type RangeConfig,
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

describe("backtestConfigEquals", () => {
  it("ignores key order", () => {
    const a = defaultBacktestConfig();
    // Rebuild the top level with the keys reversed — same data, different order.
    const b = Object.fromEntries(Object.entries(a).reverse()) as BacktestConfig;
    expect(backtestConfigEquals(a, b)).toBe(true);
  });

  it("ignores key order at depth, not just the top level", () => {
    // The case above reverses only the top level, and Object.fromEntries copies
    // the nested objects BY REFERENCE — so `range`/`costs` are literally the
    // same objects on both sides and it never exercises the recursion. Reverse
    // a nested object's own keys so only a canonical() that recurses (rather
    // than JSON.stringify-ing sub-objects wholesale) reports these equal.
    const a = defaultBacktestConfig();
    const b = { ...a, range: Object.fromEntries(Object.entries(a.range).reverse()) as RangeConfig };
    expect(backtestConfigEquals(a, b)).toBe(true);
  });

  it("treats an absent optional field as its default", () => {
    const a = defaultBacktestConfig();
    // The per-side switches (longEnabled/…) would read better here, but
    // normalizeBacktestConfig doesn't fill them — the only fields it defaults
    // are the cost fields, so `costs.spread` is the one this can be shown with.
    const b = { ...a, costs: { ...a.costs, spread: undefined } } as unknown as BacktestConfig;
    expect(backtestConfigEquals(a, b)).toBe(true);
  });

  it("treats an absent riskSynced as ON, so a no-op sync toggle is not dirty", () => {
    // defaultBacktestConfig() omits riskSynced (absent means ON), and the
    // toggle writes the explicit `true`. Behaviourally identical, so the dirty
    // dot must not light — it gates run capture.
    const a = defaultBacktestConfig();
    expect(a.riskSynced).toBeUndefined();
    expect(backtestConfigEquals(a, { ...a, riskSynced: true })).toBe(true);
    expect(backtestConfigEquals(a, { ...a, riskSynced: false })).toBe(false);
  });

  it("sees a genuine difference in the range", () => {
    const a = defaultBacktestConfig();
    const b = { ...defaultBacktestConfig(), range: { ...a.range, bars: 999 } };
    expect(backtestConfigEquals(a, b)).toBe(false);
  });

  it("sees a genuine difference in costs", () => {
    const a = defaultBacktestConfig();
    const b = { ...defaultBacktestConfig(), costs: { ...a.costs, spread: 12.5 } };
    expect(backtestConfigEquals(a, b)).toBe(false);
  });

  it("sees a parked side (longEnabled flipped off) as different", () => {
    const a = defaultBacktestConfig();
    const b = { ...defaultBacktestConfig(), longEnabled: false };
    expect(backtestConfigEquals(a, b)).toBe(false);
  });

  it("treats a key held as undefined the same as an omitted key", () => {
    // A stored preset round-trips through JSON.stringify, which drops
    // undefined-valued keys; the live panel can still hold the key with an
    // undefined value. `canonical` filters undefined members so those two
    // shapes — same strategy, different shape — compare equal. normalize can't
    // rescue this one: it doesn't fill the per-side switches.
    const withoutKey = defaultBacktestConfig();
    delete withoutKey.longEnabled; // the shape JSON.stringify would have produced
    const withUndefined = { ...withoutKey, longEnabled: undefined };
    expect(
      backtestConfigEquals(withUndefined as BacktestConfig, withoutKey as BacktestConfig),
    ).toBe(true);
  });

  it("sees reordered rules within a group as different", () => {
    // Rule order within a group is meaningful, so `canonical` deliberately does
    // not sort arrays — a swap must read as an edit.
    const a = defaultBacktestConfig();
    const rules = [{ expr: "A", enabled: true }, { expr: "B", enabled: true }];
    const b = { ...a, longEntry: { combine: "AND" as const, rules: [...rules].reverse() } };
    expect(backtestConfigEquals({ ...a, longEntry: { combine: "AND", rules } }, b)).toBe(false);
  });
});

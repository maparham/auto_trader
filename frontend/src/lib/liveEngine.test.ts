import { describe, it, expect, vi } from "vitest";
import { initialLiveState, armSnapshot, setPositionVintage } from "./liveState";
import { defaultBacktestConfig, type Rule } from "./backtestConfig";
import type { CodedStrategyConfig } from "./codedConfig";

// liveEngine → backtestSeries → customIndicators reads LineType at module load;
// stub klinecharts' runtime surface (same as backtestSeries.test.ts).
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { runOneCycle } = await import("./liveEngine");

describe("runOneCycle", () => {
  it("reconciles, evaluates, and places the returned actions once", async () => {
    const s = armSnapshot(initialLiveState(defaultBacktestConfig(), "capital:demo", 1), "s1", 1700);
    const deps = {
      buildSeries: vi.fn().mockResolvedValue({}),
      fetchOpenPositions: vi.fn().mockResolvedValue([]), // flat
      evaluateStrategy: vi.fn().mockResolvedValue({
        actions: [{ kind: "open", leg: "long", side: "buy", reason: "x", stop_level: 9, take_profit_level: 12 }],
      }),
      placeActions: vi.fn((actions: unknown[]) =>
        Promise.resolve(actions.map((action) => ({ ok: true, detail: "filled", dealId: "d1", action }))),
      ),
    };
    const bars = [
      { timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 1_700_000_060_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    ];
    const result = await runOneCycle(s, bars, 1_700_000_060, "MINUTE", "EURUSD", deps as never);
    expect(deps.fetchOpenPositions).toHaveBeenCalledWith("capital:demo", "EURUSD");
    expect(deps.evaluateStrategy).toHaveBeenCalledTimes(1);
    expect(deps.placeActions).toHaveBeenCalledTimes(1);
    // opening a position records its vintage (the current snapshot)
    expect(result.state.positionVintage?.armedAtSec).toBe(1700);
  });

  it("clears a stale vintage when the broker shows flat (bracket closed the position)", async () => {
    // Armed on v2, but still carrying v1's vintage from an open position.
    const v1 = armSnapshot(initialLiveState(defaultBacktestConfig(), "capital:demo", 1), "s1", 1000);
    const v2 = armSnapshot(v1, "s1", 2000); // re-armed → snapshot is v2's
    const withVintage = setPositionVintage(v2, v1.snapshot); // position opened under v1
    const deps = {
      buildSeries: vi.fn().mockResolvedValue({}),
      fetchOpenPositions: vi.fn().mockResolvedValue([]), // broker flat: bracket closed it
      evaluateStrategy: vi.fn().mockResolvedValue({ actions: [] }),
      placeActions: vi.fn(),
    };
    const bars = [
      { timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 1_700_000_060_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    ];
    const result = await runOneCycle(withVintage, bars, 1_700_000_060, "MINUTE", "EURUSD", deps as never);
    // vintage cleared → next entry evaluates under the current (v2) snapshot
    expect(result.state.positionVintage).toBeNull();
    // and evaluate saw a flat (null) position, using v2's config
    expect(deps.evaluateStrategy).toHaveBeenCalledTimes(1);
    const req = deps.evaluateStrategy.mock.calls[0][0];
    expect(req.position).toBeNull();
  });

  it("non-coded (expression) mode sends exprMode + expr rows, no structured groups and no series", async () => {
    const cfg = {
      ...defaultBacktestConfig(), mode: "rules" as const,
      longEntry: { combine: "AND" as const, rules: [{ expr: "candle.close > candle.open", enabled: true } as unknown as Rule] },
      longExit: { combine: "AND" as const, rules: [] },
      shortEntry: { combine: "AND" as const, rules: [] },
      shortExit: { combine: "AND" as const, rules: [] },
    };
    const s = armSnapshot(initialLiveState(cfg, "capital:demo", 1), "s1", 1700);
    const deps = {
      buildSeries: vi.fn().mockResolvedValue({ SHOULD_NOT: [1] }),
      fetchOpenPositions: vi.fn().mockResolvedValue([]), // flat
      evaluateStrategy: vi.fn().mockResolvedValue({
        actions: [{ kind: "open", leg: "long", side: "buy", reason: "expr", stop_level: 9, take_profit_level: 12 }],
      }),
      placeActions: vi.fn((actions: unknown[]) =>
        Promise.resolve(actions.map((action) => ({ ok: true, detail: "filled", dealId: "d1", action }))),
      ),
    };
    const bars = [
      { timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 1_700_000_060_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    ];
    const result = await runOneCycle(s, bars, 1_700_000_060, "MINUTE", "EURUSD", deps as never);
    // expr path never calls buildSeries and sends an empty series object
    expect(deps.buildSeries).not.toHaveBeenCalled();
    const req = deps.evaluateStrategy.mock.calls[0][0];
    expect(req.exprMode).toBe(true);
    expect(req.exprLongEntry).toEqual([{ expr: "candle.close > candle.open", enabled: true }]);
    expect(req.codedStrategy).toBeUndefined();
    expect(req.series).toEqual({});
    // The structured rule-group fields were removed from the evaluate request.
    expect(req.longEntry).toBeUndefined();
    // the returned open action is placed and its vintage recorded
    expect(deps.placeActions).toHaveBeenCalledTimes(1);
    expect(result.state.positionVintage?.armedAtSec).toBe(1700);
  });

  it("coded mode without a coded snapshot sends no structured groups, no risk, and calls buildSeries", async () => {
    const cfg = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    const s = armSnapshot(initialLiveState(cfg, "capital:demo", 1), "s1", 1700);
    const deps = {
      buildSeries: vi.fn().mockResolvedValue({}),
      fetchOpenPositions: vi.fn().mockResolvedValue([]), // flat
      evaluateStrategy: vi.fn().mockResolvedValue({ actions: [] }),
      placeActions: vi.fn(),
    };
    const bars = [
      { timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 1_700_000_060_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    ];
    await runOneCycle(s, bars, 1_700_000_060, "MINUTE", "EURUSD", deps as never, "capital");
    // Regression guard: no coded snapshot ⇒ request shape matches today's (no
    // structured groups, no risk) even though buildSeries is now always invoked.
    expect(deps.buildSeries).toHaveBeenCalled();
    expect(deps.evaluateStrategy).toHaveBeenCalledTimes(1);
    const req = deps.evaluateStrategy.mock.calls[0][0];
    expect(req.codedStrategy).toBe("ema_cross.py");
    expect(req.series).toEqual({});
    // The structured rule-group fields were removed from the evaluate request.
    expect(req.longEntry).toBeUndefined();
    expect(req.longExit).toBeUndefined();
    expect(req.shortEntry).toBeUndefined();
    expect(req.shortExit).toBeUndefined();
    expect(req.longRisk).toBeUndefined();
    expect(req.shortRisk).toBeUndefined();
    expect(req.codedParams).toBeUndefined();
    // Coded mode needs the backend to fetch ad-hoc HTF timeframes itself.
    expect(req.broker).toBe("capital");
    expect(req.priceSide).toBe("mid");
  });

  it("coded cycle carries an expr exit row on exprLongExit and sends no structured longExit (422 guard)", async () => {
    // Coded exits are now authored in the EXPRESSION editor, so an exit row is
    // shaped { expr, enabled } with NO left/op/right. Sending that row through the
    // STRUCTURED longExit field would fail the backend's RuleDTO (requires
    // left/op/right) → HTTP 422. The structured longExit/shortExit fields were
    // removed from the request entirely, so the real row travels on exprLongExit.
    const EXPR_EXIT_ROW = { expr: "candle.close < EMA(20)", enabled: true } as unknown as Rule;
    const coded: CodedStrategyConfig = {
      params: { ema_fast: 12 },
      longRisk: { stop: { kind: "pct", value: 2 }, target: { kind: "none" } },
      longExit: { combine: "AND", rules: [EXPR_EXIT_ROW] },
      shortExit: { combine: "AND", rules: [] },
    };
    const cfg = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    let s = armSnapshot(initialLiveState(cfg, "capital:demo", 1), "s1", 1700);
    s = { ...s, snapshot: { ...s.snapshot!, coded } };
    const deps = {
      buildSeries: vi.fn().mockResolvedValue({ RSI_14: [70] }),
      fetchOpenPositions: vi.fn().mockResolvedValue([]), // flat
      evaluateStrategy: vi.fn().mockResolvedValue({ actions: [] }),
      placeActions: vi.fn(),
    };
    const bars = [
      { timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 1_700_000_060_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    ];
    await runOneCycle(s, bars, 1_700_000_060, "MINUTE", "EURUSD", deps as never, "capital");
    expect(deps.buildSeries).toHaveBeenCalled();
    const req = deps.evaluateStrategy.mock.calls[0][0];
    expect(req.codedParams).toEqual({ ema_fast: 12 });
    expect(req.longRisk).toEqual(coded.longRisk);
    expect(req.shortRisk).toBeUndefined();
    // 422 guard: the structured group fields were removed — the expr-only exit
    // row would fail RuleDTO if sent through longExit/shortExit.
    expect(req.longExit).toBeUndefined();
    expect(req.shortExit).toBeUndefined();
    // The real exit row travels on exprLongExit so the backend expr route decides exits.
    expect(req.exprLongExit).toEqual([{ expr: "candle.close < EMA(20)", enabled: true }]);
    expect(req.exprShortExit).toEqual([]);
    expect(req.series).toEqual({ RSI_14: [70] });
  });

  it("coded mode always sends longEnabled/shortEnabled true, ignoring rules-mode toggles (I1)", async () => {
    // longEnabled/shortEnabled are rules-mode UI; RuleStrategy gates EXITS on
    // them. A disabled side from rules mode must not silently disable that
    // side's panel exit rules on a coded run while the .py still opens
    // positions on that side.
    const cfg = {
      ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py",
      longEnabled: true, shortEnabled: false,
    };
    const s = armSnapshot(initialLiveState(cfg, "capital:demo", 1), "s1", 1700);
    const deps = {
      buildSeries: vi.fn().mockResolvedValue({}),
      fetchOpenPositions: vi.fn().mockResolvedValue([]),
      evaluateStrategy: vi.fn().mockResolvedValue({ actions: [] }),
      placeActions: vi.fn(),
    };
    const bars = [
      { timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 1_700_000_060_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    ];
    await runOneCycle(s, bars, 1_700_000_060, "MINUTE", "EURUSD", deps as never);
    const req = deps.evaluateStrategy.mock.calls[0][0];
    expect(req.longEnabled).toBe(true);
    expect(req.shortEnabled).toBe(true);
  });

  it("coded mode normalizes a none/none snapshot risk to undefined before sending (C1)", async () => {
    const coded: CodedStrategyConfig = {
      params: {},
      longRisk: { stop: { kind: "none" }, target: { kind: "none" } },
      longExit: { combine: "AND", rules: [] },
      shortExit: { combine: "AND", rules: [] },
    };
    const cfg = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    let s = armSnapshot(initialLiveState(cfg, "capital:demo", 1), "s1", 1700);
    s = { ...s, snapshot: { ...s.snapshot!, coded } };
    const deps = {
      buildSeries: vi.fn().mockResolvedValue({}),
      fetchOpenPositions: vi.fn().mockResolvedValue([]),
      evaluateStrategy: vi.fn().mockResolvedValue({ actions: [] }),
      placeActions: vi.fn(),
    };
    const bars = [
      { timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 1_700_000_060_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    ];
    await runOneCycle(s, bars, 1_700_000_060, "MINUTE", "EURUSD", deps as never);
    const req = deps.evaluateStrategy.mock.calls[0][0];
    expect(req.longRisk).toBeUndefined();
  });

  it("refuses to trade when coded mode has no strategy selected (never falls back to rules)", async () => {
    const cfg = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: undefined };
    const s = armSnapshot(initialLiveState(cfg, "capital:demo", 1), "s1", 1700);
    const deps = {
      buildSeries: vi.fn().mockResolvedValue({}),
      fetchOpenPositions: vi.fn().mockResolvedValue([]), // flat
      evaluateStrategy: vi.fn().mockResolvedValue({ actions: [] }),
      placeActions: vi.fn(),
    };
    const bars = [
      { timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 1_700_000_060_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    ];
    const result = await runOneCycle(s, bars, 1_700_000_060, "MINUTE", "EURUSD", deps as never);
    expect(deps.buildSeries).not.toHaveBeenCalled();
    expect(deps.evaluateStrategy).not.toHaveBeenCalled();
    expect(deps.placeActions).not.toHaveBeenCalled();
    expect(result.state.log.some((l) => l.text.includes("coded mode but no strategy selected"))).toBe(true);
  });

  it("logs and does not place when evaluateStrategy rejects (no unhandled rejection)", async () => {
    const s = armSnapshot(initialLiveState(defaultBacktestConfig(), "capital:demo", 1), "s1", 1700);
    const deps = {
      buildSeries: vi.fn().mockResolvedValue({}),
      fetchOpenPositions: vi.fn().mockResolvedValue([]), // flat
      evaluateStrategy: vi.fn().mockRejectedValue(new Error("422: bad strategy")),
      placeActions: vi.fn(),
    };
    const bars = [
      { timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 1_700_000_060_000, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    ];
    const result = await runOneCycle(s, bars, 1_700_000_060, "MINUTE", "EURUSD", deps as never);
    expect(deps.placeActions).not.toHaveBeenCalled();
    expect(result.state.log.some((l) => l.text.includes("evaluate failed") && l.text.includes("422: bad strategy"))).toBe(true);
  });

  it("no-op when disarmed", async () => {
    const s = initialLiveState(defaultBacktestConfig(), "capital:demo", 1);
    const deps = {
      buildSeries: vi.fn(), fetchOpenPositions: vi.fn(),
      evaluateStrategy: vi.fn(), placeActions: vi.fn(),
    };
    const bars = [{ timestamp: 1_700_000_000_000, open: 10, high: 10, low: 10, close: 10, volume: 0 }];
    await runOneCycle(s, bars, 1_700_000_060, "MINUTE", "EURUSD", deps as never);
    expect(deps.evaluateStrategy).not.toHaveBeenCalled();
  });
});

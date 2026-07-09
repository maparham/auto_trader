import { describe, it, expect, vi } from "vitest";
import { initialLiveState, armSnapshot, setPositionVintage } from "./liveState";
import { defaultBacktestConfig } from "./backtestConfig";

// liveEngine → backtestSeries → customIndicators reads LineType at module load;
// stub klinecharts' runtime surface (same as backtestSeries.test.ts).
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  registerIndicator: () => {},
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

  it("coded mode skips buildSeries and posts codedStrategy", async () => {
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
    expect(deps.buildSeries).not.toHaveBeenCalled();
    expect(deps.evaluateStrategy).toHaveBeenCalledTimes(1);
    const req = deps.evaluateStrategy.mock.calls[0][0];
    expect(req.codedStrategy).toBe("ema_cross.py");
    expect(req.series).toEqual({});
    expect(req.longEntry).toEqual({ combine: "AND", rules: [] });
    expect(req.longExit).toEqual({ combine: "AND", rules: [] });
    expect(req.shortEntry).toEqual({ combine: "AND", rules: [] });
    expect(req.shortExit).toEqual({ combine: "AND", rules: [] });
    expect(req.longRisk).toBeUndefined();
    expect(req.shortRisk).toBeUndefined();
    // Coded mode needs the backend to fetch ad-hoc HTF timeframes itself.
    expect(req.broker).toBe("capital");
    expect(req.priceSide).toBe("mid");
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

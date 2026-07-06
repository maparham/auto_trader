import { describe, it, expect, vi } from "vitest";
import { initialLiveState, armSnapshot } from "./liveState";
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

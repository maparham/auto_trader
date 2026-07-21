import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";
import type { BacktestConfig } from "./backtestConfig";

// customIndicators.ts reads LineType at module load (AVWAP line style table);
// stub klinecharts' runtime surface like overlays.test.ts does.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { buildSeries } = await import("./backtestSeries");

// The base run is on 1-minute bars; the ATR-only builder computes on the base
// candles, so fetchTimeframe is never called.
const BASE = "MINUTE";
const noFetch = async (): Promise<KLineData[]> => [];

function candles(closes: number[], volumes?: number[]): KLineData[] {
  return closes.map((c, i) => ({
    timestamp: i * 60_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: volumes?.[i] ?? 0,
  }));
}

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

describe("buildSeries — ATR risk/scaling series", () => {
  it("emits an ATR_{n} series when a risk config references ATR", async () => {
    const data = candles([10, 11, 12, 13, 14, 15]);
    const out = await buildSeries(data, cfg({
      longRisk: { stop: { kind: "trailAtr", mult: 2, length: 3 }, target: { kind: "none" } },
    }), BASE, noFetch);
    expect(out["ATR_3"]).toBeDefined();
    expect(out["ATR_3"].length).toBe(data.length);
    expect(out["ATR_3"][0]).toBeNull(); // cold until 3 TRs exist
    expect(out["ATR_3"][2]).not.toBeNull();
  });

  it("emits no ATR series when no risk config references ATR", async () => {
    const data = candles([10, 11, 12]);
    const out = await buildSeries(data, cfg({
      longRisk: { stop: { kind: "pct", value: 2 }, target: { kind: "none" } },
    }), BASE, noFetch);
    expect(Object.keys(out).some((k) => k.startsWith("ATR_"))).toBe(false);
  });

  it("emits ATR_{n} for scaling spacing", async () => {
    const data = candles([10, 11, 12, 13]);
    const out = await buildSeries(data, cfg({
      longScaling: { maxConcurrent: 3, spacing: { kind: "atr", mult: 2, length: 3 } },
    }), BASE, noFetch);
    expect(out["ATR_3"]).toBeDefined();
  });
});

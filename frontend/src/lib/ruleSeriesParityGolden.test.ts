// Emits backend/tests/fixtures/rule_series_golden.json — a representative rule
// config (base EMA, an HTF EMA, a sloped price, an ATR risk) run through
// buildSeries. The backend's test_rule_series_parity.py asserts its assembler
// reproduces `series` key-for-key. Regenerate with:
//   npx vitest run src/lib/ruleSeriesParityGolden.test.ts
/// <reference types="node" />
import { writeFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";
import type { FetchTimeframe } from "./backtestSeries";
import type { BacktestConfig } from "./backtestConfig";

// customIndicators.ts reads LineType at module load (AVWAP line style table);
// stub klinecharts' runtime surface like backtestSeries.test.ts does.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { buildSeries } = await import("./backtestSeries");

function bars(closes: number[], stepMs: number, t0 = 0): KLineData[] {
  return closes.map((c, i) => ({
    timestamp: t0 + i * stepMs, open: c, high: c + 1, low: c - 1, close: c, volume: i + 1,
  }));
}

describe("rule series parity golden", () => {
  it("writes the golden fixture", async () => {
    const HOUR = 3600_000;
    const candles = bars(
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 15, 16, 17, 18, 19],
      HOUR,
    );
    const htf4 = bars([10, 14, 18, 15, 19], 4 * HOUR);

    const config: BacktestConfig = {
      range: { mode: "bars", bars: candles.length, history: "full" },
      longEntry: {
        combine: "AND",
        rules: [
          {
            left: { kind: "indicator", indicator: "EMA", length: 3 },
            op: "gt",
            right: { kind: "indicator", indicator: "EMA", length: 2, timeframe: "HOUR_4" },
          },
          {
            left: { kind: "price", field: "close", slope: { len: 2 } },
            op: "gt",
            right: { kind: "const", value: 0 },
          },
        ],
      },
      longExit: { combine: "AND", rules: [] },
      shortEntry: { combine: "AND", rules: [] },
      shortExit: { combine: "AND", rules: [] },
      longEnabled: true,
      shortEnabled: true,
      longRisk: { stop: { kind: "atr", mult: 2, length: 3 }, target: { kind: "none" } },
      costs: { quantity: 1, commissionPerSide: 0, slippage: 0, startingCash: 10_000 },
    };

    const fetchTimeframe: FetchTimeframe = async (tf) =>
      tf === "HOUR_4" ? htf4 : [];
    const series = await buildSeries(candles, config, "HOUR", fetchTimeframe);

    // Sanity: the representative config exercises base EMA, HTF EMA, sloped
    // price, and ATR risk coverage before we snapshot it as the golden.
    expect(Object.keys(series).sort()).toEqual(
      ["ATR_3", "EMA_2@HOUR_4", "EMA_3", "close~2"].sort(),
    );

    writeFileSync(
      new URL("../../../backend/tests/fixtures/rule_series_golden.json", import.meta.url),
      JSON.stringify({ baseResolution: "HOUR", candles, htf: { HOUR_4: htf4 }, config, series }, null, 2),
    );
  });
});

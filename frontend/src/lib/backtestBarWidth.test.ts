// @vitest-environment jsdom
// fitBacktestTrades pads by the chart's DECLARED bar width, not the smallest
// timestamp gap: on a 1439m chart the smallest gap is the 1-minute short bar
// that ends each day, which would shrink the context pad to minutes.
import { describe, it, expect, vi } from "vitest";
import type { Chart, KLineData } from "klinecharts";

const applyVisibleRangeKeepStart = vi.fn();
vi.mock("./chartSync", () => ({
  applyVisibleRangeKeepStart: (...a: unknown[]) => applyVisibleRangeKeepStart(...a),
  scrollTsToCenter: () => {},
}));

const { fitBacktestTrades } = await import("./backtest");
const { setDeclaredBarMs } = await import("./barInterval");

const W = 1439 * 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const bars: KLineData[] = [];
for (let d = 0; d < 30; d++) {
  bars.push({ timestamp: T0 + d * DAY, open: 1, high: 1, low: 1, close: 1 });
  bars.push({ timestamp: T0 + d * DAY + W, open: 1, high: 1, low: 1, close: 1 });
}
const chart = { getDataList: () => bars } as unknown as Chart;

describe("fitBacktestTrades on a 1439m chart", () => {
  it("pads a same-bar trade by five declared bars", () => {
    setDeclaredBarMs(chart, W);
    const entry = (T0 + 15 * DAY) / 1000;
    fitBacktestTrades(chart, { trades: [{ entry_time: entry, exit_time: entry }] } as never);
    const [, from, to] = applyVisibleRangeKeepStart.mock.calls[0];
    expect(entry * 1000 - from).toBe(5 * W);
    expect(to - entry * 1000).toBe(5 * W);
  });
});

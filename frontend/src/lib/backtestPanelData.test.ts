import { describe, it, expect } from "vitest";
import { metricRows, tradeRows, sortTradeRows } from "./backtestPanelData";
import type { BacktestResult } from "../api";

function result(over: Partial<BacktestResult> = {}): BacktestResult {
  return {
    epic: "X", resolution: "MINUTE", candles: [], markers: [], equity: [],
    trades: [], summary: { net_pnl: 0, n_trades: 0, win_rate: 0, max_drawdown: 0 },
    metrics: { return_pct: 0, profit_factor: null, expectancy: 0, avg_win: 0, avg_loss: 0,
      avg_win_loss_ratio: null, largest_win: 0, largest_loss: 0, max_drawdown_pct: 0,
      avg_duration_bars: 0, max_consec_wins: 0, max_consec_losses: 0 },
    ...over,
  };
}

describe("metricRows", () => {
  it("labels and tones the summary + metrics; null profit factor shows as dash", () => {
    const rows = metricRows(result({
      summary: { net_pnl: 123.4, n_trades: 4, win_rate: 0.5, max_drawdown: 20 },
      metrics: { ...result().metrics, profit_factor: null, return_pct: 1.234 },
    }));
    const byLabel = Object.fromEntries(rows.map(r => [r.label, r]));
    expect(byLabel["Net P&L"].value).toBe("+123.40");
    expect(byLabel["Net P&L"].tone).toBe("pos");
    expect(byLabel["Win rate"].value).toBe("50%");
    expect(byLabel["Profit factor"].value).toBe("—"); // null -> dash
  });
});

describe("tradeRows + sort", () => {
  const res = result({
    resolution: "MINUTE",
    trades: [
      { side: "buy", quantity: 2, entry_time: 0, entry_price: 100, exit_time: 300, exit_price: 110, pnl: 20, leg: "long", reason: "target" },
      { side: "sell", quantity: 1, entry_time: 60, entry_price: 100, exit_time: 120, exit_price: 105, pnl: -5, leg: "short", reason: "stop" },
    ] as BacktestResult["trades"],
  });
  it("derives pnl%, duration bars, and keeps the original index", () => {
    const rows = tradeRows(res, 60);
    expect(rows[0].i).toBe(0);
    expect(rows[0].pnl).toBe(20);
    expect(rows[0].pnlPct).toBeCloseTo(20 / (100 * 2) * 100, 6); // 10%
    expect(rows[0].durationBars).toBe(5); // 300s / 60s
    expect(rows[0].reason).toBe("target");
  });
  it("sorts by pnl descending, stably", () => {
    const rows = sortTradeRows(tradeRows(res, 60), "pnl", "desc");
    expect(rows.map(r => r.pnl)).toEqual([20, -5]);
  });
});

import { describe, it, expect } from "vitest";
import { metricRows, tradeRows, sortTradeRows, legTable, type LegTable } from "./backtestPanelData";
import type { BacktestResult, LegMetrics } from "../api";

function cell(t: LegTable, rowLeg: string, colLabel: string) {
  const ci = t.columns.findIndex((c) => c.label === colLabel);
  const row = t.rows.find((r) => r.leg === rowLeg)!;
  return row.cells[ci];
}

function result(over: Partial<BacktestResult> = {}): BacktestResult {
  return {
    epic: "X", resolution: "MINUTE", candles: [], markers: [], equity: [],
    trades: [], summary: { net_pnl: 0, n_trades: 0, win_rate: 0, max_drawdown: 0 },
    metrics: { return_pct: 0, profit_factor: null, expectancy: 0, avg_win: 0, avg_loss: 0,
      avg_win_loss_ratio: null, largest_win: 0, largest_loss: 0, max_drawdown_pct: 0,
      avg_duration_bars: 0, max_consec_wins: 0, max_consec_losses: 0 },
    ...over,
  } as BacktestResult;
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

describe("legTable", () => {
  const longLeg: LegMetrics = {
    n_trades: 3, win_rate: 2 / 3, net_pnl: 80, expectancy: 2, profit_factor: 3,
    avg_win: 10, avg_loss: -4, avg_win_loss_ratio: 2.5,
    largest_win: 12, largest_loss: -4, max_consec_losses: 1, max_consec_wins: 2, avg_duration_bars: 3,
  };
  const shortLeg: LegMetrics = {
    n_trades: 1, win_rate: 0, net_pnl: 20, expectancy: 1, profit_factor: null,
    avg_win: 0, avg_loss: 0, avg_win_loss_ratio: null,
    largest_win: 0, largest_loss: 0, max_consec_losses: 0, max_consec_wins: 1, avg_duration_bars: 2,
  };
  const res = result({
    summary: { net_pnl: 100, n_trades: 4, win_rate: 0.5, max_drawdown: 0 },
    metrics: { ...result().metrics, profit_factor: 2, expectancy: 2, avg_win: 10, avg_loss: -5,
      avg_win_loss_ratio: 2, largest_win: 12, largest_loss: -6,
      max_consec_losses: 2, max_consec_wins: 2, avg_duration_bars: 3 },
    by_leg: { long: longLeg, short: shortLeg },
  });

  it("orders rows ALL, LONG, SHORT and leads with Trades", () => {
    const t = legTable(res);
    expect(t.rows.map((r) => r.leg)).toEqual(["ALL", "LONG", "SHORT"]);
    expect(t.columns[0].label).toBe("Trades");
    expect(t.columns.map((c) => c.label)).toContain("Avg duration");
  });

  it("builds the ALL row from summary + metrics", () => {
    const t = legTable(res);
    expect(cell(t, "ALL", "Trades").value).toBe("4");
    expect(cell(t, "ALL", "Win rate").value).toBe("50%");
    expect(cell(t, "ALL", "Net P&L").value).toBe("+100.00");
    expect(cell(t, "ALL", "Net P&L").tone).toBe("pos");
    expect(cell(t, "ALL", "Avg duration").value).toBe("3.0 bars");
  });

  it("builds LONG/SHORT rows from by_leg", () => {
    const t = legTable(res);
    expect(cell(t, "LONG", "Trades").value).toBe("3");
    expect(cell(t, "LONG", "Net P&L").value).toBe("+80.00");
    expect(cell(t, "LONG", "Avg win/loss").value).toBe("2.50");
    expect(cell(t, "SHORT", "Net P&L").value).toBe("+20.00");
  });

  it("shows a dash for one-sided null ratios", () => {
    const t = legTable(res);
    expect(cell(t, "SHORT", "Profit factor").value).toBe("—");
    expect(cell(t, "SHORT", "Avg win/loss").value).toBe("—");
  });

  it("zeroes LONG/SHORT when by_leg is absent", () => {
    const t = legTable(result({ summary: { net_pnl: 0, n_trades: 0, win_rate: 0, max_drawdown: 0 } }));
    expect(cell(t, "SHORT", "Trades").value).toBe("0");
    expect(cell(t, "LONG", "Net P&L").value).toBe("+0.00");
  });

  it("backfills zeros for a leg cached before a metric was added (partial by_leg)", () => {
    // A result persisted before expectancy/win-streak existed carries a leg
    // object without those keys. legTable must render them as zeros, not crash.
    const partialLong = {
      n_trades: 3, win_rate: 0.5, net_pnl: 30, profit_factor: 1,
      avg_win: 5, avg_loss: -2, avg_win_loss_ratio: 2.5,
      largest_win: 5, largest_loss: -2, max_consec_losses: 1, avg_duration_bars: 1,
      // expectancy and max_consec_wins intentionally absent
    } as unknown as LegMetrics;
    const stale = result({ by_leg: { long: partialLong, short: partialLong } });
    expect(() => legTable(stale)).not.toThrow();
    const t = legTable(stale);
    expect(cell(t, "LONG", "Expectancy").value).toBe("0.00");
    expect(cell(t, "LONG", "Win streak").value).toBe("0");
    // Present keys still render from the leg, not from ZERO_LEG.
    expect(cell(t, "LONG", "Net P&L").value).toBe("+30.00");
  });

  it("includes Expectancy and Max consec wins columns", () => {
    const fakeResult = result({
      summary: { net_pnl: 10, n_trades: 3, win_rate: 0.66, max_drawdown: 0 },
      metrics: {
        return_pct: 1, profit_factor: 2, expectancy: 3.33, avg_win: 6, avg_loss: -2,
        avg_win_loss_ratio: 3, largest_win: 7, largest_loss: -3, max_drawdown_pct: 0,
        avg_duration_bars: 1, max_consec_wins: 2, max_consec_losses: 1,
      },
      by_leg: {
        long: { n_trades: 2, win_rate: 0.5, net_pnl: 3, expectancy: 1.5, profit_factor: 1,
          avg_win: 5, avg_loss: -2, avg_win_loss_ratio: 2.5, largest_win: 5, largest_loss: -2,
          max_consec_losses: 1, max_consec_wins: 1, avg_duration_bars: 1 },
        short: { n_trades: 1, win_rate: 1, net_pnl: 7, expectancy: 7, profit_factor: null,
          avg_win: 7, avg_loss: 0, avg_win_loss_ratio: null, largest_win: 7, largest_loss: 0,
          max_consec_losses: 0, max_consec_wins: 1, avg_duration_bars: 1 },
      },
    });
    const t = legTable(fakeResult);
    const labels = t.columns.map((c) => c.label);
    expect(labels).toContain("Expectancy");
    expect(labels).toContain("Win streak");
    expect(t.rows.map((r) => r.leg)).toEqual(["ALL", "LONG", "SHORT"]);
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

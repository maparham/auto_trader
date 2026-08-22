import { describe, it, expect } from "vitest";
import { metricRows, tradeRows, sortTradeRows, legTable, rowWindow, type LegTable } from "./backtestPanelData";
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

  it("financing metric appears only when nonzero", () => {
    const off = metricRows(result({
      metrics: { ...result().metrics, financing_total: 0 },
    }));
    expect(off.some((r) => r.label === "Financing")).toBe(false);

    // Engine convention positive = paid; displayed as its P&L impact (negated),
    // so a 12.5 paid fee renders as a red "−12.50".
    const on = metricRows(result({
      metrics: { ...result().metrics, financing_total: 12.5 },
    }));
    const row = on.find((r) => r.label === "Financing");
    expect(row?.value).toBe("−12.50"); // U+2212 minus, formatSignedMoney
    expect(row?.tone).toBe("neg");
  });

  // Two trades that both hit the same fixed take-profit have near-zero P&L
  // deviation, which drives SQN (and friends) to absurd values; the band words
  // must not endorse that, so under 30 trades the verdict is "low sample".
  it("flags Sharpe/Sortino/SQN as low sample under 30 trades instead of banding", () => {
    const rows = metricRows(result({
      summary: { net_pnl: 590, n_trades: 2, win_rate: 1, max_drawdown: 0 },
      metrics: { ...result().metrics, sharpe: 2.77, sortino: 475.55, sqn: 133.68 },
    }));
    const byLabel = Object.fromEntries(rows.map(r => [r.label, r]));
    for (const label of ["Sharpe", "Sortino", "SQN"]) {
      expect(byLabel[label].verdict).toEqual({ label: "low sample", tone: "muted" });
    }
    // The value itself still shows; only the rating is withheld.
    expect(byLabel["SQN"].value).toBe("133.68");
  });

  it("bands the ratios normally at 30+ trades", () => {
    const rows = metricRows(result({
      summary: { net_pnl: 590, n_trades: 30, win_rate: 0.5, max_drawdown: 0 },
      metrics: { ...result().metrics, sharpe: 2.77, sortino: 2.5, sqn: 2.7 },
    }));
    const byLabel = Object.fromEntries(rows.map(r => [r.label, r]));
    expect(byLabel["Sharpe"].verdict).toEqual({ label: "very good", tone: "good" });
    expect(byLabel["Sortino"].verdict).toEqual({ label: "good", tone: "good" });
    expect(byLabel["SQN"].verdict).toEqual({ label: "good", tone: "good" });
  });

  it("still shows no verdict for null ratios regardless of trade count", () => {
    const rows = metricRows(result({
      summary: { net_pnl: 0, n_trades: 2, win_rate: 1, max_drawdown: 0 },
    }));
    const byLabel = Object.fromEntries(rows.map(r => [r.label, r]));
    expect(byLabel["SQN"].verdict).toBeUndefined();
    expect(byLabel["Sortino"].verdict).toBeUndefined();
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
  it("carries per-trade financing (0 when absent)", () => {
    const r = result({
      trades: [
        { side: "buy", quantity: 1, entry_time: 0, entry_price: 100, exit_time: 60, exit_price: 101, pnl: 1, leg: "long", reason: "target", financing: -0.75 },
        { side: "buy", quantity: 1, entry_time: 0, entry_price: 100, exit_time: 60, exit_price: 101, pnl: 1, leg: "long", reason: "target" },
      ] as BacktestResult["trades"],
    });
    const rows = tradeRows(r, 60);
    expect(rows[0].financing).toBe(-0.75);
    expect(rows[1].financing).toBe(0);
  });
  it("sorts by pnl descending, stably", () => {
    const rows = sortTradeRows(tradeRows(res, 60), "pnl", "desc");
    expect(rows.map(r => r.pnl)).toEqual([20, -5]);
  });

  it("tradeRows exitTime prefers exit_time_exact when present", () => {
    const res = {
      trades: [
        { side: "buy", leg: "long", entry_time: 1000, entry_price: 100, exit_time: 1000,
          exit_price: 99, pnl: -1, reason: "stop", exit_time_exact: 3000 },
        { side: "buy", leg: "long", entry_time: 2000, entry_price: 100, exit_time: 5000,
          exit_price: 101, pnl: 1, reason: "range end", exit_time_exact: null },
      ],
    } as unknown as Parameters<typeof tradeRows>[0];

    const rows = tradeRows(res, 3600);
    expect(rows[0].exitTime).toBe(3000); // exact wins
    expect(rows[1].exitTime).toBe(5000); // falls back to raw
  });
});

describe("rowWindow", () => {
  it("renders everything when the list is small or row height unknown", () => {
    expect(rowWindow(0, 400, 27, 5)).toEqual({ start: 0, end: 5, padTop: 0, padBottom: 0 });
    expect(rowWindow(500, 400, 0, 1000)).toEqual({ start: 0, end: 1000, padTop: 0, padBottom: 0 });
  });
  it("windows a long list to the visible slice plus overscan", () => {
    // 27px rows, scrolled to row 100, 405px viewport shows 15 rows.
    const w = rowWindow(2700, 405, 27, 11605, 10);
    expect(w.start).toBe(90); // 100 - overscan
    expect(w.end).toBe(126); // 100 + 15 + 1 + overscan
    expect(w.padTop).toBe(90 * 27);
    expect(w.padBottom).toBe((11605 - 126) * 27);
  });
  it("clamps at the top and bottom of the list", () => {
    const top = rowWindow(0, 405, 27, 1000, 10);
    expect(top.start).toBe(0);
    expect(top.padTop).toBe(0);
    const bottom = rowWindow(27 * 990, 405, 27, 1000, 10);
    expect(bottom.end).toBe(1000);
    expect(bottom.padBottom).toBe(0);
  });
  it("still lands on real rows when a stale scrollTop points past a now-shorter list", () => {
    // Was scrolled deep into an 11.6k-trade run, then re-ran with only 50
    // trades: scrollTop is far beyond the new content. The window must show the
    // last page (non-empty slice), not an all-spacer, no-rows dead zone.
    const w = rowWindow(11605 * 27, 405, 27, 50, 10);
    expect(w.end).toBe(50);
    expect(w.start).toBeLessThan(w.end); // slice is non-empty
    expect(w.padBottom).toBe(0);
    // padTop never exceeds the real content span.
    expect(w.padTop).toBeLessThanOrEqual(50 * 27);
  });
});

describe("bootstrap rows in the overview groups", () => {
  const trade = (pnl: number) => ({
    side: "BUY", leg: "long", entry_time: 0, entry_price: 1, exit_time: 60,
    exit_price: 1, pnl, quantity: 1, reason: "tp",
  });

  it("adds P(profit), P5 net P&L and P95 drawdown rows fed by the trade list", () => {
    const pnls = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? -5 : 8));
    const res = result({
      trades: pnls.map(trade) as never,
      summary: { net_pnl: pnls.reduce((a, b) => a + b, 0), n_trades: 40, win_rate: 0.66, max_drawdown: 10 },
    });
    const byLabel = Object.fromEntries(metricRows(res).map((r) => [r.label, r]));
    expect(byLabel["P(profit)"].value).toMatch(/^\d+%$/);
    expect(byLabel["P(profit)"].verdict).toBeTruthy();
    expect(byLabel["P5 net P&L"].value).toMatch(/^[+−]\d+\.\d\d$/);
    expect(byLabel["P95 drawdown"].value).toMatch(/^\d+\.\d\d$/);
  });

  it("mutes the P(profit) verdict as low sample under 30 trades", () => {
    const res = result({
      trades: [trade(5), trade(6), trade(7)] as never,
      summary: { net_pnl: 18, n_trades: 3, win_rate: 1, max_drawdown: 0 },
    });
    const byLabel = Object.fromEntries(metricRows(res).map((r) => [r.label, r]));
    expect(byLabel["P(profit)"].verdict).toEqual({ label: "low sample", tone: "muted" });
  });

  it("dashes the bootstrap rows when there are too few trades to resample", () => {
    const byLabel = Object.fromEntries(metricRows(result()).map((r) => [r.label, r]));
    expect(byLabel["P(profit)"].value).toBe("-");
    expect(byLabel["P5 net P&L"].value).toBe("-");
    expect(byLabel["P95 drawdown"].value).toBe("-");
  });

  it("groups the rows under Performance and Risk & extremes", async () => {
    const { metricGroups, METRIC_INFO } = await import("./backtestPanelData");
    const groups = metricGroups(result());
    const perf = groups.find((g) => g.title === "Performance")!;
    const risk = groups.find((g) => g.title === "Risk & extremes")!;
    expect(perf.rows.map((r) => r.label)).toContain("P(profit)");
    expect(perf.rows.map((r) => r.label)).toContain("P5 net P&L");
    expect(risk.rows.map((r) => r.label)).toContain("P95 drawdown");
    for (const label of ["P(profit)", "P5 net P&L", "P95 drawdown"]) {
      expect(METRIC_INFO[label]).toBeTruthy();
    }
  });
});

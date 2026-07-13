// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import type { BacktestAnalysis } from "./api";
import BacktestAnalysisPanel from "./BacktestAnalysisPanel";

// vitest isn't run with jest-style globals, so RTL's automatic cleanup never
// registers (see BacktestSettingsModal.test.tsx). Without this each render leaks.
afterEach(cleanup);

const analysis: BacktestAnalysis = {
  n_trades: 7,
  sl: {
    winners_mae_hist: { edges: [0.25, 0.5, 0.75, 1.0], counts: [2, 1, 0, 1, 0] },
    losers_mae_hist: { edges: [0.25, 0.5, 0.75, 1.0], counts: [0, 0, 1, 2, 0] },
    winners_near_stop_pct: 0.25,
    n_with_r: 7,
  },
  tp: {
    avg_winner_mfe_r: 2.8,
    avg_winner_realized_r: 1.5,
    median_left_on_table_r: 1.1,
    pct_nontarget_exits_reached_target: 0.4,
  },
  exit_reasons: [
    { bucket: "target", n: 4, win_rate: 1, expectancy: 5, net_pnl: 20, low_sample: true },
    { bucket: "stop", n: 3, win_rate: 0, expectancy: -2, net_pnl: -6, low_sample: true },
  ],
  r_hist: { edges: [-3, -2, -1, 0, 1, 2, 3], counts: [0, 0, 3, 0, 0, 2, 2, 0] },
  context: {
    trend: [
      { bucket: "up", n: 5, win_rate: 0.8, expectancy: 3, net_pnl: 15, low_sample: false },
      { bucket: "down", n: 2, win_rate: 0, expectancy: -0.5, net_pnl: -1, low_sample: true },
    ],
    vol_regime: [],
    session: [],
    candle_pattern: [],
    day_of_week: [],
  },
};

describe("BacktestAnalysisPanel", () => {
  it("renders SL/TP read-outs, exit reasons, and context tables", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    expect(screen.getByText(/25% of winners drew down 80% of the way to the stop before recovering/i)).toBeTruthy();
    expect(screen.getByText(/1.1R/)).toBeTruthy(); // left on the table
    expect(screen.getByText("target")).toBeTruthy();
    expect(screen.getByText("up")).toBeTruthy();
  });

  it("shows the empty state when there are no trades", () => {
    render(<BacktestAnalysisPanel analysis={{ ...analysis, n_trades: 0 }} />);
    expect(screen.getByText(/no trades to analyse/i)).toBeTruthy();
  });

  it("renders nothing useful crash-free with no analysis (older stored runs)", () => {
    render(<BacktestAnalysisPanel analysis={null} />);
    expect(screen.getByText(/run a backtest/i)).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

import type { BacktestAnalysis, BacktestWhatif } from "./api";
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
    day_of_week: [
      { bucket: "3", n: 4, win_rate: 0.5, expectancy: 1, net_pnl: 4, low_sample: true },
      { bucket: "0", n: 3, win_rate: 0.33, expectancy: -1, net_pnl: -3, low_sample: true },
    ],
  },
  whatif: {
    rule_exit: {
      by_reason: [
        { reason: "Sell to Close", n: 30, would_have_won: 11, would_have_lost: 16,
          undecided: 3, net_delta_r: -14.2 },
      ],
      totals: { n: 30, would_have_won: 11, would_have_lost: 16, undecided: 3,
        net_delta_r: -14.2 },
    },
    no_target: { n: 22, would_have_stopped: 6, survived: 16, net_saved_r: 9.1 },
    stop_curve: [
      { frac: 0.8, winners_killed: 1, losers_cheapened: 26, net_delta_r: 4.1 },
    ],
    target_curve: [{ target_r: 2.0, n_reached: 11, pct_reached: 0.3 }],
    fill_delay: { n: 37, avg_r: 0.07, total_r: 2.6 },
    limit_entry: { n: 37, fill_rate: 0.62, filled_net_delta_r: 3.4, undecided: 2,
      unfilled_foregone_r: 5.1, unfilled_winners: 4, net_verdict_r: -1.7 },
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

  it("shows day names in calendar order for day_of_week buckets", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    const mon = screen.getByText("Mon");
    const thu = screen.getByText("Thu"); // bucket "3", listed first by count
    expect(mon).toBeTruthy();
    expect(thu).toBeTruthy();
    // Mon must render before Thu despite Thu having more trades.
    expect(
      mon.compareDocumentPosition(thu) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the empty state when there are no trades", () => {
    render(<BacktestAnalysisPanel analysis={{ ...analysis, n_trades: 0 }} />);
    expect(screen.getByText(/no trades to analyse/i)).toBeTruthy();
  });

  it("renders nothing useful crash-free with no analysis (older stored runs)", () => {
    render(<BacktestAnalysisPanel analysis={null} />);
    expect(screen.getByText(/run a backtest/i)).toBeTruthy();
  });

  it("renders the what-if section with bullets and both curve tables", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    expect(screen.getByText(/What if/i)).toBeTruthy();
    expect(
      screen.getByText(/11 of 30 trades closed by "Sell to Close" would have gone on to hit the target/i),
    ).toBeTruthy();
    expect(screen.getByText(/target saved 9.1R net/i)).toBeTruthy();
    expect(screen.getByText(/fill delay costs 0.07R per trade/i)).toBeTruthy();
    expect(screen.getByText(/would have filled 62% of entries/i)).toBeTruthy();
    // Scoped to the What-if section: "80%" also appears in the pre-existing
    // Trend-at-entry table (win_rate 0.8), so an unscoped query is ambiguous.
    const whatIf = screen.getByText(/What if/i).closest("section")!;
    expect(within(whatIf).getByText("80%")).toBeTruthy(); // stop curve row
    expect(within(whatIf).getByText("2R")).toBeTruthy(); // target curve row
  });

  it("renders the negative-foregone limit-entry case as dodging losses, with a non-100% fill rate", () => {
    const negFore: BacktestAnalysis = {
      ...analysis,
      whatif: {
        ...(analysis.whatif as BacktestWhatif),
        limit_entry: {
          n: 37,
          fill_rate: 0.9968,
          filled_net_delta_r: 3.4,
          undecided: 2,
          unfilled_foregone_r: -1.0,
          unfilled_winners: 0,
          net_verdict_r: 4.4,
        },
      },
    };
    render(<BacktestAnalysisPanel analysis={negFore} />);
    expect(
      screen.getByText(/while dodging 1\.0R of losses on entries that never filled/i),
    ).toBeTruthy();
    expect(screen.queryByText(/would have filled 100% of entries/i)).toBeNull();
    expect(screen.getByText(/would have filled 99\.6% of entries/i)).toBeTruthy();
  });

  it("skips what-if entirely when absent or all-None", () => {
    render(<BacktestAnalysisPanel analysis={{ ...analysis, whatif: undefined }} />);
    expect(screen.queryByText(/What if/i)).toBeNull();
    cleanup();
    render(
      <BacktestAnalysisPanel
        analysis={{
          ...analysis,
          whatif: { rule_exit: null, no_target: null, stop_curve: null,
            target_curve: null, fill_delay: null, limit_entry: null },
        }}
      />,
    );
    expect(screen.queryByText(/What if/i)).toBeNull();
  });
});

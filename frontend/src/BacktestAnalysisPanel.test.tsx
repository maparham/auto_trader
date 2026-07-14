// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

// jsdom's localStorage isn't wired up in this project's vitest config (see
// BacktestSettingsModal.test.tsx); the sub-tab and collapsed-set persistence
// needs a working stand-in before the persist module loads.
installMemStorage();

import type { BacktestAnalysis, BacktestWhatif } from "./api";
import { saveBacktestAnalysisTab } from "./lib/persist";
import BacktestAnalysisPanel, { hourBucketRows } from "./BacktestAnalysisPanel";

// vitest isn't run with jest-style globals, so RTL's automatic cleanup never
// registers (see BacktestSettingsModal.test.tsx). Without this each render leaks.
// localStorage is cleared too: the sub-tab and collapsed-set persistence would
// otherwise leak one test's UI state into the next.
afterEach(() => {
  cleanup();
  localStorage.clear();
});

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
  r_hist: { edges: [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5], counts: [0, 0, 3, 0, 2, 2, 0] },
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
    breakeven_curve: [
      { frac: 0.5, n_armed: 40, n_fired: 12, losers_rescued: 9, winners_cut: 3, net_delta_r: 6.2 },
      { frac: 1.0, n_armed: 30, n_fired: 8, losers_rescued: 6, winners_cut: 2, net_delta_r: 4.1 },
      { frac: 1.5, n_armed: 20, n_fired: 4, losers_rescued: 3, winners_cut: 1, net_delta_r: 2.0 },
      { frac: 2.0, n_armed: 10, n_fired: 2, losers_rescued: 1, winners_cut: 1, net_delta_r: 0.5 },
      { frac: 3.0, n_armed: 4, n_fired: 1, losers_rescued: 1, winners_cut: 0, net_delta_r: 0.9 },
    ],
  },
};

// Click a sub-tab by its accessible name.
const showTab = (name: "Placement" | "What-if" | "Context") =>
  fireEvent.click(screen.getByRole("tab", { name }));

describe("BacktestAnalysisPanel", () => {
  it("renders SL/TP read-outs on Placement, exit reasons and context tables on Context", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    expect(screen.getByText(/25% of winners drew down 80% of the way to the stop before recovering/i)).toBeTruthy();
    expect(screen.getByText(/1.1R/)).toBeTruthy(); // left on the table
    showTab("Context");
    expect(screen.getByText("target")).toBeTruthy();
    expect(screen.getByText("up")).toBeTruthy();
  });

  it("shows day names in calendar order for day_of_week buckets", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    showTab("Context");
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
    showTab("What-if");
    expect(screen.getByText(/What if/i)).toBeTruthy();
    expect(
      screen.getByText(/11 of 30 trades closed by "Sell to Close" would have gone on to hit the target/i),
    ).toBeTruthy();
    expect(screen.getByText(/target saved 9.1R net/i)).toBeTruthy();
    expect(screen.getByText(/fill delay costs 0.07R per trade/i)).toBeTruthy();
    expect(screen.getByText(/would have filled 62% of entries/i)).toBeTruthy();
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
    showTab("What-if");
    expect(
      screen.getByText(/while dodging 1\.0R of losses on entries that never filled/i),
    ).toBeTruthy();
    expect(screen.queryByText(/would have filled 100% of entries/i)).toBeNull();
    expect(screen.getByText(/would have filled 99\.6% of entries/i)).toBeTruthy();
  });

  it("hides the What-if tab entirely when whatif is absent or all-None", () => {
    render(<BacktestAnalysisPanel analysis={{ ...analysis, whatif: undefined }} />);
    expect(screen.queryByRole("tab", { name: "What-if" })).toBeNull();
    expect(screen.queryByText(/What if/i)).toBeNull();
    cleanup();
    render(
      <BacktestAnalysisPanel
        analysis={{
          ...analysis,
          whatif: { rule_exit: null, no_target: null, stop_curve: null,
            target_curve: null, fill_delay: null, limit_entry: null, breakeven_curve: null },
        }}
      />,
    );
    expect(screen.queryByRole("tab", { name: "What-if" })).toBeNull();
    // The other two tabs still work.
    expect(screen.getByText(/25% of winners drew down/i)).toBeTruthy();
    showTab("Context");
    expect(screen.getByText("target")).toBeTruthy();
  });

  describe("sub-tabs", () => {
    it("defaults to Placement and shows only that page's content", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      const placement = screen.getByRole("tab", { name: "Placement" });
      expect(placement.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByText(/25% of winners drew down/i)).toBeTruthy();
      // Context and What-if content is not mounted.
      expect(screen.queryByText("target")).toBeNull();
      expect(screen.queryByText(/fill delay/i)).toBeNull();
    });

    it("switching tabs swaps the content", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("Context");
      expect(screen.getByText("target")).toBeTruthy();
      expect(screen.queryByText(/25% of winners drew down/i)).toBeNull();
      showTab("What-if");
      expect(screen.getByText(/fill delay costs/i)).toBeTruthy();
      expect(screen.queryByText("target")).toBeNull();
      showTab("Placement");
      expect(screen.getByText(/25% of winners drew down/i)).toBeTruthy();
    });

    it("persists the active tab across remount", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("Context");
      cleanup();
      render(<BacktestAnalysisPanel analysis={analysis} />);
      expect(
        screen.getByRole("tab", { name: "Context" }).getAttribute("aria-selected"),
      ).toBe("true");
      expect(screen.getByText("target")).toBeTruthy();
    });

    it("falls back to Placement when the persisted tab is the hidden What-if tab", () => {
      saveBacktestAnalysisTab("whatif");
      render(<BacktestAnalysisPanel analysis={{ ...analysis, whatif: undefined }} />);
      expect(
        screen.getByRole("tab", { name: "Placement" }).getAttribute("aria-selected"),
      ).toBe("true");
      expect(screen.getByText(/25% of winners drew down/i)).toBeTruthy();
    });
  });

  describe("collapsible sections", () => {
    it("collapsing a section hides its body; header remains", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("Context");
      expect(screen.getByText("target")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /exit reasons/i }));
      expect(screen.queryByText("target")).toBeNull(); // body hidden
      expect(screen.getByRole("button", { name: /exit reasons/i })).toBeTruthy(); // header stays
      // Re-expanding brings the body back.
      fireEvent.click(screen.getByRole("button", { name: /exit reasons/i }));
      expect(screen.getByText("target")).toBeTruthy();
    });

    it("persists the collapsed set across remount", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("Context");
      fireEvent.click(screen.getByRole("button", { name: /exit reasons/i }));
      cleanup();
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("Context");
      expect(screen.queryByText("target")).toBeNull(); // still collapsed
      expect(screen.getByText("up")).toBeTruthy(); // trend table unaffected
    });

    it("collapses an individual distribution block on Placement", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      // Exact name: the header's InfoTip is also a button, named "About Winners: ...".
      fireEvent.click(
        screen.getByRole("button", { name: "Winners: worst drawdown before profit" }),
      );
      // The winners histogram bullets disappear; the losers block is untouched.
      expect(screen.queryByText(/2 trades reached ≤25% to stop/i)).toBeNull();
      expect(screen.getByText(/2 trades reached 75–100% to stop/i)).toBeTruthy();
    });

    it("ignores unknown slugs in the stored array; unlisted sections stay expanded", () => {
      localStorage.setItem(
        "auto-trader.backtestAnalysisCollapsed",
        JSON.stringify(["bogus-slug", "exit-reasons"]),
      );
      render(<BacktestAnalysisPanel analysis={analysis} />);
      expect(screen.getByText(/25% of winners drew down/i)).toBeTruthy(); // expanded
      showTab("Context");
      expect(screen.queryByText("target")).toBeNull(); // exit-reasons collapsed
      expect(screen.getByText("up")).toBeTruthy(); // trend expanded
    });

    it("keeps the header InfoTip from toggling the section", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />);
      showTab("What-if");
      expect(screen.getByText(/fill delay costs/i)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "About What if" }));
      // Clicking the InfoTip must not collapse the section.
      expect(screen.getByText(/fill delay costs/i)).toBeTruthy();
    });
  });

  it("renders the breakeven-stop table and a positive 1R readout bullet", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    showTab("What-if");
    expect(screen.getByText(/Move stop to breakeven/i)).toBeTruthy();
    expect(
      screen.getByText(
        /Moving the stop to breakeven once a trade was 1R in profit would have saved 4\.1R net across 8 trades/i,
      ),
    ).toBeTruthy();
  });

  it("phrases a net-negative breakeven 1R row as a cost", () => {
    const neg: BacktestAnalysis = {
      ...analysis,
      whatif: {
        ...(analysis.whatif as BacktestWhatif),
        breakeven_curve: [
          { frac: 0.5, n_armed: 40, n_fired: 12, losers_rescued: 3, winners_cut: 9, net_delta_r: -6.2 },
          { frac: 1.0, n_armed: 30, n_fired: 8, losers_rescued: 2, winners_cut: 6, net_delta_r: -4.1 },
          { frac: 1.5, n_armed: 20, n_fired: 4, losers_rescued: 1, winners_cut: 3, net_delta_r: -2.0 },
          { frac: 2.0, n_armed: 10, n_fired: 2, losers_rescued: 1, winners_cut: 1, net_delta_r: 0.0 },
          { frac: 3.0, n_armed: 4, n_fired: 0, losers_rescued: 0, winners_cut: 0, net_delta_r: 0.0 },
        ],
      },
    };
    render(<BacktestAnalysisPanel analysis={neg} />);
    showTab("What-if");
    expect(
      screen.getByText(/Moving the stop to breakeven once a trade was 1R in profit would have cost 4\.1R net/i),
    ).toBeTruthy();
  });

  it("omits the breakeven section when the curve is absent (older runs)", () => {
    const noBe: BacktestAnalysis = {
      ...analysis,
      whatif: { ...(analysis.whatif as BacktestWhatif), breakeven_curve: null },
    };
    render(<BacktestAnalysisPanel analysis={noBe} />);
    showTab("What-if");
    expect(screen.queryByText(/Move stop to breakeven/i)).toBeNull();
    // The tab is still visible because other scenarios remain.
    expect(screen.getByText(/What if/i)).toBeTruthy();
  });

  describe("By month section", () => {
    const monthRow = (bucket: string, net_pnl: number) => ({
      bucket, n: 6, win_rate: 0.5, expectancy: net_pnl / 6, net_pnl, low_sample: false,
    });

    it("renders when two or more month rows are present", () => {
      render(
        <BacktestAnalysisPanel
          analysis={{ ...analysis, month_stats: [monthRow("2026-01", 120), monthRow("2026-02", -40)] }}
        />,
      );
      showTab("Context");
      expect(screen.getByText("By month")).toBeTruthy();
      expect(screen.getByText("2026-01")).toBeTruthy();
      expect(screen.getByText("2026-02")).toBeTruthy();
    });

    it("is hidden with fewer than two month rows", () => {
      render(
        <BacktestAnalysisPanel analysis={{ ...analysis, month_stats: [monthRow("2026-01", 120)] }} />,
      );
      showTab("Context");
      expect(screen.queryByText("By month")).toBeNull();
    });

    it("is hidden when month_stats is absent", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />); // base literal has no month_stats
      showTab("Context");
      expect(screen.queryByText("By month")).toBeNull();
    });
  });
});

describe("hourBucketRows", () => {
  it("buckets UTC-aligned at offset 0 with correct labels and derived stats", () => {
    const rows = hourBucketRows(
      [
        { hour: 1, n: 4, wins: 2, sum_pnl: 10 },
        { hour: 9, n: 6, wins: 3, sum_pnl: -12 },
        { hour: 22, n: 3, wins: 1, sum_pnl: 5 },
      ],
      0,
    );
    const byBucket = Object.fromEntries(rows.map((r) => [r.bucket, r]));
    // hour 1 -> bucket 0 (00:00-04:00); hour 9 -> bucket 2 (08:00-12:00);
    // hour 22 -> bucket 5, the last bucket, whose end renders as 24:00.
    expect(byBucket["00:00-04:00"]).toBeTruthy();
    expect(byBucket["08:00-12:00"]).toBeTruthy();
    expect(byBucket["20:00-24:00"]).toBeTruthy();
    expect(byBucket["00:00-04:00"].n).toBe(4);
    expect(byBucket["00:00-04:00"].win_rate).toBeCloseTo(0.5);
    expect(byBucket["00:00-04:00"].expectancy).toBeCloseTo(2.5);
    expect(byBucket["00:00-04:00"].net_pnl).toBeCloseTo(10);
    expect(byBucket["00:00-04:00"].low_sample).toBe(true); // n=4 < 5
    expect(byBucket["08:00-12:00"].low_sample).toBe(false); // n=6
    expect(byBucket["08:00-12:00"].net_pnl).toBeCloseTo(-12);
  });

  it("shifts buckets by a positive local offset", () => {
    // hour 1 + 2 = local 3 -> still bucket 0 (00:00-04:00);
    // hour 9 + 2 = local 11 -> bucket 2 (08:00-12:00);
    // hour 3 + 2 = local 5 -> bucket 1 (04:00-08:00)
    const rows = hourBucketRows(
      [
        { hour: 1, n: 1, wins: 1, sum_pnl: 1 },
        { hour: 3, n: 1, wins: 0, sum_pnl: -1 },
        { hour: 9, n: 1, wins: 1, sum_pnl: 2 },
      ],
      2,
    );
    const labels = rows.map((r) => r.bucket);
    expect(labels).toEqual(["00:00-04:00", "04:00-08:00", "08:00-12:00"]);
  });

  it("wraps hours near midnight and returns [] for empty input", () => {
    // hour 23 + 2 = 25 -> local 1 -> bucket 0
    const rows = hourBucketRows([{ hour: 23, n: 2, wins: 1, sum_pnl: 0 }], 2);
    expect(rows.map((r) => r.bucket)).toEqual(["00:00-04:00"]);
    expect(hourBucketRows([], 0)).toEqual([]);
  });
});

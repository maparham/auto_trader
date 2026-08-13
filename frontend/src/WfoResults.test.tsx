// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WfoResults, driftPath } from "./WfoResults";
import type { WfoRunState } from "./lib/signals";
import {
  wfoEquityShownSignal,
  wfoBandsShownSignal,
  wfoEquityCompoundedSignal,
} from "./lib/signals";

afterEach(() => {
  cleanup();
  // Signals are module singletons (default true) — reset so tests don't leak.
  wfoEquityShownSignal.set(true);
  wfoBandsShownSignal.set(true);
  wfoEquityCompoundedSignal.set(true);
});

const fold = (i: number, over: Partial<import("./api").WfoFold> = {}): import("./api").WfoFold => ({
  train_from: 1000 + i, train_to: 2000 + i, test_from: 2000 + i, test_to: 3000 + i,
  combo: { "param:fast": 5 + i }, is_metrics: { sharpe: 1.2 }, oos_metrics: { return_pct: 2.5, net_pnl: 25, n_trades: 12 },
  wfe: 0.7, low_sample: false, error: null, ...over,
});
const scheme = (span: string): import("./api").WfoScheme => ({
  train_span: span,
  folds: [fold(0), fold(1, { combo: null, error: null }), fold(2, { low_sample: true })],
  stitched: { equity: [[2000, 10000], [2999, 10100]], equity_scaled: [[2000, 10000], [2999, 10100]], trades: [], metrics: { sharpe: 1.1, max_drawdown_pct: 4.2 } },
  stability: { per_axis: { "param:fast": { stability: 0.8, adjacency: 1, values: [5, 6, 7] } }, overall: 0.8, adjacency: 1 },
  robustness: { robustness_score: 71.5, wfe_median: 0.7, pct_folds_profitable: 0.67, oos_sharpe: 1.1, oos_max_drawdown_pct: 4.2, param_stability: 0.8, oos_trades_total: 36 },
});
const doneState = (schemes = [scheme("3m")]): WfoRunState => ({
  phase: "done", done: 6, total: 6, running: false, foldRows: [],
  result: { eval_mode: "sliced", objective: { metric: "sharpe", selection: "plateau" }, schedule: {}, axes: [], schemes },
});

describe("WfoResults", () => {
  it("renders scorecard, folds incl. no-winner and low-sample rows", () => {
    render(<WfoResults state={doneState()} onApplyCombo={() => {}} onLoadFoldTable={() => Promise.resolve([])}
      axes={[{ kind: "range", target: "param:fast", label: "fast", from: 5, to: 15, step: 5 }]} schemeIndex={0} onSchemeIndex={() => {}} />);
    expect(screen.getByText("71.5")).toBeTruthy();
    expect(screen.getByText(/no eligible winner/i)).toBeTruthy();
    expect(document.querySelectorAll(".wfo-fold-row").length).toBe(3);
  });

  it("matrix strip appears for 2+ schemes and selects", () => {
    const onScheme = vi.fn();
    render(<WfoResults state={doneState([scheme("2w"), scheme("3m")])} onApplyCombo={() => {}} onLoadFoldTable={() => Promise.resolve([])}
      axes={[]} schemeIndex={0} onSchemeIndex={onScheme} />);
    fireEvent.click(screen.getByText("3m"));
    expect(onScheme).toHaveBeenCalledWith(1);
  });

  it("shows all-combos-failed banner", () => {
    const st = doneState();
    st.result = { ...st.result!, grid_errors: { failed: 4, total: 4, sample: "boom" } };
    render(<WfoResults state={st} onApplyCombo={() => {}} onLoadFoldTable={() => Promise.resolve([])} axes={[]} schemeIndex={0} onSchemeIndex={() => {}} />);
    expect(screen.getByText(/All 4 combos failed/)).toBeTruthy();
  });

  it("display chips flip the chart signals live", () => {
    render(<WfoResults state={doneState()} onApplyCombo={() => {}} onLoadFoldTable={() => Promise.resolve([])}
      axes={[]} schemeIndex={0} onSchemeIndex={() => {}} />);
    // All three default on.
    expect(wfoEquityShownSignal.value).toBe(true);
    expect(wfoBandsShownSignal.value).toBe(true);
    expect(wfoEquityCompoundedSignal.value).toBe(true);

    fireEvent.click(screen.getByText("Equity"));
    expect(wfoEquityShownSignal.value).toBe(false);
    fireEvent.click(screen.getByText("Fold bands"));
    expect(wfoBandsShownSignal.value).toBe(false);
    fireEvent.click(screen.getByText("Summed"));
    expect(wfoEquityCompoundedSignal.value).toBe(false);
    fireEvent.click(screen.getByText("Compounded"));
    expect(wfoEquityCompoundedSignal.value).toBe(true);

    // The pressed state reflects the signal.
    expect(screen.getByText("Equity").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Compounded").getAttribute("aria-pressed")).toBe("true");
  });

  it("driftPath maps values to a polyline and breaks on null", () => {
    expect(driftPath([5, 6, 7])).toMatch(/^M/);
    expect(driftPath([5, null, 7]).match(/M/g)!.length).toBe(2);
    expect(driftPath([])).toBe("");
  });

  it("fold click loads ranked table into SweepResults drill-in", async () => {
    const rows = [{ combo: { "param:fast": 5 }, metrics: { net_pnl: 10, n_trades: 3, win_rate: 0.5, max_drawdown: 1 }, windows: null, error: null }];
    const load = vi.fn().mockResolvedValue(rows);
    render(<WfoResults state={doneState()} onApplyCombo={() => {}} onLoadFoldTable={load}
      axes={[{ kind: "range", target: "param:fast", label: "fast", from: 5, to: 15, step: 5 }]} schemeIndex={0} onSchemeIndex={() => {}} />);
    fireEvent.click(document.querySelectorAll(".wfo-fold-row")[0]);
    expect(load).toHaveBeenCalledWith("s0/f0");
    // SweepResults drill-in rendered: its "Net P/L" metric header is unique to
    // the combo table (the fold rows above already contain the "fast" axis text).
    await screen.findAllByText("Net P/L");
    expect(document.querySelector(".wfo-fold-drill .sweep-results")).toBeTruthy();
    fireEvent.click(document.querySelectorAll(".wfo-fold-row")[0]);   // collapse
    fireEvent.click(document.querySelectorAll(".wfo-fold-row")[0]);   // re-expand
    expect(load).toHaveBeenCalledTimes(1);    // cached, no refetch on re-expand
  });

  it("drill-in fetch failure shows expiry copy", async () => {
    const load = vi.fn().mockRejectedValue(new Error("wfo job not found"));
    render(<WfoResults state={doneState()} onApplyCombo={() => {}} onLoadFoldTable={load} axes={[]} schemeIndex={0} onSchemeIndex={() => {}} />);
    fireEvent.click(document.querySelectorAll(".wfo-fold-row")[0]);
    await screen.findByText(/reopen from the archive/i);
  });

  // --- baseline comparison: excess over the null baseline ------------------
  // Folds: [0] normal +2.5, [1] no-winner, [2] low-sample -1.2, [3] errored.
  const excessState = (): WfoRunState => {
    const s = scheme("3m");
    s.folds = [
      fold(0, { excess_return_pct: 2.5 }),
      fold(1, { combo: null, error: null }),
      fold(2, { low_sample: true, excess_return_pct: -1.2 }),
      fold(3, { error: "boom", excess_return_pct: null }),
    ];
    s.robustness = { ...s.robustness, median_fold_excess_pct: 0.65, pct_folds_beating_null: 0.57 };
    return doneState([s]);
  };
  const renderResults = (st: WfoRunState) =>
    render(<WfoResults state={st} onApplyCombo={() => {}} onLoadFoldTable={() => Promise.resolve([])}
      axes={[]} schemeIndex={0} onSchemeIndex={() => {}} />);

  it("renders the Excess % column with sign coloring", () => {
    renderResults(excessState());
    expect(screen.getByText("Excess %")).toBeTruthy();
    expect(screen.getByText("+2.5%")).toBeTruthy();
    expect(screen.getByText("-1.2%")).toBeTruthy();
    const rows = document.querySelectorAll(".wfo-fold-row");
    expect(rows[0].querySelector("td.pos")).toBeTruthy();
    expect(rows[2].querySelector("td.neg")).toBeTruthy();
    // Errored fold keeps the row rectangular: window + failed + 5 dashes + apply.
    expect(rows[3].querySelectorAll("td").length).toBe(8);
  });

  it("tones an exactly-zero excess neutral and drops the + prefix", () => {
    const s = scheme("3m");
    s.folds = [fold(0, { excess_return_pct: 0 })];
    renderResults(doneState([s]));
    const cell = document.querySelectorAll(".wfo-fold-row")[0].querySelectorAll("td")[4];
    expect(cell.className).toBe("");
    expect(cell.textContent).toBe("0%");
  });

  it("renders the excess scorecard tiles", () => {
    renderResults(excessState());
    expect(screen.getByText("Median excess")).toBeTruthy();
    expect(screen.getByText("Folds > null")).toBeTruthy();
    expect(screen.getByText("57%")).toBeTruthy();
    expect(screen.getByText("0.7%")).toBeTruthy();
  });

  it("renders dashes when baseline data is absent (old archive)", () => {
    renderResults(doneState());
    expect(screen.getByText("Excess %")).toBeTruthy();
    // Column still present; the normal fold row carries an empty excess cell.
    const rows = document.querySelectorAll(".wfo-fold-row");
    expect(rows[0].querySelectorAll("td").length).toBe(8);
    // Column order: window, params, IS, OOS ret, Excess, OOS trades, WFE, apply.
    expect(rows[0].querySelectorAll("td")[4].textContent).toBe("–");
    // Tiles fall back to the en dash, not "undefined".
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
  });

  it("fmt does not render a negative zero", () => {
    const st = doneState();
    st.result!.schemes[0].robustness = {
      ...st.result!.schemes[0].robustness, median_fold_excess_pct: -0.04,
    };
    renderResults(st);
    expect(screen.queryByText("-0%")).toBeNull();
    expect(screen.getByText("0%")).toBeTruthy();
  });
});

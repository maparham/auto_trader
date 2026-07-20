// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WfoResults, driftPath } from "./WfoResults";
import type { WfoRunState } from "./lib/signals";

afterEach(cleanup);

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

  it("driftPath maps values to a polyline and breaks on null", () => {
    expect(driftPath([5, 6, 7])).toMatch(/^M/);
    expect(driftPath([5, null, 7]).match(/M/g)!.length).toBe(2);
    expect(driftPath([])).toBe("");
  });
});

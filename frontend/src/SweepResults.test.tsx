// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SweepResults } from "./SweepResults";

afterEach(cleanup);

const rows = [
  { combo: { "param:n": 5, "risk:long.stop.value": 1 },
    metrics: { net_pnl: 100, n_trades: 4, win_rate: 0.5, max_drawdown: 20,
               profit_factor: 2, return_pct: 1 }, error: null },
  { combo: { "param:n": 10, "risk:long.stop.value": 1 },
    metrics: { net_pnl: -50, n_trades: 2, win_rate: 0, max_drawdown: 60,
               profit_factor: null, return_pct: -0.5 }, error: null },
  { combo: { "param:n": 5, "risk:long.stop.value": 2 }, metrics: null, error: "boom" },
];
const axes = [
  { target: "param:n", label: "n", from: 5, to: 10, step: 5 },
  { target: "risk:long.stop.value", label: "Stop %", from: 1, to: 2, step: 1 },
];

describe("SweepResults", () => {
  it("renders a row per combo, greys failures, sorts by column", () => {
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    expect(screen.getAllByRole("row")).toHaveLength(4);   // header + 3
    expect(document.querySelector(".sweep-error")).toBeTruthy();
    fireEvent.click(screen.getByText("Net P/L"));         // sort desc
    const first = screen.getAllByRole("row")[1];
    expect(first.textContent).toContain("100");
  });

  it("applies a combo on row click", () => {
    const onApply = vi.fn();
    render(<SweepResults rows={rows} axes={axes} onApply={onApply} />);
    fireEvent.click(screen.getAllByRole("row")[1]);
    expect(onApply).toHaveBeenCalledWith(rows[0].combo);
  });

  it("renders a 2-axis heatmap grid colored by metric", () => {
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    expect(document.querySelectorAll(".sweep-cell").length).toBeGreaterThan(0);
  });
});

// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SweepResults } from "./SweepResults";

afterEach(cleanup);

const rows = [
  { combo: { "param:n": 5, "risk:long.stop.value": 1 },
    metrics: { net_pnl: 100, n_trades: 4, win_rate: 0.5, max_drawdown: 20,
               profit_factor: 2, avg_win_loss_ratio: null, return_pct: 1 }, error: null },
  { combo: { "param:n": 10, "risk:long.stop.value": 1 },
    metrics: { net_pnl: -50, n_trades: 2, win_rate: 0, max_drawdown: 60,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: -0.5 }, error: null },
  { combo: { "param:n": 5, "risk:long.stop.value": 2 }, metrics: null, error: "boom" },
];
const axes = [
  { kind: "range" as const, target: "param:n", label: "n", from: 5, to: 10, step: 5 },
  { kind: "range" as const, target: "risk:long.stop.value", label: "Stop %", from: 1, to: 2, step: 1 },
];

describe("SweepResults", () => {
  it("renders a row per combo, greys failures, sorts by column", () => {
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    expect(screen.getAllByRole("row")).toHaveLength(4);   // header + 3
    expect(document.querySelector(".sweep-error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Net P\/L/ })); // sort desc
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

const opRows = [
  { combo: { "op:long.entry.0": "gt", "param:n": 5 },
    metrics: { net_pnl: 10, n_trades: 1, win_rate: 1, max_drawdown: 0,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: 0.1 }, error: null },
  { combo: { "op:long.entry.0": "lt", "param:n": 5 },
    metrics: { net_pnl: -10, n_trades: 1, win_rate: 0, max_drawdown: 10,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: -0.1 }, error: null },
];
const opAxes = [
  { kind: "list" as const, target: "op:long.entry.0", label: "long entry 1 op", options: [
    { label: "greater than", patch: { "op:long.entry.0": "gt" } },
    { label: "less than", patch: { "op:long.entry.0": "lt" } },
  ] },
  { kind: "range" as const, target: "param:n", label: "n", from: 5, to: 5, step: 1 },
];

describe("SweepResults list axes", () => {
  it("labels combos with the matched option label", () => {
    render(<SweepResults rows={opRows} axes={opAxes} onApply={() => {}} />);
    expect(screen.getAllByText(/greater than/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/less than/).length).toBeGreaterThan(0);
  });

  it("renders heatmap ticks from option labels and applies the cell's combo", () => {
    const onApply = vi.fn();
    render(<SweepResults rows={opRows} axes={opAxes} onApply={onApply} />);
    const cells = document.querySelectorAll(".sweep-cell");
    expect(cells.length).toBe(2);            // 2 op options x 1 n value
    fireEvent.click(cells[0]);
    expect(onApply).toHaveBeenCalledWith(opRows[0].combo);
  });
});

// 3-axis fixture: axes A (1|2) x B (10) x C (100|200). With X=A, Y=B the C
// axis collapses: cell (A=1,B=10) matches two rows (net_pnl 50 and 80, where
// the 80 row has the WORSE drawdown 90), cell (A=2,B=10) matches one success
// and one failure.
const rows3 = [
  { combo: { "param:a": 1, "param:b": 10, "param:c": 100 },
    metrics: { net_pnl: 50, n_trades: 1, win_rate: 1, max_drawdown: 30,
               profit_factor: 2, avg_win_loss_ratio: null, return_pct: 0.5 }, error: null },
  { combo: { "param:a": 1, "param:b": 10, "param:c": 200 },
    metrics: { net_pnl: 80, n_trades: 2, win_rate: 1, max_drawdown: 90,
               profit_factor: 3, avg_win_loss_ratio: null, return_pct: 0.8 }, error: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 100 },
    metrics: { net_pnl: -20, n_trades: 1, win_rate: 0, max_drawdown: 40,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: -0.2 }, error: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 200 }, metrics: null, error: "boom" },
];
const axes3 = [
  { kind: "range" as const, target: "param:a", label: "A", from: 1, to: 2, step: 1 },
  { kind: "range" as const, target: "param:b", label: "B", from: 10, to: 10, step: 1 },
  { kind: "range" as const, target: "param:c", label: "C", from: 100, to: 200, step: 100 },
];

// 3-axis fixture where cell (A=1) collapses two failures (all failed) and cell
// (A=2) collapses one success and one failure (mixed).
const rowsMixedFail = [
  { combo: { "param:a": 1, "param:b": 10, "param:c": 100 }, metrics: null, error: "boom" },
  { combo: { "param:a": 1, "param:b": 10, "param:c": 200 }, metrics: null, error: "boom" },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 100 },
    metrics: { net_pnl: -20, n_trades: 1, win_rate: 0, max_drawdown: 40,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: -0.2 }, error: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 200 }, metrics: null, error: "boom" },
];

// 3-axis fixture where cell (A=1) has the FAILED row ordered first, then a
// success whose profit_factor is null: success must still win.
const rowsNullFirst = [
  { combo: { "param:a": 1, "param:b": 10, "param:c": 100 }, metrics: null, error: "boom" },
  { combo: { "param:a": 1, "param:b": 10, "param:c": 200 },
    metrics: { net_pnl: 40, n_trades: 1, win_rate: 1, max_drawdown: 10,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: 0.4 }, error: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 100 },
    metrics: { net_pnl: 20, n_trades: 1, win_rate: 1, max_drawdown: 5,
               profit_factor: 1.5, avg_win_loss_ratio: null, return_pct: 0.2 }, error: null },
];

describe("SweepResults 3+ axes", () => {
  it("renders X/Y pickers for 3 axes but not for 2", () => {
    const { unmount } = render(<SweepResults rows={rows3} axes={axes3} onApply={() => {}} />);
    expect(screen.getByLabelText("Heatmap X axis")).toBeTruthy();
    expect(screen.getByLabelText("Heatmap Y axis")).toBeTruthy();
    unmount();
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    expect(screen.queryByLabelText("Heatmap X axis")).toBeNull();
  });

  it("aggregated cell shows the best row by the color metric and applies its combo", () => {
    const onApply = vi.fn();
    render(<SweepResults rows={rows3} axes={axes3} onApply={onApply} />);
    const cells = [...document.querySelectorAll(".sweep-cell")];
    expect(cells).toHaveLength(2);                       // X=A (2 ticks) x Y=B (1 tick)
    const best = cells.find((c) => c.textContent === "+80.00")!;
    expect(best).toBeTruthy();                           // best net_pnl over collapsed C
    fireEvent.click(best);
    expect(onApply).toHaveBeenCalledWith(rows3[1].combo); // full combo incl. param:c 200
  });

  it("a cell with only failed matches still renders err, a mixed cell prefers success", () => {
    render(<SweepResults rows={rowsMixedFail} axes={axes3} onApply={() => {}} />);
    // Cells: X=A (2 ticks) x Y=B (1 tick). A=1 collapses two failures (all
    // failed, renders err); A=2 collapses one success (-20) and one failure
    // (success wins).
    const cells = [...document.querySelectorAll(".sweep-cell")];
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toBe("err");          // A=1: every match failed
    expect(cells[0].className).toContain("sweep-error");
    expect(cells[1].textContent).toBe("-20.00");        // A=2: mixed, success wins
    expect(cells[1].className).not.toContain("sweep-error");
  });

  it("prefers a null-metric success over a failed row ordered first in a cell", () => {
    const onApply = vi.fn();
    render(<SweepResults rows={rowsNullFirst} axes={axes3} onApply={onApply} />);
    // Color by Profit factor, a metric that is null on the A=1 success. The
    // failed row is ordered first in the cell, but success must still win.
    fireEvent.change(screen.getByLabelText("Heatmap color metric"), { target: { value: "profit_factor" } });
    const cells = [...document.querySelectorAll(".sweep-cell")];
    expect(cells[0].className).not.toContain("sweep-error");   // not the failed row
    expect(cells[0].textContent).toBe("—");                    // success, PF null
    fireEvent.click(cells[0]);
    expect(onApply).toHaveBeenCalledWith(rowsNullFirst[1].combo);
  });

  it("drawdown picks the minimum over the collapsed axis", () => {
    const onApply = vi.fn();
    render(<SweepResults rows={rows3} axes={axes3} onApply={onApply} />);
    fireEvent.change(screen.getByLabelText("Heatmap color metric"), { target: { value: "max_drawdown" } });
    const cells = [...document.querySelectorAll(".sweep-cell")];
    const best = cells.find((c) => c.textContent === "30.00")!;
    expect(best).toBeTruthy();                           // min drawdown, not the 90 row
    fireEvent.click(best);
    expect(onApply).toHaveBeenCalledWith(rows3[0].combo);
  });

  it("picking in X the axis Y holds swaps them", () => {
    render(<SweepResults rows={rows3} axes={axes3} onApply={() => {}} />);
    const x = screen.getByLabelText("Heatmap X axis") as HTMLSelectElement;
    const y = screen.getByLabelText("Heatmap Y axis") as HTMLSelectElement;
    expect(x.value).toBe("param:a");
    expect(y.value).toBe("param:b");
    fireEvent.change(x, { target: { value: "param:b" } });
    expect((screen.getByLabelText("Heatmap X axis") as HTMLSelectElement).value).toBe("param:b");
    expect((screen.getByLabelText("Heatmap Y axis") as HTMLSelectElement).value).toBe("param:a");
  });

  it("hover on an aggregated cell names the collapsed axis value", () => {
    render(<SweepResults rows={rows3} axes={axes3} onApply={() => {}} />);
    const best = [...document.querySelectorAll(".sweep-cell")].find((c) => c.textContent === "+80.00")!;
    fireEvent.mouseEnter(best);
    expect(document.querySelector(".sweep-heat-detail")!.textContent).toContain("C 200");
  });
});

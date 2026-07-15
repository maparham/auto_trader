// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SweepResults } from "./SweepResults";
import type { SweepRow } from "./api";
import type { SweepAxis } from "./lib/sweep";

afterEach(cleanup);

const rows = [
  { combo: { "param:n": 5, "risk:long.stop.value": 1 },
    metrics: { net_pnl: 100, n_trades: 4, win_rate: 0.5, max_drawdown: 20,
               profit_factor: 2, avg_win_loss_ratio: null, return_pct: 1 }, error: null, windows: null },
  { combo: { "param:n": 10, "risk:long.stop.value": 1 },
    metrics: { net_pnl: -50, n_trades: 2, win_rate: 0, max_drawdown: 60,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: -0.5 }, error: null, windows: null },
  { combo: { "param:n": 5, "risk:long.stop.value": 2 }, metrics: null, error: "boom", windows: null },
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
               profit_factor: null, avg_win_loss_ratio: null, return_pct: 0.1 }, error: null, windows: null },
  { combo: { "op:long.entry.0": "lt", "param:n": 5 },
    metrics: { net_pnl: -10, n_trades: 1, win_rate: 0, max_drawdown: 10,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: -0.1 }, error: null, windows: null },
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
               profit_factor: 2, avg_win_loss_ratio: null, return_pct: 0.5 }, error: null, windows: null },
  { combo: { "param:a": 1, "param:b": 10, "param:c": 200 },
    metrics: { net_pnl: 80, n_trades: 2, win_rate: 1, max_drawdown: 90,
               profit_factor: 3, avg_win_loss_ratio: null, return_pct: 0.8 }, error: null, windows: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 100 },
    metrics: { net_pnl: -20, n_trades: 1, win_rate: 0, max_drawdown: 40,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: -0.2 }, error: null, windows: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 200 }, metrics: null, error: "boom", windows: null },
];
const axes3 = [
  { kind: "range" as const, target: "param:a", label: "A", from: 1, to: 2, step: 1 },
  { kind: "range" as const, target: "param:b", label: "B", from: 10, to: 10, step: 1 },
  { kind: "range" as const, target: "param:c", label: "C", from: 100, to: 200, step: 100 },
];

// 3-axis fixture where cell (A=1) collapses two failures (all failed) and cell
// (A=2) collapses one success and one failure (mixed).
const rowsMixedFail = [
  { combo: { "param:a": 1, "param:b": 10, "param:c": 100 }, metrics: null, error: "boom", windows: null },
  { combo: { "param:a": 1, "param:b": 10, "param:c": 200 }, metrics: null, error: "boom", windows: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 100 },
    metrics: { net_pnl: -20, n_trades: 1, win_rate: 0, max_drawdown: 40,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: -0.2 }, error: null, windows: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 200 }, metrics: null, error: "boom", windows: null },
];

// 3-axis fixture where cell (A=1) has the FAILED row ordered first, then a
// success whose profit_factor is null: success must still win.
const rowsNullFirst = [
  { combo: { "param:a": 1, "param:b": 10, "param:c": 100 }, metrics: null, error: "boom", windows: null },
  { combo: { "param:a": 1, "param:b": 10, "param:c": 200 },
    metrics: { net_pnl: 40, n_trades: 1, win_rate: 1, max_drawdown: 10,
               profit_factor: null, avg_win_loss_ratio: null, return_pct: 0.4 }, error: null, windows: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 100 },
    metrics: { net_pnl: 20, n_trades: 1, win_rate: 1, max_drawdown: 5,
               profit_factor: 1.5, avg_win_loss_ratio: null, return_pct: 0.2 }, error: null, windows: null },
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

describe("SweepResults robustness columns", () => {
  const axes: SweepAxis[] = [
    { kind: "range", target: "param:n", label: "n", from: 1, to: 2, step: 1 },
  ];
  const robustRow = (n: number, m: Partial<NonNullable<SweepRow["metrics"]>>, wins: SweepRow["windows"]): SweepRow => ({
    combo: { "param:n": n },
    metrics: {
      net_pnl: 0, n_trades: 1, win_rate: 0.5, max_drawdown: 1,
      profit_factor: null, avg_win_loss_ratio: null, return_pct: 0, ...m,
    },
    windows: wins,
    error: null,
  });

  it("renders robustness columns with k/N windows-profitable and sorts nulls last", () => {
    const rows = [
      robustRow(1, { worst_window_pnl: -5, median_window_pnl: 2, pct_windows_profitable: 0.75, mean_window_pnl_minus_std: 1 },
        [{ from: 0, to: 1, pnl: 3, trades: 2 }, { from: 1, to: 2, pnl: -5, trades: 1 },
         { from: 2, to: 3, pnl: 2, trades: 1 }, { from: 3, to: 4, pnl: 4, trades: 1 }]),
      robustRow(2, {}, null),  // no window metrics: sorts below on robust columns
    ];
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    expect(screen.getByText("Worst wnd")).toBeTruthy();
    expect(screen.getByText("3/4")).toBeTruthy();
    fireEvent.click(screen.getByText("Worst wnd"));
    const cells = screen.getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(cells[0]).toContain("-5");     // row with metrics first even on desc
  });

  it("offers robustness metrics in the heatmap dropdown when two axes exist", () => {
    const axes2: SweepAxis[] = [
      { kind: "range", target: "param:n", label: "n", from: 1, to: 2, step: 1 },
      { kind: "range", target: "param:m", label: "m", from: 1, to: 2, step: 1 },
    ];
    const rows = [robustRow(1, { worst_window_pnl: 1 }, [])];
    render(<SweepResults rows={rows} axes={axes2} onApply={() => {}} />);
    const dropdown = screen.getByLabelText("Heatmap color metric");
    expect(within(dropdown).getByText("Worst window")).toBeTruthy();
  });

  it("renders a per-window strip with pnl and trade counts", () => {
    const rows = [
      robustRow(1, { worst_window_pnl: -5, median_window_pnl: 2, pct_windows_profitable: 0.5, mean_window_pnl_minus_std: 0 },
        [{ from: 1740787200, to: 1741392000, pnl: 8.2, trades: 9 },
         { from: 1741392000, to: 1741996800, pnl: -2.9, trades: 8 }]),
    ];
    const { container } = render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    // Robust cells carry a tooltip trigger (the strip is portaled on hover), never
    // a native title attribute, and neither do the headers.
    expect(container.querySelectorAll(".tooltip-trigger").length).toBeGreaterThan(0);
    expect(container.querySelector("th[title]")).toBeNull();
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("shows the window breakdown on robustness-cell hover", async () => {
    const rows = [
      robustRow(1, { pct_windows_profitable: 0.5 },
        [{ from: 1740787200, to: 1741392000, pnl: 8.2, trades: 9 },
         { from: 1741392000, to: 1741996800, pnl: -2.9, trades: 8 }]),
    ];
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    // The k/N cell is wrapped in a delay=0 Tooltip; mouseenter does not bubble,
    // so fire it on the trigger span (the cell content's parent).
    fireEvent.mouseEnter(screen.getByText("1/2").parentElement!);
    expect(await screen.findByText("9 tr")).toBeTruthy();
    expect(await screen.findByText("8 tr")).toBeTruthy();
    expect(await screen.findByText("+8.20")).toBeTruthy();
  });

  it("wraps robustness headers in a tooltip carrying the info copy", () => {
    const rows = [robustRow(1, { worst_window_pnl: -5 }, [])];
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    // Focus shows the shared Tooltip instantly (no delay on keyboard focus).
    fireEvent.focus(screen.getByText("Worst wnd").closest(".tooltip-trigger")!);
    expect(screen.getByRole("tooltip").textContent).toContain("The most this combo lost");
  });
});

import { describe, expect, it } from "vitest";
import type { SweepRow } from "../api";
import type { SweepAxis } from "./sweep";
import { plateauCenter, withPlateau } from "./sweepPlateau";

const axis = (target: string): SweepAxis =>
  ({ kind: "range", target, label: target, from: 1, to: 5, step: 1 });

const row = (combo: Record<string, number>, net: number | null): SweepRow => ({
  combo,
  metrics: net === null ? null : ({ net_pnl: net, n_trades: 5, win_rate: 0.5,
    max_drawdown: 1, profit_factor: null, avg_win_loss_ratio: null, return_pct: 0 } as never),
  windows: null,
  error: net === null ? "boom" : null,
});

describe("withPlateau", () => {
  // 1D grid p=[1..5], net [0, 10, 0, 5, 4]: the 10 is an isolated spike
  // (neighbor median 0); the 5 sits on a plateau with 0 and 4 around it.
  const axes = [axis("param:p")];
  const rows = [0, 10, 0, 5, 4].map((net, i) => row({ "param:p": i + 1 }, net));

  it("scores the plateau above the spike", () => {
    const { rows: scored, spikes } = withPlateau(rows, axes);
    const score = (i: number) => (scored[i].metrics as never as { plateau_score: number }).plateau_score;
    expect(score(1)).toBe(0);        // median(0, 10, 0)
    expect(score(3)).toBe(4);        // median(0, 5, 4)
    expect(spikes[1]).toBe(true);    // 10 > 0, neighbors median 0
    expect(spikes[3]).toBe(false);
  });

  it("plateauCenter picks the best-scored row", () => {
    const { rows: scored } = withPlateau(rows, axes);
    expect(plateauCenter(scored)?.combo).toEqual({ "param:p": 4 });
  });

  it("failed rows pass through unscored and unspiked", () => {
    const withFail = [...rows, row({ "param:p": 6 }, null)];
    const { rows: scored, spikes } = withPlateau(withFail, axes);
    expect(scored[5].metrics).toBeNull();
    expect(spikes[5]).toBe(false);
  });

  it("no range axes yields null scores", () => {
    const listAxes: SweepAxis[] = [{ kind: "list", target: "op:x", label: "op",
      options: [{ label: "a", patch: { "op:x": "gt" } }] }];
    const { rows: scored } = withPlateau([row({ "op:x": 1 }, 5)], listAxes);
    expect((scored[0].metrics as never as { plateau_score: number | null }).plateau_score).toBeNull();
  });

  it("2D: diagonal cells are neighbors (Chebyshev)", () => {
    const axes2 = [axis("param:a"), axis("param:b")];
    const grid: SweepRow[] = [];
    for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++)
      grid.push(row({ "param:a": a, "param:b": b }, a === 2 && b === 2 ? 9 : 1));
    const { rows: scored } = withPlateau(grid, axes2);
    const center = scored.find((r) => r.combo["param:a"] === 2 && r.combo["param:b"] === 2)!;
    // center's neighborhood is all 9 cells: median(1x8, 9) = 1
    expect((center.metrics as never as { plateau_score: number }).plateau_score).toBe(1);
  });
});

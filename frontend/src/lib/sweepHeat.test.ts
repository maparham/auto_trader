// Heatmap cell index + display tiers. The index replaces the per-cell linear
// scan over all rows (O(cells x rows) per render) with one O(rows) pass; the
// tier picks how the grid renders as cell counts grow.
import { describe, expect, it } from "vitest";
import type { SweepRow } from "../api";
import type { SweepAxis } from "./sweep";
import { axisTicks, buildHeatIndex, cellKey, heatTier, HEAT_TEXT_MAX_CELLS, HEAT_COMPACT_MAX_CELLS } from "./sweepHeat";

const mk = (combo: Record<string, number | string>, net: number | null, extra: Partial<NonNullable<SweepRow["metrics"]>> = {}): SweepRow => ({
  combo,
  metrics: net === null ? null : {
    net_pnl: net, n_trades: 1, win_rate: 1, max_drawdown: 10,
    profit_factor: 1, avg_win_loss_ratio: null, return_pct: 0, ...extra,
  },
  error: net === null ? "boom" : null,
  windows: null,
});

const axA: SweepAxis = { kind: "range", target: "param:a", label: "A", from: 1, to: 2, step: 1 };
const axB: SweepAxis = { kind: "range", target: "param:b", label: "B", from: 10, to: 10, step: 1 };
const axOp: SweepAxis = {
  kind: "list", target: "op:long.entry.0", label: "op", options: [
    { label: "greater than", patch: { "op:long.entry.0": "gt" } },
    { label: "less than", patch: { "op:long.entry.0": "lt" } },
  ],
};

describe("axisTicks", () => {
  it("builds sorted unique ticks from row values for a range axis", () => {
    const rows = [mk({ "param:a": 2 }, 1), mk({ "param:a": 1 }, 2), mk({ "param:a": 2 }, 3)];
    const ticks = axisTicks(axA, rows);
    expect(ticks.map((t) => t.label)).toEqual(["1", "2"]);
    expect(ticks[0].match).toEqual({ "param:a": 1 });
  });

  it("builds one tick per option for a list axis", () => {
    const ticks = axisTicks(axOp, []);
    expect(ticks.map((t) => t.label)).toEqual(["greater than", "less than"]);
  });
});

describe("buildHeatIndex", () => {
  it("maps each cell to its exact row with 2 axes", () => {
    const rows = [
      mk({ "param:a": 1, "param:b": 10 }, 5),
      mk({ "param:a": 2, "param:b": 10 }, -3),
    ];
    const xT = axisTicks(axA, rows);
    const yT = axisTicks(axB, rows);
    const idx = buildHeatIndex(rows, axA, axB, "net_pnl");
    expect(idx.get(cellKey(xT[0], yT[0]))).toBe(rows[0]);
    expect(idx.get(cellKey(xT[1], yT[0]))).toBe(rows[1]);
  });

  it("keeps the best row by the metric when a collapsed axis maps many rows to one cell", () => {
    const rows = [
      mk({ "param:a": 1, "param:b": 10, "param:c": 100 }, 50),
      mk({ "param:a": 1, "param:b": 10, "param:c": 200 }, 80),
    ];
    const xT = axisTicks(axA, rows);
    const yT = axisTicks(axB, rows);
    const idx = buildHeatIndex(rows, axA, axB, "net_pnl");
    expect(idx.get(cellKey(xT[0], yT[0]))).toBe(rows[1]);
  });

  it("picks the minimum for max_drawdown", () => {
    const rows = [
      mk({ "param:a": 1, "param:c": 100 }, 50, { max_drawdown: 30 }),
      mk({ "param:a": 1, "param:c": 200 }, 80, { max_drawdown: 90 }),
    ];
    const xT = axisTicks(axA, rows);
    const idx = buildHeatIndex(rows, axA, undefined, "max_drawdown");
    expect(idx.get(cellKey(xT[0], null))).toBe(rows[0]);
  });

  it("a success beats a failed row even when its metric value is null, regardless of order", () => {
    const rows = [
      mk({ "param:a": 1, "param:c": 100 }, null),
      mk({ "param:a": 1, "param:c": 200 }, 40, { profit_factor: null }),
    ];
    const xT = axisTicks(axA, rows);
    const idx = buildHeatIndex(rows, axA, undefined, "profit_factor");
    expect(idx.get(cellKey(xT[0], null))).toBe(rows[1]);
  });

  it("an all-failed cell still maps to a failed row; the first seen is kept", () => {
    const rows = [
      mk({ "param:a": 1, "param:c": 100 }, null),
      mk({ "param:a": 1, "param:c": 200 }, null),
    ];
    const xT = axisTicks(axA, rows);
    const idx = buildHeatIndex(rows, axA, undefined, "net_pnl");
    expect(idx.get(cellKey(xT[0], null))).toBe(rows[0]);
  });

  it("indexes list-axis rows by matching option patches", () => {
    const rows = [
      mk({ "op:long.entry.0": "gt", "param:a": 1 }, 10),
      mk({ "op:long.entry.0": "lt", "param:a": 1 }, -10),
    ];
    const xT = axisTicks(axOp, rows);
    const yT = axisTicks(axA, rows);
    const idx = buildHeatIndex(rows, axOp, axA, "net_pnl");
    expect(idx.get(cellKey(xT[0], yT[0]))).toBe(rows[0]);
    expect(idx.get(cellKey(xT[1], yT[0]))).toBe(rows[1]);
  });
});

describe("heatTier", () => {
  it("shows text up to the text cap, compact above it, collapses past the compact cap", () => {
    expect(heatTier(1)).toBe("text");
    expect(heatTier(HEAT_TEXT_MAX_CELLS)).toBe("text");
    expect(heatTier(HEAT_TEXT_MAX_CELLS + 1)).toBe("compact");
    expect(heatTier(HEAT_COMPACT_MAX_CELLS)).toBe("compact");
    expect(heatTier(HEAT_COMPACT_MAX_CELLS + 1)).toBe("collapsed");
  });
});

// Heatmap cell index + display tiers for SweepResults.
//
// The index is the perf-critical piece: the grid used to find each cell's row
// with a linear scan over every result (O(cells x rows) per render, ~16M
// comparisons at 4000 combos — the main-thread freeze on big sweeps). Here
// each row is assigned to its cell in ONE O(rows) pass, keeping the best row
// per cell under the same rules the per-cell scan applied: a success always
// beats a failure, higher metric wins (lower for max_drawdown), a null metric
// on a success loses to a value, first-seen wins ties/failures.
//
// Tiers pick the grid's rendering as cell counts grow: readable text cells up
// to HEAT_TEXT_MAX_CELLS, color-only compact cells (hover/click still work) up
// to HEAT_COMPACT_MAX_CELLS, collapsed behind a toggle beyond that.

import type { SweepRow } from "../api";
import { axisOptionFor, fmtAxisValue, type SweepAxis, type SweepCombo } from "./sweep";

export type HeatTick = { key: string; label: string; match: Record<string, number | string> };

export const HEAT_TEXT_MAX_CELLS = 400;
export const HEAT_COMPACT_MAX_CELLS = 4000;

export type HeatTier = "text" | "compact" | "collapsed";

export function heatTier(cellCount: number): HeatTier {
  if (cellCount <= HEAT_TEXT_MAX_CELLS) return "text";
  if (cellCount <= HEAT_COMPACT_MAX_CELLS) return "compact";
  return "collapsed";
}

/** Ticks for one grid axis: list axes get one tick per option; range axes get
 * the sorted unique values actually present in the rows (not the configured
 * range — archived sweeps may hold values outside today's editor state). */
export function axisTicks(a: SweepAxis, rows: SweepRow[]): HeatTick[] {
  if (a.kind === "list") {
    return a.options.map((o, i) => ({ key: `o${i}`, label: o.label, match: o.patch }));
  }
  const set = new Set<number>();
  for (const r of rows) {
    const v = r.combo[a.target];
    if (typeof v === "number") set.add(v);
  }
  return [...set].sort((x, y) => x - y)
    .map((v) => ({ key: String(v), label: fmtAxisValue(v), match: { [a.target]: v } }));
}

export function cellKey(xt: HeatTick, yt: HeatTick | null): string {
  return `${xt.key} ${yt?.key ?? ""}`;
}

// Direction-aware "which row is better" on the color metric. Success vs
// failure is decided on `metrics === null` BEFORE any metric comparison: a
// nullable metric (profit_factor, avg_win_loss_ratio) can be null on a
// successful row too, so comparing values first would let a failed row tie
// and win. Failure only wins over another failure (first seen kept).
function better(a: SweepRow, b: SweepRow, metric: string): SweepRow {
  if (a.metrics === null) return b.metrics === null ? a : b;
  if (b.metrics === null) return a;
  const av = (a.metrics as Record<string, number | null>)[metric] ?? null;
  const bv = (b.metrics as Record<string, number | null>)[metric] ?? null;
  if (bv === null) return a;
  if (av === null) return b;
  if (metric === "max_drawdown") return bv < av ? b : a;
  return bv > av ? b : a;
}

/** Which tick of `axis` a row falls on, as the tick's key; null when the row
 * matches no list option. Range keys are String(value), matching axisTicks'
 * keys (ticks and rows carry the identical stored number). */
function tickKeyFor(axis: SweepAxis, row: SweepRow): string | null {
  if (axis.kind !== "list") return String(row.combo[axis.target]);
  const opt = axisOptionFor(axis, row.combo as SweepCombo);
  return opt ? `o${axis.options.indexOf(opt)}` : null;
}

/** One O(rows) pass building cellKey -> best matching row. `yAxis` follows
 * the grid's 1-axis degenerate form: no Y axis means a single row of cells
 * keyed with a null Y tick. A row whose range value isn't among the ticks
 * just creates an entry no cell ever looks up — harmless. */
export function buildHeatIndex(
  rows: SweepRow[],
  xAxis: SweepAxis,
  yAxis: SweepAxis | undefined,
  metric: string,
): Map<string, SweepRow> {
  const idx = new Map<string, SweepRow>();
  for (const r of rows) {
    const xk = tickKeyFor(xAxis, r);
    if (xk === null) continue;
    let yk = "";
    if (yAxis) {
      const k = tickKeyFor(yAxis, r);
      if (k === null) continue;
      yk = k;
    }
    const key = `${xk} ${yk}`;
    const prev = idx.get(key);
    idx.set(key, prev ? better(prev, r, metric) : r);
  }
  return idx;
}

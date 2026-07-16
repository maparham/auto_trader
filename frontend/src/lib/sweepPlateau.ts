// Parameter-plateau scoring over an in-memory sweep result set. The best cell
// in a grid is, by selection, the luckiest cell; real edges live on plateaus.
// plateau_score = median of the cell and its grid neighbors, capped at the
// cell's own value, so a cell cannot borrow credit from a lucky neighbor.
// Neighbors differ by at most one step (Chebyshev distance 1) on every numeric
// range axis and match exactly on every list axis. Pure functions; no engine
// or transport dependency.

import type { SweepRow } from "../api";
import type { SweepAxis } from "./sweep";

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function withPlateau(
  rows: SweepRow[],
  axes: SweepAxis[],
  metric: "net_pnl" = "net_pnl",
): { rows: SweepRow[]; spikes: boolean[] } {
  const rangeTargets = axes.filter((a) => a.kind === "range").map((a) => a.target);
  const listTargets = axes.filter((a) => a.kind === "list")
    .flatMap((a) => a.options.length ? Object.keys(a.options[0].patch) : []);

  // Index grid per range axis: sorted unique swept values -> ordinal position.
  const indexOf = new Map<string, Map<number, number>>();
  for (const t of rangeTargets) {
    const vals = [...new Set(rows.map((r) => r.combo[t]).filter((v): v is number => typeof v === "number"))]
      .sort((a, b) => a - b);
    indexOf.set(t, new Map(vals.map((v, i) => [v, i])));
  }

  const coord = (r: SweepRow): number[] | null => {
    const c: number[] = [];
    for (const t of rangeTargets) {
      const i = indexOf.get(t)!.get(r.combo[t] as number);
      if (i === undefined) return null;
      c.push(i);
    }
    return c;
  };
  const ok = rows.map((r) => r.metrics !== null);
  const coords = rows.map((r, i) => (ok[i] ? coord(r) : null));
  const val = (i: number): number => (rows[i].metrics as Record<string, number>)[metric] ?? 0;

  const scored: SweepRow[] = [];
  const spikes: boolean[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!ok[i] || rangeTargets.length === 0 || coords[i] === null) {
      scored.push(ok[i] && rows[i].metrics
        ? { ...rows[i], metrics: { ...rows[i].metrics!, plateau_score: null } as never }
        : rows[i]);
      spikes.push(false);
      continue;
    }
    const neighbors: number[] = [];
    for (let j = 0; j < rows.length; j++) {
      if (j === i || !ok[j] || coords[j] === null) continue;
      if (!listTargets.every((t) => rows[i].combo[t] === rows[j].combo[t])) continue;
      const cheb = Math.max(...coords[i]!.map((c, k) => Math.abs(c - coords[j]![k])));
      if (cheb === 1) neighbors.push(val(j));
    }
    const score = Math.min(val(i), median([val(i), ...neighbors]));
    scored.push({ ...rows[i], metrics: { ...rows[i].metrics!, plateau_score: score } as never });
    spikes.push(val(i) > 0 && neighbors.length >= 2 && median(neighbors) <= 0);
  }
  return { rows: scored, spikes };
}

export function plateauCenter(rows: SweepRow[]): SweepRow | null {
  let best: SweepRow | null = null;
  for (const r of rows) {
    const s = (r.metrics as Record<string, number | null> | null)?.plateau_score;
    if (s == null) continue;
    const bs = (best?.metrics as Record<string, number | null> | null)?.plateau_score;
    const bn = (best?.metrics as Record<string, number> | null)?.net_pnl ?? -Infinity;
    const rn = (r.metrics as Record<string, number>).net_pnl;
    if (best === null || s > (bs as number) || (s === bs && rn > bn)) best = r;
  }
  return best;
}

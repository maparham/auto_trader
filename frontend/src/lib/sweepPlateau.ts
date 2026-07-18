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

  // Cell lookup keyed by list-axis values + grid coordinate, so each row's
  // neighborhood is the <=3^d - 1 offset lookups around its own coordinate
  // instead of a scan over every other row (O(n^2) froze the UI per streamed
  // chunk on multi-thousand-combo sweeps). Each cell holds ALL rows landing
  // on it (normally one; duplicates happen on e.g. overlapping resumed
  // chunks), preserving the old scan's neighbor multiplicity in the median.
  const cellOf = (i: number): string =>
    `${listTargets.map((t) => String(rows[i].combo[t])).join("|")}#${coords[i]!.join(",")}`;
  const byCell = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    if (!ok[i] || coords[i] === null) continue;
    const k = cellOf(i);
    const cell = byCell.get(k);
    if (cell) cell.push(i);
    else byCell.set(k, [i]);
  }
  // All non-zero Chebyshev-distance-1 offsets in d dimensions.
  const offsets: number[][] = [];
  const dims = rangeTargets.length;
  for (let m = 0; m < Math.pow(3, dims); m++) {
    const o: number[] = [];
    for (let k = 0, rest = m; k < dims; k++, rest = Math.floor(rest / 3)) o.push((rest % 3) - 1);
    if (o.some((x) => x !== 0)) offsets.push(o);
  }

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
    const listKey = listTargets.map((t) => String(rows[i].combo[t])).join("|");
    const neighbors: number[] = [];
    for (const o of offsets) {
      const cell = byCell.get(`${listKey}#${coords[i]!.map((c, k) => c + o[k]).join(",")}`);
      if (!cell) continue;
      for (const j of cell) if (j !== i) neighbors.push(val(j));
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

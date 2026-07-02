// Pure ordering math for reordering the chart's bottom sub-panes. Kept side-effect
// free (no klinecharts, no storage) so it is unit-testable; the live-chart mutation
// that consumes it is reorderSubPanes in ./indicators.
import type { IndicatorInstance } from "./persist";

// Move arr[from] to index `to`, returning a NEW array (never mutates the input).
export function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const out = arr.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

// Given the current top-to-bottom order of reorderable pane ids, move `movingPaneId`
// to `targetIndex` (clamped into range). Returns the desired order plus `divIndex` —
// the first index at which desired differs from current, so the caller only rebuilds
// panes from there down. Returns null when the pane is unknown or the move is a no-op.
export function planPaneReorder(
  paneIds: string[],
  movingPaneId: string,
  targetIndex: number,
): { desired: string[]; divIndex: number } | null {
  const from = paneIds.indexOf(movingPaneId);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(paneIds.length - 1, targetIndex));
  if (to === from) return null;
  const desired = arrayMove(paneIds, from, to);
  let divIndex = 0;
  while (divIndex < paneIds.length && paneIds[divIndex] === desired[divIndex]) divIndex++;
  return { desired, divIndex };
}

// Rewrite the persisted instance list so the sub-pane instances appear in
// `newSubOrderIds` order, while every non-sub-pane entry (candle-pane overlays like
// EMA) stays in its original slot. This keeps hydrate replaying sub-panes in the new
// order without disturbing overlays.
export function reorderInstanceList(
  current: IndicatorInstance[],
  newSubOrderIds: string[],
): IndicatorInstance[] {
  const subSet = new Set(newSubOrderIds);
  const byId = new Map(current.map((i) => [i.id, i]));
  let k = 0;
  return current.map((inst) =>
    subSet.has(inst.id) ? byId.get(newSubOrderIds[k++]) ?? inst : inst,
  );
}

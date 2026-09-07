// Identity-preserving state updates for the redraw loop. useChartPaint's
// redraw runs on every pan/zoom frame and rebuilds its outputs (price tag,
// alert tags, trade pills) from scratch; committing those fresh identities
// re-rendered the whole ChartCore cell tree once per frame even when nothing
// on screen had changed. Passing next through these keeps the previous
// identity whenever the content is equal, so React bails out of the commit.
//
// Shallow comparison ON PURPOSE: every value in these states is a flat record
// of primitives (y/price/label/flags) rebuilt per frame — nested objects would
// need deep equality, and none of the callers carry any.

/** next when any own field differs from prev, else prev (same identity). */
export function stableValue<T extends Record<string, unknown>>(
  prev: T | null,
  next: T | null,
): T | null {
  if (prev === null || next === null) return next;
  const pk = Object.keys(prev);
  const nk = Object.keys(next);
  if (pk.length !== nk.length) return next;
  for (const k of nk) {
    if (!Object.is(prev[k], next[k])) return next;
  }
  return prev;
}

/** next when the length or any element (shallow) differs, else prev. */
export function stableArray<T extends Record<string, unknown>>(prev: T[], next: T[]): T[] {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    if (stableValue(prev[i], next[i]) !== prev[i]) return next;
  }
  return prev;
}

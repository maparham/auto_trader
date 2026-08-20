// Which cells are running a chart-replay session of ANY kind (masked or not).
//
// Split out of lib/chartSync for the same reason lib/maskedReplay was split out
// of lib/signals: chartSync imports klinecharts, which touches `window` at
// module-eval time, so anything that needs only this flag — the agent bridge's
// dealing gate, which runs in a node test env — would otherwise drag a chart
// library in behind it. chartSync re-exports these, so its own callers are
// unchanged.
//
// Cells currently in a REPLAY session (chart/useReplay.ts), mirrored here by
// ChartCore. A replaying cell sits at a different — and deliberately HIDDEN —
// moment in time, so nothing may broadcast its window on this channel: a
// sibling receiving it pans its own bars there and renders those timestamps
// through its OWN, unmasked axis formatter, handing the user the very dates the
// session exists to conceal. ChartCore gates its own publishes off a render-live
// ref; this registry is for the publishes App.tsx makes ON a cell's behalf
// (turning the date-range link or lock on reads the focused cell's window and
// broadcasts it), where no such ref is in reach. Same queryable-global idiom as
// chartSync's gestureCellId, and released on unmount for the same reason: a stale
// entry for a dead cell id would silently mute a later cell reusing it.
const replayingCells = new Set<string>();

export function setCellReplaying(id: string, active: boolean): void {
  if (active) replayingCells.add(id);
  else replayingCells.delete(id);
}

export function isCellReplaying(id: string): boolean {
  return replayingCells.has(id);
}

/** Is ANY cell replaying? For chrome that is not tied to a cell and only needs
 *  to know a session is in progress somewhere — the agent bridge's dealing
 *  gate, which acts on the ACCOUNT rather than on a chart. */
export function anyCellReplaying(): boolean {
  return replayingCells.size > 0;
}

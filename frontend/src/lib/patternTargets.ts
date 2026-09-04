// The pattern-search cross-cell registry: each mounted chart cell that can be
// pattern-searched registers itself here (series identity + a "show this match"
// jump handler), and a cell searching in layout scope reads the registry to know
// which sibling series to fan out to and where to route a foreign row's jump.
// Module-level like replayingCells: only the ACTIVE tab's cells are mounted, so
// the registry's contents ARE the open layout. No klinecharts imports, so it
// stays usable from node-env modules and tests.
import type { PatternMatch } from "./patternSearch";

export interface PatternTarget {
  cellId: string;
  epic: string;
  resolution: string;
  /** The period's display label ("5m"), for compact row tags in the panel. */
  label: string;
  /** Jump this cell to the match: paint its bands and scroll there. */
  showMatch: (m: PatternMatch) => void;
  /** Clear the bands showMatch painted. Called by the panel's dismiss: the
   *  cell never ran a search of its own, so nothing on its side would ever
   *  clear them. */
  clearMatchBands: () => void;
  /** Clear the selection band the drag gesture painted. The panel's dismiss
   *  calls it on the cell showing the ORIGIN series — the panel outlives that
   *  cell's mount, so the cell cannot clear its own band on dismiss. */
  clearSelectionBand: () => void;
}

// Map preserves insertion order, which is cell mount order — stable enough for
// the fan-out (result order is re-sorted by distance anyway).
const targets = new Map<string, PatternTarget>();

/** Register a cell as searchable/jumpable. Returns an unregister function that
 *  only removes THIS registration: a re-register for the same cell supersedes
 *  it, and the stale cleanup (effect ordering) must not tear the new one down. */
export function registerPatternTarget(t: PatternTarget): () => void {
  targets.set(t.cellId, t);
  return () => {
    if (targets.get(t.cellId) === t) targets.delete(t.cellId);
  };
}

export function listPatternTargets(): PatternTarget[] {
  return [...targets.values()];
}

export function getPatternTarget(cellId: string): PatternTarget | undefined {
  return targets.get(cellId);
}

/** Test hook: the registry is deliberately module-level, so suites must clear it. */
export function clearPatternTargets(): void {
  targets.clear();
}

// ---------------------------------------------------------------------------
// Pending cross-TAB jumps. A row found in a chart on ANOTHER tab cannot jump
// through the registry (only the active tab's cells are mounted), so the
// origin cell parks the match here, App switches tabs, and the target cell
// consumes its parked match when it mounts and registers. One slot per cell:
// a newer jump supersedes an unconsumed older one.

const pendingJumps = new Map<string, PatternMatch>();

export function setPendingPatternJump(cellId: string, m: PatternMatch): void {
  pendingJumps.set(cellId, m);
}

/** Consume the parked jump for a cell, if any. One-shot on purpose: the jump
 *  must fire on the mount the user asked for, not again on every later one. */
export function takePendingPatternJump(cellId: string): PatternMatch | undefined {
  const m = pendingJumps.get(cellId);
  pendingJumps.delete(cellId);
  return m;
}

/** Drop every parked jump — the origin panel's dismiss, and test isolation. */
export function clearPendingPatternJumps(): void {
  pendingJumps.clear();
}

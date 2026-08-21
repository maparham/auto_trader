// Where the replay transport sits inside its cell, per scope.
//
// The pill defaults to the cell's top-right corner and can be dragged anywhere
// inside it: a floating bar over a chart is always in someone's way, and which
// corner is free depends on the chart, not on us. Stored device-locally (a
// window position is a property of this screen, not of the layout that syncs
// between devices) and keyed by scope, like the session record it accompanies.
//
// Coordinates are pixels from the cell's top-left, NOT a fraction of its size.
// A fraction keeps a pill "in the same place" when a split resizes, but the
// thing the user was avoiding — a legend, an axis, a cluster of pills — does not
// scale with the cell, so the offset is the more faithful memory. Whatever is
// stored is clamped back inside on every render, which is what makes a resize,
// a layout change or a stale record safe.

import { PREFIX, load, saveLocal } from "./persist/core";

export interface PillPos {
  /** Pixels from the cell's left edge. */
  x: number;
  /** Pixels from the cell's top edge. */
  y: number;
}

const KEY = `${PREFIX}.replayPillPos`;
const CAP = 40; // scopes kept; oldest pruned beyond this (same bound as the sessions map)
/** Kept clear of the cell edges so the pill never looks glued to a border. */
export const PILL_MARGIN = 8;

export function loadPillPos(scope: string): PillPos | null {
  return load<Record<string, PillPos>>(KEY, {})[scope] ?? null;
}

export function savePillPos(scope: string, pos: PillPos): void {
  const all = load<Record<string, PillPos>>(KEY, {});
  all[scope] = pos;
  // No purge path reaches this map (purgeScope matches `${PREFIX}.${scope}.`
  // keys, and these live as FIELDS inside one flat key), so closing a cell would
  // orphan its entry forever. Bound it the way saveReplaySession does. Insertion
  // order is the age order here: a re-saved scope keeps its original slot, which
  // is fine — the cap exists to stop unbounded growth, not to be an LRU.
  const keys = Object.keys(all);
  if (keys.length > CAP) {
    keys.slice(0, keys.length - CAP).forEach((k) => delete all[k]);
  }
  saveLocal(KEY, all);
}

export function clearPillPos(scope: string): void {
  const all = load<Record<string, PillPos>>(KEY, {});
  if (!(scope in all)) return;
  delete all[scope];
  saveLocal(KEY, all);
}

/**
 * A stored (or in-flight) position, forced back inside the cell.
 *
 * Clamps rather than rejects: a cell that shrank, a layout that went from one
 * column to four, or a record written on a larger screen should move the pill,
 * not lose it off-screen or throw it back to the corner. When the pill is WIDER
 * than the cell (a 4-way split, where it wraps to several rows) the max goes
 * negative, so the lower bound wins and it pins to the left edge — visible and
 * usable, which beats centred and half outside.
 */
export function clampPillPos(
  pos: PillPos,
  cell: { width: number; height: number },
  pill: { width: number; height: number },
): PillPos {
  const maxX = cell.width - pill.width - PILL_MARGIN;
  const maxY = cell.height - pill.height - PILL_MARGIN;
  return {
    x: Math.max(PILL_MARGIN, Math.min(pos.x, maxX)),
    y: Math.max(PILL_MARGIN, Math.min(pos.y, maxY)),
  };
}

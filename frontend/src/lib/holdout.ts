// Holdout ("lockbox") config per strategy: reserve the last pct% of the
// configured range. Training runs and sweeps clamp to the front span; the
// holdout is only touched by the explicit Evaluate action, and every look is
// counted, because a holdout that gets peeked at repeatedly quietly becomes
// training data.
//
// Storage mirrors sweepMemory.ts: one flat, device-local key under PREFIX
// holding a `{ [strategyKey]: Entry }` map, entry-capped at CAP with oldest-
// first eviction. Strategy keys are derived with sweepMemory's exported
// sweepContext so holdout and sweep memory key identically.

import { load, saveLocal, PREFIX } from "./persist/core";

export { sweepContext } from "./sweepMemory";

const KEY = `${PREFIX}.holdout`; // added to DEVICE_LOCAL_FLAT_KEYS (persist/core.ts)
const CAP = 100;

// pct is nulled (not the entry deleted) when the holdout is disabled, so the
// preserved peek count re-surfaces if it's re-enabled — a peeked-at holdout can
// never be silently laundered back to zero peeks. loadHoldout treats a null pct
// as "no holdout", so callers behave identically to a missing entry.
type Entry = { pct: number | null; peeks: number; at: number };

/** Split [fromMs, toMs) at the (1 - pct/100) point: everything before the cut
 * is training, everything at/after is the reserved holdout. The cut is the same
 * value for both bounds (train ends where holdout begins), rounded to whole ms. */
export function splitHoldout(fromMs: number, toMs: number, pct: number): {
  trainToMs: number;
  holdoutFromMs: number;
} {
  const cut = Math.round(fromMs + (toMs - fromMs) * (1 - pct / 100));
  return { trainToMs: cut, holdoutFromMs: cut };
}

function loadAll(): Record<string, Entry> {
  return load<Record<string, Entry>>(KEY, {});
}

function saveAll(map: Record<string, Entry>): void {
  const keys = Object.keys(map);
  if (keys.length > CAP) {
    for (const k of keys
      .sort((a, b) => map[a].at - map[b].at)
      .slice(0, keys.length - CAP))
      delete map[k];
  }
  saveLocal(KEY, map);
}

export function loadHoldout(
  strategyKey: string,
): { pct: number; peeks: number } | null {
  const e = loadAll()[strategyKey];
  return e && e.pct !== null ? { pct: e.pct, peeks: e.peeks } : null;
}

export function saveHoldoutPct(strategyKey: string, pct: number | null): void {
  const map = loadAll();
  // Disabling nulls the pct but KEEPS the entry (and its peek count); only cap
  // eviction ever deletes an entry, so re-enabling restores the peeks.
  map[strategyKey] = { pct, peeks: map[strategyKey]?.peeks ?? 0, at: Date.now() };
  saveAll(map);
}

/** Record one look at the holdout result; returns the new peek count (0 if no
 * holdout is configured for the strategy). */
export function recordPeek(strategyKey: string): number {
  const map = loadAll();
  const e = map[strategyKey];
  if (!e) return 0;
  e.peeks += 1;
  e.at = Date.now();
  saveAll(map);
  return e.peeks;
}

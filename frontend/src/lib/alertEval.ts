// Pure price-alert evaluation — the crossing / once / every / re-arm logic, with
// NO chart, overlay, or storage dependency. Extracted so it has exactly one
// definition shared by two callers:
//   - overlays.checkAlerts (active tab: reads live on-chart overlay levels)
//   - alertEngine (ALL tabs incl. background: reads saved levels from storage)
// A single definition means a `once` alert can't fire in one path and re-fire in
// the other from divergent state. Unit-tested in alertEval.test.ts.

import type { AlertCondition, AlertTrigger } from "./persist";

// 5 bps: how far price must clear the level before an "every" alert re-arms.
export const RE_ARM_FRACTION = 5e-4;

export interface AlertEvalInput {
  condition: AlertCondition;
  trigger: AlertTrigger;
  /** Whether the alert is currently armed (eligible to fire). */
  armed: boolean;
}

export interface AlertEvalResult {
  /** The condition was met on this tick (and the alert was armed). */
  fired: boolean;
  /** The alert's armed state AFTER this tick (caller persists it). */
  nextArmed: boolean;
  /** A "once" alert fired and should now be removed. */
  remove: boolean;
}

// Evaluate one alert against a price tick. `prev` is the previous price sample
// (null on the very first tick — crossings need two samples, so nothing fires).
export function evaluateAlert(
  prev: number | null,
  price: number,
  level: number,
  input: AlertEvalInput,
): AlertEvalResult {
  const { condition, trigger, armed } = input;
  const unchanged: AlertEvalResult = { fired: false, nextArmed: armed, remove: false };

  if (!Number.isFinite(price) || !Number.isFinite(level)) return unchanged;

  // Crossings need two samples (prev → price), so nothing fires on the first tick.
  // Level checks (greater/less) are satisfied by the current price ALONE, so they
  // must be allowed to fire immediately — including when prev == null (baselines
  // reset to null on every reload/edit/move, and an already-satisfied alert would
  // otherwise miss its first sample, e.g. a one-tick spike present at reload).
  const isLevelCheck = condition === "greater" || condition === "less";
  if (prev == null && !isLevelCheck) return unchanged;

  const crossUp = prev != null && prev <= level && price > level;
  const crossDown = prev != null && prev >= level && price < level;
  let hit = false;
  switch (condition) {
    case "crossing": hit = crossUp || crossDown; break;
    case "crossing_up": hit = crossUp; break;
    case "crossing_down": hit = crossDown; break;
    // "greater"/"less" are level checks, not crossings: they're satisfied
    // whenever price is on the right side of the level — including immediately,
    // without waiting for a fresh cross.
    case "greater": hit = price > level; break;
    case "less": hit = price < level; break;
  }

  if (hit && armed) {
    if (trigger === "once") return { fired: true, nextArmed: false, remove: true };
    return { fired: true, nextArmed: false, remove: false }; // disarm until cleared
  }
  // Re-arm an "every" alert. Crossing alerts re-arm once price has cleared the
  // level by RE_ARM_FRACTION in either direction (so the next cross can fire).
  // Level checks (greater/less) instead re-arm only when the condition becomes
  // FALSE again — price back on the wrong side, past the margin — otherwise a
  // satisfied "greater" would re-arm and re-fire on every tick.
  if (!armed && trigger === "every") {
    // Floor the margin so a level of 0 still has hysteresis: Math.abs(0) * frac is
    // 0, which would re-arm (and let an "every" alert re-fire) on every tick.
    const margin = Math.max(Math.abs(level) * RE_ARM_FRACTION, 1e-10);
    let canReArm: boolean;
    if (condition === "greater") canReArm = price < level - margin;
    else if (condition === "less") canReArm = price > level + margin;
    else canReArm = Math.abs(price - level) > margin;
    if (canReArm) return { fired: false, nextArmed: true, remove: false };
  }
  return unchanged;
}

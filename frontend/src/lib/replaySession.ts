// Chart replay: the persisted session record and the pure decisions that start
// a session. Device-local by design (saveLocal, never save()): another device's
// replay cursor is meaningless, and a replay step must never enter the undo
// stack or the backend mirror.
import { PREFIX, load, saveLocal } from "./persist/core";
import type { ReplayLedgerState } from "./replayLedger";

export type JumpWindowKey = "1W" | "1M" | "3M" | "1Y" | "custom";

const DAY_MS = 86_400_000;

/** Random-jump window presets. "custom" carries no span — the panel supplies an
 * explicit from/to range instead. */
export const JUMP_WINDOWS: ReadonlyArray<{ key: JumpWindowKey; label: string; ms: number }> = [
  { key: "1W", label: "Past week", ms: 7 * DAY_MS },
  { key: "1M", label: "Past month", ms: 30 * DAY_MS },
  { key: "3M", label: "Past 3 months", ms: 90 * DAY_MS },
  { key: "1Y", label: "Past year", ms: 365 * DAY_MS },
  { key: "custom", label: "Custom range", ms: 0 },
];

/** How many times a jump may re-roll past a dead zone (weekend / holiday /
 * pre-listing gap) before the caller gives up and says so. */
export const MAX_JUMP_ATTEMPTS = 6;

export interface ReplaySessionRecord {
  epic: string;
  resolution: string;
  /** Cursor at session start — the masking anchor and the report card's origin. */
  startMs: number;
  /** "Known through" instant (see replayBars). */
  cursorMs: number;
  /** Furthest cursor ever played to: the trading gate that closes the
   * rewind-and-cheat loophole. */
  highWaterMs: number;
  masked: boolean;
  showStrategy: boolean;
  /** ReplayLedgerState (typed in replayLedger.ts; persisted as structural JSON
   * and re-hydrated on load, imported as `type` so only type-checked, not runtime). */
  ledger: ReplayLedgerState | null;
  savedAt: number;
}

const REPLAY_KEY = `${PREFIX}.replaySessions`;
const REPLAY_CAP = 40; // scopes kept; oldest pruned beyond this

export function loadReplaySession(scope: string): ReplaySessionRecord | null {
  return load<Record<string, ReplaySessionRecord>>(REPLAY_KEY, {})[scope] ?? null;
}

export function saveReplaySession(scope: string, rec: ReplaySessionRecord): void {
  const all = load<Record<string, ReplaySessionRecord>>(REPLAY_KEY, {});
  all[scope] = rec;
  // No purge path can reach this map: purgeScope matches `${PREFIX}.${scope}.`
  // keys, and a replay entry is a FIELD inside one flat key. Closing a cell would
  // orphan its entry forever, so bound the map the way saveViewPos does.
  const keys = Object.keys(all);
  if (keys.length > REPLAY_CAP) {
    keys
      .sort((a, b) => (all[a].savedAt ?? 0) - (all[b].savedAt ?? 0))
      .slice(0, keys.length - REPLAY_CAP)
      .forEach((k) => delete all[k]);
  }
  saveLocal(REPLAY_KEY, all);
}

export function clearReplaySession(scope: string): void {
  const all = load<Record<string, ReplaySessionRecord>>(REPLAY_KEY, {});
  if (!(scope in all)) return;
  delete all[scope];
  saveLocal(REPLAY_KEY, all);
}

/**
 * Where a random jump lands. Uniform inside [now - window, now - window/10]:
 * the 10% headroom guarantees the session has unseen bars left to play instead
 * of starting at the live edge. Each re-roll `attempt` widens the window by 50%
 * so a run of dead-zone landings (a long holiday closure, an instrument listed
 * mid-window) escapes instead of re-rolling inside the same gap forever. The range
 * on each attempt is a strict superset of the last, never retreating the head.
 */
export function pickJumpTarget(args: {
  nowMs: number;
  windowMs: number;
  attempt: number;
  random: () => number;
}): { fromMs: number; toMs: number; targetMs: number } {
  const widened = args.windowMs * (1 + 0.5 * args.attempt);
  const fromMs = args.nowMs - widened;
  const toMs = args.nowMs - args.windowMs / 10;
  return { fromMs, toMs, targetMs: fromMs + (toMs - fromMs) * args.random() };
}

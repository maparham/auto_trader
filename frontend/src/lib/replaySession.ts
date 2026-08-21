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

/** The random-jump window the picker is left on, remembered across sessions.
 *
 * ONE global entry, not one per scope: a user thinks "my jump window", and
 * keying it per cell would reintroduce the very surprise this fixes the moment
 * they replay a different chart. Device-local like every other replay record.
 *
 * The picker unmounts the instant a jump succeeds (it is rendered on
 * `mode === "picking"`), so its local state cannot be the memory: without this,
 * every session after the first silently re-armed the default month window
 * while the user believed they had asked for a year.
 */
export interface JumpWindowPref {
  key: JumpWindowKey;
  /** Days back for the "custom" entry. Kept even while another preset is
   * selected, so switching away and back does not lose the number. */
  days: number;
}

export const DEFAULT_JUMP_PREF: JumpWindowPref = { key: "1M", days: 90 };

const JUMP_PREF_KEY = `${PREFIX}.replayJumpWindow`;

/** Validated on READ, not on write: a stored key can outlive the preset list it
 * came from (a rename, a removed window), and falling back beats jumping into a
 * zero-width window. */
export function loadJumpPref(): JumpWindowPref {
  const raw = load<Partial<JumpWindowPref>>(JUMP_PREF_KEY, {});
  const days = Number(raw.days);
  return {
    key: JUMP_WINDOWS.some((w) => w.key === raw.key) ? (raw.key as JumpWindowKey) : DEFAULT_JUMP_PREF.key,
    days: Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_JUMP_PREF.days,
  };
}

export function saveJumpPref(pref: JumpWindowPref): void {
  saveLocal(JUMP_PREF_KEY, pref);
}

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
 * Where a random jump lands. Uniform inside [now - span, now - span/10]: the 10%
 * headroom guarantees the session has unseen bars left to play instead of
 * starting at the live edge.
 *
 * Each re-roll `attempt` HALVES the span, drawing closer to now rather than
 * further from it. The earlier version widened instead, on the theory that a run
 * of dead-zone landings meant a long closure to escape. The real dead end is not
 * a holiday, it is the HISTORY FLOOR: a broker keeps 1-minute candles for weeks
 * and hourly ones for years, so a "past year" jump on a minute chart fails for
 * every point older than the floor. Widening walked away from the data and the
 * error even told the user to widen further. Halving converges on the floor from
 * above, so six attempts take a year's window down to about eleven days, while a
 * fresh uniform draw each time escapes an ordinary weekend just as well.
 *
 * The caller says how narrow it had to go (see randomJump): landing much closer
 * to now than asked is worth a word, since a masked session cannot show it.
 */
export function pickJumpTarget(args: {
  nowMs: number;
  windowMs: number;
  attempt: number;
  random: () => number;
}): { fromMs: number; toMs: number; targetMs: number } {
  const span = args.windowMs / 2 ** args.attempt;
  const fromMs = args.nowMs - span;
  const toMs = args.nowMs - span / 10;
  return { fromMs, toMs, targetMs: fromMs + (toMs - fromMs) * args.random() };
}

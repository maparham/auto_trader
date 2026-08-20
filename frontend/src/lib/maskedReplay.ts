// Which cells are running a MASKED (blind) chart-replay session, and the anchor +
// axis preferences needed to relabel a bar timestamp the way each one's axis does.
//
// Chrome that renders a BAR timestamp but lives outside ChartCore — drawing
// coordinates, the PREV_HL anchor field, the marker popovers, the backtest trade
// table — cannot see a cell's replay state, so it reads this and formats through
// `maskedTimeLabel` (lib/timeFormat) instead. On-chart labels built in
// lib/indicators (curve labels, legend descriptions) read it too: those are not
// React, so they call `maskedSessionNow()` directly rather than the hook.
// Without it, a blind session is broken by opening a settings panel, hovering a
// marker, or merely having a PREV_HL indicator with an anchor on the chart.
//
// A REGISTRY keyed by cellId, not a single slot. Two cells can hold masked
// sessions at once (useReplay is per-cell state persisted per scope, with no
// global single-session lock), and a single slot is fail-OPEN in a way that is
// easy to miss: A arms, B arms and overwrites, B exits and clears the slot — A is
// still masked but nothing republishes, so every panel goes back to real dates.
// With a registry each cell writes and clears only its OWN entry, so B leaving
// cannot unmask A, and a consumer that knows its cell can read that cell's own
// anchor instead of a neighbour's (which is what made the day NUMBER wrong
// before, even when the masking itself held).
//
// Deliberately NOT gated on which cell has focus. A split can hold a masked cell
// that is not focused, and hovering a marker on it does not focus it — a
// focus-gated mask would have a hole exactly where the leak is. Over-masking is
// harmless (a sibling's drawing panel reads "Day 3 09:30" while a session runs
// elsewhere); under-masking defeats the feature. Fail closed.
//
// Lives in its own module rather than lib/signals.ts so lib/indicators can import
// it without pulling in that file's persist/trading/backtest graph.

import { Signal } from "./signals";
import type { Clock } from "./timeFormat";

export interface MaskedReplaySession {
  cellId: string;
  /** Session start cursor — the masking anchor ("Day 1"). */
  startMs: number;
  clock: Clock;
  timezone: string;
}

/** What a LABEL needs: the same fields, except the anchor may be missing when
 *  the caller could not say which cell it is labelling and more than one is
 *  masked (see anyMaskedReplay). A null anchor means "masked, day number
 *  unknown", never "not masked". */
export type MaskedReplayLabelSource = Omit<MaskedReplaySession, "startMs"> & {
  startMs: number | null;
};

export type MaskedReplayRegistry = Readonly<Record<string, MaskedReplaySession>>;

/** Empty = no masked session anywhere on screen. */
export const maskedReplaySignal = new Signal<MaskedReplayRegistry>({});

/** Add or replace one cell's entry, leaving every other cell's alone. */
export function armMaskedReplay(
  registry: MaskedReplayRegistry,
  session: MaskedReplaySession,
): MaskedReplayRegistry {
  return { ...registry, [session.cellId]: session };
}

/** Drop one cell's entry, leaving every other cell's alone. */
export function disarmMaskedReplay(
  registry: MaskedReplayRegistry,
  cellId: string,
): MaskedReplayRegistry {
  if (!(cellId in registry)) return registry; // no-op keeps the object identity
  const next = { ...registry };
  delete next[cellId];
  return next;
}

// Any masked session at all — what chrome that cannot tell which cell it is
// describing must fail closed on. Returns the STORED entry object (not a copy),
// so repeated calls give a stable identity for useSyncExternalStore as long as
// nothing actually changed.
//
// TWO OR MORE masked cells is the case worth reading carefully. Masking still
// holds (any entry means no real date), but no anchor is CORRECT for a caller
// that cannot say which cell it is describing: labelling B's bars from A's
// anchor prints a confidently wrong day number, and a wrong number is worse than
// an absent one — the user counts sessions in days and has no way to tell the
// two apart. So the anchor is withheld instead: `startMs: null`, which
// `maskedTimeLabel` renders as "Day ?" plus the clock time. Callers that KNOW
// their cell (maskedReplayFor / useMaskedReplayFor) are unaffected and keep
// their exact day number — this only degrades the read that was already
// guessing.
//
// The ambiguous value is memoised on the registry's identity for the same
// reason the single-entry path returns the stored object: useSyncExternalStore
// throws "The result of getSnapshot should be cached" if a fresh object comes
// back from every read.
let ambiguousFrom: MaskedReplayRegistry | null = null;
let ambiguousValue: MaskedReplayLabelSource | null = null;

export function anyMaskedReplay(registry: MaskedReplayRegistry): MaskedReplayLabelSource | null {
  let first: MaskedReplaySession | null = null;
  let count = 0;
  for (const key in registry) {
    if (!first) first = registry[key];
    if (++count > 1) break;
  }
  if (!first) return null;
  if (count === 1) return first;
  if (ambiguousFrom !== registry) {
    ambiguousFrom = registry;
    ambiguousValue = { ...first, startMs: null };
  }
  return ambiguousValue;
}

/** The entry for one specific cell, or null. Preferred when the caller knows
 *  which cell it is rendering for: it gives the RIGHT day number, not a
 *  neighbour's. */
export function maskedReplayFor(
  registry: MaskedReplayRegistry,
  cellId: string,
): MaskedReplaySession | null {
  return registry[cellId] ?? null;
}

/** Non-React read for module-level code (lib/indicators label builders). */
export function maskedSessionNow(): MaskedReplayLabelSource | null {
  return anyMaskedReplay(maskedReplaySignal.value);
}

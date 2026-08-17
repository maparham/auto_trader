// Subscribe React chrome to the masked-replay registry (lib/maskedReplay): a
// masked chart-replay session running anywhere on screen means no panel may print
// the real date of a bar. Components that render a BAR timestamp call this and,
// when it returns non-null, route the timestamp through `maskedTimeLabel` instead
// of their own formatter.
//
// useSyncExternalStore rather than the useEffect + useState idiom App uses for
// the other signals: the snapshot is read during render, so a panel that mounts
// while a session is already running never paints one frame of real dates, and
// there is no set-state-in-effect.
//
// Snapshot identity: `anyMaskedReplay` returns the STORED session object, not a
// copy, so repeated reads give the same reference until a cell actually arms,
// disarms or changes its entry. That is what keeps useSyncExternalStore from
// throwing "The result of getSnapshot should be cached to avoid an infinite loop".

import { useCallback, useSyncExternalStore } from "react";
import {
  anyMaskedReplay,
  maskedReplayFor,
  maskedReplaySignal,
  type MaskedReplaySession,
} from "./maskedReplay";
import { maskedTimeLabel } from "./timeFormat";
import { formatExpiryShort } from "./alertUi";

export type MaskedReplay = MaskedReplaySession | null;

const subscribe = (onChange: () => void) => maskedReplaySignal.subscribe(onChange);
const snapshot = (): MaskedReplay => anyMaskedReplay(maskedReplaySignal.value);

export function useMaskedReplay(): MaskedReplay {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * ONE cell's masked session, for chrome that knows which cell it is drawing for
 * (the trade pills, which belong to exactly one chart). Preferred over the
 * any-cell read above wherever the caller has a cellId: a live sibling cell then
 * keeps its real dates, and the day number is counted from THIS cell's own
 * anchor rather than a neighbour's (which is what made the number wrong before,
 * even when the masking itself held).
 *
 * The snapshot closure is memoised on cellId because useSyncExternalStore
 * re-subscribes whenever it changes identity; the VALUE identity is already
 * stable because maskedReplayFor returns the stored session object rather than a
 * copy, which is what keeps React from throwing "The result of getSnapshot
 * should be cached to avoid an infinite loop".
 */
export function useMaskedReplayFor(cellId: string): MaskedReplay {
  const snap = useCallback(
    (): MaskedReplay => maskedReplayFor(maskedReplaySignal.value, cellId),
    [cellId],
  );
  return useSyncExternalStore(subscribe, snap, snap);
}

// The chrome that labels a BAR with `formatExpiryShort` — the three on-chart
// marker popovers and the backtest trade table — all sit on bars that are on
// screen, so during a masked session each prints the exact date the session
// hides. One hook for all of them keeps the masked and unmasked labels from
// drifting apart.
//
// The `formatExpiryShort` import couples this hook to alert-UI formatting on
// purpose: those callers share that one unmasked formatter, so the masked form
// and the unmasked form are two halves of a single decision and belong together.
export function useBarTimeLabel(): (ms: number) => string {
  const masked = useMaskedReplay();
  return (ms: number) =>
    masked ? maskedTimeLabel(masked.startMs, ms, masked.clock, masked.timezone) : formatExpiryShort(ms);
}

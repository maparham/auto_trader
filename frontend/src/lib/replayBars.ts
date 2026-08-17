// Pure bar math for chart replay. Everything here is a function of (bars,
// cursor) — no chart, no fetch, no state — so the closed-bar rule that keeps a
// replay session BLIND is unit-testable on its own.
//
// `cursorMs` is "the market is known through this instant": the CLOSE time of
// the newest revealed bar, never a bar's timestamp. That definition is what
// makes a timeframe switch exact — the cursor carries across unchanged and each
// resolution re-derives its own visible set from it.
import type { KLineData } from "klinecharts";
import { RESOLUTION_SECONDS } from "./feed";

/** Nominal bar width in ms. Only ever a FALLBACK for the newest loaded bar (see
 * barCloseMs): RESOLUTION_SECONDS' derived entries (WEEK_2, MONTH_*, YEAR) are
 * approximate by its own documentation, so a real next-bar timestamp always wins. */
export function nominalMsFor(resolution: string): number {
  return (RESOLUTION_SECONDS[resolution] ?? 60) * 1000;
}

/** When bar `i` closes. The next bar's timestamp is the truth (correct for the
 * calendar-bucketed derived timeframes the backend folds, where a nominal width
 * is wrong by days); the nominal width covers the newest loaded bar, which has
 * no successor yet. */
export function barCloseMs(bars: readonly KLineData[], i: number, nominalMs: number): number {
  const next = bars[i + 1];
  return next ? next.timestamp : bars[i].timestamp + nominalMs;
}

/** How many bars are CLOSED at or before the cursor. Bars are ascending, so this
 * is a binary search on a monotone predicate. */
export function revealedCount(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
): number {
  let lo = 0;
  let hi = bars.length; // count of revealed bars, in [0, length]
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (barCloseMs(bars, mid, nominalMs) <= cursorMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The bars a replaying chart may paint at this cursor. */
export function revealedBars(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
): KLineData[] {
  return bars.slice(0, revealedCount(bars, cursorMs, nominalMs));
}

/** Cursor after one step forward, or null when the loaded bars are exhausted
 * (the caller refills the forward buffer or declares the end of history). */
export function nextCursorMs(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
): number | null {
  const n = revealedCount(bars, cursorMs, nominalMs);
  return n < bars.length ? barCloseMs(bars, n, nominalMs) : null;
}

/** Cursor after one step back, or null when a step would leave the chart blank
 * (one revealed bar is the floor). */
export function prevCursorMs(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
): number | null {
  const n = revealedCount(bars, cursorMs, nominalMs);
  return n >= 2 ? barCloseMs(bars, n - 2, nominalMs) : null;
}

/** Cursor for a chosen START timestamp: the close of the bar that CONTAINS it,
 * so a pick anywhere inside a bar reveals that bar and nothing after it. null
 * when no loaded bar covers the timestamp (dead zone — the caller re-rolls). */
export function cursorForStartTs(
  bars: readonly KLineData[],
  startTs: number,
  nominalMs: number,
): number | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].timestamp <= startTs) {
      return barCloseMs(bars, i, nominalMs) > startTs ? barCloseMs(bars, i, nominalMs) : null;
    }
  }
  return null;
}

/** Splice the replay slice onto whatever OLDER history the chart already holds.
 * Scroll-back paging prepends bars through the same facade, and a later slice
 * apply would otherwise drop them; anything at or after the slice's first bar is
 * dropped instead, since the slice is authoritative from there on. */
export function mergeOlder(
  existing: readonly KLineData[],
  revealed: readonly KLineData[],
): KLineData[] {
  if (!revealed.length) return [...revealed];
  const firstTs = revealed[0].timestamp;
  const older: KLineData[] = [];
  for (const b of existing) {
    if (b.timestamp >= firstTs) break;
    older.push(b);
  }
  return [...older, ...revealed];
}

/** Merge a freshly fetched window into the replay bar store.
 *
 * A refill CANNOT be treated as a superset of the store: bufferWindowSec spans a
 * fixed duration, so re-centring it on an advanced cursor returns a window of the
 * same width shifted right — on continuous data (crypto, synthetic epics) that is
 * the same bar COUNT, gaining bars on the right and losing them on the left.
 * Keeping "whichever array is longer" would therefore never adopt the refill at
 * all and the session would stall at the end of its first buffer.
 *
 * So: never shrink, never drop either end. Both inputs are ascending; the result
 * is ascending and unique by timestamp, with `fetched` winning a collision (it is
 * the fresher read of the same bar). An empty `fetched` leaves the store as it is,
 * which matters because fetchRange reports a failed page as an empty one. */
export function mergeForward(
  store: readonly KLineData[],
  fetched: readonly KLineData[],
): KLineData[] {
  if (!fetched.length) return store.slice();
  if (!store.length) return fetched.slice();
  const out: KLineData[] = [];
  let i = 0;
  let j = 0;
  while (i < store.length && j < fetched.length) {
    if (store[i].timestamp < fetched[j].timestamp) out.push(store[i++]);
    else if (store[i].timestamp > fetched[j].timestamp) out.push(fetched[j++]);
    else {
      out.push(fetched[j++]); // same bar, fresher read
      i++;
    }
  }
  while (i < store.length) out.push(store[i++]);
  while (j < fetched.length) out.push(fetched[j++]);
  return out;
}

/** Whether one more step forward is safe: the bar the cursor would step ONTO
 * already has a loaded successor, so its close is a real next-bar timestamp
 * rather than barCloseMs's nominal-width fallback.
 *
 * This is the whole no-lookahead/no-un-reveal rule in one place. Stepping onto
 * the last loaded bar would (a) reveal the still-forming bar at the live edge and
 * (b) let a later refill that appends across a session gap — a Friday daily bar
 * whose close jumps from F+1d to Monday — push that bar's close PAST the cursor,
 * un-revealing a bar the user has already seen. Both the step guard and the
 * end-of-session check read this predicate so they cannot disagree. */
export function hasLoadedSuccessor(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
): boolean {
  return revealedCount(bars, cursorMs, nominalMs) + 1 < bars.length;
}

/** True when the cursor is within `margin` bars of the end of the store, so the
 * forward buffer should be refilled before stepping can block on the network. */
export function needsBuffer(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
  margin: number,
): boolean {
  return bars.length - revealedCount(bars, cursorMs, nominalMs) <= margin;
}

/** The [from, to] SECOND window a replay load asks the candles API for: enough
 * history left of the cursor to fill the screen, plus a forward buffer so
 * stepping never blocks on the network. Clamped at `nowMs` — replay never
 * crosses the live edge, which is why the backend cache's no-forward-fetch
 * limitation is irrelevant here. */
export function bufferWindowSec(args: {
  centerMs: number;
  resSec: number;
  contextBars: number;
  forwardBars: number;
  nowMs: number;
}): { fromSec: number; toSec: number } {
  const centerSec = Math.floor(args.centerMs / 1000);
  return {
    fromSec: centerSec - args.contextBars * args.resSec,
    toSec: Math.min(centerSec + args.forwardBars * args.resSec, Math.floor(args.nowMs / 1000)),
  };
}

// Pure helpers for the trade-review tour: step through one cohort of a
// backtest's trades (losses by default) to study each in context. The card UI
// (TradeReviewCard) owns presentation and signal wiring; everything here is
// data-only and unit-tested.

import type { StoredBacktestResult } from "./persist";
import type { TradeReviewState } from "./signals";

type Trade = StoredBacktestResult["trades"][number];
type Marker = StoredBacktestResult["markers"][number];

export type ReviewCohort = "losses" | "wins" | "all";

/** Trade indices for a review cohort, chronological by entry time (stable on
 * ties). Breakeven trades count as losses — they're not wins, and the tour's
 * point is studying what didn't pay. */
export function reviewOrder(trades: readonly Trade[], cohort: ReviewCohort): number[] {
  const idx = trades
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => (cohort === "all" ? true : cohort === "wins" ? t.pnl > 0 : t.pnl <= 0));
  idx.sort((a, b) => a.t.entry_time - b.t.entry_time || a.i - b.i);
  return idx.map(({ i }) => i);
}

/** Next position after stepping by `delta`, clamped to [0, len-1] (0 when the
 * order is empty). Clamped rather than wrapped: hitting an end and silently
 * teleporting to the other end mid-study is disorienting. */
export function reviewStep(pos: number, delta: number, len: number): number {
  if (len <= 0) return 0;
  return Math.min(Math.max(pos + delta, 0), len - 1);
}

/** Realized R multiple: signed price move over the initial stop distance.
 * Null when there's no initial stop or the stop isn't on the risk side of the
 * entry (no meaningful one-R distance). Price-based — financing/commission are
 * P&L concerns, not risk-unit ones. */
export function realizedR(t: Trade): number | null {
  if (t.stop_initial == null) return null;
  const dir = t.leg === "long" ? 1 : -1;
  const risk = (t.entry_price - t.stop_initial) * dir;
  if (risk <= 0) return null;
  return ((t.exit_price - t.entry_price) * dir) / risk;
}

/** The opening marker for a trade — where the signal provenance (`terms`, the
 * captured rule values) lives. Matched by entry bar + leg + opening side
 * (long opens with a buy, short with a sell); same-bar same-leg collisions
 * fall back to the nearest entry price. Null when the markers don't cover the
 * trade (mechanical fills carry no terms anyway). */
export function entryMarkerFor(t: Trade, markers: readonly Marker[]): Marker | null {
  const side = t.leg === "long" ? "buy" : "sell";
  const hits = markers.filter((m) => m.time === t.entry_time && m.leg === t.leg && m.side === side);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  let best = hits[0];
  for (const m of hits) {
    if (Math.abs(m.price - t.entry_price) < Math.abs(best.price - t.entry_price)) best = m;
  }
  return best;
}

/** Compact duration between two unix-second stamps: "25m", "3h 25m", "2d 5h". */
export function fmtTradeDuration(entrySec: number, exitSec: number): string {
  const s = Math.max(exitSec - entrySec, 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Chart focus for a custom-cohort tour: while one is active (a contrast bucket
// launched it, so it carries a label), the trades OUTSIDE that cohort fade on
// the chart, leaving the cohort at full strength. Two-tone by construction —
// win/loss colors are untouched, only opacity carries the cohort. Standard
// Losses/Wins/All tours return null: those are a stepping order, not a filter,
// and dimming most of the chart for them would be noise.
export const DIMMED_OPACITY = 0.22;

export function cohortFocus(review: TradeReviewState | null): ReadonlySet<number> | null {
  if (!review || review.label == null) return null;
  return new Set(review.order);
}

/** Opacity for a marker covering `indices` (one dash, or an aggregate pill's
 * trades): full while any of them is in the cohort, dimmed otherwise. */
export function focusOpacity(
  focus: ReadonlySet<number> | null,
  indices: readonly number[],
): number {
  if (focus === null) return 1;
  return indices.some((i) => focus.has(i)) ? 1 : DIMMED_OPACITY;
}

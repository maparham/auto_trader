// The trading period(s) a backtest ran over, for on-chart shading. A period is
// the configured window ([fromMs,toMs]) restricted, when a recurrence mask is
// on, to the recurring active sessions. We derive the drawable bands by sampling
// the CURRENTLY LOADED bars through the same `isActive` oracle the mask-preview
// heatstrip uses — exact at candle resolution (which is all that shows), bounded
// by the bar count, and correct for DST / overnight wrap because isActive is the
// single source of truth (no second copy of the schedule semantics). Sampling at
// the bars also makes the invariant hold by construction: a marker sits on a bar,
// so an active-bar marker always lands inside a band.

import type { RecurrenceMask } from "./backtestConfig";
import { isActive } from "./backtestSchedule";

/** The window a backtest traded over, plus the RESOLVED mask (resolveMask output,
 * no `session` field) when one was active. Persisted on the stored result. */
export interface BacktestPeriod {
  fromMs: number;
  toMs: number;
  mask?: RecurrenceMask;
}

/** One drawable shaded span (ms). Edges are loaded-bar timestamps. */
export interface PeriodBand {
  fromMs: number;
  toMs: number;
}

const DATE_OPTS: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** A human "1 May, 02:00 – 1 Jun 2026, 02:00" label for a traded window. Drops the
 * from-side year when both ends share it. Shared by the settings modal's range
 * preview and the Results status line. */
export function formatPeriodRange(fromMs: number, toMs: number): string {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const sameYear = from.getFullYear() === to.getFullYear();
  const fromLabel = from.toLocaleString([], { ...(sameYear ? { day: "numeric", month: "short" } : DATE_OPTS), ...TIME_OPTS });
  const toLabel = to.toLocaleString([], { ...DATE_OPTS, ...TIME_OPTS });
  return `${fromLabel} – ${toLabel}`;
}

/** Date-only variant of formatPeriodRange, e.g. "1 Jul – 14 Jul 2026" — for the
 * Results status line, where the daily-hours label carries the times separately. */
export function formatPeriodDateRange(fromMs: number, toMs: number): string {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const sameYear = from.getFullYear() === to.getFullYear();
  const fromLabel = from.toLocaleString([], sameYear ? { day: "numeric", month: "short" } : DATE_OPTS);
  const toLabel = to.toLocaleString([], DATE_OPTS);
  return `${fromLabel} – ${toLabel}`;
}

/** Bands to shade for `period` given the ascending loaded-bar timestamps
 * (`barTimes`, ms). No mask → one band, the window clamped to the loaded range.
 * Mask → maximal contiguous runs of active bars inside the window. Empty when
 * nothing is loaded, the window doesn't overlap the bars, or the mask keeps no
 * loaded bar active (no fallback to the whole window). Pure + exported for tests. */
export function computePeriodBands(period: BacktestPeriod, barTimes: number[]): PeriodBand[] {
  if (barTimes.length === 0) return [];
  const first = barTimes[0];
  const last = barTimes[barTimes.length - 1];
  const from = Math.max(period.fromMs, first);
  const to = Math.min(period.toMs, last);
  if (!(to > from)) return [];

  if (!period.mask) return [{ fromMs: from, toMs: to }];

  const bands: PeriodBand[] = [];
  let runStart: number | null = null;
  let runEnd = 0;
  for (const t of barTimes) {
    if (t < from || t > to) continue; // only bars inside the window
    if (isActive(period.mask, t)) {
      if (runStart === null) runStart = t;
      runEnd = t;
    } else if (runStart !== null) {
      bands.push({ fromMs: runStart, toMs: runEnd });
      runStart = null;
    }
  }
  if (runStart !== null) bands.push({ fromMs: runStart, toMs: runEnd });
  return bands;
}

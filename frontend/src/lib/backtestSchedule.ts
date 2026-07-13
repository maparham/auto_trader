// Mirror of the backend predicate (auto_trader/engine/schedule.py). Wire
// conventions MUST match: daysOfWeek = JS getDay 0=Sun..6=Sat, monthsOfYear
// 1=Jan..12=Dec, timeOfDay minutes-from-midnight in `tz`, half-open + wrap.
// tz evaluation uses Intl (no external deps). Keep pure — pass timestamps in.

import type { DayTimeWindow, RecurrenceMask, SessionPreset } from "./backtestConfig";

// `days` = the session's default trading weekdays (JS getDay 0=Sun..6=Sat),
// inlined by resolveMask when the user hasn't picked weekday chips, so an
// exchange preset excludes weekends automatically. `null` = every day (Crypto).
const WEEKDAYS = [1, 2, 3, 4, 5]; // Mon–Fri
export const SESSION_PRESETS: Record<
  SessionPreset,
  { label: string; window: DayTimeWindow | null; tz: string; days: number[] | null }
> = {
  NYSE: { label: "NYSE", window: { startMin: 9 * 60 + 30, endMin: 16 * 60 }, tz: "America/New_York", days: WEEKDAYS },
  London: { label: "London", window: { startMin: 8 * 60, endMin: 16 * 60 + 30 }, tz: "Europe/London", days: WEEKDAYS },
  Frankfurt: { label: "Frankfurt", window: { startMin: 9 * 60, endMin: 17 * 60 + 30 }, tz: "Europe/Berlin", days: WEEKDAYS },
  Tokyo: { label: "Tokyo", window: { startMin: 9 * 60, endMin: 15 * 60 }, tz: "Asia/Tokyo", days: WEEKDAYS },
  Sydney: { label: "Sydney", window: { startMin: 10 * 60, endMin: 16 * 60 }, tz: "Australia/Sydney", days: WEEKDAYS },
  Crypto: { label: "Crypto (24/7)", window: null, tz: "UTC", days: null },
};

/** Inline a session preset into timeOfDay+tz+daysOfWeek; drop `session`.
 * The preset's trading days fill in only when the user hasn't set explicit
 * weekday chips, so exchange sessions skip weekends without extra clicks while
 * an explicit chip selection still wins. Idempotent. */
export function resolveMask(m: RecurrenceMask): RecurrenceMask {
  if (!m.session) return m;
  const preset = SESSION_PRESETS[m.session];
  const { session: _session, ...rest } = m;
  return {
    ...rest,
    tz: preset.tz,
    timeOfDay: preset.window ?? undefined,
    daysOfWeek: rest.daysOfWeek?.length ? rest.daysOfWeek : preset.days ?? undefined,
  };
}

// Wall-clock fields of `tMs` in `tz`, via Intl (DST-correct).
function localParts(tMs: number, tz: string): { dow: number; month: number; day: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(tMs).map((p) => [p.type, p.value]));
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some engines emit "24" at midnight
  return {
    dow: DOW[parts.weekday],
    month: Number(parts.month),
    day: Number(parts.day),
    minute: hour * 60 + Number(parts.minute),
  };
}

// Milliseconds that `tz`'s wall clock is ahead of UTC at instant `atMs`
// (negative when behind). DST-correct via Intl. One-pass; only inaccurate
// within the ~1h of a DST transition, which never matters for a session label.
function tzOffsetMs(tz: string, atMs: number): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(atMs);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  let h = g("hour"); if (h === 24) h = 0;
  return Date.UTC(g("year"), g("month") - 1, g("day"), h, g("minute"), g("second")) - atMs;
}

// The UTC instants of a window's open/close, treating its startMin/endMin as
// wall-clock minutes-of-day in `tz` on the date of `nowMs` (DST-correct).
function windowUtcMs(window: DayTimeWindow, tz: string, nowMs: number): { startMs: number; endMs: number } {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(nowMs);
  const g = (t: string) => Number(ymd.find((x) => x.type === t)!.value);
  const Y = g("year"), M = g("month"), D = g("day");
  const toUtc = (min: number) => {
    const guess = Date.UTC(Y, M - 1, D, Math.floor(min / 60), min % 60);
    return guess - tzOffsetMs(tz, guess);
  };
  return { startMs: toUtc(window.startMin), endMs: toUtc(window.endMin) };
}

/** A session window (minutes-of-day in its home tz) rendered in the viewer's
 * local timezone for the date of `nowMs`, e.g. "14:30–21:00". DST-correct.
 * Returns null for a 24/7 (null-window) session. */
export function sessionLocalRange(window: DayTimeWindow | null, tz: string, nowMs: number): string | null {
  if (!window) return null;
  const { startMs, endMs } = windowUtcMs(window, tz, nowMs);
  const fmt = (utcMs: number) =>
    new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false }).format(utcMs);
  return `${fmt(startMs)}–${fmt(endMs)}`;
}

/** A session window (minutes-of-day in its home `sessionTz`) re-expressed as
 * minutes-of-day in `targetTz` for the date of `nowMs`, DST-correct. This is
 * how a session preset fills the From/To fields without changing the chosen
 * timezone. Returns null for a 24/7 (null-window) session. */
export function sessionWindowInTz(
  window: DayTimeWindow | null,
  sessionTz: string,
  targetTz: string,
  nowMs: number,
): DayTimeWindow | null {
  if (!window) return null;
  const { startMs, endMs } = windowUtcMs(window, sessionTz, nowMs);
  return {
    startMin: localParts(startMs, targetTz).minute,
    endMin: localParts(endMs, targetTz).minute,
  };
}

function inWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end; // overnight wrap
}

/** Mirror of backend is_active. Pass a RESOLVED mask (call resolveMask first). */
export function isActive(m: RecurrenceMask | undefined, tMs: number): boolean {
  if (!m || !m.enabled) return true;
  const tz = m.tz ?? "UTC";
  const { dow, month, day, minute } = localParts(tMs, tz);
  if (m.daysOfWeek?.length && !m.daysOfWeek.includes(dow)) return false;
  if (m.monthsOfYear?.length && !m.monthsOfYear.includes(month)) return false;
  if (m.daysOfMonth?.length && !m.daysOfMonth.includes(day)) return false;
  if (m.timeOfDay && !inWindow(minute, m.timeOfDay.startMin, m.timeOfDay.endMin)) return false;
  return true;
}

export type RangeChip = { label: string; fromMs: number; toMs: number };

// Whole-calendar-unit boundaries in `tz`. Built from the tz-local Y/M/D of
// `now` and Date.UTC arithmetic; adequate for chip ranges (bar membership is
// decided by isActive, not these bounds). Emits: chip 0 = the current (partial)
// unit up to now, then N whole prior units, most-recent first.
export function buildRangeChips(
  unit: "day" | "week" | "month" | "year",
  now: number,
  tz: string,
): RangeChip[] {
  const p = localParts(now, tz); // reuse dow for week alignment
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const get = (t: string) => Number(ymd.find((x) => x.type === t)!.value);
  const Y = get("year"), M = get("month"), D = get("day");
  const chips: RangeChip[] = [];

  if (unit === "year") {
    chips.push({ label: "YTD", fromMs: Date.UTC(Y, 0, 1), toMs: now });
    for (let i = 1; i <= 5; i++) chips.push({ label: `${Y - i}`, fromMs: Date.UTC(Y - i, 0, 1), toMs: Date.UTC(Y - i + 1, 0, 1) });
  } else if (unit === "month") {
    chips.push({ label: "This month", fromMs: Date.UTC(Y, M - 1, 1), toMs: now });
    for (let i = 1; i <= 12; i++) {
      const d = new Date(Date.UTC(Y, M - 1 - i, 1));
      const label = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).format(d);
      chips.push({ label, fromMs: d.getTime(), toMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) });
    }
  } else if (unit === "week") {
    // Week starts Monday. Days back to this week's Monday: (dow+6)%7.
    const mondayOffset = (p.dow + 6) % 7;
    const thisMon = Date.UTC(Y, M - 1, D - mondayOffset);
    chips.push({ label: "This week", fromMs: thisMon, toMs: now });
    for (let i = 1; i <= 8; i++) {
      const from = thisMon - i * 7 * 86400_000;
      chips.push({ label: i === 1 ? "Last week" : `${i} weeks ago`, fromMs: from, toMs: from + 7 * 86400_000 });
    }
  } else {
    const today = Date.UTC(Y, M - 1, D);
    chips.push({ label: "Today", fromMs: today, toMs: now });
    for (let i = 1; i <= 10; i++) {
      const from = today - i * 86400_000;
      const label = i === 1 ? "Yesterday" :
        new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(from));
      chips.push({ label, fromMs: from, toMs: from + 86400_000 });
    }
  }
  return chips;
}

export function coverage(bars: number[], mask: RecurrenceMask | undefined): { active: number; total: number } {
  let active = 0;
  for (const t of bars) if (isActive(mask, t)) active++;
  return { active, total: bars.length };
}

// Pure mapping from a TradingView-style range button to the interval to switch
// to and the visible window to fit. The left edge is anchored to the START of the
// calendar period (period-to-date), not a trailing window: "1M" means "from the
// 1st of this month", "YTD" means "from Jan 1", etc. Two keys have no natural
// calendar boundary and stay trailing: 5D (5 days back) and All (everything).
//
// All timestamps are milliseconds, computed on the UTC calendar (consistent with
// how candle timestamps are stored). `fromTs` may predate the loaded history; the
// caller pages history back to cover it, then fits [fromTs, toTs].

// Calendar period-to-date keys (left edge = start of the calendar period).
export type CalendarKey = "1D" | "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "All";
// Trailing-offset keys (left edge = exactly this far back from now).
export type TrailingKey = "-1D" | "-1W" | "-1M" | "-1Y";
export type RangeKey = CalendarKey | TrailingKey;

export const RANGE_KEYS: CalendarKey[] = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "All"];
export const TRAILING_KEYS: TrailingKey[] = ["-1D", "-1W", "-1M", "-1Y"];

// Short hover-tooltip text for each button.
export const RANGE_DESCRIPTIONS: Record<RangeKey, string> = {
  "1D": "From the start of today",
  "5D": "Last 5 days",
  "1M": "From the 1st of this month",
  "3M": "From the start of this quarter",
  "6M": "From the start of this half-year",
  YTD: "From January 1st",
  "1Y": "From January 1st last year",
  All: "All available history",
  "-1D": "This time 1 day ago",
  "-1W": "This time 1 week ago",
  "-1M": "This time 1 month ago",
  "-1Y": "This time 1 year ago",
};

export interface RangeWindow {
  resolution: string; // a feed.ts PERIODS resolution
  fromTs: number; // ms — left edge (period start)
  toTs: number; // ms — right edge (now)
}

const DAY = 86_400_000;

// Interval each key switches the chart to. Trailing offsets reuse the interval of
// the calendar span they most resemble (-1D≈1D, -1W≈5D, -1M≈1M, -1Y≈1Y).
const RESOLUTION: Record<RangeKey, string> = {
  "1D": "MINUTE",
  "5D": "MINUTE_5",
  "1M": "MINUTE_30",
  "3M": "HOUR",
  "6M": "HOUR_4",
  YTD: "DAY",
  "1Y": "DAY",
  All: "DAY",
  "-1D": "MINUTE",
  "-1W": "MINUTE_5",
  "-1M": "MINUTE_30",
  "-1Y": "DAY",
};

// Calendar boundaries must align to the CHART's timezone (the time axis is drawn
// in it), not UTC — otherwise "start of the month" lands at the UTC midnight,
// which can be hours off the local one. These helpers do tz-aware civil-time math.

// The wall-clock fields of `ms` as seen in `tz`.
function tzParts(tz: string, ms: number) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(ms)) p[part.type] = part.value;
  return {
    y: +p.year,
    mo: +p.month - 1, // 0-11
    d: +p.day,
    h: +p.hour % 24, // some locales emit "24" at midnight
    mi: +p.minute,
    s: +p.second,
  };
}

// UTC ms whose wall-clock time in `tz` is the given civil date/time. Refined once
// so it's correct across DST offset changes.
function zonedWallToUTC(tz: string, y: number, mo: number, d: number, h = 0, mi = 0): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const offset = (atMs: number) => {
    const p = tzParts(tz, atMs);
    return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - atMs;
  };
  let utc = guess - offset(guess);
  utc = guess - offset(utc); // refine for the DST edge
  return utc;
}

// Left edge (period start) in ms for a given key, "now", and the chart timezone.
function periodStart(key: RangeKey, nowMs: number, tz: string): number {
  const { y, mo, d, h, mi } = tzParts(tz, nowMs);
  switch (key) {
    case "1D":
      return zonedWallToUTC(tz, y, mo, d); // start of today (local midnight)
    case "5D":
      return nowMs - 5 * DAY; // trailing — no calendar boundary
    case "1M":
      return zonedWallToUTC(tz, y, mo, 1); // 1st of this month
    case "3M":
      return zonedWallToUTC(tz, y, Math.floor(mo / 3) * 3, 1); // start of this quarter
    case "6M":
      return zonedWallToUTC(tz, y, mo < 6 ? 0 : 6, 1); // start of this half-year
    case "YTD":
      return zonedWallToUTC(tz, y, 0, 1); // Jan 1 this year
    case "1Y":
      return zonedWallToUTC(tz, y - 1, 0, 1); // Jan 1 last year
    case "All":
      return 0; // everything (caller pages until exhausted)
    // Trailing offsets: exactly this far back from now.
    case "-1D":
      return nowMs - DAY;
    case "-1W":
      return nowMs - 7 * DAY;
    case "-1M":
      // Clamp the day so May 31 → Apr 30 (not May 1 via overflow).
      return zonedWallToUTC(tz, y, mo - 1, clampDay(y, mo - 1, d), h, mi);
    case "-1Y":
      return zonedWallToUTC(tz, y - 1, mo, clampDay(y - 1, mo, d), h, mi); // Feb 29 → Feb 28
  }
}

// Last valid day-of-month for (year, month), so a "same day last month/year"
// computation can't overflow into the next month.
function clampDay(y: number, mo: number, d: number): number {
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return Math.min(d, lastDay);
}

// `timeZone` is an IANA zone (the chart's display timezone). Pass "UTC" for
// UTC-aligned boundaries.
export function rangeWindow(key: RangeKey, nowMs: number, timeZone: string): RangeWindow {
  return { resolution: RESOLUTION[key], fromTs: periodStart(key, nowMs, timeZone), toTs: nowMs };
}

// The "go to date" calendar value (a "YYYY-MM-DD" string from <input type=date>)
// resolved to the start of that civil day in the CHART's timezone — the same
// tz-aware anchoring the range buttons use, so the calendar and the buttons agree
// on where a day starts (rather than UTC midnight, which is hours off elsewhere).
export function goToDateTs(dateStr: string, timeZone: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return zonedWallToUTC(timeZone, y, m - 1, d);
}

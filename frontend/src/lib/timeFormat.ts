// Time-axis timestamp formatting for the chart.
//
// klinecharts has no `styles.xAxis` date-format field; the only lever is
// `chart.setFormatter({ formatDate })`. The library calls formatDate with a
// small set of canonical format strings depending on zoom granularity:
//   XAxis:     'HH:mm' | 'MM-DD' | 'YYYY-MM' | 'YYYY' | 'YYYY-MM-DD HH:mm'
//   Crosshair: 'YYYY-MM-DD HH:mm'   (the label riding the time axis on hover)
//   Tooltip:   'YYYY-MM-DD HH:mm'   (OHLC tooltip)
// We re-render those buckets per the user's clock + date-format choice, applying
// to every type so the hover label stays consistent with the ticks.
//
// The library's tick-granularity boundary detection compares formatDate()
// outputs for equality (e.g. does this tick's year differ from the previous
// tick's), so this stays correct as long as output is a pure function of
// (timestamp, template) which it is. The default preset (24h + Y-M-D) is
// byte-for-byte identical to klinecharts' built-in formatter.

import type { FormatDateParams } from "klinecharts";

export type Clock = "24h" | "12h";
// ymd/dmy/mdy = numeric orders; med = textual "Jul 10 '26". An optional weekday
// prefix ("Fri …") is orthogonal — see makeFormatDate's showWeekday.
export type DateFormat = "ymd" | "dmy" | "mdy" | "med";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Parts {
  YYYY: string;
  MM: string;
  DD: string;
  HH: string;
  mm: string;
  ss: string;
}

// Mirrors klinecharts' built-in part extraction (incl. the hour '24' -> '00'
// quirk from Intl.DateTimeFormat with hour12:false).
function extract(dtf: Intl.DateTimeFormat, ts: number): Parts {
  const p: Parts = { YYYY: "", MM: "", DD: "", HH: "", mm: "", ss: "" };
  for (const { type, value } of dtf.formatToParts(new Date(ts))) {
    switch (type) {
      case "year":
        p.YYYY = value;
        break;
      case "month":
        p.MM = value;
        break;
      case "day":
        p.DD = value;
        break;
      case "hour":
        p.HH = value === "24" ? "00" : value;
        break;
      case "minute":
        p.mm = value;
        break;
      case "second":
        p.ss = value;
        break;
    }
  }
  return p;
}

// The calendar date Y/M/D name, as a UTC midnight. The parts are already in the
// axis timezone, so re-pinning them to UTC turns "the local calendar day" into a
// plain number: two such values differ by an exact multiple of 86.4e6 no matter
// what the zone did in between (DST, an offset change), which is what makes both
// callers below correct without any zone arithmetic of their own.
function localDateAsUtc(p: Parts): number {
  return Date.UTC(+p.YYYY, +p.MM - 1, +p.DD);
}

// Weekday abbreviation for the date Y/M/D resolve to.
function weekday(p: Parts): string {
  return WEEKDAYS[new Date(localDateAsUtc(p)).getUTCDay()];
}

function renderDate(p: Parts, fmt: string, format: DateFormat, showWeekday: boolean): string {
  const wantY = fmt.includes("YYYY");
  const wantM = fmt.includes("MM");
  const wantD = fmt.includes("DD");
  if (!wantY && !wantM && !wantD) return "";
  // Weekday only makes sense at day granularity (not month/year ticks). When on,
  // it prefixes every format the same way ("Fri 2026-07-10", "Fri Jul 10 '26").
  const wd = showWeekday && wantD ? `${weekday(p)} ` : "";
  if (format === "med") {
    // Textual order — by granularity bucket: day -> "Jul 10", month -> "Jul '26",
    // year -> "2026". Weekday prefix (when on) makes day -> "Fri Jul 10".
    const mon = MONTHS[+p.MM - 1] ?? p.MM;
    const yr = `'${p.YYYY.slice(-2)}`;
    if (wantD) {
      const day = `${mon} ${+p.DD}`;
      return wd + (wantY ? `${day} ${yr}` : day);
    }
    if (wantM) return `${mon} ${yr}`;
    return p.YYYY;
  }
  if (format === "ymd") {
    // Hyphen-joined ISO order — matches klinecharts' default exactly (weekday off).
    return wd + [wantY && p.YYYY, wantM && p.MM, wantD && p.DD].filter(Boolean).join("-");
  }
  const seq =
    format === "dmy"
      ? [wantD && p.DD, wantM && p.MM, wantY && p.YYYY]
      : [wantM && p.MM, wantD && p.DD, wantY && p.YYYY];
  return wd + seq.filter(Boolean).join("/");
}

function renderTime(p: Parts, fmt: string, clock: Clock): string {
  if (!fmt.includes("HH")) return "";
  const withSec = fmt.includes("ss");
  if (clock === "24h") {
    return withSec ? `${p.HH}:${p.mm}:${p.ss}` : `${p.HH}:${p.mm}`;
  }
  const h24 = parseInt(p.HH, 10);
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const base = withSec ? `${h12}:${p.mm}:${p.ss}` : `${h12}:${p.mm}`;
  return `${base} ${suffix}`;
}

// Builds a klinecharts FormatDate function for the chosen clock + date format.
// v10 hands the callback one params object; the old v9 positional args
// (dateTimeFormat, timestamp, template) are now named fields, and the format
// string field was renamed `format` -> `template`.
export function makeFormatDate(clock: Clock, format: DateFormat, showWeekday = false) {
  return ({ dateTimeFormat, timestamp, template }: FormatDateParams): string => {
    const p = extract(dateTimeFormat, timestamp);
    const date = renderDate(p, template, format, showWeekday);
    const time = renderTime(p, template, clock);
    return date && time ? `${date} ${time}` : date || time;
  };
}

// --- masked clock (chart replay, blind sessions) ------------------------------
//
// A replay session started by a random jump hides WHEN it is: the axis, the
// crosshair label and the OHLC tooltip all read "Day N HH:mm", relative to the
// jump point. Substituted for makeFormatDate on the replaying cell only, and
// swapped back on exit (the report card does the reveal).
//
// Every template klinecharts hands us that carries ANY date part collapses to
// "Day N" — including the coarse 'YYYY' and 'YYYY-MM' tick buckets, which would
// otherwise print the real year outright. Output stays a pure function of
// (timestamp, template), which is what the library's tick-granularity
// de-duplication relies on.

const MASK_DAY_MS = 86_400_000;

// One-shot masked label for chrome OUTSIDE the chart that renders a BAR
// timestamp — drawing coordinates, indicator anchors, the aggregate-marker
// popovers. Those live at app level (they can't see a cell's replay state) and
// each formats its own way, so rather than five ad-hoc maskings they all route
// a timestamp through here whenever `signals.maskedReplaySignal` is armed, and
// get back exactly what that cell's axis shows for the same bar: "Day N HH:mm".
//
// An invalid saved timezone makes the Intl constructor throw; degrade to the day
// part alone rather than taking the panel down (same guard the chart's own
// formatter effect uses). That branch has no Intl to resolve a calendar date
// through, so it falls back to elapsed 24h blocks from the anchor — off by one
// against the axis for part of each day when the session didn't start at local
// midnight, but blind, monotone, and only reachable from a corrupt saved
// timezone (in which case the chart's own axis is on the same fallback).
export function maskedTimeLabel(
  anchorMs: number,
  timestamp: number,
  clock: Clock,
  timeZone?: string,
): string {
  const fmt = makeMaskedFormatDate(anchorMs, clock);
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat("en", {
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: timeZone || undefined,
    });
  } catch {
    return `Day ${Math.floor((timestamp - anchorMs) / MASK_DAY_MS) + 1}`;
  }
  return fmt({
    dateTimeFormat: dtf,
    timestamp,
    template: "YYYY-MM-DD HH:mm",
    type: "crosshair",
  });
}

export function makeMaskedFormatDate(anchorMs: number, clock: Clock) {
  // Anchor's own calendar date, memoized on the dtf klinecharts hands us (one
  // instance per timezone/preference change, so this extracts once per session
  // rather than once per axis tick). Keying on identity rather than caching
  // unconditionally is what keeps the result a pure function of the inputs: a
  // different dtf (the user switches timezone mid-session) re-derives instead of
  // answering from a stale zone.
  let anchorDtf: Intl.DateTimeFormat | null = null;
  let anchorDate = 0;
  return ({ dateTimeFormat, timestamp, template }: FormatDateParams): string => {
    const p = extract(dateTimeFormat, timestamp);
    const time = renderTime(p, template, clock);
    const wantsDate = template.includes("YYYY") || template.includes("MM") || template.includes("DD");
    if (!wantsDate) return time;
    if (dateTimeFormat !== anchorDtf) {
      anchorDtf = dateTimeFormat;
      anchorDate = localDateAsUtc(extract(dateTimeFormat, anchorMs));
    }
    // Day 1 is the CALENDAR day the session started (in the display timezone),
    // Day 2 the next calendar day; context bars before the start count down
    // (Day 0, Day -1, ...). Counting elapsed 24h blocks from the jump INSTANT
    // instead would be self-consistent and leak nothing, but for any anchor that
    // isn't local midnight it makes the clock wrap inside a single label: a
    // 21:30 session runs one "Day" from 21:30 to 21:29, so the axis reads
    // "Day 0 21:30" then "Day 0 17:30" left to right and time appears to run
    // backwards. Both sides are the local calendar date re-pinned to UTC, so the
    // difference is a whole number of days even across a DST-shortened one.
    const day = Math.round((localDateAsUtc(p) - anchorDate) / MASK_DAY_MS) + 1;
    const label = `Day ${day}`;
    return time ? `${label} ${time}` : label;
  };
}

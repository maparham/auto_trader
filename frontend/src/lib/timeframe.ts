// Timeframe grammar: parse, canonicalize, size and label any candle resolution.
// Mirrors backend/auto_trader/core/timeframe.py; both are pinned by
// timeframes.corpus.json. A resolution is a native name (MINUTE, HOUR_4, DAY),
// a fixed seconds key (SECOND_5, live only), YEAR, or UNIT_N. Labels (7m, 6H,
// 2D, 3W, 4M, 1Y) and the D/W pin aliases parse too. Dependency-free on purpose:
// feed.ts and the expression catalog both import it.

export type TfUnit = "SECOND" | "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH" | "YEAR";
export type SizedUnit = "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH";

export class TimeframeError extends Error {}

const SECONDS_KEYS: Record<string, number> = {
  SECOND: 1, SECOND_5: 5, SECOND_10: 10, SECOND_15: 15, SECOND_30: 30, SECOND_45: 45,
};
const UNIT_SECONDS: Record<SizedUnit, number> = {
  MINUTE: 60, HOUR: 3600, DAY: 86400, WEEK: 604800, MONTH: 30 * 86400,
};
const YEAR_SECONDS = 365 * 86400;
export const TF_LIMITS: Record<SizedUnit, number> = {
  MINUTE: 1439, HOUR: 24, DAY: 365, WEEK: 52, MONTH: 12,
};
const UNIT_WORD: Record<SizedUnit, string> = {
  MINUTE: "minutes", HOUR: "hours", DAY: "days", WEEK: "weeks", MONTH: "months",
};
export const TF_UNIT_SUFFIX: Record<SizedUnit, "m" | "H" | "D" | "W" | "M"> = {
  MINUTE: "m", HOUR: "H", DAY: "D", WEEK: "W", MONTH: "M",
};
const SUFFIX_UNIT: Record<string, SizedUnit> = { m: "MINUTE", H: "HOUR", D: "DAY", W: "WEEK", M: "MONTH" };
const NATIVE = new Set(["MINUTE", "MINUTE_5", "MINUTE_15", "MINUTE_30", "HOUR", "HOUR_4", "DAY", "WEEK"]);

const CANON_RE = /^(MINUTE|HOUR|DAY|WEEK|MONTH)(?:_(\d{1,5}))?$/;
const LABEL_RE = /^(\d{1,5})([mHDWM])$/;

interface Tf { unit: TfUnit; n: number }

/** The grammar's out-of-range reason for a unit ("minutes must be between 1
 * and 1439"), shared with forms that range-check before parsing. */
export function tfRangeMessage(unit: SizedUnit): string {
  return `${UNIT_WORD[unit]} must be between 1 and ${TF_LIMITS[unit]}`;
}

function normalize(unit: SizedUnit, n: number): Tf {
  if (!(n >= 1 && n <= TF_LIMITS[unit])) {
    throw new TimeframeError(tfRangeMessage(unit));
  }
  if (unit === "MINUTE" && n % 60 === 0) return { unit: "HOUR", n: n / 60 };
  if (unit === "HOUR" && n === 24) return { unit: "DAY", n: 1 };
  if (unit === "MONTH" && n === 12) return { unit: "YEAR", n: 1 };
  return { unit, n };
}

export function parseTf(res: string): Tf {
  if (typeof res !== "string") throw new TimeframeError("timeframe must be a string");
  if (Object.hasOwn(SECONDS_KEYS, res)) return { unit: "SECOND", n: SECONDS_KEYS[res] };
  if (res === "YEAR" || res === "1Y") return { unit: "YEAR", n: 1 };
  if (res === "D") return { unit: "DAY", n: 1 };
  if (res === "W") return { unit: "WEEK", n: 1 };
  let m = CANON_RE.exec(res);
  if (m) return normalize(m[1] as SizedUnit, m[2] ? parseInt(m[2], 10) : 1);
  m = LABEL_RE.exec(res);
  if (m) return normalize(SUFFIX_UNIT[m[2]], parseInt(m[1], 10));
  throw new TimeframeError(
    `unknown timeframe '${res.slice(0, 40)}'. Use a number and a unit, like 7m, 6H, 2D, 3W or 2M`,
  );
}

function toStr(t: Tf): string {
  if (t.unit === "YEAR") return "YEAR";
  return t.n === 1 ? t.unit : `${t.unit}_${t.n}`;
}

export function canonicalTf(res: string): string {
  return toStr(parseTf(res));
}

export function tryCanonicalTf(res: string): string | null {
  try {
    return canonicalTf(res);
  } catch {
    return null;
  }
}

// Memoized: RESOLUTION_SECONDS (feed.ts) falls through to this on every miss,
// and those lookups sit in paint/overlay loops. The key space is tiny.
const SECONDS_MEMO = new Map<string, number | null>();

export function tfSecondsOf(res: string): number | null {
  const hit = SECONDS_MEMO.get(res);
  if (hit !== undefined) return hit;
  let out: number | null;
  try {
    const t = parseTf(res);
    out = t.unit === "SECOND" ? t.n
      : t.unit === "YEAR" ? YEAR_SECONDS
      : t.n * UNIT_SECONDS[t.unit as SizedUnit];
  } catch {
    out = null;
  }
  if (SECONDS_MEMO.size < 1024) SECONDS_MEMO.set(res, out);
  return out;
}

const DAY_MS = 86_400_000;

/** When a bar opening at `openMs` closes, for the bars whose width is NOT the
 *  nominal one: non-native minute/hour timeframes reset at 00:00 UTC, so the
 *  day's last bar ends at midnight (5H: the 20:00 bar is 4h). Month groups are
 *  January-anchored and end on the next group's first day (the year's last
 *  group is short and ends on Jan 1); YEAR ends on the next Jan 1. Mirrors the
 *  backend's candle_aggregate.bucket_end. Everything else returns
 *  `openMs + nominal`. null for an invalid timeframe. */
export function barEndMs(res: string, openMs: number): number | null {
  const secs = tfSecondsOf(res);
  if (secs == null) return null;
  const end = openMs + secs * 1000;
  let t: Tf;
  try {
    t = parseTf(res);
  } catch {
    return null;
  }
  if ((t.unit === "MINUTE" || t.unit === "HOUR") && !isNativeTf(res)) {
    const nextMidnight = openMs - (((openMs % DAY_MS) + DAY_MS) % DAY_MS) + DAY_MS;
    return Math.min(end, nextMidnight);
  }
  if (t.unit === "YEAR" || t.unit === "MONTH") {
    const d = new Date(openMs);
    const y = d.getUTCFullYear();
    if (t.unit === "YEAR") return Date.UTC(y + 1, 0, 1);
    const start = Math.floor(d.getUTCMonth() / t.n) * t.n;
    const next = Math.min(y * 12 + start + t.n, (y + 1) * 12);
    return Date.UTC(Math.floor(next / 12), next % 12, 1);
  }
  return end;
}

/** Open (ms) of the bucket containing `ts`, mirroring the backend's
 *  candle_aggregate.bucket_open for the grids the chart can compute alone:
 *  non-native minute/hour timeframes tile each UTC day from 00:00 (5H: 00, 05,
 *  10, 15, 20); month groups are January-anchored and YEAR opens on Jan 1.
 *  Everything else (natives, DAY_N, WEEK_N) keeps the fixed
 *  floor(ts / width) * width grid. null for an invalid timeframe. */
export function bucketOpenMs(res: string, ts: number): number | null {
  const secs = tfSecondsOf(res);
  if (secs == null || secs <= 0) return null;
  const t = parseTf(res);
  if ((t.unit === "MINUTE" || t.unit === "HOUR") && !isNativeTf(res)) {
    const span = secs * 1000;
    const day = ts - (((ts % DAY_MS) + DAY_MS) % DAY_MS);
    return day + Math.floor((ts - day) / span) * span;
  }
  if (t.unit === "YEAR" || t.unit === "MONTH") {
    const d = new Date(ts);
    if (t.unit === "YEAR") return Date.UTC(d.getUTCFullYear(), 0, 1);
    return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / t.n) * t.n, 1);
  }
  const width = secs * 1000;
  return Math.floor(ts / width) * width;
}

export function tfLabel(res: string): string {
  let t: Tf;
  try {
    t = parseTf(res);
  } catch {
    return res;
  }
  if (t.unit === "SECOND") return `${t.n}s`;
  if (t.unit === "YEAR") return "1Y";
  return `${t.n}${TF_UNIT_SUFFIX[t.unit as SizedUnit]}`;
}

export function isNativeTf(res: string): boolean {
  const c = tryCanonicalTf(res);
  return c != null && NATIVE.has(c);
}

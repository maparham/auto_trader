// Pure formatters for the market-info popover's curated sections.
//
// Everything timezone-dependent takes an explicit offsetMinutes (minutes EAST
// of UTC — pass `-new Date().getTimezoneOffset()` from the UI) so the functions
// stay deterministic under test regardless of the machine's zone.

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_MIN = 1440;
const WEEK_MIN = 7 * DAY_MIN;

export interface HoursRow {
  days: string; // "Mon – Thu" / "Fri"
  hours: string; // "00:00 – 23:00, 22:00 – 00:00" or "closed"
}

function hhmm(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Broker openingHours dict → local-time rows, consecutive identical days
 * grouped. The broker sends per-day windows in ITS zone (UTC for Capital);
 * shifting can push a window across midnight into the neighbor day, where it
 * fuses with that day's windows — exactly how Capital's own app renders it. */
export function localOpeningHours(
  oh: Record<string, unknown>,
  offsetMinutes: number,
): HoursRow[] {
  // 1. Parse to absolute week-minute intervals (Mon 00:00 = 0).
  const intervals: Array<[number, number]> = [];
  DAY_KEYS.forEach((k, day) => {
    const wins = Array.isArray(oh[k]) ? (oh[k] as unknown[]) : [];
    for (const w of wins) {
      if (typeof w !== "string") continue;
      const parts = w.split("-");
      if (parts.length !== 2) continue;
      const a = parseHHMM(parts[0]);
      const b = parseHHMM(parts[1]);
      if (a == null || b == null) continue;
      const start = day * DAY_MIN + a;
      const end = day * DAY_MIN + (b === 0 ? DAY_MIN : b); // "– 00:00" = end of day
      if (end > start) intervals.push([start, end]);
    }
  });
  if (!intervals.length) return [];

  // 2. Shift into local time; wrap around the week edges.
  const shifted: Array<[number, number]> = [];
  for (const [s0, e0] of intervals) {
    let s = s0 + offsetMinutes;
    let e = e0 + offsetMinutes;
    if (s < 0) {
      s += WEEK_MIN;
      e += WEEK_MIN;
    }
    if (e <= WEEK_MIN) shifted.push([s, e]);
    else {
      shifted.push([s, WEEK_MIN]);
      shifted.push([0, e - WEEK_MIN]);
    }
  }

  // 3. Merge overlapping/contiguous intervals (fuses cross-midnight chains).
  shifted.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of shifted) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }

  // 4. Split back into per-day window strings ("hh:mm – hh:mm", 24:00 → 00:00).
  const perDay: string[][] = DAY_KEYS.map(() => []);
  for (const [s, e] of merged) {
    for (let day = Math.floor(s / DAY_MIN); day * DAY_MIN < e && day < 7; day++) {
      const ds = Math.max(s, day * DAY_MIN) - day * DAY_MIN;
      const de = Math.min(e, (day + 1) * DAY_MIN) - day * DAY_MIN;
      if (de > ds) perDay[day].push(`${hhmm(ds)} – ${hhmm(de === DAY_MIN ? 0 : de)}`);
    }
  }

  // 5. Group consecutive days with identical window lists.
  const rows: HoursRow[] = [];
  let i = 0;
  while (i < 7) {
    let j = i;
    while (j + 1 < 7 && perDay[j + 1].join("|") === perDay[i].join("|")) j++;
    rows.push({
      days: i === j ? DAY_LABEL[i] : `${DAY_LABEL[i]} – ${DAY_LABEL[j]}`,
      hours: perDay[i].length ? perDay[i].join(", ") : "closed",
    });
    i = j + 1;
  }
  return rows;
}

/** Overnight-funding rate: the broker's value is already in percent
 * (-0.01096 → "-0.011%"). */
export function fundingText(rate: unknown): string | null {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
  return `${rate.toFixed(3)}%`;
}

/** Swap-charge timestamp (ms epoch) → local wall-clock "HH:MM". */
export function swapTimeText(tsMs: unknown, offsetMinutes: number): string | null {
  if (typeof tsMs !== "number" || !Number.isFinite(tsMs)) return null;
  const mins = ((Math.floor(tsMs / 60000) + offsetMinutes) % DAY_MIN + DAY_MIN) % DAY_MIN;
  return hhmm(mins);
}

/** Account leverage (Capital's per-asset-class preference, e.g. 10) → "10:1".
 * This is the EFFECTIVE leverage Capital's own app shows; the instrument's
 * marginFactor is a static base that ignores the account setting. */
export function accountLeverageText(leverage: unknown): string | null {
  if (typeof leverage !== "number" || !(leverage > 0)) return null;
  return `${leverage}:1`;
}

/** Margin derived from the account leverage: 10 → "10.00%", 20 → "5.00%". */
export function accountMarginText(leverage: unknown): string | null {
  if (typeof leverage !== "number" || !(leverage > 0)) return null;
  return `${(100 / leverage).toFixed(2)}%`;
}

/** marginFactor + unit → "10.00%" for PERCENTAGE, verbatim otherwise. */
export function marginText(factor: unknown, unit: unknown): string | null {
  if (typeof factor !== "number" || !Number.isFinite(factor)) return null;
  if (unit === "PERCENTAGE") return `${factor.toFixed(2)}%`;
  return unit == null || unit === "" ? String(factor) : `${factor} ${String(unit)}`;
}

/** Leverage derived from a percentage margin: 10% → "10:1". Whole numbers from
 * 10:1 up, one decimal below. Null for non-percentage units. */
export function leverageText(factor: unknown, unit: unknown): string | null {
  if (unit !== "PERCENTAGE" || typeof factor !== "number" || !(factor > 0)) return null;
  const ratio = 100 / factor;
  const txt = ratio >= 10 ? String(Math.round(ratio)) : String(Math.round(ratio * 10) / 10);
  return `${txt}:1`;
}

/** Spread = |offer − bid| rendered at the instrument's decimal places. */
export function spreadText(bid: unknown, offer: unknown, decimals: unknown): string | null {
  if (typeof bid !== "number" || typeof offer !== "number") return null;
  return Math.abs(offer - bid).toFixed(safeDecimals(decimals));
}

/** A price at the instrument's decimal places. */
export function priceText(v: unknown, decimals: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v.toFixed(safeDecimals(decimals));
}

/** Position of `price` inside [low, high] as 0–100 (clamped); null when the
 * range is missing or degenerate. */
export function rangePosition(low: unknown, high: unknown, price: unknown): number | null {
  if (typeof low !== "number" || typeof high !== "number" || typeof price !== "number") {
    return null;
  }
  if (!(high > low)) return null;
  return Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
}

function safeDecimals(d: unknown): number {
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 8 ? d : 2;
}

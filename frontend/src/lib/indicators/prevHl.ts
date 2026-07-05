// Previous-period High/Low (TradingView "Previous Day/Week/Month HL"):
// stepped horizontal lines at the high and low of the most recent COMPLETED
// day / week / month — plus an INTERVAL boundary keyed to the chart's own bar
// timeframe, so the indicator works on any TF (e.g. "previous N 1H bars"). A
// constant value across a period's bars renders as the flat line TV draws; the
// level steps to the new aggregate when a fresh period begins. Each boundary
// aggregates over the previous N periods via a selectable function (max/min by
// default, or avg/median).
import {
  IndicatorSeries,
  LineType,
  type Indicator,
  type IndicatorTemplate,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import { fullLine } from "./shared";

interface PrevHlPoint {
  rollingHigh?: number;
  rollingLow?: number;
  dayHigh?: number;
  dayLow?: number;
  weekHigh?: number;
  weekLow?: number;
  anchorHigh?: number;
  anchorLow?: number;
}

// How the previous N periods' highs (and lows) collapse into one level:
//  - "extreme": highest high / lowest low (the default, classic prev-period H/L)
//  - "avg":     mean of the highs / mean of the lows
//  - "median":  median of the highs / median of the lows (outlier-robust)
export type PrevHlAgg = "extreme" | "avg" | "median";

// Unit for the single ROLLING-range boundary. The nested time units (1 hr = 60 min,
// 24 hr = 1 day, …) all live on ONE rolling axis, so they're one control with a unit
// selector — "rolling 1 hour" ≡ "rolling 60 minutes". "bars" = the chart's own bars
// (absorbs the old Interval boundary: rolling, measured in bars).
export type PrevHlRollingUnit = "bars" | "minute" | "hour" | "day" | "week";

// Whether the rolling clock-span counts closed-market time (time units only):
//  - "trading":  skip gaps — the span is N units of TRADING time (= a fixed bar
//                count), so it reaches a full N units back even across a weekend/
//                overnight. Stable bar count regardless of gaps.
//  - "wallclock": consume gaps — the span is N units of REAL elapsed time, so near
//                a session open it reaches across the gap and catches fewer bars.
type PrevHlGapMode = "trading" | "wallclock";

export interface PrevHlExtend {
  hideLegendValue?: boolean;
  // Per-line show/hide (Style tab), keyed by figure key (rollingHigh/dayLow/…).
  // calc OMITS a hidden line's key so klinecharts draws nothing for it — this is
  // how the per-boundary rolling/day/week + High/Low toggles take effect.
  lineHidden?: Record<string, boolean>;
  // Per-instance timezone OVERRIDE (Inputs tab). An IANA zone name buckets this
  // instance's day/week boundaries in that zone regardless of the chart axis;
  // absent (or "chart") follows the global chart timezone (indicatorTz). The
  // rolling boundary doesn't use the calendar zone.
  tz?: string;
  // Lookback length per boundary (Inputs tab), keyed by kind. For day/week it's a
  // count of previous COMPLETED (skip-empty, anchored) periods; for rolling it's the
  // number of `rollingUnit`s in the sliding window. Absent or <1 → 1.
  lengths?: Partial<Record<PeriodKind, number>>;
  // Aggregation function per boundary (Inputs tab). Absent → "extreme".
  aggs?: Partial<Record<PeriodKind, PrevHlAgg>>;
  // Rolling-range unit + gap handling (Inputs tab). Defaults: hour, trading.
  rollingUnit?: PrevHlRollingUnit;
  gapMode?: PrevHlGapMode;
  // Anchored boundary: the cumulative High/Low since this anchor time (epoch ms).
  // 0/absent = unplaced (no line). Length/agg don't apply — it's max-high/min-low
  // from the anchor onward. The typed date-time is interpreted in the instance's tz.
  anchorTs?: number;
}

// The boundary kinds, paired with their high/low figure keys. Order = figure order
// in the template + the Style-tab rows. Two orthogonal concepts:
//  - "rolling": a sliding trailing window of `length` × `rollingUnit` (bars or a
//               time unit). The general lookback — never resets.
//  - "day"/"week": ANCHORED, skip-empty calendar periods — the previous trading day/
//               week, flat across the current period and stepping at its boundary.
//  - "anchor": the cumulative high/low since a user-picked date-time (extendData
//               .anchorTs). Like an Anchored VWAP but for high/low; no line before it.
export const PREV_HL_PERIODS: PrevHlBoundary[] = [
  { kind: "rolling", hi: "rollingHigh", lo: "rollingLow" },
  { kind: "day", hi: "dayHigh", lo: "dayLow" },
  { kind: "week", hi: "weekHigh", lo: "weekLow" },
  { kind: "anchor", hi: "anchorHigh", lo: "anchorLow" },
];

// Period boundaries are bucketed in the CHART'S timezone (the same IANA zone the
// time axis renders in — settings.timezone, or the browser zone when unset), so
// "previous day" steps exactly where the visible date label changes on the axis.
// ChartCore keeps this in sync via setIndicatorTimezone() whenever the user
// changes the timezone, and forces PREV_HL instances to recompute. Distinct keys
// are grouped in data order, so "previous day" is the prior day that actually HAS
// bars — weekends/holidays are skipped rather than leaving an empty calendar gap.
export type PeriodKind = "rolling" | "day" | "week" | "anchor";

// The resolved IANA zone (never "") used to bucket bars. Defaults to the browser
// zone so the indicator is correct even before ChartCore pushes the chart's zone.
let indicatorTz: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

// Cache one formatter per zone (constructing Intl.DateTimeFormat per bar is slow).
// Keyed by zone so a per-instance override and the global chart zone can coexist.
// Each yields wall-clock Y/M/D + weekday in its zone for any timestamp.
const tzFormatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = tzFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour12: false,
    });
    tzFormatters.set(zone, fmt);
  }
  return fmt;
}

// Resolve an override zone ("" / "chart" / undefined → the global chart zone) to a
// concrete IANA name. An invalid name falls back to the chart zone.
function resolvePrevHlZone(tz: string | undefined): string {
  if (!tz || tz === "chart") return indicatorTz;
  try {
    // Validate: an unknown timeZone throws here.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return indicatorTz;
  }
}

// The IANA zone's UTC offset (ms) at instant `ts`: format `ts` in the zone, read it
// back as if UTC, and take the difference. Used to convert a typed wall-clock anchor
// to/from epoch ms in the instance's zone.
function tzOffsetMs(zone: string, ts: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ts);
  const m: Record<string, string> = {};
  for (const x of parts) m[x.type] = x.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUTC - ts;
}

// Epoch ms → "YYYY-MM-DDTHH:mm" wall-clock in the instance's zone, for a datetime-
// local input. tz is the extendData.tz ("chart"/IANA/undefined). Empty when unplaced.
export function prevHlAnchorToInput(anchorTs: number, tz: string | undefined): string {
  if (!(anchorTs > 0)) return "";
  const zone = resolvePrevHlZone(tz);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(anchorTs);
  const m: Record<string, string> = {};
  for (const x of parts) m[x.type] = x.value;
  return `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}`;
}

// "YYYY-MM-DDTHH:mm" wall-clock (in the instance's zone) → epoch ms. Two offset
// passes settle DST transitions. Empty/invalid → 0 (unplaced).
export function prevHlInputToAnchor(input: string, tz: string | undefined): number {
  if (!input) return 0;
  const zone = resolvePrevHlZone(tz);
  const [d, t] = input.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = (t ?? "00:00").split(":").map(Number);
  if (!y || !mo || !da) return 0;
  let ts = Date.UTC(y, mo - 1, da, h || 0, mi || 0);
  for (let i = 0; i < 2; i++) ts = Date.UTC(y, mo - 1, da, h || 0, mi || 0) - tzOffsetMs(zone, ts);
  return ts;
}

// Set the zone PREV_HL buckets in (resolved IANA name; "" → browser zone). Called
// by ChartCore on timezone change. Returns true if the zone actually changed, so
// the caller only forces a recompute when needed.
export function setIndicatorTimezone(tz: string): boolean {
  let resolved = tz;
  if (!resolved) {
    try {
      resolved = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      resolved = "UTC";
    }
  }
  if (resolved === indicatorTz) return false;
  indicatorTz = resolved;
  return true;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

// Zone-local Y/M/D/weekday for a timestamp, via the cached formatter for `zone`.
function zonedParts(ts: number, zone: string): { y: number; m: number; d: number; wd: number } {
  const parts = zoneFormatter(zone).formatToParts(ts);
  let y = 0;
  let m = 0;
  let d = 0;
  let wd = 0;
  for (const p of parts) {
    if (p.type === "year") y = Number(p.value);
    else if (p.type === "month") m = Number(p.value);
    else if (p.type === "day") d = Number(p.value);
    else if (p.type === "weekday") wd = WEEKDAY_INDEX[p.value] ?? 0;
  }
  return { y, m, d, wd };
}

// Bucket key for the ANCHORED count-mode boundaries (day/week). The rolling boundary
// is a sliding window computed separately, so it never reaches here.
function periodKey(ts: number, kind: "day" | "week", zone: string): number {
  const { y, m, d, wd } = zonedParts(ts, zone);
  switch (kind) {
    case "day":
      // A unique ordinal for the zone-local calendar day (proleptic-ish): the
      // exact value is irrelevant, only that it's distinct per day and equal for
      // all bars of the same zone-local day.
      return y * 10000 + m * 100 + d;
    case "week": {
      // ISO week starting Monday: the Monday's UTC-epoch-day, derived from the
      // zone-local day-of-week. Using a fixed UTC anchor keeps the key stable and
      // comparable; we only need same-week bars to collapse to one key.
      const dayNum = Math.floor(Date.UTC(y, m - 1, d) / 86400000); // zone-local date as UTC ordinal
      return dayNum - wd; // back up to Monday (wd: Mon=0 … Sun=6)
    }
  }
}

// Collapse one side's values (the window's highs, or its lows) into a single level
// per the chosen function. `wantMax` only matters for "extreme": highs take the max
// (highest high), lows take the min (lowest low).
function aggregate(values: number[], fn: PrevHlAgg, wantMax: boolean): number {
  if (fn === "avg") {
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
  }
  if (fn === "median") {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  // "extreme": highest high (max) for the upper line, lowest low (min) for the lower.
  let acc = wantMax ? -Infinity : Infinity;
  for (const v of values) acc = wantMax ? Math.max(acc, v) : Math.min(acc, v);
  return acc;
}

// The typical bar spacing (ms), as the median positive timestamp delta — robust to
// occasional gaps. 0 when there's too little data to tell.
function estimateBarMs(dataList: KLineData[]): number {
  if (dataList.length < 2) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < dataList.length; i++) {
    const d = dataList[i].timestamp - dataList[i - 1].timestamp;
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return 0;
  deltas.sort((a, b) => a - b);
  return deltas[deltas.length >> 1];
}

type PrevHlBoundary = { kind: PeriodKind; hi: keyof PrevHlPoint; lo: keyof PrevHlPoint };

// ANCHORED count mode (day / week): the window is the last N COMPLETED calendar
// buckets that actually have data — empty buckets are skipped, so a Monday's
// "previous day" is Friday. The level is flat across the current period and steps as
// each bucket finishes (classic previous-day / previous-week high & low).
function computeBucketed(
  dataList: KLineData[],
  out: PrevHlPoint[],
  p: PrevHlBoundary,
  n: number,
  fn: PrevHlAgg,
  zone: string,
  hidden: Record<string, boolean>,
): void {
  const kind = p.kind as "day" | "week";
  const window: Array<{ hi: number; lo: number }> = [];
  let curKey: number | null = null;
  let curHi = -Infinity;
  let curLo = Infinity;
  let aggHi: number | undefined;
  let aggLo: number | undefined;
  for (let i = 0; i < dataList.length; i++) {
    const k = dataList[i];
    const key = periodKey(k.timestamp, kind, zone);
    if (curKey === null) {
      curKey = key;
    } else if (key !== curKey) {
      window.push({ hi: curHi, lo: curLo });
      if (window.length > n) window.shift();
      aggHi = window.length ? aggregate(window.map((w) => w.hi), fn, true) : undefined;
      aggLo = window.length ? aggregate(window.map((w) => w.lo), fn, false) : undefined;
      curKey = key;
      curHi = -Infinity;
      curLo = Infinity;
    }
    curHi = Math.max(curHi, k.high);
    curLo = Math.min(curLo, k.low);
    if (aggHi !== undefined && !hidden[p.hi]) out[i][p.hi] = aggHi;
    if (aggLo !== undefined && !hidden[p.lo]) out[i][p.lo] = aggLo;
  }
}

// Milliseconds per rolling time unit. "bars" has no fixed ms (it counts chart bars).
const ROLLING_UNIT_MS: Record<Exclude<PrevHlRollingUnit, "bars">, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

// ROLLING mode: a sliding trailing window over the bars BEFORE each bar. The window
// size is `length` × `unit`:
//  - unit "bars": exactly `length` previous chart bars (absorbs the old Interval).
//  - a time unit, "trading" gap mode: a FIXED bar count round(span / barMs) — skips
//    closed time, so the window always holds the same number of real bars
//    (1 hour ≡ 60 minutes ≡ 4 bars on a 15m chart).
//  - a time unit, "wallclock" gap mode: bars whose timestamp falls in [now − span,
//    now) — real elapsed time, so a market gap shrinks how many bars land in it.
function computeRolling(
  dataList: KLineData[],
  out: PrevHlPoint[],
  p: PrevHlBoundary,
  length: number,
  unit: PrevHlRollingUnit,
  gapMode: PrevHlGapMode,
  fn: PrevHlAgg,
  hidden: Record<string, boolean>,
  barMs: number,
): void {
  const isBars = unit === "bars";
  const spanMs = isBars ? 0 : length * ROLLING_UNIT_MS[unit];
  const useWallclock = !isBars && gapMode === "wallclock";
  // Bar-count window (bars unit, or a time span in trading mode).
  const barCount = isBars
    ? Math.max(1, Math.floor(length))
    : barMs > 0
      ? Math.max(1, Math.round(spanMs / barMs))
      : 1;
  let left = 0; // wallclock sliding-window left edge
  for (let i = 0; i < dataList.length; i++) {
    let start: number; // first bar of the window (inclusive); window is [start, i)
    if (useWallclock) {
      const cutoff = dataList[i].timestamp - spanMs;
      while (left < i && dataList[left].timestamp < cutoff) left++;
      start = left;
      if (start >= i) continue; // nothing in the trailing span
    } else {
      start = i - barCount;
      if (start < 0) continue; // not enough prior bars yet
    }
    const his: number[] = [];
    const los: number[] = [];
    for (let j = start; j < i; j++) {
      his.push(dataList[j].high);
      los.push(dataList[j].low);
    }
    if (!his.length) continue;
    if (!hidden[p.hi]) out[i][p.hi] = aggregate(his, fn, true);
    if (!hidden[p.lo]) out[i][p.lo] = aggregate(los, fn, false);
  }
}

// ANCHORED-since mode: the cumulative high/low from the anchor timestamp onward —
// max-high and min-low over every bar at/after the anchor (an Anchored-VWAP-style
// running extreme). No line before the anchor. Always max/min (length/agg N/A).
function computeAnchor(
  dataList: KLineData[],
  out: PrevHlPoint[],
  p: PrevHlBoundary,
  anchorTs: number,
  hidden: Record<string, boolean>,
): void {
  if (!(anchorTs > 0)) return; // unplaced → no line
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = 0; i < dataList.length; i++) {
    const k = dataList[i];
    if (k.timestamp < anchorTs) continue;
    hi = Math.max(hi, k.high);
    lo = Math.min(lo, k.low);
    if (!hidden[p.hi]) out[i][p.hi] = hi;
    if (!hidden[p.lo]) out[i][p.lo] = lo;
  }
}

function computePrevHl(dataList: KLineData[], ext: PrevHlExtend): PrevHlPoint[] {
  const hidden = ext.lineHidden ?? {};
  const zone = resolvePrevHlZone(ext.tz);
  const lengths = ext.lengths ?? {};
  const aggs = ext.aggs ?? {};
  const rollingUnit: PrevHlRollingUnit = ext.rollingUnit ?? "hour";
  const gapMode: PrevHlGapMode = ext.gapMode ?? "trading";
  const anchorTs = Number(ext.anchorTs) || 0;
  const out: PrevHlPoint[] = dataList.map(() => ({}));
  // Only compute boundaries that have at least one visible line.
  const active = PREV_HL_PERIODS.filter((p) => !hidden[p.hi] || !hidden[p.lo]);
  if (!active.length) return out;
  const barMs = estimateBarMs(dataList);

  for (const p of active) {
    const n = Math.max(1, Math.floor(lengths[p.kind] ?? 1));
    const fn: PrevHlAgg = aggs[p.kind] ?? "extreme";
    if (p.kind === "anchor") {
      computeAnchor(dataList, out, p, anchorTs, hidden);
    } else if (p.kind === "rolling") {
      // A time span shorter than one bar can't form a window (degenerate, e.g.
      // "10 minutes" on a 15m chart) → draw nothing. "bars" is never degenerate.
      if (rollingUnit !== "bars" && barMs > 0 && n * ROLLING_UNIT_MS[rollingUnit] < barMs) continue;
      computeRolling(dataList, out, p, n, rollingUnit, gapMode, fn, hidden, barMs);
    } else {
      // day/week are degenerate when one period is finer than a bar (e.g. "day" on a
      // weekly chart) → draw nothing.
      if (barMs > 0) {
        const unitMs = p.kind === "day" ? 86_400_000 : 604_800_000;
        if (n * unitMs < barMs) continue;
      }
      computeBucketed(dataList, out, p, n, fn, zone, hidden);
    }
  }
  return out;
}


// A millisecond span as a plain phrase, e.g. "1 week", "4 hours", "15 minutes" —
// used to tell the user the minimum lookback at the current timeframe.
function humanDuration(ms: number): string {
  const units: [number, string][] = [
    [604_800_000, "week"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [u, name] of units) {
    if (ms >= u && ms % u === 0) {
      const n = ms / u;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  for (const [u, name] of units) {
    if (ms >= u) {
      const n = Math.round(ms / u);
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  const n = Math.max(1, Math.round(ms / 60_000));
  return `${n} minute${n === 1 ? "" : "s"}`;
}

// Whether any ACTIVE boundary draws nothing at the current bar spacing (its window
// is shorter than one bar) — mirrors the `continue` (skip) conditions in
// computePrevHl. The minimum valid window is one bar, so `minDuration` is the bar's
// own duration as a phrase ("1 week" on a 1W chart). The legend uses this for its
// warning. degenerate=false when nothing is too short (or there's too little data).
export function prevHlDegenerateInfo(
  dataList: KLineData[],
  ext: PrevHlExtend,
): { degenerate: boolean; minDuration: string } {
  const barMs = estimateBarMs(dataList);
  if (!barMs) return { degenerate: false, minDuration: "" };
  const hidden = ext.lineHidden ?? {};
  const lengths = ext.lengths ?? {};
  const rollingUnit: PrevHlRollingUnit = ext.rollingUnit ?? "hour";
  let degenerate = false;
  for (const p of PREV_HL_PERIODS) {
    if (hidden[p.hi] && hidden[p.lo]) continue; // boundary fully off → not shown
    if (p.kind === "anchor") continue; // anchored window — never degenerate
    const n = Math.max(1, Math.floor(lengths[p.kind] ?? 1));
    let unitMs: number;
    if (p.kind === "rolling") {
      if (rollingUnit === "bars") continue; // bar-counted → never degenerate
      unitMs = ROLLING_UNIT_MS[rollingUnit];
    } else {
      unitMs = p.kind === "day" ? 86_400_000 : 604_800_000;
    }
    if (n * unitMs < barMs) {
      degenerate = true;
      break;
    }
  }
  return { degenerate, minDuration: humanDuration(barMs) };
}

// A compact summary of the ACTIVE boundaries' lookbacks, for the legend row — e.g.
// "12 hours, 1 day, since 2026-02-01 09:30". Skips hidden boundaries and an unplaced
// anchor. Empty when nothing is active.
export function prevHlLegendSummary(ext: PrevHlExtend): string {
  const hidden = ext.lineHidden ?? {};
  const lengths = ext.lengths ?? {};
  const rollingUnit: PrevHlRollingUnit = ext.rollingUnit ?? "hour";
  const on = (hi: string, lo: string) => !hidden[hi] || !hidden[lo];
  const count = (k: PeriodKind) => Math.max(1, Math.floor(lengths[k] ?? 1));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (on("rollingHigh", "rollingLow")) parts.push(plural(count("rolling"), rollingUnit));
  if (on("dayHigh", "dayLow")) parts.push(plural(count("day"), "day"));
  if (on("weekHigh", "weekLow")) parts.push(plural(count("week"), "week"));
  if (on("anchorHigh", "anchorLow")) {
    const ts = Number(ext.anchorTs) || 0;
    if (ts > 0) parts.push(`since ${prevHlAnchorToInput(ts, ext.tz).replace("T", " ")}`);
  }
  return parts.join(", ");
}

// One hue per boundary so minute/hour/day/week/interval read apart at a glance; the
// High and Low of a period share the hue (TradingView convention), distinguished by
// position. FULL SmoothLineStyle entries (the line drawer crashes on partials).
const PREV_HL_C_ROLLING = "#089981"; // green
const PREV_HL_C_DAY = "#2962ff"; // blue
const PREV_HL_C_WEEK = "#FF9600"; // orange
const PREV_HL_C_ANCHOR = "#E11D74"; // pink
const PREV_HL_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine(PREV_HL_C_ROLLING, LineType.Dashed), // rollingHigh
  fullLine(PREV_HL_C_ROLLING, LineType.Dashed), // rollingLow
  fullLine(PREV_HL_C_DAY, LineType.Dashed), // dayHigh
  fullLine(PREV_HL_C_DAY, LineType.Dashed), // dayLow
  fullLine(PREV_HL_C_WEEK, LineType.Dashed), // weekHigh
  fullLine(PREV_HL_C_WEEK, LineType.Dashed), // weekLow
  fullLine(PREV_HL_C_ANCHOR, LineType.Solid), // anchorHigh (solid: a fixed reference)
  fullLine(PREV_HL_C_ANCHOR, LineType.Solid), // anchorLow
];

// Previous Minute/Hour/Day/Week/Interval High/Low: ten stepped horizontal lines.
// Each boundary's High/Low pair toggles independently via the Style tab (extendData
// .lineHidden → calc omits the key). Figure titles are blank so the lines don't
// flood the legend value row (AVWAP-style); the Style tab labels them via a
// dedicated map (PREV_HL_LINE_LABELS in IndicatorSettings).
export const PREV_HL_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Prev HL",
  series: IndicatorSeries.Price,
  precision: 2,
  figures: [
    { key: "rollingHigh", type: "line" },
    { key: "rollingLow", type: "line" },
    { key: "dayHigh", type: "line" },
    { key: "dayLow", type: "line" },
    { key: "weekHigh", type: "line" },
    { key: "weekLow", type: "line" },
    { key: "anchorHigh", type: "line" },
    { key: "anchorLow", type: "line" },
  ],
  styles: { lines: PREV_HL_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computePrevHl(dataList, (ind.extendData ?? {}) as PrevHlExtend),
};

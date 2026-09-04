// Time Highlight: shade or recolor candles that fall inside user-defined
// windows — daily HH:MM time-of-day windows, or recurring anchor ranges
// projected onto every prior/later day/week/month/year — interpreted in the
// CHART's axis timezone (setIndicatorTimezone, as PREV_HL). Unlike the
// Sessions indicator (a compact sub-pane with per-session IANA zones), this
// overlays the MAIN candle pane — a translucent background band, a recolor of
// the in-window candles, or both. Figure-less: `calc` stores per-bar window
// membership on indicator.result and `draw` paints in pure pixel space
// (returning true so klinecharts skips its default figure loop). Membership
// math reuses sessions.ts's DST-safe `localTimeToUtc`.
import {
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
} from "klinecharts";
import { localTimeToUtc } from "./sessions";
import { getIndicatorTimezone } from "./prevHl";
import type { RecurrenceMask } from "../backtestConfig";
import { isActive, localParts, resolveMask, tzOffsetMs } from "../backtestSchedule";

export type TimeHighlightMode = "band" | "candles" | "both";

interface TimeWindowBase {
  id: string;
  color: string;
  mode: TimeHighlightMode;
  enabled: boolean;
}

// One time-of-day window, recurring daily. `to <= from` means the window
// crosses local midnight (e.g. a user-configured 22:00-06:00). Membership is
// DST-aware (resolved per bar against the indicator zone).
export interface DailyWindowDef extends TimeWindowBase {
  from: string; // "HH:MM" local
  to: string; // "HH:MM"; to <= from wraps past local midnight
}

export type RecurrencePeriod = "day" | "week" | "month" | "year";

// A concrete anchor range projected onto every prior/later period: the anchor's
// wall-clock calendar components shift by k days/weeks/months/years in the
// indicator zone (so 09:30 stays 09:30 across DST; month-end and Feb 29 clamp).
// [anchorStartMs, anchorEndMs) is half-open. The optional mask refines each
// occurrence with the backtest recurrence filters (weekdays, excluded dates,
// time of day), evaluated in the same zone.
export interface RecurringWindowDef extends TimeWindowBase {
  anchorStartMs: number;
  anchorEndMs: number;
  period: RecurrencePeriod;
  mask?: RecurrenceMask;
}

export type TimeWindowDef = DailyWindowDef | RecurringWindowDef;

export function isRecurringWindow(w: TimeWindowDef): w is RecurringWindowDef {
  return "anchorStartMs" in w;
}

export interface TimeHighlightExtend {
  windows?: TimeWindowDef[];
  hideLegendValue?: boolean;
}

// The zone highlights resolve in: the CHART's axis zone (kept in sync by
// ChartCore via setIndicatorTimezone, same as PREV_HL), so bands always agree
// with the axis date/time labels. Defaults to the browser zone before ChartCore
// pushes anything.
export function timeHighlightZone(): string {
  return getIndicatorTimezone();
}

// One soft-blue band across the local trading day, band mode.
export const DEFAULT_TIME_WINDOWS: TimeWindowDef[] = [
  { id: "w1", color: "#2962ff", from: "09:00", to: "17:00", mode: "band", enabled: true },
];

// Is `w` active at `ts` (device-local `zone`)? Normal window: [from, to).
// Crossing window (to <= from): active in the evening tail (>= from) OR the
// early-morning tail (< to), both resolved on ts's own local date — so a bar
// just after local midnight counts. Same rule as sessions' sessionActiveAt.
export function windowActiveAt(ts: number, w: DailyWindowDef, zone: string): boolean {
  if (!w.enabled) return false;
  const fromUtc = localTimeToUtc(ts, zone, w.from);
  const toUtc = localTimeToUtc(ts, zone, w.to);
  if (w.to <= w.from) return ts >= fromUtc || ts < toUtc;
  return ts >= fromUtc && ts < toUtc;
}

export interface TimeHighlightPoint {
  ids?: string[]; // active window ids at this bar (order follows the window list)
}

export interface Occurrence {
  startMs: number; // inclusive
  endMs: number; // exclusive
}

// Rough period lengths, only for estimating which k-range of occurrences can
// intersect a data range. Membership itself uses exact calendar arithmetic.
const APPROX_PERIOD_MS: Record<RecurrencePeriod, number> = {
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_800_000,
  year: 31_557_600_000,
};

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Shift an instant by k periods, calendar-wise in `zone`: decompose into
// wall-clock Y/M/D + minute-of-day, move the date, recompose via the
// guess-correct idiom. Wall-clock time is preserved across DST; month shifts
// clamp a month-end day to the target month's length (Jan 31 → Feb 28), year
// shifts clamp Feb 29 → Feb 28. Sub-minute ms carry over unchanged.
function shiftByPeriods(ms: number, period: RecurrencePeriod, k: number, zone: string): number {
  const p = localParts(ms, zone);
  let y = p.year;
  let mo = p.month;
  let d = p.day;
  if (period === "day") d += k;
  else if (period === "week") d += 7 * k;
  else if (period === "month") {
    const idx = mo - 1 + k;
    y += Math.floor(idx / 12);
    mo = ((idx % 12) + 12) % 12 + 1;
    d = Math.min(d, daysInMonth(y, mo));
  } else {
    y += k;
    d = Math.min(d, daysInMonth(y, mo));
  }
  const guess = Date.UTC(y, mo - 1, d, Math.floor(p.minute / 60), p.minute % 60);
  return guess - tzOffsetMs(zone, guess) + (ms % 60_000);
}

// All occurrences of `w`'s anchor range that intersect [rangeStartMs,
// rangeEndMs), ascending. k=0 is the anchor itself; negative k are prior
// periods. The scan range comes from the approximate period length with a
// ±2 safety margin, so DST/clamp jitter never drops an edge occurrence.
export function projectOccurrences(
  w: RecurringWindowDef,
  rangeStartMs: number,
  rangeEndMs: number,
  zone: string,
): Occurrence[] {
  if (!w.enabled || w.anchorEndMs <= w.anchorStartMs) return [];
  const approx = APPROX_PERIOD_MS[w.period];
  const kMin = Math.floor((rangeStartMs - w.anchorEndMs) / approx) - 2;
  const kMax = Math.ceil((rangeEndMs - w.anchorStartMs) / approx) + 2;
  const out: Occurrence[] = [];
  for (let k = kMin; k <= kMax; k++) {
    const startMs = shiftByPeriods(w.anchorStartMs, w.period, k, zone);
    const endMs = shiftByPeriods(w.anchorEndMs, w.period, k, zone);
    if (endMs > rangeStartMs && startMs < rangeEndMs) out.push({ startMs, endMs });
  }
  return out;
}

// Per-bar active-window ids, in configured order (so later windows paint over
// earlier ones deterministically).
export function computeTimeHighlight(
  dataList: KLineData[],
  ext: TimeHighlightExtend,
  zone: string,
): TimeHighlightPoint[] {
  const windows = ext.windows ?? DEFAULT_TIME_WINDOWS;
  if (!dataList.length) return [];
  const first = dataList[0].timestamp;
  const last = dataList[dataList.length - 1].timestamp;
  // Occurrence intervals + resolved masks per recurring window, computed once
  // for the loaded data range. Masks evaluate in the indicator zone regardless
  // of any stored mask tz, so bands always agree with the axis labels.
  const recurring = new Map<string, { occ: Occurrence[]; mask?: RecurrenceMask }>();
  for (const w of windows) {
    if (!isRecurringWindow(w)) continue;
    recurring.set(w.id, {
      occ: projectOccurrences(w, first, last + 1, zone),
      mask: w.mask ? { ...resolveMask(w.mask), tz: zone } : undefined,
    });
  }
  return dataList.map((k) => {
    const ids = windows
      .filter((w) => {
        if (!isRecurringWindow(w)) return windowActiveAt(k.timestamp, w, zone);
        const r = recurring.get(w.id)!;
        if (!r.occ.some((o) => k.timestamp >= o.startMs && k.timestamp < o.endMs)) return false;
        return isActive(r.mask, k.timestamp);
      })
      .map((w) => w.id);
    return ids.length ? { ids } : {};
  });
}

export interface WindowSegment {
  start: number; // first bar index (inclusive)
  end: number; // last bar index (inclusive)
}

// Collapse consecutive bars where `id` is active into one segment. Bars where it
// is inactive produce gaps.
export function buildWindowSegments(points: TimeHighlightPoint[], id: string): WindowSegment[] {
  const segs: WindowSegment[] = [];
  let cur: WindowSegment | null = null;
  for (let i = 0; i < points.length; i++) {
    const active = points[i].ids?.includes(id) ?? false;
    if (active) {
      if (cur) cur.end = i;
      else cur = { start: i, end: i };
    } else if (cur) {
      segs.push(cur);
      cur = null;
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

// A recurring window from the chart-drag gesture: whole dragged bars, half-open
// [firstBarOpen, lastBarOpen + barMs). endTs null = click without drag → the
// single clicked bar. Defaults to daily recurrence (the settings panel edits the
// period after placement); the mask starts enabled-empty so the calendar
// popover's weekday default never kicks in (see makeAddRecurringWindow).
export function buildRecurringWindowFromDrag(
  startTs: number,
  endTs: number | null,
  barMs: number,
): RecurringWindowDef {
  const lo = endTs == null ? startTs : Math.min(startTs, endTs);
  const hi = endTs == null ? startTs : Math.max(startTs, endTs);
  return {
    id: `w${Math.random().toString(36).slice(2, 8)}`,
    color: "#787b86",
    mode: "band",
    enabled: true,
    anchorStartMs: lo,
    anchorEndMs: hi + barMs,
    period: "day",
    mask: { enabled: true },
  };
}

// The window list with `win` appended, materializing the implied defaults first
// (an instance with no explicit windows shows DEFAULT_TIME_WINDOWS; appending
// must keep what the user sees rather than silently dropping it).
export function appendWindow(ext: TimeHighlightExtend, win: TimeWindowDef): TimeWindowDef[] {
  return [...(ext.windows ?? DEFAULT_TIME_WINDOWS), win];
}

// Alpha for the translucent background band (painted in front of the candles —
// klinecharts gives no below-candle hook — so keep it low).
const BAND_ALPHA = 0.12;

// Paint the highlight windows onto the candle pane. For each window (in list
// order, so later ones paint over earlier): band mode fills its in-window
// segments full pane height at low alpha; candles mode redraws each in-window
// bar's wick + body opaque in the window color, on top of the original candle.
// Both does band first, then candles. Pure pixel space; returns true (isCover)
// so klinecharts draws no default figures.
function drawTimeHighlight(params: IndicatorDrawParams<TimeHighlightPoint, unknown, unknown>): boolean {
  const { ctx, chart, indicator, xAxis, yAxis, bounding } = params;
  const barSpace = chart.getBarSpace();
  const kLineDataList = chart.getDataList();
  const ext = (indicator.extendData ?? {}) as TimeHighlightExtend;
  const windows = ext.windows ?? DEFAULT_TIME_WINDOWS;
  const points = indicator.result ?? [];
  const H = bounding.height;
  const halfBar = barSpace.halfBar;
  const bodyHalf = Math.max(0.5, barSpace.halfGapBar);
  ctx.save();
  for (const w of windows) {
    if (!w.enabled) continue;
    const wantBand = w.mode === "band" || w.mode === "both";
    const wantCandles = w.mode === "candles" || w.mode === "both";
    if (wantBand) {
      ctx.globalAlpha = BAND_ALPHA;
      ctx.fillStyle = w.color;
      for (const seg of buildWindowSegments(points, w.id)) {
        const left = xAxis.convertToPixel(seg.start) - halfBar;
        const right = xAxis.convertToPixel(seg.end) + halfBar;
        const width = right - left;
        if (width <= 0) continue;
        ctx.fillRect(left, 0, width, H);
      }
    }
    if (wantCandles) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = w.color;
      ctx.strokeStyle = w.color;
      ctx.lineWidth = 1;
      // Iterate the full result (off-screen bars draw off-canvas, harmlessly) —
      // same convention as the RSI/Sessions draws; avoids a visibleRange
      // inclusive/exclusive off-by-one dropping the newest in-window candle.
      for (let i = 0; i < points.length; i++) {
        if (!points[i].ids?.includes(w.id)) continue;
        const k = kLineDataList[i];
        if (!k) continue;
        const x = xAxis.convertToPixel(i);
        // Crisp 1px wick, high→low.
        const wickX = Math.round(x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(wickX, yAxis.convertToPixel(k.high));
        ctx.lineTo(wickX, yAxis.convertToPixel(k.low));
        ctx.stroke();
        // Body, open→close (min 1px tall so a doji stays visible).
        const openY = yAxis.convertToPixel(k.open);
        const closeY = yAxis.convertToPixel(k.close);
        const top = Math.min(openY, closeY);
        const bodyH = Math.max(1, Math.abs(closeY - openY));
        ctx.fillRect(x - bodyHalf, top, bodyHalf * 2, bodyH);
      }
    }
  }
  ctx.restore();
  return true;
}

// Figure-less candle-pane overlay. 'price' so it shares the candle
// price axis (yAxis.convertToPixel maps price→pixel in candles mode); no
// figures and no numeric result values, so it never perturbs the price
// auto-range. calc stores per-bar membership; draw paints the highlights.
export const TIME_HIGHLIGHT_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Time Highlight",
  series: 'price',
  precision: 0,
  figures: [],
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeTimeHighlight(dataList, (ind.extendData ?? {}) as TimeHighlightExtend, timeHighlightZone()),
  draw: (params) => drawTimeHighlight(params as IndicatorDrawParams<TimeHighlightPoint, unknown, unknown>),
};

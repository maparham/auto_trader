// Time-axis ticks that stay put while zooming.
//
// klinecharts' stock x-axis spaces labels every N bars, N = label width /
// bar space rounded to even, and anchors them at multiples of N. With smooth
// zoom N changes almost every frame, so every label hops to a different bar.
//
// Here a tick goes on the first bar of each calendar bucket (5 minutes, an
// hour, a day, a month, ...), so it is a property of the bar's timestamp, not
// of the zoom. The bucket size is the finest whose expected spacing clears
// MIN_TICK_PX; crossing that threshold halves or doubles the labels and leaves
// the rest where they were. Ticks that would still overlap (session gaps,
// weekends) are thinned by rank, so a day start beats an hour beside it.
//
// The label template follows the boundary the bar crosses: a year start reads
// 'YYYY', a month 'YYYY-MM', a day 'MM-DD', anything finer 'HH:mm'. Those are
// the buckets timeFormat.ts renders per the user's clock and date format.

import { registerXAxis, utils } from "klinecharts";

/** Expected px between neighbouring ticks before the next coarser step. */
export const MIN_TICK_PX = 80;
/** Clear space between two labels' text. */
const LABEL_GAP_PX = 12;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Step = { ms: number; kind: "fixed" | "week" | "month" };

// Fixed steps divide a day evenly, so buckets line up with the local clock.
const STEPS: Step[] = [
  ...[1, 2, 5, 10, 15, 30].map((m) => ({ ms: m * MIN, kind: "fixed" as const })),
  ...[1, 2, 3, 4, 6, 12].map((h) => ({ ms: h * HOUR, kind: "fixed" as const })),
  { ms: DAY, kind: "fixed" },
  { ms: 7 * DAY, kind: "week" },
  ...[1, 3, 6, 12, 24, 60, 120].map((m) => ({ ms: m * 30 * DAY, kind: "month" as const })),
];

// Boundary ranks: higher is coarser.
const R_STEP = 1;
const R_DAY = 2;
const R_MONTH = 3;
const R_YEAR = 4;

const PERIOD_MS: Record<string, number> = {
  second: 1000,
  minute: MIN,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
  year: 365 * DAY,
};

export function periodMs(period: { span: number; type: string } | null | undefined): number {
  return period ? period.span * (PERIOD_MS[period.type] ?? DAY) : DAY;
}

/** The finest step whose ticks land at least MIN_TICK_PX apart on average. */
export function pickStep(barSpace: number, barMs: number): Step {
  const pxPerMs = barSpace / barMs;
  // Never finer than a bar: a step below the period would tick every bar.
  return STEPS.find((s) => s.ms >= barMs && s.ms * pxPerMs >= MIN_TICK_PX) ?? STEPS[STEPS.length - 1];
}

// Which bucket of `step` a local (offset-shifted, UTC-read) time falls in.
function bucket(local: number, step: Step): number {
  if (step.kind === "fixed") return Math.floor(local / step.ms);
  if (step.kind === "week") return Math.floor((local / DAY + 3) / 7); // epoch day 0 is a Thursday
  const d = new Date(local);
  const months = Math.round(step.ms / (30 * DAY));
  return Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / months);
}

export interface TimeTickInput {
  from: number;
  to: number;
  barSpace: number;
  barMs: number;
  /** Bar timestamp (ms) at a data index, extrapolated past the ends. */
  tsAt(i: number): number | null;
  /** The display timezone's UTC offset (ms) at a timestamp. */
  offsetAt(ts: number): number;
  pxAt(i: number): number;
  format(ts: number, template: string): string;
  textWidth(text: string): number;
  /** Second-resolution charts read 'HH:mm:ss' below a day. */
  seconds?: boolean;
}

export interface TimeTick {
  coord: number;
  value: number;
  text: string;
}

export function buildTimeTicks(input: TimeTickInput): TimeTick[] {
  const { from, to, barSpace, barMs, tsAt, offsetAt, pxAt, format, textWidth } = input;
  const step = pickStep(barSpace, barMs);
  const cands: { i: number; ts: number; rank: number }[] = [];
  const start = Math.floor(from);
  const end = Math.ceil(to);
  const prev = tsAt(start - 1);
  let prevLocal = prev == null ? null : prev + offsetAt(prev);
  for (let i = start; i <= end; i++) {
    const ts = tsAt(i);
    if (ts == null) continue;
    const local = ts + offsetAt(ts);
    if (prevLocal != null) {
      const a = new Date(prevLocal);
      const b = new Date(local);
      let rank = 0;
      if (a.getUTCFullYear() !== b.getUTCFullYear()) rank = R_YEAR;
      else if (a.getUTCMonth() !== b.getUTCMonth()) rank = R_MONTH;
      else if (Math.floor(prevLocal / DAY) !== Math.floor(local / DAY)) rank = R_DAY;
      // A coarse boundary only counts when the step is coarse enough to want it:
      // at a 1-month step, a day start is not a tick.
      if (rank === R_DAY && step.ms > DAY && bucket(prevLocal, step) === bucket(local, step)) rank = 0;
      if (rank >= R_MONTH && step.kind === "month" && bucket(prevLocal, step) === bucket(local, step)) rank = 0;
      if (rank === 0 && bucket(prevLocal, step) !== bucket(local, step)) rank = R_STEP;
      if (rank > 0) cands.push({ i, ts, rank });
    }
    prevLocal = local;
  }

  const fine = input.seconds ? "HH:mm:ss" : "HH:mm";
  const placed: { x: number; w: number; tick: TimeTick }[] = [];
  // Coarsest first, then left to right: a day start keeps its slot over the
  // hour labels crowding it.
  const order = cands.map((_, k) => k).sort((a, b) => cands[b].rank - cands[a].rank || a - b);
  for (const k of order) {
    const c = cands[k];
    const template =
      c.rank === R_YEAR ? "YYYY" : c.rank === R_MONTH ? "YYYY-MM" : c.rank === R_DAY || barMs >= DAY ? "MM-DD" : fine;
    const text = format(c.ts, template);
    const x = pxAt(c.i);
    const w = textWidth(text);
    if (placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + LABEL_GAP_PX)) continue;
    placed.push({ x, w, tick: { coord: x, value: c.ts, text } });
  }
  return placed.sort((a, b) => a.x - b.x).map((p) => p.tick);
}

// --- klinecharts glue ---------------------------------------------------------

// Offsets change on (at finest) quarter-hour boundaries, so one Intl lookup per
// quarter hour serves every bar in it.
const QUARTER = 15 * MIN;
const offsetCache = new Map<string, number>();

function zoneOffset(dtf: Intl.DateTimeFormat, zone: string, ts: number): number {
  const key = `${zone}|${Math.floor(ts / QUARTER)}`;
  const hit = offsetCache.get(key);
  if (hit != null) return hit;
  const p: Record<string, number> = {};
  for (const { type, value } of dtf.formatToParts(new Date(ts))) p[type] = +value;
  const hour = p.hour === 24 ? 0 : p.hour;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
  const off = asUtc - Math.floor(ts / 1000) * 1000;
  if (offsetCache.size > 20_000) offsetCache.clear();
  offsetCache.set(key, off);
  return off;
}

const dtfs = new Map<string, Intl.DateTimeFormat>();
function partsFormat(zone: string): Intl.DateTimeFormat {
  let d = dtfs.get(zone);
  if (!d) {
    d = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    dtfs.set(zone, d);
  }
  return d;
}

// The internals klinecharts hands createTicks through `this` (the axis).
interface AxisThis {
  getParent(): { getChart(): { getChartStore(): ChartStoreLike } };
  convertToPixel(i: number): number;
}
interface ChartStoreLike {
  getBarSpace(): { bar: number };
  getPeriod(): { span: number; type: string } | null;
  getTimezone(): string;
  getStyles(): { xAxis: { tickText: { size: number; weight: string | number; family: string } } };
  getInnerFormatter(): { formatDate(ts: number, template: string, type: string): string };
  dataIndexToTimestamp(i: number): number | null;
}

registerXAxis({
  name: "normal",
  // A plain function: klinecharts calls it as a method of the axis.
  createTicks: function (this: AxisThis, { range }: { range: { realFrom: number; realTo: number } }) {
    const store = this.getParent().getChart().getChartStore();
    const period = store.getPeriod();
    const zone = store.getTimezone();
    const dtf = partsFormat(zone);
    const { size, weight, family } = store.getStyles().xAxis.tickText;
    const { formatDate } = store.getInnerFormatter();
    const widths = new Map<string, number>();
    return buildTimeTicks({
      from: range.realFrom,
      to: range.realTo,
      barSpace: store.getBarSpace().bar,
      barMs: periodMs(period),
      tsAt: (i) => store.dataIndexToTimestamp(i),
      offsetAt: (ts) => zoneOffset(dtf, zone, ts),
      pxAt: (i) => this.convertToPixel(i),
      format: (ts, template) => formatDate(ts, template, "xAxis"),
      textWidth: (s) => {
        let w = widths.get(s);
        if (w == null) widths.set(s, (w = utils.calcTextWidth(s, size, weight as never, family)));
        return w;
      },
      seconds: period?.type === "second",
    });
  } as never,
});

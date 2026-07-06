// Trading Sessions: a compact single-row sub-pane that shades the FX trading
// sessions (Sydney / Tokyo / London / New York by default) across the time axis.
// Overlapping sessions split the row into stripes (dynamic split). Figure-less —
// `calc` stores per-bar membership on indicator.result and `draw` paints the bands
// in pure pixel space (returning true so klinecharts skips its default figure loop).
// Sessions are DST-aware (each carries its own IANA timezone) and fully editable
// via extendData.sessions (indicator settings modal).
import {
  IndicatorSeries,
  registerYAxis,
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
} from "klinecharts";

// One trading session: business hours are LOCAL exchange time in `timezone`
// (IANA). `close <= open` means the window crosses local midnight (e.g. a
// user-configured 22:00-06:00). Membership is DST-aware (resolved per bar).
export interface SessionDef {
  id: string;
  name: string;
  color: string;
  timezone: string;
  open: string; // "HH:MM"
  close: string; // "HH:MM"
  enabled: boolean;
}

export interface SessionsExtend {
  sessions?: SessionDef[];
  hideLegendValue?: boolean;
}

// FX big 4, local business hours (none cross local midnight). Distinct hues per
// session; they read well in both light and dark themes.
export const DEFAULT_SESSIONS: SessionDef[] = [
  { id: "sydney", name: "Sydney", color: "#7e57c2", timezone: "Australia/Sydney", open: "07:00", close: "16:00", enabled: true },
  { id: "tokyo", name: "Tokyo", color: "#16a394", timezone: "Asia/Tokyo", open: "09:00", close: "18:00", enabled: true },
  { id: "london", name: "London", color: "#2962ff", timezone: "Europe/London", open: "08:00", close: "16:00", enabled: true },
  { id: "newyork", name: "New York", color: "#f59300", timezone: "America/New_York", open: "08:00", close: "17:00", enabled: true },
];

// Cache one offset formatter per zone. Constructing Intl.DateTimeFormat is expensive
// (~ms); this runs per bar per session, so a fresh construct each call would freeze
// the main thread on a full chart (unlike prevHl's tzOffsetMs, which runs once).
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
function offsetFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = offsetFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(zone, fmt);
  }
  return fmt;
}

// The IANA zone's UTC offset (ms) at instant `ts`: format `ts` in the zone, read it
// back as if it were UTC, and take the difference. Mirrors prevHl.ts's tzOffsetMs.
function tzOffsetMs(zone: string, ts: number): number {
  const parts = offsetFormatter(zone).formatToParts(ts);
  const m: Record<string, string> = {};
  for (const x of parts) m[x.type] = x.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUTC - ts;
}

// Cache one Y/M/D formatter per zone (constructing Intl per bar is slow).
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function zoneDate(ts: number, zone: string): { y: number; mo: number; d: number } {
  let fmt = dateFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour12: false,
    });
    dateFormatters.set(zone, fmt);
  }
  const m: Record<string, string> = {};
  for (const x of fmt.formatToParts(ts)) m[x.type] = x.value;
  return { y: +m.year, mo: +m.month, d: +m.day };
}

// The UTC instant of local `hhmm` on the zone-local date of `ts`. Two offset passes
// settle DST transitions (same technique as prevHlInputToAnchor). Memoized per
// (zone, local date, hhmm): every bar of a day shares the same result, collapsing
// thousands of per-bar computations to a handful per chart.
const localUtcMemo = new Map<string, number>();
export function localTimeToUtc(ts: number, zone: string, hhmm: string): number {
  const { y, mo, d } = zoneDate(ts, zone);
  const key = `${zone}|${y}-${mo}-${d}|${hhmm}`;
  const cached = localUtcMemo.get(key);
  if (cached !== undefined) return cached;
  const [h, mi] = hhmm.split(":").map(Number);
  let out = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
  for (let i = 0; i < 2; i++) out = Date.UTC(y, mo - 1, d, h || 0, mi || 0) - tzOffsetMs(zone, out);
  localUtcMemo.set(key, out);
  return out;
}

// Is `s` active at `ts`? Normal window: [open, close). Crossing window (close <=
// open): active in the evening tail (>= open) OR the early-morning tail (< close),
// both computed on ts's own local date — so a bar just after local midnight counts.
export function sessionActiveAt(ts: number, s: SessionDef): boolean {
  if (!s.enabled) return false;
  const openUtc = localTimeToUtc(ts, s.timezone, s.open);
  const closeUtc = localTimeToUtc(ts, s.timezone, s.close);
  if (s.close <= s.open) return ts >= openUtc || ts < closeUtc;
  return ts >= openUtc && ts < closeUtc;
}

export interface SessionPoint {
  ids?: string[]; // active session ids at this bar (order follows the session list)
}

// Per-bar active-session ids, in the configured session order (so stripe order in
// the draw is deterministic).
export function computeSessions(dataList: KLineData[], ext: SessionsExtend): SessionPoint[] {
  const sessions = ext.sessions ?? DEFAULT_SESSIONS;
  return dataList.map((k) => {
    const ids = sessions.filter((s) => sessionActiveAt(k.timestamp, s)).map((s) => s.id);
    return ids.length ? { ids } : {};
  });
}

export interface SessionSegment {
  start: number; // first bar index (inclusive)
  end: number; // last bar index (inclusive)
  ids: string[];
}

// Collapse consecutive bars with the SAME active-id set into one segment. Bars with
// no active session produce no segment (gaps).
export function buildSegments(points: SessionPoint[]): SessionSegment[] {
  const segs: SessionSegment[] = [];
  const keyOf = (ids?: string[]) => (ids && ids.length ? ids.join("|") : "");
  let cur: SessionSegment | null = null;
  let curKey = "";
  for (let i = 0; i < points.length; i++) {
    const ids = points[i].ids;
    const key = keyOf(ids);
    if (key && key === curKey && cur) {
      cur.end = i;
    } else {
      if (cur) segs.push(cur);
      cur = key ? { start: i, end: i, ids: ids as string[] } : null;
      curKey = key;
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

// A registered y-axis that draws NO ticks — assigned to the Sessions pane via
// paneOptions.axisOptions.name so the pane shows no numeric scale (the bands carry
// no meaningful value). klinecharts styles are global, so a named custom axis is the
// only per-pane way to suppress the ticks.
export const SESSIONS_AXIS_NAME = "sessions";
export function registerSessionsAxis(): void {
  registerYAxis({ name: SESSIONS_AXIS_NAME, createTicks: () => [] });
}

// Half a bar's pixel width, from two adjacent x conversions (robust to zoom).
function halfBarPx(xAxis: { convertToPixel: (v: number) => number }): number {
  return Math.abs(xAxis.convertToPixel(1) - xAxis.convertToPixel(0)) / 2;
}

// Paint the session bands. Solo spans fill the full pane height with the session's
// color + centered name; overlap spans split the height evenly into one stripe per
// active session (no label). Pure pixel space (bounding), so the pane's y-range is
// irrelevant. Returns true (isCover) so klinecharts draws no default figures.
function drawSessions(params: IndicatorDrawParams<SessionPoint>): boolean {
  const { ctx, indicator, xAxis, bounding } = params;
  const ext = (indicator.extendData ?? {}) as SessionsExtend;
  const sessions = ext.sessions ?? DEFAULT_SESSIONS;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const segs = buildSegments(indicator.result ?? []);
  const half = halfBarPx(xAxis) || 0;
  const H = bounding.height;
  ctx.save();
  ctx.font = "11px Helvetica Neue, Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const seg of segs) {
    const left = xAxis.convertToPixel(seg.start) - half;
    const right = xAxis.convertToPixel(seg.end) + half;
    const w = right - left;
    if (w <= 0) continue;
    const active = seg.ids.map((id) => byId.get(id)).filter(Boolean) as SessionDef[];
    const k = active.length;
    if (!k) continue;
    const stripeH = H / k;
    active.forEach((s, i) => {
      ctx.fillStyle = s.color;
      ctx.fillRect(left, i * stripeH, w, stripeH);
    });
    // Centered name only for a solo span wide enough to fit the text.
    if (k === 1) {
      const name = active[0].name;
      if (w >= ctx.measureText(name).width + 10) {
        ctx.fillStyle = "#ffffff";
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,.25)";
        ctx.shadowBlur = 1;
        ctx.shadowOffsetY = 1;
        ctx.fillText(name, (left + right) / 2, H / 2);
        ctx.restore();
      }
    }
  }
  ctx.restore();
  return true;
}

// Compact single-row session-shading sub-pane. Figure-less: calc stores per-bar
// membership on indicator.result and draw paints the bands. minValue/maxValue pin a
// dummy 0..1 range so the (hidden) y-axis never auto-ranges to NaN.
export const SESSIONS_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Sessions",
  series: IndicatorSeries.Normal,
  precision: 0,
  minValue: 0,
  maxValue: 1,
  figures: [],
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeSessions(dataList, (ind.extendData ?? {}) as SessionsExtend),
  draw: (params) => drawSessions(params as IndicatorDrawParams<SessionPoint>),
};

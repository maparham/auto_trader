// Time Highlight: shade or recolor candles that fall inside user-defined
// time-of-day windows, interpreted in the DEVICE's local timezone. Unlike the
// Sessions indicator (a compact sub-pane with per-session IANA zones), this
// overlays the MAIN candle pane — a translucent background band, a recolor of
// the in-window candles, or both. Figure-less: `calc` stores per-bar window
// membership on indicator.result and `draw` paints in pure pixel space
// (returning true so klinecharts skips its default figure loop). Membership
// math reuses sessions.ts's DST-safe `localTimeToUtc`.
import {
  IndicatorSeries,
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
} from "klinecharts";
import { localTimeToUtc } from "./sessions";

export type TimeHighlightMode = "band" | "candles" | "both";

// One time-of-day window in DEVICE-local time. `to <= from` means the window
// crosses local midnight (e.g. a user-configured 22:00-06:00). Membership is
// DST-aware (resolved per bar against the device zone).
export interface TimeWindowDef {
  id: string;
  color: string;
  from: string; // "HH:MM" device-local
  to: string; // "HH:MM"; to <= from wraps past local midnight
  mode: TimeHighlightMode;
  enabled: boolean;
}

export interface TimeHighlightExtend {
  windows?: TimeWindowDef[];
  hideLegendValue?: boolean;
}

// The device's current IANA timezone. Read per calc so highlights shift if the
// OS zone changes (accepted, per the design). Falls back to UTC if unavailable.
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// One soft-blue band across the local trading day, band mode.
export const DEFAULT_TIME_WINDOWS: TimeWindowDef[] = [
  { id: "w1", color: "#2962ff", from: "09:00", to: "17:00", mode: "band", enabled: true },
];

// Is `w` active at `ts` (device-local `zone`)? Normal window: [from, to).
// Crossing window (to <= from): active in the evening tail (>= from) OR the
// early-morning tail (< to), both resolved on ts's own local date — so a bar
// just after local midnight counts. Same rule as sessions' sessionActiveAt.
export function windowActiveAt(ts: number, w: TimeWindowDef, zone: string): boolean {
  if (!w.enabled) return false;
  const fromUtc = localTimeToUtc(ts, zone, w.from);
  const toUtc = localTimeToUtc(ts, zone, w.to);
  if (w.to <= w.from) return ts >= fromUtc || ts < toUtc;
  return ts >= fromUtc && ts < toUtc;
}

export interface TimeHighlightPoint {
  ids?: string[]; // active window ids at this bar (order follows the window list)
}

// Per-bar active-window ids, in configured order (so later windows paint over
// earlier ones deterministically).
export function computeTimeHighlight(
  dataList: KLineData[],
  ext: TimeHighlightExtend,
  zone: string,
): TimeHighlightPoint[] {
  const windows = ext.windows ?? DEFAULT_TIME_WINDOWS;
  return dataList.map((k) => {
    const ids = windows.filter((w) => windowActiveAt(k.timestamp, w, zone)).map((w) => w.id);
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

// Alpha for the translucent background band (painted in front of the candles —
// klinecharts gives no below-candle hook — so keep it low).
const BAND_ALPHA = 0.12;

// Paint the highlight windows onto the candle pane. For each window (in list
// order, so later ones paint over earlier): band mode fills its in-window
// segments full pane height at low alpha; candles mode redraws each in-window
// bar's wick + body opaque in the window color, on top of the original candle.
// Both does band first, then candles. Pure pixel space; returns true (isCover)
// so klinecharts draws no default figures.
function drawTimeHighlight(params: IndicatorDrawParams<TimeHighlightPoint>): boolean {
  const { ctx, indicator, xAxis, yAxis, bounding, barSpace, kLineDataList } = params;
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

// Figure-less candle-pane overlay. IndicatorSeries.Price so it shares the candle
// price axis (yAxis.convertToPixel maps price→pixel in candles mode); no
// figures and no numeric result values, so it never perturbs the price
// auto-range. calc stores per-bar membership; draw paints the highlights.
export const TIME_HIGHLIGHT_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Time Highlight",
  series: IndicatorSeries.Price,
  precision: 0,
  figures: [],
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeTimeHighlight(dataList, (ind.extendData ?? {}) as TimeHighlightExtend, deviceTimeZone()),
  draw: (params) => drawTimeHighlight(params as IndicatorDrawParams<TimeHighlightPoint>),
};

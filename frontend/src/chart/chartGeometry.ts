// Pure geometry + hit-test helpers extracted from ChartCore. No React, no shared
// state — each function takes its inputs explicitly. Split out so the click/hover
// hit-test and the selection painters can share the same pixel-resolved line cache
// without either re-running convertToPixel.
import { type Chart, type Indicator } from "klinecharts";
import { indTypeOf } from "../lib/customIndicators";

// How close (px) a click/cursor must be to a curve to select/hover it.
export const HIT_TOLERANCE_PX = 6;
// How close (px) the cursor must come to a trade/alert line for the price guide (the
// "+" affordance + its price) to MAGNET onto that line's exact level, AND the single
// band a press must fall within to GRAB that line. Grab-band == cursor-band: the
// ns-resize cursor that signals "draggable" shows within this same distance (see the
// snapTarget logic in onMove), so a line grabs exactly where its cursor appeared —
// no dead zone where the line drags but no cursor warned you, or vice-versa.
export const ALERT_SNAP_PX = 5;
export const DOT_RADIUS = 3.5; // selection marker radius

// AVWAP anchor drag handle: a larger solid grab handle painted at the anchor bar
// when AVWAP is selected, draggable left/right to re-anchor (TradingView-style).
export const ANCHOR_HANDLE_R = 6; // drawn radius

// A selectable indicator line resolved to pixel coordinates for the current
// view. One entry per `type:"line"` figure — an indicator can plot several
// (e.g. MACD's DIF/DEA). Each point keeps its bar timestamp `t` so the dot
// painter can anchor markers to bars. Rebuilt each redraw and read by BOTH the
// painter and the click/hover hit-test, so neither re-runs convertToPixel.
export interface LineCache {
  paneId: string;
  name: string;
  // The figure key of this specific line (e.g. "dayHigh") and the indicator's
  // type — together they resolve the curve's key-parameter tag for the end label.
  figKey: string;
  indType: string;
  extendData: unknown; // carries per-curve label text + config (curveLabels)
  calcParams?: unknown[]; // lengths/multipliers, for name+params curve labels
  color: string;
  coords: Array<{ x: number; y: number; t: number }>;
}

// Distance from point (px,py) to the segment (ax,ay)-(bx,by).
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Resolve every visible indicator line across ALL panes to pixel coordinates.
// Skips hidden indicators, non-line figures (bars/histograms — TV puts handles
// on plotted lines, not on the MACD histogram), and warmup/unplaced gaps (null
// result values; our indicators have no mid-series holes so adjacent valid
// points never bridge a real gap). Coordinates are container-absolute
// (convertToPixel absolute:true adds each pane's top offset), so a single
// full-height overlay canvas aligns sub-pane dots (RSI/MACD) too.
export function buildLineCache(chart: Chart): LineCache[] {
  const panes = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  if (!panes) return [];
  const dl = chart.getDataList();
  const vr = chart.getVisibleRange();
  const lineStyles = chart.getStyles().indicator.lines;
  const out: LineCache[] = [];
  for (const [paneId, inds] of panes) {
    for (const [name, ind] of inds) {
      if (ind.visible === false) continue;
      const result = ind.result as Array<Record<string, number | undefined>>;
      const indType = indTypeOf(ind);
      let lineIdx = 0;
      for (const fig of ind.figures) {
        if (fig.type !== "line") continue;
        const styleIdx = lineIdx++;
        const pts: Array<{ timestamp: number; value: number }> = [];
        for (let i = vr.from; i < vr.to; i++) {
          const v = result[i]?.[fig.key];
          const k = dl[i];
          if (k && typeof v === "number" && Number.isFinite(v)) {
            pts.push({ timestamp: k.timestamp, value: v });
          }
        }
        if (pts.length < 2) continue;
        const px = chart.convertToPixel(pts, { paneId, absolute: true }) as Array<{
          x: number;
          y: number;
        }>;
        const coords = px.map((c, k) => ({ x: c.x, y: c.y, t: pts[k].timestamp }));
        const color =
          ind.styles?.lines?.[styleIdx]?.color ??
          lineStyles[styleIdx % lineStyles.length]?.color ??
          "#FF9600";
        out.push({
          paneId,
          name,
          figKey: fig.key,
          indType,
          extendData: ind.extendData,
          calcParams: ind.calcParams,
          color,
          coords,
        });
      }
    }
  }
  return out;
}

// Nearest cached line within HIT_TOLERANCE_PX of (px,py), as pane+name — so a
// curve click/hover identifies its indicator (sub-pane indicators included).
export function hitTestCache(
  cache: LineCache[],
  px: number,
  py: number,
): { paneId: string; name: string } | null {
  let best: { paneId: string; name: string; d: number } | null = null;
  for (const line of cache) {
    const c = line.coords;
    for (let i = 1; i < c.length; i++) {
      const d = distToSegment(px, py, c[i - 1].x, c[i - 1].y, c[i].x, c[i].y);
      if (d <= HIT_TOLERANCE_PX && (!best || d < best.d)) {
        best = { paneId: line.paneId, name: line.name, d };
      }
    }
  }
  return best ? { paneId: best.paneId, name: best.name } : null;
}

// Resolve the AVWAP anchor bar to a pixel point on the candle pane, or null when
// AVWAP isn't placed/active or the anchor bar is scrolled outside the visible
// range. Returns the anchor bar's timestamp and the line color too, so the
// handle can be painted in the plot color and hit-tested against the cursor.
export function avwapAnchorPixel(
  chart: Chart,
  id: string, // the AVWAP INSTANCE id (its klinecharts name)
): { x: number; y: number; ts: number; color: string } | null {
  const ind = chart.getIndicatorByPaneId("candle_pane", id) as Indicator | null | undefined;
  if (!ind || ind.visible === false) return null;
  const anchorTs = Number(ind.calcParams?.[0]) || 0;
  if (anchorTs <= 0) return null; // unplaced
  const dl = chart.getDataList();
  const idx = dl.findIndex((k) => k.timestamp >= anchorTs);
  if (idx < 0) return null; // anchor is newer than the last loaded bar
  const vr = chart.getVisibleRange();
  if (idx < vr.from || idx >= vr.to) return null; // off-screen: no handle
  const result = ind.result as Array<Record<string, number | undefined>>;
  const v = result[idx]?.vwap;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const px = chart.convertToPixel([{ timestamp: dl[idx].timestamp, value: v }], {
    paneId: "candle_pane",
    absolute: true,
  }) as Array<{ x: number; y: number }>;
  if (!px[0]) return null;
  const color =
    ind.styles?.lines?.[0]?.color ??
    chart.getStyles().indicator.lines[0]?.color ??
    "#FF9600";
  return { x: px[0].x, y: px[0].y, ts: dl[idx].timestamp, color };
}

// If the selected indicator is an AVWAP INSTANCE, return its id (its klinecharts
// name); else null. Resolves type via extendData.indType so it works regardless of
// the instance id (e.g. "AVWAP#a1b2"). Used to scope the anchor handle/drag to the
// selected AVWAP when several may exist.
export function selectedAvwapId(
  chart: Chart,
  sel: { paneId: string; name: string } | null,
): string | null {
  if (!sel) return null;
  const ind = chart.getIndicatorByPaneId(sel.paneId, sel.name) as Indicator | null | undefined;
  return ind && indTypeOf(ind) === "AVWAP" ? sel.name : null;
}

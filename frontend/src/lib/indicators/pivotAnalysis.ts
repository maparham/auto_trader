// Pivots High/Low Analysis (after LuxAlgo's "Pivots High/Low Analysis & Forecast").
// A candle-pane overlay that marks each confirmed fractal swing high/low, connects
// it back to the previous same-type pivot with a dotted level segment + a vertical
// double-arrow (blue when the new pivot is higher than the prior one, red when
// lower), and labels the swing with Δ% (percent change) and Δt (bars elapsed).
// Optionally carries the most recent pivot high/low forward as a level line.
//
// The SAME computePivotAnalysis is used by the chart visual (calc/draw below) AND
// the rule-operand recipe path (backtestSeries.computeIndicatorRecipe), so the
// plotted levels and the rule values are identical by construction.
//
// No lookahead: a fractal pivot at bar i depends on the N bars to its right, so it
// is only known at bar i+N. The forward-filled operand values (pivotHigh, pivotLow,
// deltaPct, deltaT) therefore step at the CONFIRMATION bar i+N — never at the swing
// bar. The swing-bar events (phEvent/plEvent) are for drawing only.
import {
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import { fullLine } from "./shared";
import { isPivotAt } from "./pivots";

export type PivotConnectorLineStyle = "solid" | "dashed" | "dotted";

/** Style of the vertical connector between consecutive same-type pivots. Colors
 * stay price-driven (up when the new pivot is higher, down when lower); width /
 * line style / arrowheads are shared across both directions. */
export interface PivotConnectorStyle {
  upColor?: string;
  downColor?: string;
  width?: number;
  lineStyle?: PivotConnectorLineStyle;
  arrows?: boolean;
}

export interface PivotAnalysisExtend {
  // Draw the forward-carried previous-high / previous-low level lines (default on).
  showLevels?: boolean;
  // Vertical connector styling (default = today's blue-up / red-down solid arrows).
  connector?: PivotConnectorStyle;
  // Legend toggle (settings modal): hide this indicator's value from the legend.
  hideLegendValue?: boolean;
}

/** One confirmed pivot, anchored at its swing bar, with the geometry of its
 * connector back to the previous SAME-type pivot (undefined for the first). */
export interface PivotEvent {
  price: number;
  prevPrice?: number;
  prevIndex?: number;
  deltaPct?: number;
  deltaT?: number;
}

export interface PivotAnalysisPoint {
  // Forward-filled operand values (step at the confirmation bar i+N).
  pivotHigh?: number;
  pivotLow?: number;
  deltaPct?: number; // most recent pivot's % change vs prior same-type pivot
  deltaT?: number; // most recent pivot's bars vs prior same-type pivot
  // Swing-bar events, for drawing only (marker + connector + label).
  phEvent?: PivotEvent;
  plEvent?: PivotEvent;
}

/** The two Δ label lines for a pivot event, or null if it has no Δ (the first
 * pivot of its type). Shared by the small on-chart label and the hover-enlarged
 * overlay label so both read identically. */
export function pivotDeltaLabelLines(ev: PivotEvent): [string, string] | null {
  if (ev.deltaPct == null || ev.deltaT == null) return null;
  // Up arrow when the pivot rose vs the prior same-type pivot, down when it fell,
  // nothing when flat.
  const arrow = ev.deltaPct > 0 ? " ▲" : ev.deltaPct < 0 ? " ▼" : "";
  return [`Δ% : ${ev.deltaPct.toFixed(2)}${arrow}`, `Δt : ${ev.deltaT}`];
}

/** Geometry of the hover-enlarged Δ%/Δt plate, in container pixels. The single
 * source of truth shared by the hit-test (chartGeometry.pivotDeltaLabelAt) and
 * the painter (chartPainters.paintPivotDeltaLabels) so they never drift. The
 * plate sits just right of the swing bar's marker (`markerX`) and above a high
 * pivot's `anchorY` / below a low's — mirroring the small on-chart label. `textW`
 * is the widest of the two Δ lines (measured in PIVOT_DELTA_PLATE.font). */
export const PIVOT_DELTA_PLATE = {
  font: "bold 16px sans-serif", // hover-enlarged: clearly bigger + bold vs the 10px at-rest label
  lineH: 19,
  padX: 5,
  padY: 3,
  offX: 4, // plate left edge = markerX + offX (before padX back-off)
  gapY: 2, // gap between the anchor and the plate's near edge
} as const;

export interface PivotDeltaRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pivotDeltaLabelRect(
  markerX: number,
  anchorY: number,
  side: "high" | "low",
  textW: number,
): PivotDeltaRect {
  const { padX, padY, lineH, offX, gapY } = PIVOT_DELTA_PLATE;
  const w = textW + padX * 2;
  const h = lineH * 2 + padY * 2;
  const x = markerX + offX - padX;
  const y = side === "high" ? anchorY - h - gapY : anchorY + gapY;
  return { x, y, w, h };
}

/** Pure pixel hit decision for one pivot's Δ label: is `pointer` inside the
 * enlarged plate rect OR within `radius` of the swing-bar marker dot? Returns the
 * decision plus the pointer's distance to the marker so the caller can keep the
 * nearest when several pivots overlap. `markerX`/`markerY` are the swing marker's
 * pixel; `anchorY` is the label's anchor (topmost point for a high, bottom for a
 * low). Pure, so the hover-enlarge geometry is unit-tested apart from the chart. */
export interface PivotDeltaHitParams {
  markerX: number;
  markerY: number;
  anchorY: number;
  side: "high" | "low";
  textW: number;
  radius: number;
}

export function pivotDeltaHit(
  pointer: { x: number; y: number },
  p: PivotDeltaHitParams,
): { hit: boolean; dist: number } {
  const r = pivotDeltaLabelRect(p.markerX, p.anchorY, p.side, p.textW);
  const inRect =
    pointer.x >= r.x && pointer.x <= r.x + r.w && pointer.y >= r.y && pointer.y <= r.y + r.h;
  const dist = Math.hypot(pointer.x - p.markerX, pointer.y - p.markerY);
  return { hit: inRect || dist <= p.radius, dist };
}

const DEFAULT_HIGH = "#ff1100"; // pivot-high color (resistance)
const DEFAULT_LOW = "#0cb51a"; // pivot-low color (support)
const ARROW_UP = "#2157f3"; // new pivot higher than the prior same-type one
const ARROW_DOWN = "#ff1100"; // new pivot lower
export const PIVOT_LABEL_COLOR = "#787b86"; // Δ%/Δt text (gray, matches the original)

/** Connector defaults reproduce today's fixed look exactly. */
export const PIVOT_CONNECTOR_DEFAULTS: Required<PivotConnectorStyle> = {
  upColor: ARROW_UP,
  downColor: ARROW_DOWN,
  width: 1.5,
  lineStyle: "solid",
  arrows: true,
};

const CONNECTOR_DASH: Record<PivotConnectorLineStyle, number[]> = {
  solid: [],
  dashed: [4, 3],
  dotted: [1, 2],
};

/** Fill every unset connector field with its default (used by draw + settings). */
export function resolvePivotConnector(c?: PivotConnectorStyle): Required<PivotConnectorStyle> {
  return {
    upColor: c?.upColor ?? PIVOT_CONNECTOR_DEFAULTS.upColor,
    downColor: c?.downColor ?? PIVOT_CONNECTOR_DEFAULTS.downColor,
    width: c?.width ?? PIVOT_CONNECTOR_DEFAULTS.width,
    lineStyle: c?.lineStyle ?? PIVOT_CONNECTOR_DEFAULTS.lineStyle,
    arrows: c?.arrows ?? PIVOT_CONNECTOR_DEFAULTS.arrows,
  };
}

/** Confirmed fractal pivots (strict, high off the high series / low off the low
 * series), the swing-bar events, and the forward-filled operand step-values. */
export function computePivotAnalysis(dataList: KLineData[], length: number): PivotAnalysisPoint[] {
  const n = Math.max(1, Math.floor(length) || 1);
  const len = dataList.length;
  const highs = dataList.map((d) => d.high);
  const lows = dataList.map((d) => d.low);
  const out: PivotAnalysisPoint[] = Array.from({ length: len }, () => ({}));

  // Walk bars in order: build the swing-bar event and queue the confirmation
  // (bar i+N) that steps the forward-filled values.
  type Confirm = { at: number; side: "high" | "low"; price: number; deltaPct?: number; deltaT?: number };
  const confirms: Confirm[] = [];
  let prevHigh: { index: number; price: number } | undefined;
  let prevLow: { index: number; price: number } | undefined;

  for (let i = 0; i < len; i++) {
    if (isPivotAt(highs, i, n, n, "high", true)) {
      const price = highs[i];
      const deltaPct = prevHigh ? ((price - prevHigh.price) / prevHigh.price) * 100 : undefined;
      const deltaT = prevHigh ? i - prevHigh.index : undefined;
      out[i].phEvent = { price, prevPrice: prevHigh?.price, prevIndex: prevHigh?.index, deltaPct, deltaT };
      confirms.push({ at: i + n, side: "high", price, deltaPct, deltaT });
      prevHigh = { index: i, price };
    }
    if (isPivotAt(lows, i, n, n, "low", true)) {
      const price = lows[i];
      const deltaPct = prevLow ? ((price - prevLow.price) / prevLow.price) * 100 : undefined;
      const deltaT = prevLow ? i - prevLow.index : undefined;
      out[i].plEvent = { price, prevPrice: prevLow?.price, prevIndex: prevLow?.index, deltaPct, deltaT };
      confirms.push({ at: i + n, side: "low", price, deltaPct, deltaT });
      prevLow = { index: i, price };
    }
  }

  // Forward-fill: at each confirmation the matching level steps, and Δ%/Δt take
  // that pivot's values (the "most recent pivot" of either side). Array.sort is
  // stable, so a high and low confirming on the same bar keep their emit order.
  confirms.sort((a, b) => a.at - b.at);
  let ci = 0;
  let curHigh: number | undefined;
  let curLow: number | undefined;
  let curDeltaPct: number | undefined;
  let curDeltaT: number | undefined;
  for (let i = 0; i < len; i++) {
    while (ci < confirms.length && confirms[ci].at === i) {
      const c = confirms[ci];
      if (c.side === "high") curHigh = c.price;
      else curLow = c.price;
      curDeltaPct = c.deltaPct;
      curDeltaT = c.deltaT;
      ci++;
    }
    out[i].pivotHigh = curHigh;
    out[i].pivotLow = curLow;
    out[i].deltaPct = curDeltaPct;
    out[i].deltaT = curDeltaT;
  }
  return out;
}

// --- drawing -----------------------------------------------------------------

/** One arrowhead at (x,y) pointing along `ang` (canvas radians). */
function arrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, ang: number): void {
  const s = 5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - s * Math.cos(ang - Math.PI / 6), y - s * Math.sin(ang - Math.PI / 6));
  ctx.moveTo(x, y);
  ctx.lineTo(x - s * Math.cos(ang + Math.PI / 6), y - s * Math.sin(ang + Math.PI / 6));
  ctx.stroke();
}

/** A vertical line (optionally dashed/dotted) with an arrowhead at each end.
 * The dash applies only to the shaft; arrowheads always stroke solid. */
function drawDoubleArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y1: number,
  y2: number,
  dash: number[],
  arrows: boolean,
): void {
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x, y1);
  ctx.lineTo(x, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  if (arrows) {
    arrowHead(ctx, x, y1, Math.atan2(y1 - y2, 0));
    arrowHead(ctx, x, y2, Math.atan2(y2 - y1, 0));
  }
}

interface Axis {
  convertToPixel(v: number): number;
}

/** Marker + (for non-first pivots) dotted level segment, double-arrow, label. */
function drawPivot(
  ctx: CanvasRenderingContext2D,
  xAxis: Axis,
  yAxis: Axis,
  i: number,
  ev: PivotEvent,
  _side: "high" | "low",
  color: string,
  connector: Required<PivotConnectorStyle>,
): void {
  const x = xAxis.convertToPixel(i);
  const y = yAxis.convertToPixel(ev.price);

  // Marker circle at the swing point.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fill();

  if (ev.prevIndex == null || ev.prevPrice == null) return;
  const xPrev = xAxis.convertToPixel(ev.prevIndex);
  const yPrev = yAxis.convertToPixel(ev.prevPrice);

  // Dotted horizontal segment at the previous pivot's level, back to it.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(xPrev, yPrev);
  ctx.lineTo(x, yPrev);
  ctx.stroke();
  ctx.setLineDash([]);

  // Vertical connector between the two levels — color is price-driven (up when the
  // new pivot is higher, down when lower); width/dash/arrowheads are configurable.
  ctx.strokeStyle = ev.price > ev.prevPrice ? connector.upColor : connector.downColor;
  ctx.lineWidth = connector.width;
  drawDoubleArrow(ctx, x, yPrev, y, CONNECTOR_DASH[connector.lineStyle], connector.arrows);

  // The Δ%/Δt label is NOT drawn here: it's owned entirely by the chart overlay
  // (chartPainters.paintPivotDeltaLabels), which draws each pivot's label once —
  // small at rest, enlarged for the one under the cursor — so there's a single
  // label per pivot with no on-canvas + overlay doubling.
}

/** Forward-carried level step-line (connecting consecutive defined values). */
function drawLevel(
  ctx: CanvasRenderingContext2D,
  xAxis: Axis,
  yAxis: Axis,
  result: PivotAnalysisPoint[],
  key: "pivotHigh" | "pivotLow",
  color: string,
  from: number,
  to: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  for (let i = Math.max(from, 1); i < to; i++) {
    const a = result[i - 1]?.[key];
    const b = result[i]?.[key];
    if (typeof a !== "number" || typeof b !== "number") continue;
    ctx.beginPath();
    ctx.moveTo(xAxis.convertToPixel(i - 1), yAxis.convertToPixel(a));
    ctx.lineTo(xAxis.convertToPixel(i), yAxis.convertToPixel(b));
    ctx.stroke();
  }
}

function drawPivotAnalysis(params: IndicatorDrawParams<PivotAnalysisPoint, unknown, unknown>): boolean {
  const { ctx, chart, indicator, xAxis, yAxis } = params;
  const visibleRange = chart.getVisibleRange();
  const defaultStyles = chart.getStyles().indicator;
  const result = (indicator.result ?? []) as PivotAnalysisPoint[];
  const ext = (indicator.extendData ?? {}) as PivotAnalysisExtend;
  const showLevels = ext.showLevels !== false;
  const overrides = indicator.styles?.lines ?? [];
  const defaults = defaultStyles?.lines ?? [];
  const highColor = overrides[0]?.color ?? defaults[0]?.color ?? DEFAULT_HIGH;
  const lowColor = overrides[1]?.color ?? defaults[1]?.color ?? DEFAULT_LOW;
  const connector = resolvePivotConnector(ext.connector);
  const { from, to } = visibleRange;

  ctx.save();
  // Forward-carried previous-H/L level lines (toggle).
  if (showLevels) {
    drawLevel(ctx, xAxis, yAxis, result, "pivotHigh", highColor, from, to);
    drawLevel(ctx, xAxis, yAxis, result, "pivotLow", lowColor, from, to);
  }
  // Per-pivot markers + connectors + labels. Scan a small margin past the edges
  // so a pivot whose marker/label sits just off-screen still peeks in.
  const lo = Math.max(0, from - 1);
  const hi = Math.min(result.length, to + 1);
  for (let i = lo; i < hi; i++) {
    const ph = result[i]?.phEvent;
    if (ph) drawPivot(ctx, xAxis, yAxis, i, ph, "high", highColor, connector);
    const pl = result[i]?.plEvent;
    if (pl) drawPivot(ctx, xAxis, yAxis, i, pl, "low", lowColor, connector);
  }
  ctx.restore();
  return true; // suppress the default figure lines (we draw the levels ourselves)
}

const PIVOT_ANALYSIS_FIGURES = [
  { key: "pivotHigh", title: "Pivot High: ", type: "line" },
  { key: "pivotLow", title: "Pivot Low: ", type: "line" },
];

const PIVOT_ANALYSIS_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine(DEFAULT_HIGH, 'solid'), // pivotHigh
  fullLine(DEFAULT_LOW, 'solid'), // pivotLow
];

// Pivots High/Low Analysis: swing markers + Δ connectors + forward-carried levels.
// Strength in calcParams[0]; showLevels toggle on extendData.
export const PIVOT_ANALYSIS_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Pivots High/Low [LuxAlgo]",
  series: 'price',
  precision: 2,
  calcParams: [50],
  figures: PIVOT_ANALYSIS_FIGURES,
  styles: { lines: PIVOT_ANALYSIS_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computePivotAnalysis(dataList, Math.max(1, Number(ind.calcParams?.[0]) || 50)),
  draw: (params) => drawPivotAnalysis(params as IndicatorDrawParams<PivotAnalysisPoint, unknown, unknown>),
};

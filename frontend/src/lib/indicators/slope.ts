// Slope of a TV-style EMA/SMA, plotted in its own sub-pane (green up / red down
// around a zero line). The SAME slopeWithUnits + inferBarHours + computeSlope are
// used by the chart visual (calc/draw below) AND the rule-operand recipe path
// (backtestSeries.computeIndicatorRecipe), so the plotted line and the rule value
// are identical by construction. Units live on extendData so they're part of the
// recipe hash (a %/bar and a %/hr slope on the same MA don't dedup).
import {
  IndicatorSeries,
  LineType,
  type Indicator,
  type IndicatorTemplate,
  type IndicatorDrawParams,
  type KLineData,
} from "klinecharts";
import { maSeries, alignHtfToChart, emaGappy, normalizeMaKind, type MaKind } from "../mtf";
import type { MaExtend } from "./ma";
import { fullLine } from "./shared";

export type SlopeUnit = "pctHr" | "pctBar" | "priceBar";

/** A symmetric horizontal reference guide drawn at +level and −level. Visual
 * only (no rule wiring). `level` is a magnitude; a negative stored value is
 * treated as its absolute value so the two lines are always mirrored. */
export interface SlopeThreshold {
  on: boolean;
  level: number;
  color?: string;
  lineStyle?: "solid" | "dashed" | "dotted";
}

export interface SlopeExtend extends MaExtend {
  maType?: MaKind;
  units?: SlopeUnit;
  slopePeriod?: number;
  smoothing?: SlopeSmoothing;
  colorByDirection?: boolean;
  showMa?: boolean;
  threshold?: SlopeThreshold;
  showAccel?: boolean;
  accelPeriod?: number;
  accelSmoothing?: SlopeSmoothing;
  accelThreshold?: SlopeThreshold;
  // Plot |acceleration| instead of signed acceleration on the companion pane. A
  // display transform applied when computeAccelCalc builds the pane values (after
  // any smoothing/MTF align), so magnitude reads regardless of steepening vs
  // flattening. Does not touch the signed accel rule operand.
  accelAbsolute?: boolean;
  mtf?: MaExtend["mtf"] & {
    htfSeriesByLine?: Array<Array<number | undefined>>;
    htfMaBaseByLine?: Array<Array<number | undefined>>;
    htfAccelByLine?: Array<Array<number | undefined>>;
  };
}

export type SlopePoint = Record<string, number | undefined>;

/** Hours per bar inferred from the smallest positive gap between adjacent bar
 * timestamps. Used identically by the visual and the rule path, so %/hr matches
 * by construction regardless of timeframe regularity. Falls back to 1 hour. */
export function inferBarHours(candles: KLineData[]): number {
  let minMs = Infinity;
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].timestamp - candles[i - 1].timestamp;
    if (d > 0 && d < minMs) minMs = d;
  }
  return Number.isFinite(minMs) ? minMs / 3_600_000 : 1;
}

/** Slope of `raw` over `n` bars in the chosen units. undefined for the first `n`
 * bars, where raw is undefined, or where the denominator is 0.
 *   pctBar   = (v − prev) / |prev| / n × 100
 *   pctHr    = (v − prev) / |prev| / (n × barHours) × 100   (matches slopeOf)
 *   priceBar = (v − prev) / n */
export function slopeWithUnits(
  raw: Array<number | undefined>,
  n: number,
  barHours: number,
  units: SlopeUnit,
): Array<number | undefined> {
  return raw.map((v, i) => {
    const prev = raw[i - n];
    if (i < n || v === undefined || prev === undefined) return undefined;
    if (units === "priceBar") return (v - prev) / n;
    if (prev === 0) return undefined;
    const denom = units === "pctHr" ? n * barHours : n;
    return ((v - prev) / Math.abs(prev) / denom) * 100;
  });
}

/** MA (via the shared maSeries, so it matches the real EMA/SMA) then its slope. */
export function computeSlope(
  candles: KLineData[],
  maType: MaKind,
  maLen: number,
  n: number,
  units: SlopeUnit,
  ext: MaExtend,
  barHours: number,
): SlopePoint[] {
  const { base } = maSeries(candles, maType, maLen, ext);
  return slopeWithUnits(base, n, barHours, units).map((s) => ({ slope: s ?? undefined }));
}

export type SlopeSmoothing = { type: "none" | "sma" | "ema"; length: number };

/** Smooth a slope series (SMA/EMA) or return it unchanged for "none".
 * SMA needs a full window of `length` DEFINED values → first (length-1) defined
 * bars become undefined; undefined inputs pass through. */
export function smoothSeries(
  values: Array<number | undefined>,
  s?: SlopeSmoothing,
): Array<number | undefined> {
  if (!s || s.type === "none" || s.length <= 1) return values;
  if (s.type === "ema") return emaGappy(values, s.length);
  // SMA over a gappy series: window of the last `length` values, all must be defined.
  return values.map((_, i) => {
    if (i < s.length - 1) return undefined;
    let sum = 0;
    for (let j = i - s.length + 1; j <= i; j++) {
      const v = values[j];
      if (v === undefined) return undefined;
      sum += v;
    }
    return sum / s.length;
  });
}

/** Rate of change of a slope series over `n2` bars: the MA's acceleration.
 * Uses an ABSOLUTE difference, NOT the percentage renormalization slopeWithUnits
 * applies. The slope crosses zero, so dividing by |prev slope| would blow up at
 * the crossing. Units are therefore "slope units per hour" (perHour) or "slope
 * units per bar". undefined for the first n2 bars and wherever either endpoint
 * is undefined. */
export function accelSeries(
  slope: Array<number | undefined>,
  n2: number,
  barHours: number,
  perHour: boolean,
): Array<number | undefined> {
  // A non-positive period would make `slope[i - n2]` read a FUTURE index, a silent
  // lookahead that reaches backtest rules (the settings input min=1 doesn't stop a
  // typed negative). Refuse: emit an all-undefined series instead.
  if (!(n2 >= 1)) return slope.map(() => undefined);
  return slope.map((v, i) => {
    const prev = slope[i - n2];
    if (i < n2 || v === undefined || prev === undefined) return undefined;
    const denom = n2 * (perHour ? barHours : 1);
    if (denom === 0) return undefined;
    return (v - prev) / denom;
  });
}

/** ONE MA-acceleration line: the slope line (already unit-converted and
 * slope-smoothed) differentiated again, then optionally smoothed on its own.
 * Pipeline: MA -> slope -> (slope smoothing) -> accel -> (accel smoothing).
 * Shared by the pane, the rule recipe, and MTF so all three agree by construction. */
export function accelLineSeries(
  candles: KLineData[],
  maType: MaKind,
  length: number,
  n: number,
  n2: number,
  units: SlopeUnit,
  source: MaExtend["source"],
  smoothing: SlopeSmoothing | undefined,
  accelSmoothing: SlopeSmoothing | undefined,
  barHours: number,
): Array<number | undefined> {
  const slope = slopeLineSeries(candles, maType, length, n, units, source, smoothing, barHours);
  // Time base follows the slope's units: a %/hr slope accelerates per hour;
  // %/bar and price/bar accelerate per bar. That is why there is no separate
  // accel units control.
  const accel = accelSeries(slope, n2, barHours, units === "pctHr");
  return smoothSeries(accel, accelSmoothing);
}

/** ONE MA-slope line: MA (via maSeries, matches the real EMA/SMA) → slope (units)
 * → optional smoothing. Shared by the visual, the rule recipe, and MTF so all
 * three agree by construction. */
export function slopeLineSeries(
  candles: KLineData[],
  maType: MaKind,
  length: number,
  n: number,
  units: SlopeUnit,
  source: MaExtend["source"],
  smoothing: SlopeSmoothing | undefined,
  barHours: number,
): Array<number | undefined> {
  const { base } = maSeries(candles, maType, length, { source });
  const raw = slopeWithUnits(base, n, barHours, units);
  return smoothSeries(raw, smoothing);
}

// Green when the MA is rising, red when falling. TV-ish palette.
const SLOPE_UP = "#26A69A";
const SLOPE_DOWN = "#EF5350";
const ZERO_LINE = "#9598A1";
const THRESHOLD_LINE = "#787B86";
const SLOPE_PALETTE = ["#26A69A", "#42A5F5", "#FFB300", "#AB47BC", "#EF5350"];

const DASH_BY_STYLE: Record<NonNullable<SlopeThreshold["lineStyle"]>, number[]> = {
  solid: [],
  dashed: [4, 3],
  dotted: [1, 2],
};

/** MA lengths from calcParams (default [9]); empty/garbage → [9]. */
export function slopeLengths(calcParams: unknown[] | undefined): number[] {
  const xs = (calcParams ?? []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v !== 0);
  return xs.length ? xs.slice(0, 5) : [9];
}

/** Active threshold magnitude (|level|) when the guide is on and the level is a
 * usable non-zero number; otherwise null. A zero level would coincide with the
 * zero line, so it's treated as off. */
export function slopeThresholdLevel(ext: SlopeExtend): number | null {
  const t = ext.threshold;
  if (!t?.on) return null;
  const m = Math.abs(Number(t.level));
  return Number.isFinite(m) && m > 0 ? m : null;
}

function slopeShared(ext: SlopeExtend) {
  return {
    maType: normalizeMaKind(ext.maType),
    n: Number(ext.slopePeriod) || 3,
    units: (ext.units ?? "pctHr") as SlopeUnit,
    source: ext.source,
    smoothing: ext.smoothing,
  };
}

function computeSlopeCalc(candles: KLineData[], ind: Indicator): SlopePoint[] {
  const ext = (ind.extendData ?? {}) as SlopeExtend;
  const lengths = slopeLengths(ind.calcParams);
  const { maType, n, units, source, smoothing } = slopeShared(ext);
  // Constant threshold values, emitted as figure data so klinecharts' auto-scale
  // grows the pane to keep the ±level lines on-screen (and thus grabbable).
  const th = slopeThresholdLevel(ext);
  const withThreshold = (p: SlopePoint): SlopePoint => {
    if (th !== null) {
      p.thHi = th;
      p.thLo = -th;
    }
    return p;
  };
  // MTF: the coordinator stashes per-line slope series computed on native HTF bars
  // (with HTF barHours) — align it to the chart bars, no lookahead. See
  // mtfCoordinator.applySlopeTimeframe.
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfSeriesByLine && mtf.htfStarts && mtf.htfMs) {
    const ts = candles.map((k) => k.timestamp);
    const starts = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    const aligned = mtf.htfSeriesByLine.map((series) =>
      alignHtfToChart(ts, starts, series, mtf.htfMs!, true),
    );
    return candles.map((_, i) => {
      const p: SlopePoint = {};
      aligned.forEach((a, li) => (p[`slope${li}`] = a[i] ?? undefined));
      return withThreshold(p);
    });
  }
  const barHours = inferBarHours(candles);
  const lines = lengths.map((len) =>
    slopeLineSeries(candles, maType, len, n, units, source, smoothing, barHours),
  );
  return candles.map((_, i) => {
    const p: SlopePoint = {};
    lines.forEach((line, li) => (p[`slope${li}`] = line[i] ?? undefined));
    return withThreshold(p);
  });
}

// Every figure gets a title (labelled by its MA length) so the DOM legend shows a
// value for EVERY slope line — ChartLegend skips figures whose title is empty.
function slopeFigures(calcParams: unknown[]): Array<{ key: string; title: string; type: "line" }> {
  const lines = slopeLengths(calcParams).map((len, i) => ({
    key: `slope${i}`,
    title: `Slope ${len}: `,
    type: "line" as const,
  }));
  // Always-present, EMPTY-TITLE threshold figures. Titleless → the DOM legend
  // skips them; drawn manually in drawSlope. Their sole job is to feed the pane's
  // auto-scale — only when computeSlopeCalc emits thHi/thLo (threshold on) do
  // they carry data and grow the axis; otherwise they're undefined gaps.
  const threshold = ["thHi", "thLo"].map((key) => ({ key, title: "", type: "line" as const }));
  return [...lines, ...threshold];
}

// Draws one line per configured MA length, each in its own color (per-line
// override → template default → palette fallback), plus a dashed zero
// reference line. A lone line defaults to color-by-direction (green rising /
// red falling) unless colorByDirection is explicitly set to false. Returns
// true to SUPPRESS the default single-color figure lines (we draw here).
function drawSlope(params: IndicatorDrawParams<SlopePoint>): boolean {
  const { ctx, visibleRange, indicator, xAxis, yAxis, bounding, defaultStyles } = params;
  const result = (indicator.result ?? []) as SlopePoint[];
  const ext = (indicator.extendData ?? {}) as SlopeExtend;
  const lengths = slopeLengths(indicator.calcParams);
  const { from, to } = visibleRange;
  ctx.save();
  // Zero reference line across the pane.
  const yZero = yAxis.convertToPixel(0);
  ctx.strokeStyle = ZERO_LINE;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(bounding.left, yZero);
  ctx.lineTo(bounding.left + bounding.width, yZero);
  ctx.stroke();
  ctx.setLineDash([]);

  // Symmetric threshold guide at ±level (visual only). The constant thHi/thLo
  // figure values (emitted by computeSlopeCalc) already grew the pane's y-axis to
  // include these, so both lines stay on-screen and grabbable at any level.
  const th = slopeThresholdLevel(ext);
  if (th !== null) {
    const thColor = ext.threshold?.color ?? THRESHOLD_LINE;
    const dash = DASH_BY_STYLE[ext.threshold?.lineStyle ?? "dotted"];
    const left = bounding.left;
    const right = bounding.left + bounding.width;
    ctx.strokeStyle = thColor;
    ctx.fillStyle = thColor;
    ctx.lineWidth = 1;
    ctx.font = "10px -apple-system, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    // In the accel COMPANION's absolute mode the values are all ≥ 0, so only the
    // +level guide applies (computeAccelCalc likewise emits only thHi). Gate on the
    // companion's indType, NOT accelAbsolute alone: applySlope relays accelAbsolute
    // through the PARENT Slope's extendData too, and the parent reuses drawSlope but
    // always plots signed slope (computeSlopeCalc emits both thHi/thLo) — so it must
    // keep the symmetric ±level pair.
    const absOnly =
      (ext as { indType?: string }).indType === "SLOPE_ACCEL" && ext.accelAbsolute === true;
    const levels = absOnly ? [th] : [th, -th];
    for (const level of levels) {
      const y = yAxis.convertToPixel(level);
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Right-edge value label (e.g. "0.1500" / "-0.1500"), so the exact level reads.
      const label = level.toFixed(4);
      const w = ctx.measureText(label).width;
      ctx.fillText(label, right - w - 4, level >= 0 ? y - 6 : y + 6);
    }
  }

  const overrides = indicator.styles?.lines ?? [];
  const defaults = defaultStyles?.lines ?? [];
  const lineColor = (li: number): string =>
    overrides[li]?.color ?? defaults[li]?.color ?? SLOPE_PALETTE[li % SLOPE_PALETTE.length];
  const lineWidth = (li: number): number => overrides[li]?.size ?? defaults[li]?.size ?? 1.5;

  const directionMode = ext.colorByDirection !== false && lengths.length === 1;

  for (let li = 0; li < lengths.length; li++) {
    const key = `slope${li}`;
    ctx.lineWidth = lineWidth(li);
    for (let i = Math.max(from, 1); i < to; i++) {
      const a = result[i - 1]?.[key];
      const b = result[i]?.[key];
      if (a === undefined || b === undefined) continue;
      ctx.strokeStyle = directionMode ? (b >= 0 ? SLOPE_UP : SLOPE_DOWN) : lineColor(li);
      ctx.beginPath();
      ctx.moveTo(xAxis.convertToPixel(i - 1), yAxis.convertToPixel(a));
      ctx.lineTo(xAxis.convertToPixel(i), yAxis.convertToPixel(b));
      ctx.stroke();
    }
  }
  ctx.restore();
  return true; // suppress default figure lines
}

/** One on-chart MA curve derived from a Slope line: its resolved color + width
 * (matching the slope line's own style) + per-bar MA base values (undefined
 * during warm-up). */
export interface SlopeMaLine {
  color: string;
  width: number;
  values: Array<number | undefined>;
}

/** The subset of a live SLOPE indicator the on-chart MA painter reads. */
export interface SlopeMaSource {
  calcParams?: unknown[];
  extendData?: unknown;
  visible?: boolean;
  styles?: { lines?: Array<{ color?: string; size?: number }> };
}

/** Per-line MA curves to draw on the candle pane for a Slope with "Show MAs on
 * chart" enabled. Empty when showMa is off or the Slope is hidden. Each line is
 * the MA base (maSeries) of that length run through the Slope's smoothing (raw
 * when smoothing is off, smoothed with the same SMA/EMA window when on),
 * colored to match the slope line (override -> SLOPE_PALETTE). Uses the SAME
 * slopeLengths + maSeries the Slope uses, so the curves match by construction.
 * On a higher timeframe, uses the coordinator-stashed HTF MA base (already
 * smoothed on the HTF bars) aligned to the chart bars instead (see the mtf
 * branch below). */
export function slopeMaLines(ind: SlopeMaSource, candles: KLineData[]): SlopeMaLine[] {
  const ext = (ind.extendData ?? {}) as SlopeExtend;
  if (!ext.showMa || ind.visible === false) return [];
  const lengths = slopeLengths(ind.calcParams);
  const { maType, source, smoothing } = slopeShared(ext);
  const colorAt = (li: number): string =>
    ind.styles?.lines?.[li]?.color ?? SLOPE_PALETTE[li % SLOPE_PALETTE.length];
  // Match the slope line's own width (drawSlope resolves it the same way, then
  // falls back to 1.5). So a width override on the slope line carries to its MA.
  const widthAt = (li: number): number => ind.styles?.lines?.[li]?.size ?? 1.5;
  // MTF: the coordinator stashes the per-line HTF MA base (native HTF bars,
  // same lengths/source as the chart-TF path) alongside the slope series.
  // Align it to the chart bars, no lookahead, instead of recomputing on the
  // chart-TF candles. See mtfCoordinator.applySlopeTimeframe.
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfMaBaseByLine && mtf.htfStarts && mtf.htfMs) {
    const ts = candles.map((k) => k.timestamp);
    const starts = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    return lengths.map((_len, li) => ({
      color: colorAt(li),
      width: widthAt(li),
      values: alignHtfToChart(ts, starts, mtf.htfMaBaseByLine![li] ?? [], mtf.htfMs!, true),
    }));
  }
  return lengths.map((len, li) => ({
    color: colorAt(li),
    width: widthAt(li),
    values: smoothSeries(maSeries(candles, maType, len, { source }).base, smoothing),
  }));
}

export const SLOPE_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Slope",
  series: IndicatorSeries.Normal,
  precision: 4,
  calcParams: [9],
  figures: slopeFigures([9]),
  regenerateFigures: ((calcParams: unknown[]) =>
    slopeFigures(calcParams)) as IndicatorTemplate["regenerateFigures"],
  styles: { lines: SLOPE_PALETTE.map((c) => fullLine(c, LineType.Solid)) },
  calc: (dataList: KLineData[], ind: Indicator) => computeSlopeCalc(dataList, ind),
  draw: (params) => drawSlope(params as IndicatorDrawParams<SlopePoint>),
};

// Same shape as slopeFigures (including the title-less thHi/thLo auto-scale
// figures) but labelled Accel, so the companion pane's native canvas legend
// reads correctly. Keys stay slope<i> so drawSlope is reused verbatim.
function accelFigures(calcParams: unknown[]): Array<{ key: string; title: string; type: "line" }> {
  const lines = slopeLengths(calcParams).map((len, i) => ({
    key: `slope${i}`,
    title: `Accel ${len}: `,
    type: "line" as const,
  }));
  const threshold = ["thHi", "thLo"].map((key) => ({ key, title: "", type: "line" as const }));
  return [...lines, ...threshold];
}

// The companion pane's calc. Mirrors computeSlopeCalc exactly (same keys, same
// threshold auto-scale trick, same MTF align-don't-recompute rule) but the values
// are acceleration. On a higher timeframe it aligns the coordinator-stashed
// htfAccelByLine, which was computed on NATIVE HTF bars: differentiating the
// already-aligned slope would read zero inside a bucket and spike at boundaries.
function computeAccelCalc(candles: KLineData[], ind: Indicator): SlopePoint[] {
  const ext = (ind.extendData ?? {}) as SlopeExtend;
  const lengths = slopeLengths(ind.calcParams);
  const { maType, n, units, source, smoothing } = slopeShared(ext);
  const n2 = Number(ext.accelPeriod) || 3;
  // Plot |accel| when requested: a display transform on the final pane values
  // (undefined stays undefined). With magnitudes always ≥ 0 the pane reads as a
  // "how hard is it accelerating" line regardless of steepening vs flattening.
  const absolute = ext.accelAbsolute === true;
  const plot = (v: number | undefined): number | undefined =>
    v === undefined ? undefined : absolute ? Math.abs(v) : v;
  const th = slopeThresholdLevel(ext);
  const withThreshold = (p: SlopePoint): SlopePoint => {
    if (th !== null) {
      // In absolute mode the values never go below zero, so only the +level guide
      // is meaningful — emit just thHi (the pane floors at 0, no wasted space below).
      p.thHi = th;
      if (!absolute) p.thLo = -th;
    }
    return p;
  };
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfAccelByLine && mtf.htfStarts && mtf.htfMs) {
    const ts = candles.map((k) => k.timestamp);
    const starts = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    const aligned = mtf.htfAccelByLine.map((series) =>
      alignHtfToChart(ts, starts, series, mtf.htfMs!, true),
    );
    return candles.map((_, i) => {
      const p: SlopePoint = {};
      aligned.forEach((a, li) => (p[`slope${li}`] = plot(a[i] ?? undefined)));
      return withThreshold(p);
    });
  }
  const barHours = inferBarHours(candles);
  const lines = lengths.map((len) =>
    accelLineSeries(candles, maType, len, n, n2, units, source, smoothing, ext.accelSmoothing, barHours),
  );
  return candles.map((_, i) => {
    const p: SlopePoint = {};
    lines.forEach((line, li) => (p[`slope${li}`] = plot(line[i] ?? undefined)));
    return withThreshold(p);
  });
}

/** The acceleration companion pane. An INTERNAL template: it is never in the
 * indicator menu and never a rule operand (operands live on the parent Slope).
 * Reuses drawSlope, so the zero line, threshold guide, color-by-direction and
 * palette all behave exactly like the Slope pane. */
/** Native canvas legend for the companion pane (internal panes get no DOM
 * legend card). klinecharts' default source renders EVERY figure, including
 * the title-less thHi/thLo auto-scale figures, which read as bare "n/a"
 * entries; rebuild the row with the titled Accel lines only, colored like
 * drawSlope (per-line override, palette fallback, direction green/red for a
 * lone line). */
function accelTooltipSource(params: {
  indicator: Indicator;
  crosshair: { dataIndex?: number };
}): { name: string; calcParamsText: string; icons: never[]; values: Array<{ title: { text: string; color: string }; value: { text: string; color: string } }> } {
  const ind = params.indicator;
  const result = (ind.result ?? []) as SlopePoint[];
  const i = params.crosshair.dataIndex ?? result.length - 1;
  const p = result[i] ?? {};
  const lengths = slopeLengths(ind.calcParams);
  const ext = (ind.extendData ?? {}) as SlopeExtend;
  const overrides = (ind.styles?.lines ?? []) as Array<{ color?: string }>;
  const directionMode = ext.colorByDirection !== false && lengths.length === 1;
  const precision = ind.precision ?? 4;
  const values = lengths.map((len, li) => {
    const v = p[`slope${li}`];
    const color = directionMode
      ? (v ?? 0) >= 0
        ? SLOPE_UP
        : SLOPE_DOWN
      : overrides[li]?.color ?? SLOPE_PALETTE[li % SLOPE_PALETTE.length];
    return {
      title: { text: `Accel ${len}: `, color },
      value: { text: v === undefined ? "n/a" : v.toFixed(precision), color },
    };
  });
  return { name: "Accel", calcParamsText: "", icons: [], values };
}

export const SLOPE_ACCEL_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Accel",
  series: IndicatorSeries.Normal,
  precision: 4,
  calcParams: [9],
  figures: accelFigures([9]),
  regenerateFigures: ((calcParams: unknown[]) =>
    accelFigures(calcParams)) as IndicatorTemplate["regenerateFigures"],
  styles: { lines: SLOPE_PALETTE.map((c) => fullLine(c, LineType.Solid)) },
  calc: (dataList: KLineData[], ind: Indicator) => computeAccelCalc(dataList, ind),
  createTooltipDataSource: accelTooltipSource as IndicatorTemplate["createTooltipDataSource"],
  draw: (params) => drawSlope(params as IndicatorDrawParams<SlopePoint>),
};

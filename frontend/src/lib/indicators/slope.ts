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
import { maSeries, alignHtfToChart, emaGappy } from "../mtf";
import type { MaExtend } from "./ma";
import { fullLine } from "./shared";

export type SlopeUnit = "pctHr" | "pctBar" | "priceBar";

export interface SlopeExtend extends MaExtend {
  maType?: "ema" | "sma";
  units?: SlopeUnit;
  slopePeriod?: number;
  smoothing?: SlopeSmoothing;
  colorByDirection?: boolean;
  mtf?: MaExtend["mtf"] & { htfSeriesByLine?: Array<Array<number | undefined>> };
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
  maType: "ema" | "sma",
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

/** ONE MA-slope line: MA (via maSeries, matches the real EMA/SMA) → slope (units)
 * → optional smoothing. Shared by the visual, the rule recipe, and MTF so all
 * three agree by construction. */
export function slopeLineSeries(
  candles: KLineData[],
  maType: "ema" | "sma",
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
const SLOPE_PALETTE = ["#26A69A", "#42A5F5", "#FFB300", "#AB47BC", "#EF5350"];

/** MA lengths from calcParams (default [9]); empty/garbage → [9]. */
export function slopeLengths(calcParams: unknown[] | undefined): number[] {
  const xs = (calcParams ?? []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v !== 0);
  return xs.length ? xs.slice(0, 5) : [9];
}

function slopeShared(ext: SlopeExtend) {
  return {
    maType: (ext.maType === "sma" ? "sma" : "ema") as "ema" | "sma",
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
      return p;
    });
  }
  const barHours = inferBarHours(candles);
  const lines = lengths.map((len) =>
    slopeLineSeries(candles, maType, len, n, units, source, smoothing, barHours),
  );
  return candles.map((_, i) => {
    const p: SlopePoint = {};
    lines.forEach((line, li) => (p[`slope${li}`] = line[i] ?? undefined));
    return p;
  });
}

// Every figure gets a title (labelled by its MA length) so the DOM legend shows a
// value for EVERY slope line — ChartLegend skips figures whose title is empty.
function slopeFigures(calcParams: unknown[]): Array<{ key: string; title: string; type: "line" }> {
  return slopeLengths(calcParams).map((len, i) => ({
    key: `slope${i}`,
    title: `Slope ${len}: `,
    type: "line" as const,
  }));
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

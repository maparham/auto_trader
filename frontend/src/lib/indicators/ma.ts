// TV-style single-line moving averages (EMA / MA). These deliberately REPLACE
// klinecharts' built-in multi-line EMA/MA so the settings modal can expose
// Source/Offset/Timeframe. Length in calcParams[0]; the rest ride on extendData
// (MaExtend). When mtf.timeframe is set, the higher-timeframe series is aligned
// onto the live chart bars inside calc (no lookahead).
import {
  IndicatorSeries,
  LineType,
  type Indicator,
  type IndicatorTemplate,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import { maSeries, alignHtfToChart, type MaOptions } from "../mtf";
import { fullLine } from "./shared";

interface MaPoint {
  ma?: number;
  // Optional smoothing MA layered on top of the base line (TV plots it
  // separately, never overwriting `ma`). Undefined when smoothing is "none".
  smoothingMa?: number;
}

// Per-instance config for the TV-style moving averages, carried on the
// indicator's extendData (set by the settings modal / MTF coordinator). When
// `mtf.timeframe` is set, the higher-timeframe series + bar starts are stored
// here and aligned onto the live chart bars inside calc — so scroll-back fills
// in automatically (calc re-runs against the longer dataList).
export interface MaExtend extends MaOptions {
  mtf?: {
    timeframe: string | null;
    htfStarts?: number[]; // HTF bar open timestamps (ms)
    htfSeries?: Array<number | undefined>; // MA value per HTF bar
    htfMs?: number; // HTF bar duration (ms)
  };
  // Legend toggle (settings modal): hide this indicator's value from the legend.
  // Lives here so applyMaTimeframe (which rewrites extendData) preserves it.
  hideLegendValue?: boolean;
}

// EMA/MA figures: the base line plus a separate smoothing-MA line (TV plots the
// smoothing MA as its own curve, never replacing the base). The smoothingMa
// figure auto-blanks when smoothing is "none" (its value is undefined on every
// bar), so the figure list stays static.
const MA_FIGURES = (label: "EMA" | "MA") => [
  { key: "ma", title: `${label}: `, type: "line" },
  { key: "smoothingMa", title: `${label} MA: `, type: "line" },
];
// Base keeps klinecharts' first default color (orange) so existing charts are
// unchanged; the smoothing MA is TV's yellow so it reads as a distinct overlay.
const MA_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine("#FF9600", LineType.Solid), // ma (base)
  fullLine("#FFB300", LineType.Dashed), // smoothingMa
];

function computeMa(
  dataList: KLineData[],
  kind: "ema" | "sma",
  length: number,
  ext: MaExtend,
): MaPoint[] {
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfSeries && mtf.htfStarts && mtf.htfMs) {
    // Multi-timeframe: align the precomputed HTF series onto the live chart
    // bars (no lookahead — each bar takes the most recent CLOSED HTF bar).
    const aligned = alignHtfToChart(
      dataList.map((k) => k.timestamp),
      mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData),
      mtf.htfSeries,
      mtf.htfMs,
      true,
    );
    // NOTE: the MTF path carries a single precomputed line (htfSeries = the base
    // MA on the higher timeframe), so the smoothing MA is intentionally NOT shown
    // under MTF. Smoothing applies on the chart-timeframe path below.
    return aligned.map((v) => ({ ma: v ?? undefined }));
  }
  const { base, smoothing } = maSeries(dataList, kind, length, ext);
  return base.map((v, i) => ({
    ma: v ?? undefined,
    smoothingMa: smoothing?.[i] ?? undefined,
  }));
}

// EMA / MA: TV-style single-line MAs (length + source + offset + smoothing + MTF).
// Length in calcParams[0]; rest on extendData (MaExtend).
export const EMA_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "EMA",
  series: IndicatorSeries.Price,
  precision: 2,
  calcParams: [9],
  figures: MA_FIGURES("EMA"),
  styles: { lines: MA_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeMa(dataList, "ema", Number(ind.calcParams?.[0]) || 9, (ind.extendData ?? {}) as MaExtend),
};

export const MA_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "MA",
  series: IndicatorSeries.Price,
  precision: 2,
  calcParams: [20],
  figures: MA_FIGURES("MA"),
  styles: { lines: MA_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeMa(dataList, "sma", Number(ind.calcParams?.[0]) || 20, (ind.extendData ?? {}) as MaExtend),
};

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
import { maSeries, alignHtfToChart, normalizeMaKind, type MaOptions, type MaKind } from "../mtf";
import { fullLine } from "./shared";

interface MaPoint {
  ma?: number;
  // Optional smoothing MA layered on top of the base line (TV plots it
  // separately, never overwriting `ma`). Undefined when smoothing is "none".
  smoothingMa?: number;
  // Envelope: the same-kind MA of high/low (LazyBear's evwma+/evwma-).
  // Undefined on every bar when extendData.envelope is off.
  bandHi?: number;
  bandLo?: number;
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
  // MA kind override (settings Type dropdown). Unset means the template's own
  // kind, so pre-existing instances and presets are untouched.
  maType?: MaKind;
  // Envelope toggle: plot the same MA over high and low as upper/lower bands.
  envelope?: boolean;
}

/** Settings/legend label for each MA kind. */
export const MA_KIND_LABEL: Record<MaKind, string> = {
  ema: "EMA",
  sma: "SMA",
  vwma: "VWMA",
  evwma: "EVWMA",
};

/** Legend/pill label for an EMA/MA instance. A never-flipped instance (kind
 * equals its template's own kind) keeps the template label ("EMA"/"MA", not
 * "SMA"), so untouched charts never relabel; the kind label appears only when
 * the user actually flipped the type. */
export function maLegendLabel(maType: unknown, templateKind: MaKind): string {
  const kind = normalizeMaKind(maType, templateKind);
  if (kind === templateKind) return templateKind === "ema" ? "EMA" : "MA";
  return MA_KIND_LABEL[kind];
}

// Figure list: base line, smoothing MA, and the two envelope bands. The band
// figures are ALWAYS present (static figure list, same trick as smoothingMa)
// but only carry a title while the envelope is on: the DOM legend skips
// title-less figures, so an off envelope never reads as two "n/a" rows.
export function maFigures(
  label: string,
  envelope: boolean,
): Array<{ key: string; title: string; type: "line" }> {
  return [
    { key: "ma", title: `${label}: `, type: "line" },
    { key: "smoothingMa", title: `${label} MA: `, type: "line" },
    { key: "bandHi", title: envelope ? `${label} High: ` : "", type: "line" },
    { key: "bandLo", title: envelope ? `${label} Low: ` : "", type: "line" },
  ];
}

// Base keeps klinecharts' first default color (orange) so existing charts are
// unchanged; the smoothing MA is TV's yellow so it reads as a distinct overlay.
const MA_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine("#FF9600", LineType.Solid), // ma (base)
  fullLine("#FFB300", LineType.Dashed), // smoothingMa
  fullLine("#F23645", LineType.Solid), // bandHi (envelope upper)
  fullLine("#089981", LineType.Solid), // bandLo (envelope lower)
];

export function computeMa(
  dataList: KLineData[],
  templateKind: MaKind,
  length: number,
  ext: MaExtend,
): MaPoint[] {
  const kind = normalizeMaKind(ext.maType, templateKind);
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfSeries && mtf.htfStarts && mtf.htfMs) {
    // Multi-timeframe: align the precomputed HTF series onto the live chart
    // bars (no lookahead: each bar takes the most recent CLOSED HTF bar).
    const aligned = alignHtfToChart(
      dataList.map((k) => k.timestamp),
      mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData),
      mtf.htfSeries,
      mtf.htfMs,
      true,
    );
    // NOTE: the MTF path carries a single precomputed line (htfSeries = the base
    // MA on the higher timeframe), so the smoothing MA and envelope bands are
    // intentionally NOT shown under MTF. Both apply on the chart-TF path below.
    return aligned.map((v) => ({ ma: v ?? undefined }));
  }
  const { base, smoothing } = maSeries(dataList, kind, length, ext);
  // Bands mirror the base line only: same kind/length over high/low, no offset,
  // no smoothing sub-MA (source-only options), matching the TV script.
  const bands = ext.envelope
    ? {
        hi: maSeries(dataList, kind, length, { source: "high" }).base,
        lo: maSeries(dataList, kind, length, { source: "low" }).base,
      }
    : null;
  return base.map((v, i) => ({
    ma: v ?? undefined,
    smoothingMa: smoothing?.[i] ?? undefined,
    bandHi: bands?.hi[i] ?? undefined,
    bandLo: bands?.lo[i] ?? undefined,
  }));
}

// EMA / MA: TV-style single-line MAs (length + source + offset + smoothing + MTF).
// Length in calcParams[0]; rest on extendData (MaExtend).
export const EMA_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "EMA",
  series: IndicatorSeries.Price,
  precision: 2,
  calcParams: [9],
  figures: maFigures("EMA", false),
  styles: { lines: MA_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeMa(dataList, "ema", Number(ind.calcParams?.[0]) || 9, (ind.extendData ?? {}) as MaExtend),
};

export const MA_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "MA",
  series: IndicatorSeries.Price,
  precision: 2,
  calcParams: [20],
  figures: maFigures("MA", false),
  styles: { lines: MA_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeMa(dataList, "sma", Number(ind.calcParams?.[0]) || 20, (ind.extendData ?? {}) as MaExtend),
};

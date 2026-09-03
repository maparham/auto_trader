// TV-style single-line moving averages (EMA / MA). These deliberately REPLACE
// klinecharts' built-in multi-line EMA/MA so the settings modal can expose
// Source/Offset/Timeframe. Length in calcParams[0]; the rest ride on extendData
// (MaExtend). When mtf.timeframe is set, the higher-timeframe series is aligned
// onto the live chart bars inside calc (no lookahead).
import {
  type Indicator,
  type IndicatorDrawParams,
  type IndicatorTemplate,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import {
  maSeries, alignHtfToChart, normalizeMaKind, MA_KIND_LABEL, type MtfSeriesBase,
  type MaOptions, type MaKind,
} from "../mtf";
import { fullLine } from "./shared";
import { slopeStates, makeSlopeColorDraw, type SlopeState, type SlopeColorConfig } from "./slopeColor";

interface MaPoint {
  ma?: number;
  // Optional smoothing MA layered on top of the base line (TV plots it
  // separately, never overwriting `ma`). Undefined when smoothing is "none".
  smoothingMa?: number;
  // Envelope: the same-kind MA of high/low (LazyBear's evwma+/evwma-).
  // Undefined on every bar when extendData.envelope is off.
  bandHi?: number;
  bandLo?: number;
  // Rising/falling/flat classification of the plotted base line, for the
  // custom slope-colored draw (Task 3). Absent unless extendData.slopeColor
  // is enabled — see computeMa's MTF-safe handling below.
  slopeState?: SlopeState;
}

// Per-instance config for the TV-style moving averages, carried on the
// indicator's extendData (set by the settings modal / MTF coordinator). When
// `mtf.timeframe` is set, the higher-timeframe series + bar starts are stored
// here and aligned onto the live chart bars inside calc — so scroll-back fills
// in automatically (calc re-runs against the longer dataList).
export interface MaExtend extends MaOptions {
  // MtfSeriesBase carries the shared pin fields, including the forming-bar
  // ones ("Wait for timeframe closes" unchecked): waitClose, formingIdx and
  // the fold inputs the coordinator re-folds from on live ticks.
  mtf?: MtfSeriesBase & {
    htfStarts?: number[]; // HTF bar open timestamps (ms)
    htfSeries?: Array<number | undefined>; // MA value per HTF bar
    // Smoothing MA computed on the native HTF bars (before alignment, so it
    // never leaks across chart bars). Absent when smoothing is "none".
    htfSmoothing?: Array<number | undefined>;
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
  // Slope-state coloring (Task 1/3). Absent/disabled attaches nothing.
  slopeColor?: SlopeColorConfig;
}

// MA_KIND_LABEL now lives beside MaKind/normalizeMaKind in ../mtf, which has no
// RUNTIME klinecharts import, so klinecharts-free callers (the expression
// layer's instance list) can reuse the one label vocabulary. Re-exported here
// because this module is where every existing importer looks for it.
export { MA_KIND_LABEL };

/** The MA kind an EMA/MA menu type computes when extendData.maType is unset.
 * The ONE mapping from indicator type to default kind; every site that used to
 * inline `type === "EMA" ? "ema" : "sma"` goes through here. */
export function templateMaKind(type: string): MaKind {
  return type === "EMA" ? "ema" : "sma";
}

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
  fullLine("#FF9600", 'solid'), // ma (base)
  fullLine("#FFB300", 'dashed'), // smoothingMa
  fullLine("#F23645", 'solid'), // bandHi (envelope upper)
  fullLine("#089981", 'solid'), // bandLo (envelope lower)
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
    const chartTs = dataList.map((k) => k.timestamp);
    const htfBars = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    const aligned = alignHtfToChart(
      chartTs, htfBars, mtf.htfSeries, mtf.htfMs, true, mtf.formingIdx,
    );
    const smoothed = mtf.htfSmoothing
      ? alignHtfToChart(
          chartTs, htfBars, mtf.htfSmoothing, mtf.htfMs, true, mtf.formingIdx,
        )
      : undefined;
    // Slope states MUST be computed on the native HTF series (mtf.htfSeries),
    // never on `aligned` — the aligned staircase repeats each HTF value across
    // many chart bars, so a naive per-bar slope over it would read flat for
    // most of a held span and only move on the boundary bar. Classify on the
    // native series first, then forward-fill the STATES with the exact same
    // alignHtfToChart call shape used for the values above, so a rising HTF
    // span reads rising across its whole held span on the chart.
    const alignedStates = ext.slopeColor?.enabled
      ? alignHtfToChart(
          chartTs, htfBars,
          slopeStates(mtf.htfSeries, ext.slopeColor.len, ext.slopeColor.flatBandPct),
          mtf.htfMs, true, mtf.formingIdx,
        )
      : undefined;
    // NOTE: the envelope bands are intentionally NOT shown under MTF — the
    // stash carries the base + smoothing lines only. Bands apply on the
    // chart-TF path below.
    return aligned.map((v, i) => ({
      ma: v ?? undefined,
      smoothingMa: smoothed?.[i] ?? undefined,
      slopeState: alignedStates?.[i] as SlopeState | undefined,
    }));
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
  // Chart-TF path: classify directly on the plotted base line (no MTF
  // staircase to worry about).
  const states = ext.slopeColor?.enabled
    ? slopeStates(base, ext.slopeColor.len, ext.slopeColor.flatBandPct)
    : undefined;
  return base.map((v, i) => ({
    ma: v ?? undefined,
    smoothingMa: smoothing?.[i] ?? undefined,
    bandHi: bands?.hi[i] ?? undefined,
    bandLo: bands?.lo[i] ?? undefined,
    slopeState: states?.[i],
  }));
}

// EMA / MA: TV-style single-line MAs (length + source + offset + smoothing + MTF).
// Length in calcParams[0]; rest on extendData (MaExtend).
export const EMA_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "EMA",
  series: 'price',
  precision: 2,
  calcParams: [9],
  figures: maFigures("EMA", false),
  styles: { lines: MA_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeMa(dataList, "ema", Number(ind.calcParams?.[0]) || 9, (ind.extendData ?? {}) as MaExtend),
  draw: (params) => makeSlopeColorDraw("ma")(params as IndicatorDrawParams<Record<string, unknown>, unknown, unknown>),
};

export const MA_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "MA",
  series: 'price',
  precision: 2,
  calcParams: [20],
  figures: maFigures("MA", false),
  styles: { lines: MA_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeMa(dataList, "sma", Number(ind.calcParams?.[0]) || 20, (ind.extendData ?? {}) as MaExtend),
  draw: (params) => makeSlopeColorDraw("ma")(params as IndicatorDrawParams<Record<string, unknown>, unknown, unknown>),
};

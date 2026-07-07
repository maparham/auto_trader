// PivotBands: two price-pane step-lines tracking confirmed fractal swing highs
// and lows separately. Each line carries a value forward and only re-steps when a
// new pivot of that side CONFIRMS — reading as a dynamic support/resistance
// channel.
//
// No lookahead: a fractal pivot at bar i depends on the N bars to its right, so it
// is only known at bar i+N. Each line therefore holds its prior value across bars
// i … i+N-1 and steps to the new value at bar i+N. Consequence: the trailing N
// bars never contain a confirmed pivot (each line is flat at the right edge).
//
// Mode (extendData.mode):
//   - "last" (default): carry the single most recent confirmed pivot price.
//   - "avg": carry the average of the most recent K confirmed pivot prices
//     (calcParams[1]); before K pivots exist, average over however many do.
// calcParams = [N (strength), K (avg window)].
import {
  IndicatorSeries,
  LineType,
  type Indicator,
  type IndicatorTemplate,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import { fullLine } from "./shared";
import { isPivotAt } from "./pivots";
import { alignHtfToChart, priceOf, type PriceSource } from "../mtf";

export type PivotBandsMode = "last" | "avg";

// Price series the swings are detected on. "hl" (default) keeps the classic
// asymmetry — pivot-highs off each bar's high, pivot-lows off its low. Any other
// value is a single PriceSource used for BOTH lines (e.g. "close" detects swing
// highs AND lows on the close series).
export type PivotBandsSource = "hl" | PriceSource;

export interface PivotBandsExtend {
  mode?: PivotBandsMode;
  // Price series the swings are detected on (default "hl" = high for the
  // pivot-high line, low for the pivot-low line). See PivotBandsSource.
  source?: PivotBandsSource;
  // Multi-timeframe: compute the bands on a higher timeframe and align onto the
  // chart bars inside calc (no lookahead). Unlike EMA/MA this carries TWO series
  // — the pivot-high and pivot-low step-lines — since each is independent. Set by
  // the MTF coordinator (applyPivotBandsTimeframe); calc re-aligns on scroll-back.
  mtf?: {
    timeframe: string | null;
    htfStarts?: number[]; // HTF bar open timestamps (ms)
    htfHigh?: Array<number | undefined>; // pivotHigh step-value per HTF bar
    htfLow?: Array<number | undefined>; // pivotLow step-value per HTF bar
    htfMs?: number; // HTF bar duration (ms)
  };
  // Legend toggle (settings modal): hide this indicator's value from the legend.
  hideLegendValue?: boolean;
}

interface PivotBandsPoint {
  pivotHigh?: number;
  pivotLow?: number;
}

const PIVOT_BANDS_FIGURES = [
  { key: "pivotHigh", title: "Pivot High: ", type: "line" },
  { key: "pivotLow", title: "Pivot Low: ", type: "line" },
];

// Pivot-high line red-ish (resistance), pivot-low line green-ish (support).
const PIVOT_BANDS_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine("#EF5350", LineType.Solid), // pivotHigh
  fullLine("#26A69A", LineType.Solid), // pivotLow
];

// Held value for one side given the confirmed pivot prices SO FAR (most recent
// last). "last" → the newest pivot; "avg" → mean of the newest K.
function heldValue(pivots: number[], mode: PivotBandsMode, k: number): number {
  if (mode === "avg") {
    const window = pivots.slice(Math.max(0, pivots.length - k));
    return window.reduce((a, b) => a + b, 0) / window.length;
  }
  return pivots[pivots.length - 1];
}

export function computePivotBands(
  dataList: KLineData[],
  n: number,
  k: number,
  ext: PivotBandsExtend,
): PivotBandsPoint[] {
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfStarts && mtf.htfHigh && mtf.htfLow && mtf.htfMs) {
    // Multi-timeframe: align the precomputed higher-timeframe step-lines onto the
    // live chart bars. Each chart bar takes the most recent CLOSED HTF bar
    // (waitClose=true), so the HTF confirmation lag already baked into the series
    // is preserved and no chart bar sees a pivot from an HTF bar closing later.
    // The step-lines carry values forward (heldValue), so the aligned series is
    // gap-free after the first pivot — exactly what alignHtfToChart's
    // last-usable-bar rule needs.
    const ts = dataList.map((k) => k.timestamp);
    const htfBars = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    const high = alignHtfToChart(ts, htfBars, mtf.htfHigh, mtf.htfMs, true);
    const low = alignHtfToChart(ts, htfBars, mtf.htfLow, mtf.htfMs, true);
    return ts.map((_, i) => ({ pivotHigh: high[i] ?? undefined, pivotLow: low[i] ?? undefined }));
  }

  const mode: PivotBandsMode = ext.mode === "avg" ? "avg" : "last";
  const len = dataList.length;
  const out: PivotBandsPoint[] = new Array(len);
  // Default "hl": swing-highs off the high series, swing-lows off the low series.
  // Any other source drives BOTH sides off that single series.
  const src = ext.source && ext.source !== "hl" ? ext.source : null;
  const highs = src ? dataList.map((d) => priceOf(d, src)) : dataList.map((d) => d.high);
  const lows = src ? dataList.map((d) => priceOf(d, src)) : dataList.map((d) => d.low);

  // Pre-compute the confirmed pivot prices, keyed by the bar where they CONFIRM
  // (pivot at bar i confirms at i+N). Strict extremes (no flat tops/bottoms).
  const highPivotAtConfirm = new Map<number, number>();
  const lowPivotAtConfirm = new Map<number, number>();
  for (let i = 0; i < len; i++) {
    if (isPivotAt(highs, i, n, n, "high", true)) highPivotAtConfirm.set(i + n, highs[i]);
    if (isPivotAt(lows, i, n, n, "low", true)) lowPivotAtConfirm.set(i + n, lows[i]);
  }

  const highPivots: number[] = [];
  const lowPivots: number[] = [];
  for (let i = 0; i < len; i++) {
    const h = highPivotAtConfirm.get(i);
    if (h !== undefined) highPivots.push(h);
    const l = lowPivotAtConfirm.get(i);
    if (l !== undefined) lowPivots.push(l);
    out[i] = {
      pivotHigh: highPivots.length ? heldValue(highPivots, mode, k) : undefined,
      pivotLow: lowPivots.length ? heldValue(lowPivots, mode, k) : undefined,
    };
  }
  return out;
}

// PivotBands: fractal swing-high / swing-low step-lines. Strength in calcParams[0],
// average window K in calcParams[1]; Mode on extendData.
export const PIVOT_BANDS_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Pivot Bands",
  series: IndicatorSeries.Price,
  precision: 2,
  calcParams: [5, 3],
  figures: PIVOT_BANDS_FIGURES,
  styles: { lines: PIVOT_BANDS_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computePivotBands(
      dataList,
      Math.max(1, Number(ind.calcParams?.[0]) || 5),
      Math.max(1, Number(ind.calcParams?.[1]) || 3),
      (ind.extendData ?? {}) as PivotBandsExtend,
    ),
};

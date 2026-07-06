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

export type PivotBandsMode = "last" | "avg";

export interface PivotBandsExtend {
  mode?: PivotBandsMode;
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
  const mode: PivotBandsMode = ext.mode === "avg" ? "avg" : "last";
  const len = dataList.length;
  const out: PivotBandsPoint[] = new Array(len);
  const highs = dataList.map((d) => d.high);
  const lows = dataList.map((d) => d.low);

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

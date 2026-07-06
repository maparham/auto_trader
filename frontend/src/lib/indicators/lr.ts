// Linear Regression Channel (TradingView "LR") — a least-squares line fit over
// the LAST `length` bars plus an upper/lower channel at ±mult·σ. Unlike the
// moving averages this is NOT a per-bar rolling value: it's a single line fit
// over one fixed window (the most recent `length` bars), so every bar BEFORE the
// window is blank. Recomputes as new bars arrive / on scroll-back.
import {
  IndicatorSeries,
  LineType,
  type Indicator,
  type IndicatorTemplate,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import { priceOf, type PriceSource } from "../mtf";
import { fullLine } from "./shared";

interface LrPoint {
  lr?: number; // regression line
  up?: number; // upper channel (lr + mult·σ)
  dn?: number; // lower channel (lr − mult·σ)
}

export interface LrExtend {
  source?: PriceSource; // default close (TV default for LR)
  hideLegendValue?: boolean;
  // Per-line show/hide (Style tab), keyed by figure key (lr/up/dn).
  lineHidden?: Record<string, boolean>;
}

// LR base orange (matches the VWAP/MA palette) with the channel bands at lower
// opacity so they read as the regression's envelope, not separate lines.
const LR_C = "#FF9600";
const LR_BAND = "rgba(255, 150, 0, 0.6)";
const LR_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine(LR_C, LineType.Solid), // lr
  { ...fullLine(LR_BAND, LineType.Solid), dashedValue: [0, 0] }, // up (solid, faint)
  { ...fullLine(LR_BAND, LineType.Solid), dashedValue: [0, 0] }, // dn
];

export function computeLr(
  dataList: KLineData[],
  length: number,
  mult: number,
  ext: LrExtend,
): LrPoint[] {
  const source = ext.source ?? "close";
  const hidden = ext.lineHidden ?? {};
  const out: LrPoint[] = dataList.map(() => ({}));
  const n = Math.min(length, dataList.length);
  if (n < 2) return out; // need at least 2 points to fit a line
  const start = dataList.length - n;
  // Least-squares fit y = a + b·x over x = 0..n-1 (x is the bar's offset within
  // the window). Closed-form slope/intercept; then σ = RMS of residuals.
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = priceOf(dataList[start + i], source);
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const y = priceOf(dataList[start + i], source);
    const fit = intercept + slope * i;
    sse += (y - fit) * (y - fit);
  }
  const sigma = Math.sqrt(sse / n);
  const width = mult * sigma;
  for (let i = 0; i < n; i++) {
    const lr = intercept + slope * i;
    const point: LrPoint = {};
    if (!hidden.lr) point.lr = lr;
    if (!hidden.up) point.up = lr + width;
    if (!hidden.dn) point.dn = lr - width;
    out[start + i] = point;
  }
  return out;
}

// TV-style Linear Regression Channel: regression line + ±mult·σ channel over the
// last `length` bars. calcParams = [length, mult]; source/visibility on extendData
// (LrExtend). Bands share the line's hue (LR_DEFAULT_LINE_STYLES).
export const LR_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "LR",
  series: IndicatorSeries.Price,
  precision: 2,
  calcParams: [100, 2],
  figures: [
    { key: "lr", title: "LR: ", type: "line" },
    { key: "up", type: "line" },
    { key: "dn", type: "line" },
  ],
  styles: { lines: LR_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeLr(
      dataList,
      Number(ind.calcParams?.[0]) || 100,
      Number(ind.calcParams?.[1]) || 2,
      (ind.extendData ?? {}) as LrExtend,
    ),
};

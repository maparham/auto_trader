// TV-style Average True Range sub-pane. Length in calcParams[0]; Smoothing
// (RMA default / SMA / EMA / WMA — Pine's ma_function(ta.tr(true), length))
// rides on extendData (AtrExtend). Math lives in ../atr so the backtest series
// and the backend port (indicators/atr.py) share one implementation.
import type { Indicator, IndicatorTemplate, KLineData } from "klinecharts";
import {
  atrSeries,
  atrLength,
  normalizeAtrSmoothing,
  normalizeAtrPctSource,
  type AtrExtend,
} from "../atr";
import { priceOf } from "../mtf";
import { fullLine } from "./shared";

export interface AtrPoint {
  atr?: number;
  /** ATR as % of the bar's pctSource price — legend readout only, never plotted. */
  atrPct?: number;
}

export function computeAtr(dataList: KLineData[], ind: Indicator): AtrPoint[] {
  const length = atrLength(ind.calcParams as unknown[]);
  const ext = ind.extendData as AtrExtend | undefined;
  const smoothing = normalizeAtrSmoothing(ext?.smoothing);
  const pctSource = normalizeAtrPctSource(ext?.pctSource);
  return atrSeries(dataList, length, smoothing).map((v, i) => {
    if (v == null) return {};
    const price = priceOf(dataList[i], pctSource);
    return { atr: v, atrPct: price > 0 ? (v / price) * 100 : undefined };
  });
}

export const ATR_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "ATR",
  series: "normal",
  precision: 2,
  calcParams: [14],
  figures: [
    { key: "atr", title: "ATR: ", type: "line" },
    // No `type`: klinecharts draws nothing for it, but the DOM legend
    // (ChartLegend) still shows the value. `suffix` is the legend's cue to
    // append "%" after the formatted number.
    { key: "atrPct", title: "ATR%: ", ...{ suffix: "%" } },
  ],
  styles: { lines: [fullLine("#B71C1C", "solid")] }, // TV's ATR red
  calc: computeAtr,
};

// TV-style Average True Range sub-pane. Length in calcParams[0]; Smoothing
// (RMA default / SMA / EMA / WMA — Pine's ma_function(ta.tr(true), length))
// rides on extendData (AtrExtend). Math lives in ../atr so the backtest series
// and the backend port (indicators/atr.py) share one implementation.
import type { Indicator, IndicatorTemplate, KLineData } from "klinecharts";
import { atrSeries, atrLength, normalizeAtrSmoothing, type AtrExtend } from "../atr";
import { fullLine } from "./shared";

export interface AtrPoint {
  atr?: number;
}

export function computeAtr(dataList: KLineData[], ind: Indicator): AtrPoint[] {
  const length = atrLength(ind.calcParams as unknown[]);
  const smoothing = normalizeAtrSmoothing((ind.extendData as AtrExtend | undefined)?.smoothing);
  return atrSeries(dataList, length, smoothing).map((v) => ({ atr: v ?? undefined }));
}

export const ATR_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "ATR",
  series: "normal",
  precision: 4,
  calcParams: [14],
  figures: [{ key: "atr", title: "ATR: ", type: "line" }],
  styles: { lines: [fullLine("#B71C1C", "solid")] }, // TV's ATR red
  calc: computeAtr,
};

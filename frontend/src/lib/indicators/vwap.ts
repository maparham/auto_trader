// VWAP and Anchored VWAP (AVWAP), both plotting on the price (candle) pane.
//
// VWAP  = cumΣ(typical·vol) / cumΣ(vol), typical = (h+l+c)/3, from the first bar.
// AVWAP = same, but accumulation starts at an ANCHOR timestamp (calcParams[0]).
//         Default anchor 0 → first bar (≡ VWAP) until the user sets one.
import {
  type Indicator,
  type IndicatorTemplate,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import { priceOf, type PriceSource } from "../mtf";
import { fullLine } from "./shared";

interface VwapPoint {
  vwap?: number;
  // Band lines, present only for enabled bands (calc omits the key otherwise, so
  // klinecharts draws no line). Up/dn are the upper/lower of each multiplier.
  up1?: number;
  dn1?: number;
  up2?: number;
  dn2?: number;
  up3?: number;
  dn3?: number;
}

// AVWAP band configuration carried on extendData (set by the settings modal).
// `mode` picks the band width formula; `bands[k]` enables multiplier k with its
// factor. Mirrors TradingView's "Bands Settings".
export type BandMode = "stdev" | "percentage";
export interface BandSetting {
  on: boolean;
  mult: number;
}
export interface AvwapExtend {
  source?: PriceSource; // default hlc3 (standard VWAP typical price)
  bandMode?: BandMode; // default "stdev"
  bands?: [BandSetting, BandSetting, BandSetting];
  // Per-line show/hide (Style tab, TradingView-style). Keyed by figure key
  // (vwap/up1/dn1/…); calc OMITS a hidden line's output key so klinecharts draws
  // nothing for it. Default (absent) = every line visible.
  lineHidden?: Record<string, boolean>;
  hideLegendValue?: boolean;
}

export const AVWAP_DEFAULT_BANDS: [BandSetting, BandSetting, BandSetting] = [
  { on: true, mult: 1 }, // TV ships band #1 enabled
  { on: false, mult: 2 },
  { on: false, mult: 3 },
];

// Default per-figure line styles for AVWAP. The bands must read as the VWAP's
// ENVELOPE, not as separate AVWAP lines — so all band lines share the VWAP's
// orange hue (TradingView convention), dashed and thinner, distinguished by
// multiplier only via opacity (band #1 boldest, #3 faintest).
// VWAP orange at decreasing alpha for the three band multipliers, so a band reads
// as a fainter echo of the AVWAP line rather than an independent indicator.
const BAND_C1 = "rgba(255, 150, 0, 0.9)";
const BAND_C2 = "rgba(255, 150, 0, 0.6)";
const BAND_C3 = "rgba(255, 150, 0, 0.4)";
const AVWAP_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine("#FF9600", 'solid'), // vwap
  fullLine(BAND_C1, 'dashed'), // up1
  fullLine(BAND_C1, 'dashed'), // dn1
  fullLine(BAND_C2, 'dashed'), // up2
  fullLine(BAND_C2, 'dashed'), // dn2
  fullLine(BAND_C3, 'dashed'), // up3
  fullLine(BAND_C3, 'dashed'), // dn3
];

// Volume-weighted VWAP + standard-deviation/percentage bands, accumulated from
// startIndex. The band stdev is the volume-weighted deviation of the source price
// from the running VWAP: variance = Σ(p²·vol)/Σvol − vwap², clamped at 0 (FP drift
// makes it slightly negative on near-flat data, and sqrt(NaN) would blank lines).
export function vwapFrom(
  dataList: KLineData[],
  startIndex: number,
  ext: AvwapExtend,
): VwapPoint[] {
  const source = ext.source ?? "hlc3";
  const mode = ext.bandMode ?? "stdev";
  const bands = ext.bands ?? AVWAP_DEFAULT_BANDS;
  const hidden = ext.lineHidden ?? {};
  const out: VwapPoint[] = [];
  let cumPV = 0;
  let cumPPV = 0; // Σ(price²·vol), for the volume-weighted variance
  let cumV = 0;
  for (let i = 0; i < dataList.length; i++) {
    if (i < startIndex) {
      out.push({});
      continue;
    }
    const k = dataList[i];
    const price = priceOf(k, source);
    const vol = k.volume ?? 0;
    cumPV += price * vol;
    cumPPV += price * price * vol;
    cumV += vol;
    // VWAP is undefined without traded volume. Most Capital CFD/forex epics report
    // 0 volume (backend reads `lastTradedVolume or 0.0`) and tick candles are always
    // volume 0, so cumV stays 0 — emit NOTHING rather than fall back to the raw
    // price, which used to plot VWAP as the price line with collapsed bands and read
    // as a working indicator. Once any bar carries volume, cumV > 0 and VWAP plots.
    if (cumV <= 0) {
      out.push({});
      continue;
    }
    // Compute vwap unconditionally (bands need it for vwap ± width), but only
    // EMIT the vwap line key when it isn't hidden — a hidden line omits its key
    // so klinecharts draws nothing (and the drag handle / legend value drop too).
    const vwap = cumPV / cumV;
    const point: VwapPoint = {};
    if (!hidden.vwap) point.vwap = vwap;
    // Band width: stdev (volume-weighted) or a flat percentage of the VWAP.
    const stdev =
      mode === "stdev" && cumV > 0
        ? Math.sqrt(Math.max(0, cumPPV / cumV - vwap * vwap))
        : 0;
    const keys: Array<["up1" | "up2" | "up3", "dn1" | "dn2" | "dn3"]> = [
      ["up1", "dn1"],
      ["up2", "dn2"],
      ["up3", "dn3"],
    ];
    for (let b = 0; b < 3; b++) {
      if (!bands[b]?.on) continue;
      const width = mode === "stdev" ? bands[b].mult * stdev : vwap * (bands[b].mult / 100);
      const [upKey, dnKey] = keys[b];
      if (!hidden[upKey]) point[upKey] = vwap + width;
      if (!hidden[dnKey]) point[dnKey] = vwap - width;
    }
    out.push(point);
  }
  return out;
}

export const VWAP_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "VWAP",
  series: 'price',
  precision: 2,
  figures: [{ key: "vwap", title: "VWAP: ", type: "line" }],
  calc: (dataList: KLineData[]) => vwapFrom(dataList, 0, {}),
};

export const AVWAP_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "AVWAP",
  series: 'price',
  precision: 2,
  // calcParams[0] = anchor timestamp (ms). <= 0 means "unplaced": render no line
  // until the user anchors it by clicking a bar (TradingView-style).
  calcParams: [0],
  // Figure 0 is the VWAP line (kept first so the drag handle in ChartCore reads
  // result[idx].vwap). The 6 band lines follow; calc omits the key for disabled
  // bands so klinecharts draws nothing. Source + bands ride on extendData
  // (AvwapExtend); the anchor-param / legend-value hiding live in the shared
  // legendTooltipSource attached at creation. Band titles are blank so they don't
  // clutter the legend value row.
  figures: [
    { key: "vwap", title: "Value: ", type: "line" },
    { key: "up1", type: "line" },
    { key: "dn1", type: "line" },
    { key: "up2", type: "line" },
    { key: "dn2", type: "line" },
    { key: "up3", type: "line" },
    { key: "dn3", type: "line" },
  ],
  styles: { lines: AVWAP_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], indicator: Indicator) => {
    const anchorTs = Number(indicator.calcParams?.[0]) || 0;
    if (anchorTs <= 0) return dataList.map(() => ({})); // unplaced: no line yet
    const idx = dataList.findIndex((k) => k.timestamp >= anchorTs);
    const start = idx < 0 ? dataList.length : idx;
    return vwapFrom(dataList, start, (indicator.extendData ?? {}) as AvwapExtend);
  },
};

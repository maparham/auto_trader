// PivotBarsSince: the Pivot Bands pane's optional companion — two sub-pane
// curves counting the BARS SINCE the most recent confirmed swing high / swing
// low. Both are rule operands on the PARENT instance
// ("PIVOT_BANDS.barsSinceHigh"), like Slope's accel: see pivotBandsOutputs.ts.
//
// Derived state, never added on its own: the parent PIVOT_BANDS instance owns
// the toggle (extendData.showBarsSince) and every param, and lib/indicators.ts
// mints the companion instance from it (syncPivotBarsSinceCompanion), exactly
// as the Slope pane owns its acceleration companion.
//
// WHAT THE VALUE COUNTS. The count is measured from the PIVOT BAR, not from the
// bar the pivot confirmed on — the same convention as PIVOT_ANALYSIS's Δt
// (deltaT = i - prevIndex, bars between the two swing BARS). A fractal pivot at
// bar i is only known at bar i+N, so the curve steps down to N (never to 0) at
// each confirmation and then rises by one per bar. Reading it: a rising line
// means the market has not printed a new swing on that side; the height is how
// long ago the swing itself happened.
//
// Undefined until the first pivot of that side confirms (blank left edge, like
// the parent's step-lines).
import {
  type Indicator,
  type IndicatorTemplate,
  type KLineData,
} from "klinecharts";
import { fullLine } from "./shared";
import { isPivotAt } from "./pivots";
import { alignHtfToChart, priceOf } from "../mtf";
import type { PivotBandsExtend } from "./pivotBands";

export interface PivotBarsSincePoint {
  barsSinceHigh?: number;
  barsSinceLow?: number;
}

const PIVOT_BARS_SINCE_FIGURES = [
  { key: "barsSinceHigh", title: "Bars since high: ", type: "line" },
  { key: "barsSinceLow", title: "Bars since low: ", type: "line" },
];

// Same colors as the parent's bands: high-side red-ish, low-side green-ish, so
// line N means the same thing in both panes.
const PIVOT_BARS_SINCE_DEFAULT_LINE_STYLES = [
  fullLine("#EF5350", 'solid'), // barsSinceHigh
  fullLine("#26A69A", 'solid'), // barsSinceLow
];

/** Bars-since-last-confirmed-pivot per side, from the pivot BAR (see header). */
export function computePivotBarsSince(
  dataList: KLineData[],
  n: number,
  ext: PivotBandsExtend,
): PivotBarsSincePoint[] {
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfStarts && mtf.htfBarsSinceHigh && mtf.htfBarsSinceLow && mtf.htfMs) {
    // Multi-timeframe: the counts were made on the HIGHER timeframe's bars by
    // the coordinator, so the unit here is HTF bars — the number holds flat
    // across the chart bars inside one HTF bar. Aligned exactly like the
    // parent's step-lines (waitClose: a chart bar only ever sees a CLOSED HTF
    // bar, so no lookahead).
    const ts = dataList.map((k) => k.timestamp);
    const htfBars = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    const high = alignHtfToChart(ts, htfBars, mtf.htfBarsSinceHigh, mtf.htfMs, true);
    const low = alignHtfToChart(ts, htfBars, mtf.htfBarsSinceLow, mtf.htfMs, true);
    return ts.map((_, i) => ({ barsSinceHigh: high[i] ?? undefined, barsSinceLow: low[i] ?? undefined }));
  }

  const len = dataList.length;
  const out: PivotBarsSincePoint[] = new Array(len);
  // Same source rule as computePivotBands: "hl" (default) detects highs on the
  // high series and lows on the low series; any other source drives both.
  const src = ext.source && ext.source !== "hl" ? ext.source : null;
  const highs = src ? dataList.map((d) => priceOf(d, src)) : dataList.map((d) => d.high);
  const lows = src ? dataList.map((d) => priceOf(d, src)) : dataList.map((d) => d.low);

  // Pivot BAR index keyed by the bar it CONFIRMS on (pivot at i confirms at i+N).
  const highPivotAtConfirm = new Map<number, number>();
  const lowPivotAtConfirm = new Map<number, number>();
  for (let i = 0; i < len; i++) {
    if (isPivotAt(highs, i, n, n, "high", true)) highPivotAtConfirm.set(i + n, i);
    if (isPivotAt(lows, i, n, n, "low", true)) lowPivotAtConfirm.set(i + n, i);
  }

  let lastHigh = -1;
  let lastLow = -1;
  for (let i = 0; i < len; i++) {
    const h = highPivotAtConfirm.get(i);
    if (h !== undefined) lastHigh = h;
    const l = lowPivotAtConfirm.get(i);
    if (l !== undefined) lastLow = l;
    out[i] = {
      barsSinceHigh: lastHigh >= 0 ? i - lastHigh : undefined,
      barsSinceLow: lastLow >= 0 ? i - lastLow : undefined,
    };
  }
  return out;
}

// PIVOT_BARS_SINCE: strength in calcParams[0] (calcParams are copied wholesale from the
// parent, so calcParams[1] is the parent's avg window K — irrelevant here: the
// age tracks the LAST pivot regardless of the parent's Mode).
export const PIVOT_BARS_SINCE_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Bars Since Pivot",
  series: 'normal',
  precision: 0,
  calcParams: [5, 3],
  figures: PIVOT_BARS_SINCE_FIGURES,
  styles: { lines: PIVOT_BARS_SINCE_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computePivotBarsSince(
      dataList,
      Math.max(1, Number(ind.calcParams?.[0]) || 5),
      (ind.extendData ?? {}) as PivotBandsExtend,
    ),
};

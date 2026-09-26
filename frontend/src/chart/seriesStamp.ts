// Which series a chart's loaded bars ARE. The chart declares a new symbol and
// timeframe (setSymbol/setPeriod) BEFORE the awaited fetch, so for a second or
// two getDataList() still returns the previous series under the new names. The
// load effect clears this stamp when a run starts and sets it only once bars
// for that run are painted, so a reader borrowing the bars (the order ticket's
// ATR) can tell the live series from a stale, replayed or detached one.

import type { Chart } from "klinecharts";

export interface SeriesStamp {
  epic: string;
  resolution: string;
  /** False for a replay slice or a detached Go-to-date window. */
  live: boolean;
}

const stamps = new WeakMap<Chart, SeriesStamp>();

export function stampChartSeries(chart: Chart, stamp: SeriesStamp | null): void {
  if (stamp) stamps.set(chart, stamp);
  else stamps.delete(chart);
}

export function chartSeriesStamp(chart: Chart): SeriesStamp | undefined {
  return stamps.get(chart);
}

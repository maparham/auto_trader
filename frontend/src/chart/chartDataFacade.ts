// v10 data-pipeline facade. klinecharts v10 replaced the v9 imperative data
// methods (applyNewData / updateData / setLoadDataCallback /
// setPriceVolumePrecision) with a single pull-based DataLoader plus
// setSymbol/setPeriod. We own the data, so this facade keeps the old
// push-based shape: setBars stores a full dataset and asks the chart to
// re-pull it, pushBar forwards a realtime tick to the subscribed callback, and
// onLoadRequest answers the chart's left/right edge loads.
import type { Chart, KLineData, DataLoadMore, Period } from "klinecharts";

export interface ChartDataFacade {
  /** Wire the facade into a chart: calls chart.setDataLoader once. */
  attach(chart: Chart): void;
  /** Declare instrument + precision. Calls chart.setSymbol. Triggers getBars(init). */
  setSymbol(ticker: string, pricePrecision: number, volumePrecision: number): void;
  /** Declare the timeframe. Calls chart.setPeriod. Triggers getBars(init). */
  setPeriod(period: Period): void;
  /** Full dataset replacement (was applyNewData). Stores bars and calls chart.resetData(). */
  setBars(bars: KLineData[], more: DataLoadMore): void;
  /** Realtime bar tick (was chart.updateData). Forwards to the captured subscribeBar callback. */
  pushBar(bar: KLineData): void;
  /** Handler invoked when the chart hits the left/right edge (was setLoadDataCallback). */
  onLoadRequest: (type: "forward" | "backward", timestamp: number | null,
                  done: (bars: KLineData[], more: DataLoadMore) => void) => void;
  getBars(): KLineData[];
}

export function createChartDataFacade(): ChartDataFacade {
  let chart: Chart | null = null;
  let bars: KLineData[] = [];
  let more: DataLoadMore = false;
  let subscribe: ((bar: KLineData) => void) | null = null;
  // v10's ChartImp.setSymbol/setPeriod guard by REFERENCE equality, and we mint
  // fresh objects every call, so every pass-through re-fires getBars(init). That
  // re-serves the facade's stored bars, truncating any natively scroll-back-paged
  // history (e.g. the precision effect re-declaring an unchanged symbol). Cache
  // the last declared values and no-op on value-equal input.
  let lastSymbol: { ticker: string; pricePrecision: number; volumePrecision: number } | null = null;
  let lastPeriod: Period | null = null;

  const facade: ChartDataFacade = {
    onLoadRequest: (_type, _ts, done) => done([], false),
    attach(c) {
      chart = c;
      c.setDataLoader({
        getBars: ({ type, timestamp, callback }) => {
          if (type === "init" || type === "update") {
            callback(bars, more);
            return;
          }
          facade.onLoadRequest(type, timestamp, callback);
        },
        subscribeBar: ({ callback }) => { subscribe = callback; },
        unsubscribeBar: () => { subscribe = null; },
      });
    },
    setSymbol(ticker, pricePrecision, volumePrecision) {
      if (
        lastSymbol &&
        lastSymbol.ticker === ticker &&
        lastSymbol.pricePrecision === pricePrecision &&
        lastSymbol.volumePrecision === volumePrecision
      ) {
        return;
      }
      if (!chart) return; // don't cache a value the chart never received
      lastSymbol = { ticker, pricePrecision, volumePrecision };
      chart.setSymbol(lastSymbol);
    },
    setPeriod(period: Period) {
      if (lastPeriod && lastPeriod.span === period.span && lastPeriod.type === period.type) return;
      if (!chart) return; // don't cache a value the chart never received
      lastPeriod = period;
      chart.setPeriod(period);
    },
    setBars(next, nextMore) {
      bars = next;
      more = nextMore;
      chart?.resetData();
    },
    pushBar(bar) {
      subscribe?.(bar);
    },
    getBars: () => bars,
  };
  return facade;
}

// Map an app timeframe label (feed.ts Period.label: 1m 3m 5m 15m 30m 1H 4H 1D
// 1W 2W 3W 6W 1M 2M 3M 1Y, plus live-only seconds 1s..45s) to a v10 Period.
// Lowercase m = minute, uppercase M = month; lowercase s = second.
const PERIOD_TYPE_BY_UNIT = {
  s: "second",
  m: "minute",
  H: "hour",
  D: "day",
  W: "week",
  M: "month",
  Y: "year",
} as const;

type PeriodUnit = keyof typeof PERIOD_TYPE_BY_UNIT;

export function periodFromTf(tf: string): Period {
  const m = /^(\d+)(s|m|H|D|W|M|Y)$/.exec(tf);
  if (!m) throw new Error(`unknown timeframe: ${tf}`);
  const span = Number(m[1]);
  const type = PERIOD_TYPE_BY_UNIT[m[2] as PeriodUnit];
  return { span, type };
}

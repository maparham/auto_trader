// Multi-timeframe (MTF) core: compute an indicator on a higher timeframe (HTF)
// than the chart and align the result back onto the chart's bars. klinecharts'
// indicator `calc` is synchronous and only sees the chart's dataList, so the HTF
// series is fetched + computed outside the chart and injected via the indicator's
// `extendData` (see customIndicators). This module holds the two pure, testable
// pieces: the price-source/EMA math and — the correctness crux — the closed-bar
// alignment that must NOT leak future information onto past bars.

import type { KLineData } from "klinecharts";

export type PriceSource =
  | "close"
  | "open"
  | "high"
  | "low"
  | "hl2"
  | "hlc3"
  | "ohlc4"
  | "hlcc4";

// Fields common to every MTF indicator's extendData.mtf, regardless of how many
// value series it carries. Enough for the scroll-back coverage guard and the
// refresh dispatcher to read timeframe/reach without knowing the series shape.
export interface MtfSeriesBase {
  timeframe: string | null;
  htfStarts?: number[];
  htfMs?: number;
}

export function priceOf(k: KLineData, src: PriceSource): number {
  switch (src) {
    case "open": return k.open;
    case "high": return k.high;
    case "low": return k.low;
    case "hl2": return (k.high + k.low) / 2;
    case "hlc3": return (k.high + k.low + k.close) / 3;
    case "ohlc4": return (k.open + k.high + k.low + k.close) / 4;
    case "hlcc4": return (k.high + k.low + k.close + k.close) / 4;
    case "close":
    default: return k.close;
  }
}

/** Exponential moving average. out[i] is undefined only for an empty input. */
function ema(values: number[], length: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined);
  if (length < 1) return out;
  const k = 2 / (length + 1);
  let prev: number | undefined;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = prev === undefined ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Simple moving average over `length` (undefined until enough samples). */
export function sma(values: number[], length: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined);
  if (length < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

export interface MaOptions {
  source?: PriceSource;
  offset?: number;
  smoothing?: { type: "none" | "sma" | "ema"; length: number };
}

/** Result of {@link maSeries}: the base MA and (when enabled) a separate
 * smoothing MA layered on top — matching TradingView, which plots the smoothing
 * MA as its own line rather than replacing the base. `smoothing` is undefined
 * when the smoothing type is "none". */
export interface MaSeries {
  base: Array<number | undefined>;
  smoothing?: Array<number | undefined>;
}

/**
 * The moving-average lines for a set of bars: source price -> EMA/SMA (base),
 * plus an optional smoothing MA of that base. Used identically for the chart
 * timeframe and (on HTF bars) for the multi-timeframe path, so a given config
 * yields the same math regardless of where it runs.
 *
 * Like TradingView, the smoothing MA is a SEPARATE line, not an overwrite of the
 * base. `offset` shifts the base line only — TV's offset is on plot(out), not on
 * the smoothing plot — so the smoothing MA is computed from, and stays aligned
 * with, the UNshifted base.
 */
export function maSeries(
  bars: KLineData[],
  kind: "ema" | "sma",
  length: number,
  opt: MaOptions = {},
): MaSeries {
  const prices = bars.map((k) => priceOf(k, opt.source ?? "close"));
  const base = kind === "ema" ? ema(prices, length) : sma(prices, length);

  let smoothing: Array<number | undefined> | undefined;
  const sm = opt.smoothing;
  if (sm && sm.type !== "none" && sm.length > 0) {
    // Smooth only the defined tail. The base MA leads with `undefined` warmup
    // values; feeding those (as NaN) into ema/sma would poison every later value
    // and blank the whole line. The defined values are contiguous, so we slice
    // from the first one, smooth, and keep the warmup gap untouched.
    const start = base.findIndex((v) => v != null);
    if (start !== -1) {
      const defined = base.slice(start) as number[];
      const smoothed = sm.type === "ema" ? ema(defined, sm.length) : sma(defined, sm.length);
      const out: Array<number | undefined> = new Array(base.length).fill(undefined);
      for (let i = 0; i < smoothed.length; i++) out[start + i] = smoothed[i];
      smoothing = out;
    }
  }

  return {
    base: opt.offset ? applyOffset(base, opt.offset) : base,
    smoothing,
  };
}

/** Shift a series forward (offset > 0 plots it `offset` bars later). */
function applyOffset(
  series: Array<number | undefined>,
  offset: number,
): Array<number | undefined> {
  if (!offset) return series;
  const out: Array<number | undefined> = new Array(series.length).fill(undefined);
  for (let i = 0; i < series.length; i++) {
    const j = i + offset;
    if (j >= 0 && j < series.length) out[j] = series[i];
  }
  return out;
}

// A few extra HTF bars of warmup beyond the exact MA length, so tiny rounding
// at the span edge never leaves the oldest visible bar in the unconverged zone.
export const HTF_WARMUP_BARS = 10;

/**
 * The oldest timestamp an MTF indicator's HTF series must reach so it stays
 * drawn across the chart's whole *loaded* span — not just the most-recent bars.
 *
 * `alignHtfToChart` blanks any chart bar older than the oldest HTF bar it was
 * given, so the HTF fetch must reach back to the oldest loaded chart bar. It
 * must also reach `length` HTF bars *before* that, or the MA's warmup zone (SMA
 * undefined / EMA not yet converged) would land on the oldest visible bars and
 * show a blank or kinked line there — the load-bearing term of the fix.
 */
export function htfCoverageStartMs(
  oldestChartMs: number,
  htfMs: number,
  length: number,
): number {
  if (!(htfMs > 0)) return oldestChartMs;
  return oldestChartMs - (Math.max(1, length) + HTF_WARMUP_BARS) * htfMs;
}

/**
 * Map an HTF value series onto chart bars without lookahead.
 *
 * Each chart bar at time `t` takes the value of the most recent HTF bar that is
 * already "usable" at `t`. With waitClose=true (the only v1 mode) an HTF bar is
 * usable only at/after its CLOSE time (open timestamp + htfMs); with
 * waitClose=false it is usable from its open. Both input arrays must be sorted
 * ascending by time and `htfValues[i]` corresponds to `htfBars[i]`.
 *
 * The closed-bar rule is the whole point: a chart bar must never see an HTF bar
 * that closes in its future, or any backtest reading the indicator gains
 * hindsight and silently overstates itself.
 */
export function alignHtfToChart(
  chartTimestamps: number[],
  htfBars: KLineData[],
  htfValues: Array<number | undefined>,
  htfMs: number,
  waitClose = true,
): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(chartTimestamps.length).fill(undefined);
  let j = -1; // index of the last HTF bar usable so far
  for (let i = 0; i < chartTimestamps.length; i++) {
    const t = chartTimestamps[i];
    while (j + 1 < htfBars.length) {
      const next = htfBars[j + 1];
      const usableAt = waitClose ? next.timestamp + htfMs : next.timestamp;
      if (usableAt <= t) j++;
      else break;
    }
    if (j >= 0) out[i] = htfValues[j];
  }
  return out;
}

// Computes each indicator series a BacktestConfig references, keyed by the
// seriesName contract (backtestConfig.ts) so the backend can validate every
// name it needs is present without knowing anything about indicator math.
//
// An operand may name a higher timeframe than the run's base (op.timeframe): for
// those we fetch that timeframe's candles, compute the indicator on them, and
// forward-fill the result onto the base bars with alignHtfToChart (closed-bar,
// no lookahead). The emitted array is always base-length, so the backend — which
// only does positional arr[i] lookups and requires len(series)==len(candles) —
// needs no knowledge that a timeframe was involved.

import type { KLineData } from "klinecharts";
import { maSeries, sma, alignHtfToChart } from "./mtf";
import { vwapFrom, computeRsi } from "./customIndicators";
import { collectSeriesOperands, seriesName, slopeLen, riskAtrLengths, scalingAtrLengths, type BacktestConfig, type Operand } from "./backtestConfig";
import { atrSeries } from "./atr";
import { RESOLUTION_SECONDS } from "./feed";

function toNullable(arr: Array<number | undefined>): Array<number | null> {
  return arr.map((v) => (v === undefined ? null : v));
}

/** Fetch the candles for one resolution over the same window as the base run.
 * Provided by the caller (BacktestButton) since it owns epic/window/broker. */
export type FetchTimeframe = (resolution: string) => Promise<KLineData[]>;

export async function buildSeries(
  candles: KLineData[],
  cfg: BacktestConfig,
  baseResolution: string,
  fetchTimeframe: FetchTimeframe,
): Promise<Record<string, Array<number | null>>> {
  const out: Record<string, Array<number | null>> = {};
  const baseTimestamps = candles.map((k) => k.timestamp);
  // Fetch each distinct higher timeframe once, even if several operands use it.
  const htfCache = new Map<string, KLineData[]>();

  for (const op of collectSeriesOperands(cfg)) {
    const name = seriesName(op);
    if (name === null) continue;
    const tf = op.kind === "indicator" ? op.timeframe : undefined;
    if (!tf || tf === baseResolution) {
      out[name] = toNullable(derive(op, candles, tfHours(baseResolution)));
      continue;
    }
    let htf = htfCache.get(tf);
    if (!htf) {
      htf = await fetchTimeframe(tf);
      htfCache.set(tf, htf);
    }
    const htfMs = (RESOLUTION_SECONDS[tf] ?? 0) * 1000;
    // Slope MUST be taken on the native HTF values (inside derive), BEFORE the
    // forward-fill — diffing the forward-filled array would read 0 within each
    // held HTF value and spike at the boundary. The slope divides by elapsed time
    // in the operand's OWN timeframe, so pass the HTF's hours-per-bar.
    const aligned = alignHtfToChart(baseTimestamps, htf, derive(op, htf, tfHours(tf)), htfMs, true);
    out[name] = toNullable(aligned);
  }

  // ATR risk/scaling series are always base-timeframe (stops/targets execute on
  // the base bars), so they compute on the base candles directly.
  for (const length of riskAtrLengths(cfg)) {
    out[`ATR_${length}`] = atrSeries(candles, length);
  }
  for (const length of scalingAtrLengths(cfg)) {
    if (!out[`ATR_${length}`]) out[`ATR_${length}`] = atrSeries(candles, length);
  }

  return out;
}

/** Hours per bar for a resolution (the "TF" in the slope's time denominator).
 * Falls back to 1 hour for an unknown resolution. Sub-hour timeframes are < 1
 * (e.g. a 5-minute bar is 1/12 h). */
function tfHours(resolution: string): number {
  return (RESOLUTION_SECONDS[resolution] ?? 3600) / 3600;
}

/** An operand's per-bar values, applying its slope transform if it has one. The
 * slope is taken on `candles`' own values (native timeframe) so an HTF operand is
 * differenced before it's forward-filled onto the base bars, not after.
 * `barHours` is the hours-per-bar of THIS operand's timeframe. */
function derive(op: Operand, candles: KLineData[], barHours: number): Array<number | undefined> {
  const raw = computeRaw(op, candles);
  const n = slopeLen(op);
  return n === null ? raw : slopeOf(raw, n, barHours);
}

/** Tangent rate of change of `raw` in percent per HOUR over `n` bars:
 *   (v[i] − v[i−n]) / |v[i−n]| / (n × barHours) × 100
 * The run is elapsed time (n bars × barHours each), not bar count, so the slope
 * is in %/hr regardless of the operand's timeframe — a 5-min and a 15-min EMA
 * slope are directly comparable. undefined for the first `n` bars, wherever `raw`
 * is undefined, or where the denominator is 0. */
function slopeOf(raw: Array<number | undefined>, n: number, barHours: number): Array<number | undefined> {
  return raw.map((v, i) => {
    const prev = raw[i - n];
    if (i < n || v === undefined || prev === undefined || prev === 0) return undefined;
    return ((v - prev) / Math.abs(prev) / (n * barHours)) * 100;
  });
}

/** One indicator's per-bar values over the given candles (or a price field's, for
 * a sloped price operand), undefined where there's no value (warm-up gap, unplaced
 * AVWAP, missing volume). Pure in `candles`, so it runs identically on the base
 * bars or a higher timeframe's. */
function computeRaw(op: Operand, candles: KLineData[]): Array<number | undefined> {
  if (op.kind === "price") return candles.map((k) => k[op.field] ?? undefined);
  if (op.kind !== "indicator") return [];
  switch (op.indicator) {
    case "EMA":
    case "SMA":
      return maSeries(candles, op.indicator === "EMA" ? "ema" : "sma", op.length ?? 0, {}).base;
    case "VOLMA":
      return sma(candles.map((k) => k.volume ?? 0), op.length ?? 0);
    case "VOL":
      return candles.map((k) => k.volume ?? undefined);
    case "AVWAP": {
      // Mirror the chart's AVWAP calc (customIndicators.ts): anchor is an epoch-ms
      // timestamp; <= 0 means unplaced (no line). Otherwise accumulate from the
      // first bar at/after the anchor. An anchor past the last bar -> all blank.
      const anchor = op.anchor ?? 0;
      if (anchor <= 0) return candles.map(() => undefined);
      const idx = candles.findIndex((k) => k.timestamp >= anchor);
      const start = idx < 0 ? candles.length : idx;
      return vwapFrom(candles, start, {}).map((p) => p.vwap ?? undefined);
    }
    case "RSI":
      // `.val` is always present; `.rsi` is omitted when the line is style-hidden,
      // which would silently null the series for a hidden RSI line.
      return computeRsi(candles, op.length ?? 14, {}).map((p) => p.val ?? undefined);
    default:
      return [];
  }
}

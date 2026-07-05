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
import { collectSeriesOperands, seriesName, riskAtrLengths, scalingAtrLengths, type BacktestConfig, type Operand } from "./backtestConfig";
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
      out[name] = toNullable(computeRaw(op, candles));
      continue;
    }
    let htf = htfCache.get(tf);
    if (!htf) {
      htf = await fetchTimeframe(tf);
      htfCache.set(tf, htf);
    }
    const htfMs = (RESOLUTION_SECONDS[tf] ?? 0) * 1000;
    const aligned = alignHtfToChart(baseTimestamps, htf, computeRaw(op, htf), htfMs, true);
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

/** One indicator's per-bar values over the given candles, undefined where the
 * indicator has no value (warm-up gap, unplaced AVWAP, missing volume). Pure in
 * `candles`, so it runs identically on the base bars or a higher timeframe's. */
function computeRaw(op: Operand, candles: KLineData[]): Array<number | undefined> {
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

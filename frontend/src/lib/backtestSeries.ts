// Computes the ATR risk/scaling series a BacktestConfig references (the
// `ATR_{n}` stops/targets execute against), keyed so the backend can validate
// every name it needs is present. Native indicators, price, and chart-operand
// series are recomputed server-side from the rule expressions, so the browser
// no longer ships them.

import type { KLineData } from "klinecharts";
import { riskAtrLengths, scalingAtrLengths, type BacktestConfig } from "./backtestConfig";
import { atrSeries } from "./atr";

/** Fetch the candles for one resolution over the same window as the base run.
 * Provided by the caller (BacktestButton) since it owns epic/window/broker.
 * Retained for signature compatibility with the coded/live callers; the
 * ATR-only builder computes on the base candles and never fetches. */
export type FetchTimeframe = (resolution: string) => Promise<KLineData[]>;

export async function buildSeries(
  candles: KLineData[],
  cfg: BacktestConfig,
  _baseResolution: string,
  _fetchTimeframe: FetchTimeframe,
): Promise<Record<string, Array<number | null>>> {
  const out: Record<string, Array<number | null>> = {};

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

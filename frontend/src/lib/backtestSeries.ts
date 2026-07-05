// Computes each indicator series a BacktestConfig references, keyed by the
// seriesName contract (backtestConfig.ts) so the backend can validate every
// name it needs is present without knowing anything about indicator math.

import type { KLineData } from "klinecharts";
import { maSeries, sma } from "./mtf";
import { vwapFrom, computeRsi } from "./customIndicators";
import { collectSeriesOperands, seriesName, riskAtrLengths, scalingAtrLengths, type BacktestConfig, type Operand } from "./backtestConfig";
import { atrSeries } from "./atr";

function toNullable(arr: Array<number | undefined>): Array<number | null> {
  return arr.map((v) => (v === undefined ? null : v));
}

export function buildSeries(
  candles: KLineData[],
  cfg: BacktestConfig,
): Record<string, Array<number | null>> {
  const out: Record<string, Array<number | null>> = {};

  for (const op of collectSeriesOperands(cfg)) {
    const name = seriesName(op);
    if (name === null) continue;
    out[name] = computeOne(op, candles);
  }

  for (const length of riskAtrLengths(cfg)) {
    out[`ATR_${length}`] = atrSeries(candles, length);
  }

  for (const length of scalingAtrLengths(cfg)) {
    if (!out[`ATR_${length}`]) out[`ATR_${length}`] = atrSeries(candles, length);
  }

  return out;
}

function computeOne(op: Operand, candles: KLineData[]): Array<number | null> {
  if (op.kind !== "indicator") return [];
  switch (op.indicator) {
    case "EMA":
    case "SMA":
      return toNullable(maSeries(candles, op.indicator === "EMA" ? "ema" : "sma", op.length ?? 0, {}).base);
    case "VOLMA":
      return toNullable(sma(candles.map((k) => k.volume ?? 0), op.length ?? 0));
    case "VOL":
      return candles.map((k) => k.volume ?? null);
    case "AVWAP": {
      // Mirror the chart's AVWAP calc (customIndicators.ts): anchor is an epoch-ms
      // timestamp; <= 0 means unplaced (no line). Otherwise accumulate from the
      // first bar at/after the anchor. An anchor past the last bar -> all null.
      const anchor = op.anchor ?? 0;
      if (anchor <= 0) return candles.map(() => null);
      const idx = candles.findIndex((k) => k.timestamp >= anchor);
      const start = idx < 0 ? candles.length : idx;
      return vwapFrom(candles, start, {}).map((p) => p.vwap ?? null);
    }
    case "RSI":
      // `.val` is always present; `.rsi` is omitted when the line is style-hidden,
      // which would silently null the series for a hidden RSI line.
      return computeRsi(candles, op.length ?? 14, {}).map((p) => p.val ?? null);
    default:
      return [];
  }
}

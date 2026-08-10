// Average True Range, computed on the frontend and posted as an
// `ATR_{length}` series so the backtest engine can size stops/targets without
// doing any indicator math itself (it only reads the series by index).
//
// Supports multiple smoothing types (RMA/SMA/EMA/WMA), matching TradingView's
// ta.atr() with tv.input.resolution smoothing and mirroring the backend
// indicators/atr.py implementation and docs/specs/2026-08-07-atr-indicator-design.md.

import type { KLineData } from "klinecharts";
import { smoothSeries } from "./indicators/smoothing";
import type { PriceSource } from "./mtf";

export type AtrSmoothing = "rma" | "sma" | "ema" | "wma";

export const ATR_SMOOTHING_LABEL: Record<AtrSmoothing, string> = {
  rma: "RMA", sma: "SMA", ema: "EMA", wma: "WMA",
};

/** Coerce a stored/unknown smoothing to a real one; TV's default is RMA. */
export function normalizeAtrSmoothing(v: unknown): AtrSmoothing {
  return v === "sma" || v === "ema" || v === "wma" || v === "rma" ? v : "rma";
}

/** Pine ta.tr(true): TR[0] = high-low; later bars max(h-l, |h-pc|, |l-pc|). */
export function trueRangeSeries(candles: KLineData[]): number[] {
  const n = candles.length;
  const tr: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const hl = k.high - k.low;
    if (i === 0) {
      tr[i] = hl;
    } else {
      const pc = candles[i - 1].close;
      tr[i] = Math.max(hl, Math.abs(k.high - pc), Math.abs(k.low - pc));
    }
  }
  return tr;
}

/** Computes Average True Range using the specified smoothing mode.
 *
 * Returns `null` for every bar before `length` true ranges are available;
 * from bar index `length-1` on, the first ATR is the simple mean of the
 * first `length` true ranges and each later ATR is smoothed according to
 * the chosen mode:
 * - "rma" (default): Wilder's smoothing recurrence `atr = (prevAtr * (length - 1) + tr) / length`
 * - "sma", "ema", "wma": TradingView's ma_function(ta.tr(true), length), where ema/rma seed
 *   with the first-window SMA and sma/wma are trailing windows
 */
export function atrSeries(
  candles: KLineData[],
  length: number,
  smoothing: AtrSmoothing = "rma",
): Array<number | null> {
  const n = candles.length;
  const out: Array<number | null> = new Array(n).fill(null);
  if (length < 1 || n === 0) return out;
  const tr = trueRangeSeries(candles);
  if (smoothing !== "rma") {
    // TV's ma_function(ta.tr(true), length). smoothSeries' ema seeds with the
    // first-window SMA, exactly Pine's ta.ema; sma/wma are trailing windows.
    const s = smoothSeries(tr, smoothing, length);
    for (let i = 0; i < n; i++) out[i] = s[i] ?? null;
    return out;
  }
  // Wilder RMA — the legacy path, kept operation-identical (golden ATR_14).
  if (n < length) return out;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += tr[i];
  let atr = sum / length;
  out[length - 1] = atr;
  for (let i = length; i < n; i++) {
    atr = (atr * (length - 1) + tr[i]) / length;
    out[i] = atr;
  }
  return out;
}

/** Per-instance config carried on extendData (settings modal Smoothing select).
 * pctSource picks the bar price the legend's ATR% readout divides by. */
export interface AtrExtend {
  smoothing?: AtrSmoothing;
  pctSource?: PriceSource;
  hideLegendValue?: boolean;
}

/** Coerce a stored/unknown ATR% price source to a real one; default close. */
export function normalizeAtrPctSource(v: unknown): PriceSource {
  return v === "open" || v === "high" || v === "low" || v === "close" ||
    v === "hl2" || v === "hlc3" || v === "ohlc4" || v === "hlcc4"
    ? v
    : "close";
}

/** calcParams[0] truncated like Python int(); garbage/0 → 14. Mirrors
 * backend indicators/atr.py::parse_atr_config. */
export function atrLength(calcParams: unknown[] | undefined): number {
  return Math.trunc(Number(calcParams?.[0])) || 14;
}

/** The pane's DATA outputs, named by LENGTH (`ATR#id.14`, `ATR#id.14.to%`),
 * mirroring the SLOPE convention: a rule SELECTS the line the pane defines,
 * and retuning the length loudly breaks rules naming the old one
 * (unknown_indicator_output). The pct output rides the same rule, so both
 * rename together. Value line first: click-to-insert emits outputs[0]. */
export function atrOutputs(calcParams: unknown[] | undefined): string[] {
  const length = atrLength(calcParams);
  return [String(length), `${length}.to%`];
}

/** Warm-up bars for an output; 0 for a name this config does not expose (an
 * unknown ref is the lint layer's error, not a reason to inflate the ask).
 * = length, matching the expr-level ATR(n) convention (warmup.py, arg_kind
 * "length"). Mirrors Python indicators/atr.py::atr_warmup. */
export function atrWarmup(calcParams: unknown[] | undefined, output: string): number {
  const length = atrLength(calcParams);
  return output === String(length) || output === `${length}.to%` ? length : 0;
}

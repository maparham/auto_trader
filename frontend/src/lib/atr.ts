// Wilder's Average True Range, computed on the frontend and posted as an
// `ATR_{length}` series so the backtest engine can size stops/targets without
// doing any indicator math itself (it only reads the series by index).

import type { KLineData } from "klinecharts";

/** Wilder's ATR. Returns `null` for every bar before `length` true ranges are
 * available; from bar index `length-1` on, the first ATR is the simple mean of
 * the first `length` true ranges and each later ATR is Wilder-smoothed:
 * `atr = (prevAtr * (length - 1) + tr) / length`. */
export function atrSeries(candles: KLineData[], length: number): Array<number | null> {
  const n = candles.length;
  const out: Array<number | null> = new Array(n).fill(null);
  if (length < 1 || n === 0) return out;

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

// TV-style moving-average smoothing over a sparse series (undefined entries are
// "not ready yet"). Each output index needs `length` consecutive DEFINED inputs
// ending at it; otherwise undefined. Mirrors TradingView's ta.* over an
// na-prefixed series: ema/rma seed with the SMA of the first `length` defined
// values, sma/wma/vwma are trailing windows (wma weights length..1, most recent
// highest). `vol` is required for "vwma". "rma" is Wilder's smoothing.
//
// Extracted verbatim from rsi.ts so ATR (lib/atr.ts) can reuse it; ported
// op-for-op by backend core.py::smooth_series — do not reorder arithmetic.
export type SmoothType = "none" | "sma" | "ema" | "rma" | "wma" | "vwma";

export function smoothSeries(
  src: Array<number | undefined>,
  type: SmoothType,
  length: number,
  vol?: number[],
): Array<number | undefined> {
  const n = src.length;
  const out: Array<number | undefined> = new Array(n).fill(undefined);
  const L = Math.max(1, Math.floor(length) || 1);
  if (type === "none") return out;
  if (type === "ema" || type === "rma") {
    // EMA/RMA recurse from the first L-window SMA seed over defined values.
    const alpha = type === "ema" ? 2 / (L + 1) : 1 / L;
    let prev: number | undefined;
    let seedSum = 0;
    let seedCount = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (v === undefined) continue;
      if (prev === undefined) {
        seedSum += v;
        seedCount++;
        if (seedCount === L) {
          prev = seedSum / L;
          out[i] = prev;
        }
      } else {
        prev = alpha * v + (1 - alpha) * prev;
        out[i] = prev;
      }
    }
    return out;
  }
  // SMA / WMA / VWMA: a trailing window of the last L defined values.
  for (let i = 0; i < n; i++) {
    if (src[i] === undefined) continue;
    // Walk back L defined values (they're contiguous once RSI is warm).
    let count = 0;
    let num = 0;
    let den = 0;
    for (let j = i; j >= 0 && count < L; j--) {
      const v = src[j];
      if (v === undefined) break;
      const w = type === "wma" ? L - count : type === "vwma" ? (vol?.[j] ?? 0) : 1;
      num += v * w;
      den += w;
      count++;
    }
    if (count === L && den > 0) out[i] = num / den;
  }
  return out;
}

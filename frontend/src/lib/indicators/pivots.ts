// Shared fractal pivot detection. A bar is a pivot high/low when its value is the
// extreme within a window of `lbL` bars to the LEFT and `lbR` bars to the RIGHT —
// so the most recent `lbR` bars can never form one (the same confirmation lag as
// TradingView's ta.pivothigh / ta.pivotlow). Kept in one place so every indicator
// (RSI divergence, PivotBands, …) uses an identical definition of "pivot".
//
// `strict` controls tie handling on the OTHER bars in the window:
//   - strict=false  → ties allowed (no neighbour strictly beyond the pivot). This
//     matches the RSI-divergence detector's original behaviour.
//   - strict=true   → the pivot must be strictly beyond every neighbour, so a flat
//     top/bottom does not register. Used by price-based PivotBands.

/** True if bar `i` is a confirmed pivot of `want` side over the given window. */
export function isPivotAt(
  values: ReadonlyArray<number | undefined>,
  i: number,
  lbL: number,
  lbR: number,
  want: "low" | "high",
  strict = false,
): boolean {
  const v = values[i];
  if (v === undefined) return false;
  if (i - lbL < 0 || i + lbR >= values.length) return false;
  for (let j = i - lbL; j <= i + lbR; j++) {
    if (j === i) continue;
    const w = values[j];
    if (w === undefined) return false;
    // Reject if a neighbour is beyond the candidate. In strict mode an equal
    // neighbour also rejects (no flat extremes); otherwise ties are allowed.
    if (want === "low") {
      if (strict ? w <= v : w < v) return false;
    } else {
      if (strict ? w >= v : w > v) return false;
    }
  }
  return true;
}

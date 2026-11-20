// Natural log and exp for the Trendlines "Log Scale" mode, written out with
// only + - * / so the TS and the Python port (tl_log / tl_exp in
// backend/auto_trader/indicators/trendlines.py) give the SAME BITS. Math.log
// and Python's math.log may differ in the last bit, and the detector's gates
// delete a line on a 1-ULP disagreement (see the trendlines.ts header).
//
// Both are the fdlibm algorithms (e_log.c, e_exp.c), accurate to under 1 ULP.
// The range reduction scales by 2 in a loop instead of reading the exponent
// bits, which is exact for any normal double and costs about log2(x) steps
// (around 20 for a price). Keep the operation order identical to the Python.

import type { KLineData } from "klinecharts";

const SQRT2 = 1.4142135623730951;
const SQRT2_HALF = 0.7071067811865476;
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e0;
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;

/** A log price needs a positive price. Anything at or below this (a CFD that
 * traded negative, a zero tick) is read as this, so the series stays finite.
 * Such a chart is not one a log scale can show anyway. */
export const TL_LOG_FLOOR = 1e-9;

/** ln(x). x at or below TL_LOG_FLOOR, or not finite, reads as TL_LOG_FLOOR. */
export function tlLog(x: number): number {
  let m = Number.isFinite(x) && x > TL_LOG_FLOOR ? x : TL_LOG_FLOOR;
  let k = 0;
  while (m >= SQRT2) {
    m *= 0.5;
    k += 1;
  }
  while (m < SQRT2_HALF) {
    m *= 2;
    k -= 1;
  }
  const f = m - 1;
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = t2 + t1;
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - ((hfsq - (s * (hfsq + r) + k * LN2_LO)) - f);
}

/** e^x, for x in the range tlLog produces (a log price). */
export function tlExp(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? Infinity : x < 0 ? 0 : NaN;
  const k = Math.floor(x * INV_LN2 + 0.5);
  const hi = x - k * LN2_HI;
  const lo = k * LN2_LO;
  const r = hi - lo;
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  let y = 1 - ((lo - (r * c) / (2 - c)) - hi);
  if (k > 0) for (let i = 0; i < k; i++) y *= 2;
  else for (let i = 0; i < -k; i++) y *= 0.5;
  return y;
}

/** The bar with ln prices: what the detector reads in Log Scale mode. Only
 * high, low and close are read (pivots, ATR, crossings), so `open` is left
 * as the raw price rather than paying for a log nobody reads. */
export function tlLogBar(d: KLineData): KLineData {
  return { ...d, high: tlLog(d.high), low: tlLog(d.low), close: tlLog(d.close) };
}

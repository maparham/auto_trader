// Deflated Sharpe Ratio (Bailey & Lopez de Prado 2014) over an in-memory
// sweep result set. The best Sharpe of N tried combos is inflated by
// selection; DSR is the probability the true Sharpe is above 0 after
// subtracting the max Sharpe that pure luck across N trials would produce.
// Works on the per-TRADE Sharpe (sqn / sqrt(n)) so the non-normality
// correction can use the trade P&L skew/kurtosis the backend ships per row.
// Pure functions; no engine or transport dependency.

import type { SweepRow } from "../api";

const EULER_GAMMA = 0.5772156649015329;

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation. */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Inverse standard normal CDF (Acklam's rational approximation, ~1e-9). */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normInv(1 - p);
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Expected maximum Sharpe of nTrials independent tries under a true Sharpe of
 * 0, given the variance of the Sharpe estimates across the trials. This is
 * the deflation benchmark SR0.
 */
export function expectedMaxSharpe(varSr: number, nTrials: number): number {
  if (varSr <= 0 || nTrials <= 1) return 0;
  return Math.sqrt(varSr) * (
    (1 - EULER_GAMMA) * normInv(1 - 1 / nTrials) +
    EULER_GAMMA * normInv(1 - 1 / (nTrials * Math.E))
  );
}

/**
 * Probabilistic Sharpe Ratio: P(true Sharpe > srBenchmark) given an observed
 * per-trade Sharpe over n trades with the given P&L skew and raw kurtosis
 * (normal = 3). Null when n < 2 or the non-normality variance term collapses.
 */
export function probabilisticSharpe(
  sr: number, srBenchmark: number, n: number,
  skew: number | null | undefined, kurt: number | null | undefined,
): number | null {
  if (n < 2 || skew == null || kurt == null) return null;
  const varTerm = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (varTerm <= 0) return null;
  return normCdf(((sr - srBenchmark) * Math.sqrt(n - 1)) / Math.sqrt(varTerm));
}

// Per-trade Sharpe from the row metrics the backend ships: sqn is
// sqrt(n) * mean / sd of the trade P&L, so sr = sqn / sqrt(n).
function rowSr(m: NonNullable<SweepRow["metrics"]>): number | null {
  if (m.sqn == null || !m.n_trades || m.n_trades < 2) return null;
  return m.sqn / Math.sqrt(m.n_trades);
}

/**
 * Inject metrics.dsr into each row: P(true Sharpe > 0) deflated by the number
 * of combos in THIS table (so a WFO fold table deflates by its own combo
 * count). Rows lacking sqn / trade moments get dsr null; error rows pass
 * through untouched. Fresh row objects; the input is not mutated.
 */
export function withDsr(rows: SweepRow[]): SweepRow[] {
  const srs = rows
    .map((r) => (r.metrics ? rowSr(r.metrics) : null))
    .filter((s): s is number => s != null);
  const n = srs.length;
  const mean = n ? srs.reduce((a, s) => a + s, 0) / n : 0;
  const varSr = n ? srs.reduce((a, s) => a + (s - mean) ** 2, 0) / n : 0;
  const sr0 = expectedMaxSharpe(varSr, n);
  return rows.map((r) => {
    if (!r.metrics) return r;
    const sr = rowSr(r.metrics);
    const dsr = sr == null ? null : probabilisticSharpe(
      sr, sr0, r.metrics.n_trades, r.metrics.trade_skew, r.metrics.trade_kurtosis);
    return { ...r, metrics: { ...r.metrics, dsr } };
  });
}

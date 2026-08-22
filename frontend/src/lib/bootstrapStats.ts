// Bootstrap resampling of a backtest's closed-trade P&L list: how much of the
// headline result survives when the same trades are redrawn with replacement.
// Answers "was this run's profit the trades or their lucky arrangement?"
// without re-running the engine. Pure and seeded, so results are stable
// across renders and testable.

export interface BootstrapSummary {
  draws: number;
  /** 5th percentile of resampled net P&L: a pessimistic redo of the run. */
  p5Net: number;
  /** Share of resamples ending profitable (net > 0). */
  probProfit: number;
  /** Median resampled max drawdown (peak-to-trough of the resampled path). */
  ddP50: number;
  /** 95th percentile resampled max drawdown: a realistic worst case. */
  ddP95: number;
}

// Deterministic 32-bit PRNG (mulberry32): cheap, seedable, good enough for
// resampling indices.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nearest-rank percentile over a sorted ascending array, q in [0, 1].
function percentile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/**
 * Resample the trade P&L list `draws` times (same length, with replacement).
 * Each resample yields a net P&L and a max drawdown of its cumulative path
 * (peak seeded at 0, so the drawdown is an amount, matching the panel's
 * Drawdown row). Null under 2 trades: nothing to resample.
 */
export function bootstrapPnl(
  pnls: number[], draws = 3000, seed = 0x5eed,
): BootstrapSummary | null {
  const n = pnls.length;
  if (n < 2) return null;
  const rand = mulberry32(seed);
  const nets: number[] = new Array(draws);
  const dds: number[] = new Array(draws);
  for (let d = 0; d < draws; d++) {
    let sum = 0, peak = 0, dd = 0;
    for (let i = 0; i < n; i++) {
      sum += pnls[(rand() * n) | 0];
      if (sum > peak) peak = sum;
      else if (peak - sum > dd) dd = peak - sum;
    }
    nets[d] = sum;
    dds[d] = dd;
  }
  nets.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  return {
    draws,
    p5Net: percentile(nets, 0.05),
    probProfit: nets.filter((x) => x > 0).length / draws,
    ddP50: percentile(dds, 0.5),
    ddP95: percentile(dds, 0.95),
  };
}

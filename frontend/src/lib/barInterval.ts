// Robustly estimate a chart's bar interval (ms) from a list of bar timestamps.
//
// The naive `last - secondLast` gap is fragile: whenever the final two loaded
// bars straddle a session/overnight/weekend break (or the gap between the end of
// loaded history and a freshly appended live bar), that gap can be hours or days
// long. Anything that uses it as a "one bar" unit — e.g. the backtest trade R:R
// zone's right-edge padding — then balloons wildly. Instead take the SMALLEST
// positive gap across the series, which is the real bar interval regardless of
// where the gaps fall. (This is the same discipline ChartCore's marker painter
// already applies to its per-bar dot phase.)
export function minPositiveGap(times: readonly number[]): number | null {
  let min = Infinity;
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0 && d < min) min = d;
  }
  return Number.isFinite(min) ? min : null;
}

// A chart's DECLARED bar width (ms), registered on every resolution change
// (mtfCoordinator.setChartIntervalMs). The gap guess above is wrong whenever
// the smallest gap is a short bar rather than the interval: a custom intraday
// timeframe that does not divide the day ends each day on a short bar (1439m
// reads 1m, 5H reads 4h). Keyed by chart object; a disposed chart frees its
// entry. A leaf module so painters and backtest code can read it without
// importing the MTF coordinator.
const declaredBarMsByChart = new WeakMap<object, number>();

export function setDeclaredBarMs(chart: object, ms: number | null): void {
  if (ms && ms > 0) declaredBarMsByChart.set(chart, ms);
  else declaredBarMsByChart.delete(chart);
}

export function declaredBarMs(chart: object): number | undefined {
  return declaredBarMsByChart.get(chart);
}

/** The chart's bar width: the declared one when registered, else the
 * smallest positive gap in `times`. */
export function chartBarMs(chart: object, times: readonly number[]): number | null {
  return declaredBarMs(chart) ?? minPositiveGap(times);
}

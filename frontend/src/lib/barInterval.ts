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

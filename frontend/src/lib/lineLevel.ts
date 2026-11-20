// The level of a frozen line (a line alert, a picked line L<n>) `bars` bars
// after its reference bar. A Log Scale trendline is straight in ln price, so
// its geometry carries `log: true` and a slope in ln per bar: the level then
// grows by the factor e^slope per bar. pRef stays a PRICE either way.
// Mirrors backend auto_trader/core/line_level.py.

export function lineLevel(pRef: number, slope: number, bars: number, log?: boolean): number {
  return log ? pRef * Math.exp(slope * bars) : pRef + slope * bars;
}

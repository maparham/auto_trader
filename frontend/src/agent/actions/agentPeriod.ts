// An agent's timeframe arg as a Period, shared by chart.timeframe.set and
// backtest.config.set. A leaf (feed only) so the backtest actions need not
// load the chart actions' DOM-bound imports.
import type { Period } from "../../lib/feed";
import { ALL_PERIODS, periodByResolution } from "../../lib/feed";

// Resolutions and labels resolve as-is (the exact-label find keeps the seconds
// labels like 5s working); failing that, a lowercase h/d/w/y unit is
// upper-cased ("4h", "1d", "w"), since agents type those freely. m vs M stay
// case-sensitive: m is minutes, M is months.
export function agentPeriod(wanted: string): Period | undefined {
  const exact =
    periodByResolution(wanted) ?? ALL_PERIODS.find((p) => p.label === wanted);
  if (exact) return exact;
  const m = /^(\d*)([hdwy])$/.exec(wanted);
  return m ? periodByResolution(m[1] + m[2].toUpperCase()) : undefined;
}

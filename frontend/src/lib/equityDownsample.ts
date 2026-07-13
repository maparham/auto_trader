// Bound the persisted backtest equity curve. The per-cell localStorage entry is a
// render cache; equity is its only array unbounded by trade count (one native-bar
// point per traded bar — ~37K over a year of 5m), so it must be thinned before it
// overflows the shared ~5MB quota. Own module (not backtest.ts) so persist/ can
// import it without a backtest -> persist -> backtest cycle.
import type { EquityPoint } from "../api";

// Max persisted equity points. equityForBars carry-forward renders the thinned
// series as a staircase — ~2000 steps read smooth over the full range and stay
// legible when zoomed. Tunable; see the design doc.
export const EQUITY_PERSIST_CAP = 2000;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Downsample an ascending equity series to at most ~cap points for persistence.
 * Uniform stride, always keeping the first and last point; values rounded to 2 dp.
 * A series already at/under the cap is only value-rounded, not thinned. Pure. */
export function downsampleEquity(
  points: readonly EquityPoint[],
  cap: number = EQUITY_PERSIST_CAP,
): EquityPoint[] {
  const n = points.length;
  if (n <= cap) return points.map((p) => ({ time: p.time, value: round2(p.value) }));
  const step = Math.ceil(n / cap);
  const out: EquityPoint[] = [];
  for (let i = 0; i < n; i += step) {
    out.push({ time: points[i].time, value: round2(points[i].value) });
  }
  // The stride may skip the final point; the last realized equity must survive.
  const last = points[n - 1];
  if (out.length === 0 || out[out.length - 1].time !== last.time) {
    out.push({ time: last.time, value: round2(last.value) });
  }
  return out;
}

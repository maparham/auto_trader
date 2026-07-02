// Pure helpers for the Measure tool's readout. Given the two anchor points' price,
// bar index, timestamp, and the instrument price precision, produce the
// TradingView-style two-line label: "−0.293 (−0.42%) −293" / "25 bars, 2h 15m".
// Kept side-effect-free (no klinecharts, no DOM) so it's unit-testable and the
// overlay's createPointFigures just formats whatever it reads off the two points.

export interface MeasureInput {
  price0: number;
  price1: number;
  index0: number;
  index1: number;
  time0: number;
  time1: number;
  precision: number; // price decimal places (min-tick = 10^-precision)
}

export interface MeasureMetrics {
  dPrice: number;
  pct: number;
  ticks: number;
  bars: number;
  ms: number;
  up: boolean; // price rose (or unchanged) over the span → green box
  line1: string; // "Δprice (Δ%) Δticks"
  line2: string; // "N bars, Hh Mm"
}

// TradingView renders a real minus sign (U+2212), not an ASCII hyphen. Positives
// carry no sign — the box color already signals direction.
const MINUS = "−";

function signed(n: number, decimals: number): string {
  const s = Math.abs(n).toFixed(decimals);
  return n < 0 ? `${MINUS}${s}` : s;
}

// Elapsed time as at most two units: "3d 4h" / "2h 15m" / "45m". Rounded to whole
// minutes (bar granularity), so a sub-minute span reads "0m".
export function formatDuration(ms: number): string {
  const totalMin = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export function measureMetrics(inp: MeasureInput): MeasureMetrics {
  const dPrice = inp.price1 - inp.price0;
  const pct = inp.price0 !== 0 ? (dPrice / inp.price0) * 100 : 0;
  const minTick = 10 ** -Math.max(0, inp.precision);
  const ticks = minTick > 0 ? Math.round(dPrice / minTick) : 0;
  const bars = Math.abs(Math.round(inp.index1) - Math.round(inp.index0));
  const ms = Math.abs(inp.time1 - inp.time0);
  const up = dPrice >= 0;
  const line1 = `${signed(dPrice, Math.max(0, inp.precision))} (${signed(pct, 2)}%) ${signed(ticks, 0)}`;
  const line2 = `${bars} ${bars === 1 ? "bar" : "bars"}, ${formatDuration(ms)}`;
  return { dPrice, pct, ticks, bars, ms, up, line1, line2 };
}

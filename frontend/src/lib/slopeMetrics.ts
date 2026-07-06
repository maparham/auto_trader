// Pure helpers for the Slope tool's readout. Sibling to measureMetrics.ts: given the
// two anchor points' price, bar index, timestamp, and the instrument precision, it
// reports the line's ANGLE plus rate-of-change readouts (%/bar, price/bar, price/time).
// Side-effect-free (no klinecharts, no DOM) so it's unit-testable and the overlay's
// createPointFigures just formats whatever it reads off the two points.
//
// The angle uses DATA GEOMETRY, not screen pixels: a fixed reference ratio
// `ref = refK / anchorPrice` maps price×time slope onto degrees, so a line rising
// `refK`% per bar reads as 45°. With refK = 100 (the default), +1%/bar = 45° on EVERY
// instrument and at EVERY zoom — the number ties to the app's %/bar "slope" definition
// (see slope-conditions) rather than to how tilted the line happens to look on screen.

export interface SlopeInput {
  price0: number;
  price1: number;
  index0: number;
  index1: number;
  time0: number;
  time1: number;
  precision: number; // price decimal places
  // Minutes per bar at the chart's base interval (e.g. 30 for MINUTE_30). Used for the
  // gap-free price/time readout: each bar counts as this many minutes, so weekend /
  // overnight gaps don't distort the rate (two visually-identical slopes read the same).
  // Falls back to the drawn span's average spacing when omitted.
  baseIntervalMinutes?: number;
  // Percent-per-bar that reads as 45°. Default 100 → +1%/bar = 45°.
  refK?: number;
}

export interface SlopeMetrics {
  angleDeg: number; // canonical data-geometry angle, in (−90, 90]; +rising / −falling
  pctPerBar: number; // percent-per-bar, relative to the anchor (earlier) price
  pricePerBar: number; // absolute price change per bar
  pricePerTime: number; // price change per hour or per day (see timeUnit)
  timeUnit: "hr" | "day";
  bars: number; // whole bars spanned (>= 0)
  up: boolean; // rose (or flat) from earlier → later bar → green edge
  angleText: string; // "45.0°"
  pctText: string; // "1.00%/bar"
  priceBarText: string; // "1.00/bar"
  priceTimeText: string; // "1.00/hr" | "1.00/day"
}

// TradingView renders a real minus sign (U+2212), not an ASCII hyphen. Positives carry
// no sign — the pill's colored edge already signals direction.
const MINUS = "−";

function signed(n: number, decimals: number): string {
  const s = Math.abs(n).toFixed(decimals);
  return n < 0 ? `${MINUS}${s}` : s;
}

// Bars below this median spacing (in minutes) read as intraday → per-hour; a day or
// coarser reads as per-day. Derived from the drawn span so no interval plumbing is
// needed (the actual bar spacing between the two anchors).
const DAY_MINUTES = 1440;

export function slopeMetrics(inp: SlopeInput): SlopeMetrics {
  const refK = inp.refK ?? 100;
  // Measure chronologically (earlier bar → later bar) so a right-to-left drawn line
  // reads identically to a left-to-right one, and "up" means rising over time.
  const swap = inp.index1 < inp.index0;
  const iA = swap ? inp.index1 : inp.index0;
  const iB = swap ? inp.index0 : inp.index1;
  const pA = swap ? inp.price1 : inp.price0; // anchor (earlier) price
  const pB = swap ? inp.price0 : inp.price1;
  const tA = swap ? inp.time1 : inp.time0;
  const tB = swap ? inp.time0 : inp.time1;

  const dPrice = pB - pA;
  const dBars = Math.round(iB) - Math.round(iA);
  const dMs = Math.abs(tB - tA);
  const bars = Math.abs(dBars);
  const up = dPrice >= 0;

  // Canonical angle via the fixed reference ratio. ref = refK / anchorPrice makes the
  // angle a pure function of %/bar: atan2((dPrice/anchor)*refK, dBars).
  const anchor = pA !== 0 ? pA : 1;
  const ref = refK / anchor;
  const angleDeg =
    dBars === 0
      ? dPrice > 0
        ? 90
        : dPrice < 0
          ? -90
          : 0
      : (Math.atan2(dPrice * ref, dBars) * 180) / Math.PI;

  const pricePerBar = dBars !== 0 ? dPrice / dBars : 0;
  const pctPerBar = dBars !== 0 && pA !== 0 ? (dPrice / pA / dBars) * 100 : 0;

  // price/time: convert bars → time using the base interval (gap-free), so the rate is
  // "price per hour/day of chart time" and doesn't jump across weekend gaps. Falls back
  // to the drawn span's average spacing when the interval isn't supplied.
  const minutesPerBar =
    inp.baseIntervalMinutes && inp.baseIntervalMinutes > 0
      ? inp.baseIntervalMinutes
      : bars > 0
        ? dMs / bars / 60000
        : 0;
  const timeUnit: "hr" | "day" = minutesPerBar >= DAY_MINUTES ? "day" : "hr";
  const totalMinutes = bars * minutesPerBar;
  const unitMinutes = timeUnit === "day" ? DAY_MINUTES : 60;
  const pricePerTime = totalMinutes > 0 ? dPrice / (totalMinutes / unitMinutes) : 0;

  const pd = Math.max(0, inp.precision);
  return {
    angleDeg,
    pctPerBar,
    pricePerBar,
    pricePerTime,
    timeUnit,
    bars,
    up,
    angleText: `${signed(angleDeg, 1)}°`,
    pctText: `${signed(pctPerBar, 2)}%/bar`,
    priceBarText: `${signed(pricePerBar, pd)}/bar`,
    priceTimeText: `${signed(pricePerTime, pd)}/${timeUnit}`,
  };
}

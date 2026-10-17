import type { Chart } from "klinecharts";

// Glide the candle pane's auto-fit price range instead of snapping it.
//
// While a zoom or pan glides, the visible highs/lows change in steps: the
// moment an extreme bar enters or leaves the view the auto-fit jumps 2-4% in
// one frame, and every candle jumps vertically with it. createRange runs on
// each layout, so this eases the range it returns toward the real fit and,
// while it has not arrived, asks klinecharts for another y-axis rebuild on the
// next frame. A changed context (symbol, timeframe, axis kind, price-only
// flag) snaps instead, so a symbol switch never slides in from the old scale.

/** Easing time constant (ms). */
export const PRICE_EASE_TAU_MS = 90;

interface EaseState {
  key: string;
  lo: number;
  hi: number;
  t: number;
  kick: number;
}

const states = new WeakMap<object, EaseState>();

/** Internal ChartImp.layout: microtask-batched, rebuilds y ticks via createRange. */
type LayoutChart = {
  layout?: (o: { update?: boolean; buildYAxisTick?: boolean; cacheYAxisWidth?: boolean }) => void;
};

function kickNextFrame(chart: Chart, s: EaseState): void {
  if (s.kick || typeof requestAnimationFrame !== "function") return;
  s.kick = requestAnimationFrame(() => {
    s.kick = 0;
    try {
      (chart as unknown as LayoutChart).layout?.({ update: true, buildYAxisTick: true, cacheYAxisWidth: true });
    } catch {
      // A disposed chart throws from layout; nothing left to ease.
    }
  });
}

/**
 * The range to show this frame on the way to `[lo, hi]`. `key` names the
 * context; a new key (or a first call) returns the target unchanged.
 */
export function easePriceRange(
  chart: Chart,
  key: string,
  lo: number,
  hi: number,
  now: number = performance.now(),
): [number, number] {
  const s = states.get(chart);
  if (!s || s.key !== key || !Number.isFinite(s.lo) || !Number.isFinite(s.hi)) {
    states.set(chart, { key, lo, hi, t: now, kick: s?.kick ?? 0 });
    return [lo, hi];
  }
  const dt = Math.min(now - s.t, 64);
  s.t = now;
  const k = 1 - Math.exp(-Math.max(0, dt) / PRICE_EASE_TAU_MS);
  let nlo = s.lo + (lo - s.lo) * k;
  let nhi = s.hi + (hi - s.hi) * k;
  const eps = Math.abs(hi - lo) * 0.001;
  if (Math.abs(nlo - lo) <= eps && Math.abs(nhi - hi) <= eps) {
    nlo = lo;
    nhi = hi;
  } else {
    kickNextFrame(chart, s);
  }
  s.lo = nlo;
  s.hi = nhi;
  return [nlo, nhi];
}

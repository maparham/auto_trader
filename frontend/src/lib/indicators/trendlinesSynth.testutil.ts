// Deterministic random walk with enough wiggle to confirm pivots and seed
// lines. Shared by the trendlines debug tests.
import type { KLineData } from "klinecharts";

export function synthBars(n: number, seed = 7): KLineData[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const bars: KLineData[] = [];
  let price = 50_000;
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.5) * price * 0.004;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + rand() * price * 0.002;
    const low = Math.min(open, close) - rand() * price * 0.002;
    bars.push({ timestamp: t, open, high, low, close, volume: 1 });
    price = close;
    t += 60_000;
  }
  return bars;
}

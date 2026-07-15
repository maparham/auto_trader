// Test-only fixture: minute-spaced bars with per-bar volume, for the
// volume-weighted MA tests. high/low are offset by 1 from close so a
// source: "high"/"low" option is distinguishable from "close". Shared by
// mtf.test.ts and indicators/ma.test.ts so the bar shape cannot drift
// between the kernel tests and the template tests.
import type { KLineData } from "klinecharts";

export function vbars(closes: number[], volumes: number[]): KLineData[] {
  return closes.map((c, i) => ({
    timestamp: i * 60_000,
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: volumes[i] ?? 0,
  }));
}

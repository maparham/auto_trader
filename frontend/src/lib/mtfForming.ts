// The still-forming higher-timeframe bar, folded from the chart's own candles.
//
// This is the calculation half of the TV "Wait for timeframe closes" checkbox
// (unchecked): every MTF pin computes on CLOSED HTF bars, so its newest value
// sits up to a full HTF period behind the chart's newest candle. When a pin
// opts out of waiting, the coordinator appends ONE synthetic bar — the forming
// bucket, folded from the chart candles it spans — and recomputes. The fold
// input is the chart's dataList, so it is on the pane's own price side by
// construction, matching the HTF fetch.
//
// Pure and chart-free on purpose: the bucket arithmetic and the replay-cursor
// clamp are the parts worth testing without a chart in the room.
// See docs/superpowers/specs/2026-09-02-mtf-forming-bar-design.md.

import type { KLineData } from "klinecharts";

import { barEndMs } from "./timeframe";

/**
 * When the HTF bar opening at `openMs` closes. Given the pinned `timeframe`,
 * the grammar decides (barEndMs): a custom intraday bucket resets at 00:00 UTC,
 * so the day's last 5H bar (20:00) closes at midnight, not 01:00. Without one,
 * or for a key the grammar cannot read, the nominal width stands.
 */
export function htfBarEndMs(openMs: number, htfMs: number, timeframe?: string): number {
  return (timeframe != null ? barEndMs(timeframe, openMs) : null) ?? openMs + htfMs;
}

/**
 * Open timestamp (ms) of the forming HTF bucket.
 *
 * The fetched partial bar's own timestamp is authoritative when the fetch
 * returned one: the calendar-bucketed timeframes (weeks, months, year) do not
 * have nominal spans, so `lastClosedStart + htfMs` can land inside or past the
 * true bucket. Without a fetched partial, the nominal derivation is the best
 * available, read through the grammar when `timeframe` is given (the next
 * open after a short end-of-day bucket is midnight). Null when there is
 * nothing to derive from.
 */
export function formingOpenMs(
  closedStarts: number[],
  htfMs: number,
  fetchedFormingBar?: KLineData,
  timeframe?: string,
): number | null {
  if (fetchedFormingBar) return fetchedFormingBar.timestamp;
  if (!closedStarts.length || !(htfMs > 0)) return null;
  return htfBarEndMs(closedStarts[closedStarts.length - 1], htfMs, timeframe);
}

/**
 * Fold the chart candles inside the forming bucket [openMs, openMs + htfMs)
 * into one synthetic HTF bar, optionally merged over a fetched partial-bar
 * `seed` (its open wins — it saw the bucket's true first trade — extremes
 * union, and the newest close wins). `cursorMs` clamps the fold under replay:
 * candles after the cursor do not exist yet. Null when neither seed nor any
 * in-bucket candle exists — the caller then simply has no forming bar.
 * `timeframe` lets the grammar end the bucket (a short end-of-day bucket
 * closes at midnight, so the new day's candles stay out of it).
 */
export function foldFormingBar(
  chartBars: KLineData[],
  openMs: number,
  htfMs: number,
  seed?: KLineData,
  cursorMs?: number,
  timeframe?: string,
): KLineData | null {
  const closeMs = htfBarEndMs(openMs, htfMs, timeframe);
  let out: KLineData | null = seed ? { ...seed, timestamp: openMs } : null;
  // Volume is NOT summed across seed + chart candles: the seed (the broker's
  // own partial HTF bar) already aggregates the bucket's trades up to fetch
  // time, so adding the in-bucket chart candles on top would double-count.
  // Track the chart-side sum separately and take the larger of the two — the
  // chart sum wins when the loaded candles span the whole bucket (it is the
  // fresher measure), the seed wins when they don't reach back to its open.
  let chartVol = 0;
  for (const b of chartBars) {
    if (b.timestamp < openMs || b.timestamp >= closeMs) continue;
    if (cursorMs !== undefined && b.timestamp > cursorMs) continue;
    chartVol += b.volume ?? 0;
    if (!out) {
      out = { ...b, timestamp: openMs };
    } else {
      out = {
        timestamp: openMs,
        open: out.open,
        high: Math.max(out.high, b.high),
        low: Math.min(out.low, b.low),
        close: b.close,
        volume: 0, // resolved below from seed/chart, not a running sum
      };
    }
  }
  if (out) out.volume = seed ? Math.max(seed.volume ?? 0, chartVol) : chartVol;
  return out;
}

// Pure helpers for the Time Range highlight drawing (persistent full-height band
// marking a time interval). Kept side-effect-free (no klinecharts, no DOM) so the
// span math and readout are unit-testable; the overlay's createPointFigures and
// OverlayManager just call these with values they read off the chart.
//
// The core idea: a highlight covers the half-open interval [from, to) in epoch ms,
// stored as two anchor timestamps so it is timeframe-independent. `from`/`to` are
// bar-OPEN boundaries; the right edge `to` is the open of the bar AFTER the last
// covered bar (so a single 4H candle spans [open, open+4h)).

import { formatDuration } from "./measureMetrics";

// The stored [from, to) interval for a placement gesture.
//   startTs  — bar open under the initial press (snapped by convertFromPixel).
//   endTs    — bar open under the release, or null for a click with no drag.
//   tfMs     — one bar's width in ms at the placement timeframe.
// A click (endTs null or === start) marks exactly the clicked candle: [start, start+tfMs).
// A drag marks [min..max] INCLUSIVE of the bar under the cursor, so `to` extends one
// bar past the later open (its right edge / the next bar's open).
export function timeRangeSpan(
  startTs: number,
  endTs: number | null,
  tfMs: number,
): { from: number; to: number } {
  if (endTs == null || endTs === startTs) {
    return { from: startTs, to: startTs + tfMs };
  }
  const lo = Math.min(startTs, endTs);
  const hi = Math.max(startTs, endTs);
  return { from: lo, to: hi + tfMs };
}

// The band's pixel edges from the two anchors' bar-CENTER x coordinates. klinecharts
// anchors overlay points at the candle's center x, so a band drawn center-to-center
// is shifted right by half a bar and won't enclose the clicked candle. Shifting both
// edges left by half a bar width puts them on bar boundaries: for a single candle
// that's left-edge-of-clicked to left-edge-of-next = exactly the clicked candle.
export function bandEdges(
  centerX0: number,
  centerX1: number,
  barWidth: number,
): { left: number; right: number } {
  const half = barWidth / 2;
  const a = centerX0 - half;
  const b = centerX1 - half;
  return { left: Math.min(a, b), right: Math.max(a, b) };
}

// Format the readout from an explicit span + bar count, e.g. "4h · 16 bars". The
// overlay render path counts covered bars from the loaded data (robust to session
// gaps); callers that only know the timeframe use timeRangeReadout below.
export function formatTimeRangeReadout(spanMs: number, bars: number): string {
  return `${formatDuration(Math.max(0, spanMs))} · ${bars} ${bars === 1 ? "bar" : "bars"}`;
}

// Readout from an interval + timeframe: humanized span + covered bars = (to-from)/tfMs.
export function timeRangeReadout(fromMs: number, toMs: number, tfMs: number): string {
  const span = Math.max(0, toMs - fromMs);
  const bars = tfMs > 0 ? Math.max(1, Math.round(span / tfMs)) : 0;
  return formatTimeRangeReadout(span, bars);
}

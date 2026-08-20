import type { Chart } from "klinecharts";

// "Back to live" pill support: how far the view has been panned away from the
// newest bar, and how to say it in a few characters.
//
// Both halves are pure so the pill's show/hide rule is pinned by tests rather
// than by driving a real chart.

/** Bars hidden to the RIGHT of the current view.
 *
 * `realTo` is klinecharts' exclusive right index, which keeps counting past the
 * last bar once the view slides into future whitespace — so a plain subtraction
 * would go negative there. Zero means the newest bar is on screen, which is
 * exactly when the pill must be hidden. */
export function barsPastRightEdge(realTo: number, dataLen: number): number {
  return Math.max(0, dataLen - realTo);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

/** The gap between the newest visible bar and the newest bar there is, as a
 * short label ("12d back"). Null when there is no gap to report — the caller
 * uses that as "nothing to jump back to".
 *
 * The unit is the largest that still reads as a whole number, and a real gap
 * never rounds down to nothing: a few seconds behind still says "1m back". */
export function formatBehind(rightEdgeTs: number, latestTs: number): string | null {
  const gap = latestTs - rightEdgeTs;
  if (gap <= 0) return null;
  if (gap < HOUR) return `${Math.max(1, Math.floor(gap / MINUTE))}m back`;
  if (gap < DAY) return `${Math.floor(gap / HOUR)}h back`;
  if (gap < YEAR) return `${Math.floor(gap / DAY)}d back`;
  return `${Math.floor(gap / YEAR)}y back`;
}

/** The pill's whole state, read off a live chart: a label while the newest bar
 * is off-screen, null while it isn't.
 *
 * Reading the range instead of tracking scroll deltas keeps this correct after
 * PROGRAMMATIC moves too (a jump, a quick-range pick), which fire no scroll
 * gesture the pill could otherwise hear. */
export function readLiveEdge(chart: Chart): string | null {
  const data = chart.getDataList();
  const range = chart.getVisibleRange();
  if (barsPastRightEdge(range.realTo, data.length) === 0) return null;
  const rightEdge = data[Math.max(0, Math.min(range.realTo, data.length) - 1)];
  const latest = data[data.length - 1];
  if (!rightEdge || !latest) return null;
  return formatBehind(rightEdge.timestamp, latest.timestamp);
}

/** Glide duration for the jump. Long enough to see WHERE the view came from
 * (a teleport reads as a reload), short enough not to feel like waiting. */
export const LIVE_JUMP_MS = 260;

/** Send the view back to the newest bar.
 *
 * `onSettled` runs after the glide, not before: the caller uses it to persist
 * the landed position, and mid-flight the chart is still somewhere between the
 * two views. klinecharts fires no scroll ACTION for a programmatic move, so
 * this callback is the only signal that the jump finished.
 *
 * If the tab went hidden while the glide was running, the glide is frozen —
 * klinecharts animates on requestAnimationFrame, which the browser pauses there
 * (the same gotcha the crosshair pin guards against). An instant scroll covers
 * the remaining distance, so `onSettled` never persists a half-scrolled view.
 * `isHidden` is injectable so this stays testable off a DOM. */
export function jumpToLive(
  chart: Chart,
  onSettled: () => void,
  isHidden: () => boolean = () => document.hidden,
): void {
  chart.scrollToRealTime(LIVE_JUMP_MS);
  setTimeout(() => {
    if (isHidden()) chart.scrollToRealTime();
    onSettled();
  }, LIVE_JUMP_MS);
}

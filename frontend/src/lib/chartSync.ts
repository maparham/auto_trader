// Per-tab crosshair broadcaster (TradingView's "link" crosshair). The cell under
// the cursor publishes the hovered bar timestamp (or null on leave); sibling cells
// in the SAME tab paint a vertical time guide at that timestamp on their overlay
// canvas. Keyed by tab id so other tabs are unaffected. Mirrors the module-
// singleton idiom of mtfCoordinator — pure pub/sub, no React.
//
// Why a custom guide (not a real crosshair): klinecharts v9 exposes no public API
// to set the crosshair position programmatically (executeAction only fires the
// subscription callbacks, it doesn't draw), so each sibling draws the line itself
// using the same overlay canvas it already uses for the "+" affordance crosshair.

import { DomPosition, type Chart } from "klinecharts";

export interface CrosshairMsg {
  sourceCellId: string;
  timestamp: number | null; // null = cursor left the source chart
}

// Per-tab pub/sub channel: listeners keyed by tab id so a publish fans out only to
// cells in the same tab; the unsubscribe drops the tab's set once empty. One
// generic class backs both the crosshair link (here) and the date-range link
// (below) — a single subscribe/publish/teardown to keep correct, not two copies.
class TabChannel<T> {
  private byTab = new Map<string, Set<(m: T) => void>>();

  subscribe(tabId: string, fn: (m: T) => void): () => void {
    let set = this.byTab.get(tabId);
    if (!set) {
      set = new Set();
      this.byTab.set(tabId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.byTab.delete(tabId);
    };
  }

  publish(tabId: string, msg: T): void {
    const set = this.byTab.get(tabId);
    if (!set) return;
    for (const fn of set) fn(msg);
  }
}

export const chartSync = new TabChannel<CrosshairMsg>();

// ---------------------------------------------------------------------------
// Per-tab date-range ("link" time axis) broadcaster + the math that reproduces a
// time window on a sibling chart. Same module-singleton pub/sub as above, on its
// own channel so crosshair and range links are independent. The window is carried
// as the two edge TIMESTAMPS (not bar indices) so cells on DIFFERENT intervals
// land the same wall-clock span: each sibling maps the timestamps onto its OWN
// bars before fitting.
//
// Why this isn't a one-liner: klinecharts v9 has no setVisibleRange(from, to). It
// only exposes setBarSpace (zoom) + scrollToTimestamp (anchor one ts a constant
// ~2 bars from the right edge), so "show this time window" has to be synthesised
// from those. The barSpace→window relation isn't exact (it drifts a few %), so we
// do one measure-and-correct pass, then anchor the right edge by pixel distance.
// Verified empirically across intervals: left edge lands within ~1 bar, right edge
// exact. getVisibleRange / convertFromPixel update synchronously, so this whole
// routine runs in one frame with no settle wait — fine for live drag.

export interface RangeMsg {
  sourceCellId: string;
  fromTs: number; // wall-clock time at the left pixel edge
  toTs: number; //   wall-clock time at the right pixel edge
}

export const rangeSync = new TabChannel<RangeMsg>();

// klinecharts clamps barSpace to [1, 50] px/bar and silently ignores any value
// outside that range (TimeScaleStore.setBarSpace), so mirror its ceiling here.
const MIN_BAR_SPACE = 1;
const MAX_BAR_SPACE = 50;
function clampBarSpace(space: number): number {
  return Math.min(MAX_BAR_SPACE, Math.max(MIN_BAR_SPACE, space));
}

// convertFromPixel/convertToPixel are typed as T | T[]; we always pass one point.
function one<T>(r: T | T[]): T {
  return Array.isArray(r) ? r[0] : r;
}
function tsAtX(chart: Chart, x: number): number | null {
  const p = one(chart.convertFromPixel([{ x }], { paneId: "candle_pane", absolute: true }));
  return typeof p?.timestamp === "number" ? p.timestamp : null;
}
function xAtTs(chart: Chart, timestamp: number): number | null {
  const p = one(chart.convertToPixel([{ timestamp }], { paneId: "candle_pane", absolute: true }));
  return typeof p?.x === "number" ? p.x : null;
}
function mainWidth(chart: Chart): number {
  return chart.getSize("candle_pane", DomPosition.Main)?.width ?? 0;
}
// Nearest bar index to `ts` in a sorted-by-timestamp data list (binary search).
function nearestIdx(data: { timestamp: number }[], ts: number): number {
  const n = data.length;
  if (n === 0) return 0;
  if (ts <= data[0].timestamp) return 0;
  if (ts >= data[n - 1].timestamp) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (data[m].timestamp < ts) lo = m + 1;
    else hi = m;
  }
  return Math.abs(data[lo].timestamp - ts) < Math.abs(data[lo - 1].timestamp - ts) ? lo : lo - 1;
}

// The cell the cursor is currently driving (set on pointer-enter / pointer-down /
// wheel over a cell). Date-range link broadcasts ONLY from this cell, so the chart
// the user is actually scrolling dictates the window and a sibling that merely
// applies it — which receives no pointer events, so never becomes the owner — can't
// echo the range back. Pure ownership, independent of when klinecharts fires its
// scroll/zoom callbacks (sync vs async), so there's no feedback loop to chase.
let gestureCellId: string | null = null;
export function setGestureCell(id: string): void {
  gestureCellId = id;
}
export function isGestureCell(id: string): boolean {
  return gestureCellId === id;
}
// Release ownership if this cell currently holds it. Called when a cell unmounts
// (tab switch / layout change) so the global never points at a dead cell — a stale
// owner would make a freshly-mounted cell's first scroll fail the isGestureCell
// check and silently skip its broadcast.
export function releaseGestureCell(id: string): void {
  if (gestureCellId === id) gestureCellId = null;
}

// Read the time window currently on screen as its two pixel-edge timestamps. Uses
// the candle pane's true left/right pixel edges so empty space (scrolled past the
// last bar) is captured faithfully. Returns null if the chart isn't measurable yet.
export function readVisibleRange(chart: Chart): { fromTs: number; toTs: number } | null {
  const w = mainWidth(chart);
  if (w <= 1) return null;
  const fromTs = tsAtX(chart, 1);
  const toTs = tsAtX(chart, w - 1);
  if (fromTs == null || toTs == null || !(toTs > fromTs)) return null;
  return { fromTs, toTs };
}

// Pan/zoom `chart` so its left edge ≈ fromTs and right edge ≈ toTs, mapping the
// timestamps onto this chart's own bars (handles a different interval). No-op if
// the chart has no width or data yet; degrades gracefully when the chart lacks
// history covering the window (the window is then approximate, never a throw).
export function applyVisibleRange(chart: Chart, fromTs: number, toTs: number): void {
  const w = mainWidth(chart);
  if (w <= 1 || !(toTs > fromTs)) return;
  const data = chart.getDataList();
  if (!data || data.length < 2) return;
  const bars = Math.max(1, nearestIdx(data, toTs) - nearestIdx(data, fromTs));
  // klinecharts silently no-ops setBarSpace for values outside [1, 50] (px/bar).
  // When the window maps onto only a few bars of a coarser sibling, w/bars blows
  // past 50, so an unclamped call would be dropped — leaving the sibling at its
  // old zoom showing the wrong window. Clamp so it caps at max zoom (that bar plus
  // context) instead of being thrown away. Clamping the stored `space` too keeps
  // the correction pass below honest about what was actually applied.
  let space = clampBarSpace(w / bars);
  chart.setBarSpace(space);
  chart.scrollToTimestamp(toTs, 0);
  // One correction pass: rescale zoom by the ratio of the span we actually got to
  // the span we wanted (the barSpace→window relation isn't exactly linear).
  const lpx = tsAtX(chart, 1);
  const rpx = tsAtX(chart, w - 1);
  if (lpx != null && rpx != null && rpx > lpx) {
    space = clampBarSpace(space * ((rpx - lpx) / (toTs - fromTs)));
    chart.setBarSpace(space);
  }
  // Anchor the right pixel edge on toTs (scrollToTimestamp parks it ~2 bars in, so
  // nudge by the residual pixel distance).
  chart.scrollToTimestamp(toTs, 0);
  const x = xAtTs(chart, toTs);
  if (x != null) chart.scrollByDistance(w - x, 0);
}

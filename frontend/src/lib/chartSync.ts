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
  // The three fields below are present ONLY when the source is in "lock charts" mode
  // (see App.tsx) — their presence is the "exact mode" flag. Lock forces every cell
  // onto the master's interval, so the master's bar pixel-width (barSpace) is directly
  // meaningful on a receiver: copying it verbatim, then scrolling so the reference bar
  // `anchorTs` lands on the SAME pixel `anchorX` it occupies on the master, reproduces
  // the window pixel-for-pixel (verified 0px across the view for matching bars). The
  // plain cross-interval date-range link omits all three, so a barSpace/pixel from a
  // different timeframe can never be misapplied — that path synthesises from fromTs/toTs.
  //
  // Why a real bar's exact pixel and not just toTs: convertFromPixel SNAPS to the
  // nearest bar, so toTs alone discards the sub-bar offset between that bar's centre
  // and the pixel edge — anchoring it cost a constant ~½-bar drift. anchorX carries
  // that offset back, eliminating it.
  barSpace?: number;
  anchorTs?: number; // timestamp of the reference bar (hovered candle, else right edge)
  anchorX?: number; //  that bar's exact pixel x on the master's candle pane
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

// Sticky alignment anchor per tab (lock mode). Hovering a bar (cursor-driven, see
// ChartCore's crosshair handler) sets the tab's anchor to that timestamp; from then
// on EVERY pan/zoom mirror anchors on it instead of the right-edge bar, so the
// hovered candle stays vertically aligned across rows through all subsequent gestures
// (the link no longer reverts to the right edge). It stays put when the cursor leaves
// (sticky). Unset (default) → readExactAnchor falls back to the right edge. Cleared
// when lock turns off so a future lock session starts fresh. Keyed by tab so each tab
// keeps its own reference point.
const alignAnchorByTab = new Map<string, number>();
export function setAlignAnchor(tabId: string, ts: number): void {
  alignAnchorByTab.set(tabId, ts);
}
export function getAlignAnchor(tabId: string): number | undefined {
  return alignAnchorByTab.get(tabId);
}
export function clearAlignAnchor(tabId: string): void {
  alignAnchorByTab.delete(tabId);
}

// Read the time window currently on screen as its two pixel-edge timestamps.
// When the chart is scrolled so an edge sits in the empty space past the first/last
// bar, convertFromPixel at that pixel maps to NO bar and returns null.
//
// `extentFallback` (default true) governs what happens at such a null edge:
//  - true  — fall back to the data extent so a window is ALWAYS reported. CRUCIAL for
//            lock mode: returning null would make the broadcast bail, so a master
//            scrolled into right-edge whitespace would stop driving its followers and
//            they'd freeze out of alignment (the trap that desynced locked charts).
//  - false — return null, so the caller broadcasts NOTHING. The plain cross-interval
//            date-range link uses this: clamping to the extent would yank linked
//            siblings to re-frame when the user merely scrolls past the last bar into
//            whitespace, where they should simply stay put.
export function readVisibleRange(
  chart: Chart,
  extentFallback = true,
): { fromTs: number; toTs: number } | null {
  const w = mainWidth(chart);
  if (w <= 1) return null;
  const data = chart.getDataList();
  if (!data || data.length < 1) return null;
  let fromTs = tsAtX(chart, 1);
  let toTs = tsAtX(chart, w - 1);
  if (fromTs == null || toTs == null) {
    if (!extentFallback) return null;
    if (fromTs == null) fromTs = data[0].timestamp;
    if (toTs == null) toTs = data[data.length - 1].timestamp;
  }
  if (!(toTs > fromTs)) return null;
  return { fromTs, toTs };
}

// Exact-mode payload for "lock charts": the master's barSpace plus a reference bar
// near the right edge and that bar's exact pixel. Receivers on the same interval use
// these to reproduce the window pixel-for-pixel (see applyVisibleRangeExact). Returns
// null if the chart isn't measurable yet; callers then fall back to the plain range.
export function readExactAnchor(
  chart: Chart,
  preferredTs?: number,
): { barSpace: number; anchorTs: number; anchorX: number } | null {
  const w = mainWidth(chart);
  if (w <= 1) return null;
  const data = chart.getDataList();
  if (!data || data.length < 1) return null;
  let anchorTs: number | null;
  if (preferredTs != null) {
    // Sticky alignment anchor (the last hovered timestamp): anchor on the master's bar
    // nearest it so the hovered candle stays aligned across rows on every gesture,
    // instead of the link reverting to the right edge. Snapping to a real bar makes
    // anchorX a true candle centre. The anchor holds even when it's scrolled off
    // screen (xAtTs still extrapolates its pixel, so the offset is preserved).
    anchorTs = data[nearestIdx(data, preferredTs)].timestamp;
  } else {
    // Default anchor: the bar nearest the right pixel edge (latest visible) — a REAL
    // data point (convertFromPixel snaps to it), so its convertToPixel is that bar's
    // true centre. If the right edge is in whitespace past the last bar, that pixel
    // maps to no bar (null) — fall back to the last bar so the link survives a master
    // scrolled past its last bar instead of silently dying (see readVisibleRange).
    anchorTs = tsAtX(chart, w - 1);
    if (anchorTs == null) anchorTs = data[data.length - 1].timestamp;
  }
  const anchorX = xAtTs(chart, anchorTs);
  if (anchorX == null) return null;
  return { barSpace: chart.getBarSpace(), anchorTs, anchorX };
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

// Exact mirror for "lock charts": the sibling shares the master's interval, so we
// copy its barSpace verbatim and scroll so the reference bar `anchorTs` lands on the
// exact pixel `anchorX` it holds on the master — no bar-count re-derivation. With
// matching bars (same instrument, or the same trading session) this lands EVERY
// column on the same pixel (measured 0px across the view). The approximate path's
// ~1-bar left drift came from re-deriving zoom from a bar count, which this skips.
// If the two instruments' sessions differ the bars themselves don't line up, so
// columns can still diverge away from the anchor — a data limit, not a math one.
//
// The scroll is iterated: scrollToTimestamp parks the bar ~2 bars from the right, and
// a single scrollByDistance can leave a sub-pixel residual, so we nudge until the bar
// sits within ½px of anchorX (converges in 1–2 passes; capped so a chart that lacks
// the history to reach the target degrades gracefully instead of looping).
export function applyVisibleRangeExact(
  chart: Chart,
  anchorTs: number,
  anchorX: number,
  barSpace: number,
): void {
  const w = mainWidth(chart);
  if (w <= 1 || !(barSpace > 0)) return;
  const data = chart.getDataList();
  if (!data || data.length < 2) return;
  // Snap the broadcast anchor to THIS chart's nearest real bar. Same instrument →
  // the same bar (pixel-perfect). Different instrument whose session lacks that exact
  // time → its closest candle, so the clicked/anchored candle still lines up rather
  // than landing between bars.
  const nearTs = data[nearestIdx(data, anchorTs)].timestamp;
  const target = clampBarSpace(barSpace);
  // Already aligned (same zoom AND anchor bar already on the target pixel)? Skip — the
  // anchor follows the cursor, so this fires on every hovered-bar change; without this
  // a sibling that's already in place would needlessly re-scroll each time.
  if (Math.abs(chart.getBarSpace() - target) < 0.01) {
    const cur = xAtTs(chart, nearTs);
    if (cur != null && Math.abs(cur - anchorX) < 0.5) return;
  }
  chart.setBarSpace(target);
  chart.scrollToTimestamp(nearTs, 0);
  scrollBarToPixel(chart, nearTs, anchorX);
}

// Pan (no zoom change) so the chart's view puts the bar at `ts` on pixel `x`. Nudges
// iteratively because scrollByDistance can leave a sub-pixel residual; converges in
// 1–2 passes, capped so a chart that can't scroll far enough (not enough history)
// degrades gracefully instead of looping.
function scrollBarToPixel(chart: Chart, ts: number, x: number): void {
  for (let i = 0; i < 6; i++) {
    const cur = xAtTs(chart, ts);
    if (cur == null) break;
    const d = x - cur;
    if (Math.abs(d) < 0.5) break;
    chart.scrollByDistance(d, 0);
  }
}


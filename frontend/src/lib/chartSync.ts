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

import { type Chart } from "klinecharts";

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
// only exposes setBarSpace (zoom) + scrollToTimestamp (park one bar flush at the
// right edge), so "show this time window" has to be synthesised from those. The barSpace→window relation isn't exact (it drifts a few %), so we
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
  return chart.getSize("candle_pane", 'main')?.width ?? 0;
}
// Typical bar spacing (ms) as the median positive timestamp delta — robust to
// session gaps (mirrors customIndicators' estimateBarMs, which can't be imported
// here: that module registers indicators at load). 0 when too little data to tell.
function medianBarMs(data: { timestamp: number }[]): number {
  if (data.length < 2) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const d = data[i].timestamp - data[i - 1].timestamp;
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return 0;
  deltas.sort((a, b) => a - b);
  return deltas[deltas.length >> 1];
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

// Timestamp at pixel x, EXTRAPOLATED into whitespace. klinecharts maps pixels past
// the data extent onto virtual bar slots (whitespace renders at the same barSpace as
// real bars), but convertFromPixel returns null there — no bar to look the time up
// on. Reproduce the mapping in wall-clock terms by extending from the nearest end
// bar at this chart's typical bar interval, so a window edge in whitespace still
// carries a meaningful time.
function tsAtXVirtual(
  chart: Chart,
  x: number,
  data: { timestamp: number }[],
  barMs: number,
): number | null {
  const ts = tsAtX(chart, x);
  if (ts != null) return ts;
  if (!(barMs > 0)) return null;
  const space = chart.getBarSpace().bar;
  if (!(space > 0)) return null;
  const lastTs = data[data.length - 1].timestamp;
  const xLast = xAtTs(chart, lastTs);
  if (xLast != null && x > xLast) return lastTs + ((x - xLast) / space) * barMs;
  const firstTs = data[0].timestamp;
  const xFirst = xAtTs(chart, firstTs);
  if (xFirst != null && x < xFirst) return firstTs - ((xFirst - x) / space) * barMs;
  return null;
}

// The window's position on this chart's bar axis, in (fractional) bar indices —
// virtual indices past either end stand for whitespace slots, converted at this
// chart's own bar interval. This is what lets a window that extends past the last
// bar keep its meaning on a chart with a different interval.
function floatIdxAt(data: { timestamp: number }[], ts: number, barMs: number): number {
  const n = data.length;
  const firstTs = data[0].timestamp;
  const lastTs = data[n - 1].timestamp;
  if (barMs > 0 && ts > lastTs) return n - 1 + (ts - lastTs) / barMs;
  if (barMs > 0 && ts < firstTs) return -((firstTs - ts) / barMs);
  return nearestIdx(data, ts);
}

// Read the time window currently on screen as its two pixel-edge timestamps. An
// edge sitting in the empty space past the first/last bar is extrapolated at the
// chart's bar interval (see tsAtXVirtual), so a master panned into right-edge
// whitespace KEEPS reporting a (partly virtual) window and its followers keep
// tracking — the old behavior of bailing there froze followers at the master's
// last-bar time, hiding any newer candles of their own for good. Falls back to the
// data extent only when extrapolation is impossible (single bar).
export function readVisibleRange(chart: Chart): { fromTs: number; toTs: number } | null {
  const w = mainWidth(chart);
  if (w <= 1) return null;
  const data = chart.getDataList();
  if (!data || data.length < 1) return null;
  const barMs = medianBarMs(data);
  let fromTs = tsAtXVirtual(chart, 1, data, barMs);
  let toTs = tsAtXVirtual(chart, w - 1, data, barMs);
  if (fromTs == null) fromTs = data[0].timestamp;
  if (toTs == null) toTs = data[data.length - 1].timestamp;
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
  return { barSpace: chart.getBarSpace().bar, anchorTs, anchorX };
}

// Pan/zoom `chart` so its left edge ≈ fromTs and right edge ≈ toTs, mapping the
// timestamps onto this chart's own bars (handles a different interval). A window
// extending past the last bar becomes right-edge whitespace here too: the excess
// time converts to virtual bars at THIS chart's interval, and the last bar is
// pinned that many bar-widths left of the edge — so a follower first reveals its
// own newest candles, then mirrors the master's whitespace proportionally. No-op if
// the chart has no width or data yet; degrades gracefully when the chart lacks
// history covering the window (the window is then approximate, never a throw).
export function applyVisibleRange(chart: Chart, fromTs: number, toTs: number): void {
  const w = mainWidth(chart);
  if (w <= 1 || !(toTs > fromTs)) return;
  const data = chart.getDataList();
  if (!data || data.length < 2) return;
  const barMs = medianBarMs(data);
  const lastTs = data[data.length - 1].timestamp;
  const toIdx = floatIdxAt(data, toTs, barMs);
  // Whitespace share of the window, in this chart's own (virtual) bars.
  const wsBars = Math.max(0, toIdx - (data.length - 1));
  const bars = Math.max(1, toIdx - floatIdxAt(data, fromTs, barMs));
  // klinecharts silently no-ops setBarSpace for values outside [1, 50] (px/bar).
  // When the window maps onto only a few bars of a coarser sibling, w/bars blows
  // past 50, so an unclamped call would be dropped — leaving the sibling at its
  // old zoom showing the wrong window. Clamp so it caps at max zoom (that bar plus
  // context) instead of being thrown away. Clamping the stored `space` too keeps
  // the correction pass below honest about what was actually applied.
  let space = clampBarSpace(w / bars);
  chart.setBarSpace(space);
  // The scroll anchor must be a REAL bar (scrollToTimestamp clamps a future time to
  // the last bar anyway): the bar nearest toTs, or the last bar when toTs is in the
  // whitespace — then pinned wsBars bar-widths left of the right edge.
  const anchorTs = toTs > lastTs ? lastTs : data[nearestIdx(data, toTs)].timestamp;
  chart.scrollToTimestamp(anchorTs, 0);
  scrollBarToPixel(chart, anchorTs, w - wsBars * space);
  // One correction pass: rescale zoom by the ratio of the span we actually got to
  // the span we wanted (the barSpace→window relation isn't exactly linear). Edges
  // in whitespace are measured by extrapolation, same as the read side.
  const lpx = tsAtXVirtual(chart, 1, data, barMs);
  const rpx = tsAtXVirtual(chart, w - 1, data, barMs);
  if (lpx != null && rpx != null && rpx > lpx) {
    space = clampBarSpace(space * ((rpx - lpx) / (toTs - fromTs)));
    chart.setBarSpace(space);
  }
  // Re-pin after the zoom correction (barSpace changes shift the anchor's pixel).
  scrollBarToPixel(chart, anchorTs, w - wsBars * space);
}

// Like applyVisibleRange, but guarantees `startTs` (default fromTs) stays on
// screen near the left. applyVisibleRange right-anchors toTs and floors zoom at
// MIN_BAR_SPACE, so a window wider than the view can hold at max zoom-out pushes
// the left end off screen. Used when the START matters more than the end — a
// finished backtest must land on its FIRST trade even when the whole traded span
// can't fit. When the span fits this only nudges in a small left margin; when it
// doesn't it re-pins startTs a few bars from the left (the tail overflows right,
// pannable) instead of hiding it off the left edge.
export function applyVisibleRangeKeepStart(
  chart: Chart,
  fromTs: number,
  toTs: number,
  startTs: number = fromTs,
): void {
  applyVisibleRange(chart, fromTs, toTs);
  const w = mainWidth(chart);
  const data = chart.getDataList();
  if (w <= 1 || !data || data.length < 2) return;
  const barTs = data[nearestIdx(data, startTs)].timestamp;
  const leftPad = Math.min(Math.max(chart.getBarSpace().bar * 4, 16), w * 0.15);
  const x = xAtTs(chart, barTs);
  // Already visible with at least the left margin — the span fit, leave it.
  if (x == null || x >= leftPad - 0.5) return;
  scrollBarToPixel(chart, barTs, leftPad);
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
// The scroll is iterated: scrollToTimestamp lands the bar flush at the right edge
// (half a bar in), and a single scrollByDistance can leave a sub-pixel residual, so
// we nudge until the bar sits within ½px of anchorX (converges in 1–2 passes; capped
// so a chart that lacks the history to reach the target degrades gracefully instead
// of looping).
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
  if (Math.abs(chart.getBarSpace().bar - target) < 0.01) {
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


// Pure trade-marker math: labels and glyphs, pill stacking and placement,
// bar lookup, per-bar trade clusters, trade dashes and the anchor helpers.
// No chart state lives here.
import type { Marker, TradeZone as TradeZoneWire } from "../../api";
import type { StoredBacktestResult } from "../persist";

export type Trade = StoredBacktestResult["trades"][number];

/** Chart marker label. Risk exits read by reason: stop/trailing => "SL",
 * target => "TP". Otherwise "+" opens a position and "-" closes it, prefixed by
 * the order side (B/S): open-long=B+, close-long=S-, open-short=S+, close-short=B-. */
export function markerLabel(side: "buy" | "sell", leg: "long" | "short", reason?: string): string {
  if (reason === "stop" || reason === "trail") return "SL";
  if (reason === "target") return "TP";
  const letter = side === "buy" ? "B" : "S";
  const opening = (leg === "long" && side === "buy") || (leg === "short" && side === "sell");
  return `${letter}${opening ? "+" : "-"}`;
}

/** The trade direction to badge an ENTRY marker with, or null for an exit fill.
 * A fill opens a position when its side matches its leg (buy⇒long, sell⇒short) —
 * the same "opening" test markerLabel uses. Entries get a ▲long / ▼short arrow
 * in the pill; exits (which close the opposite side) get none. */
export function entryDirection(side: "buy" | "sell", leg: "long" | "short"): "long" | "short" | null {
  const opening = (leg === "long" && side === "buy") || (leg === "short" && side === "sell");
  return opening ? leg : null;
}

// The long/short direction glyphs, shared by the native pill (markerPillLabel)
// and the coarser-timeframe aggregate pill (aggPillLabel) so the up/down cue
// reads identically on every timeframe.
export const LONG_GLYPH = "▲";
export const SHORT_GLYPH = "▼";

/** The native fill pill's text: `markerLabel` prefixed with the direction glyph
 * on ENTRY fills (▲ B+ / ▼ S+) so long vs short reads at a glance. Exits
 * (S-/B-/SL/TP) get no glyph — direction only tags the opening fill. */
export function markerPillLabel(side: "buy" | "sell", leg: "long" | "short", reason?: string): string {
  const base = markerLabel(side, leg, reason);
  const dir = entryDirection(side, leg);
  return dir ? `${dir === "long" ? LONG_GLYPH : SHORT_GLYPH} ${base}` : base;
}

/** The aggregate (grouped) pill's text for a bar's cluster of trades: the same
 * direction glyphs as the native pill plus the count·net summary. A bar with
 * both directions splits the count inline (▲2 ▼1 · +4); a single-direction bar
 * shows one glyph (▲ 3 · +12, or ▲ +12 when it holds just one trade). Pure +
 * exported for tests; consumed by BacktestAggMarkers. */
export function aggPillLabel(longs: number, shorts: number, net: number): string {
  // One decimal for a single-digit magnitude (small nets read too coarse as
  // integers); drop to a whole number once |net| ≥ 10, where the decimal is just
  // pill-widening noise.
  const abs = Math.abs(net);
  const netStr = `${net >= 0 ? "+" : "−"}${abs.toFixed(abs >= 10 ? 0 : 1)}`;
  if (longs > 0 && shorts > 0) {
    return `${LONG_GLYPH}${longs} ${SHORT_GLYPH}${shorts} · ${netStr}`;
  }
  const glyph = longs > 0 ? LONG_GLYPH : SHORT_GLYPH;
  const count = longs + shorts;
  return count >= 2 ? `${glyph} ${count} · ${netStr}` : `${glyph} ${netStr}`;
}

// Vertical distance between stacked pills on one bar: the default overlay text
// pill is 12px text + 4px vertical padding + 1px border each way (~22px tall),
// so this step clears it with no overlap.
export const MARKER_PILL_STACK_STEP = 22;

/** Stack index for a fill marker's pill: 0 for the first marker on a bar+side,
 * then counting up per collision. Two fills can share a candle AND a placement
 * (a short's ▼ S+ entry on the bar a prior short's B- exit filled) — without
 * stacking, both pills render centered at the same x/y and the wider one peeks
 * out half-clipped behind the other. The caller passes one shared `counts` map
 * per draw pass; keys are the snapped bar time + placement. */
export function nextMarkerStack(
  counts: Map<string, number>,
  ts: number,
  placement: "above" | "below",
): number {
  const key = `${ts}|${placement}`;
  const n = counts.get(key) ?? 0;
  counts.set(key, n + 1);
  return n;
}

/** Which side of the candle a fill marker should hang from so it clears the
 * body. The arrow always pins to the exact fill price, so the pill has to be
 * offset AWAY from the body: if the fill sits in the lower half of the candle
 * (e.g. a short opened at a bullish candle's open, which is its low), drop the
 * pill BELOW it; otherwise keep the historical ABOVE placement. Ties at the
 * exact midpoint default to "above". Decided once at draw time (price space, so
 * stable across zoom/pan). Returns "above" when high==low (a flat/degenerate
 * bar has no body to clear). */
export function markerPlacement(fillPrice: number, high: number, low: number): "above" | "below" {
  const mid = (high + low) / 2;
  return fillPrice < mid ? "below" : "above";
}

/** One higher-timeframe bar's worth of trades, ready to draw as a single pill.
 * `barTs`/`high` anchor the pill (ms + the bar's high price); `fromTs`/`toTs`
 * (ms) are the min-entry→max-exit span used to zoom on drill-in. Pure output of
 * `aggregateTradesByBar` — exported for tests. */
export interface TradeCluster {
  barTs: number;
  high: number;
  trades: { trade: Trade; index: number }[];
  net: number;
  fromTs: number;
  toTs: number;
}

/** Index of the loaded bar that CONTAINS `ms` — the last bar whose timestamp is
 * `<= ms`, clamped to `[0, last]`. The same "last bar at or before this time"
 * rule klinecharts uses to snap an overlay, rather than `floor(t / seconds)`
 * math — daily/weekly/derived bars don't align to epoch multiples. A time before
 * the first / after the last loaded bar clamps to the edge bar so it stays
 * discoverable. Empty `barTimes` returns -1. Pure + exported (shared by
 * `aggregateTradesByBar` and the live trade-marker drawer). */
export function barIndexForTs(barTimes: number[], ms: number): number {
  return barIndexBy(barTimes.length, (i) => barTimes[i], ms);
}

/** barIndexForTs over the bar objects directly — for callers that only need a
 * couple of lookups and shouldn't materialize a full timestamps array first
 * (the loaded list can run to 150k+ bars after a deep jump). */
export function barIndexForBars(bars: readonly { timestamp: number }[], ms: number): number {
  return barIndexBy(bars.length, (i) => bars[i].timestamp, ms);
}

function barIndexBy(len: number, tsAt: (i: number) => number, ms: number): number {
  const last = len - 1;
  if (last < 0) return -1;
  if (ms <= tsAt(0)) return 0;
  if (ms >= tsAt(last)) return last;
  let lo = 0;
  let hi = last;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tsAt(mid) <= ms) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return idx;
}

/** Bucket trades into the loaded chart bar that CONTAINS each trade's entry
 * (the bar whose `[timestamp, nextTimestamp)` window covers `entry_time`), by
 * the shared `barIndexForTs` rule. Trades before the first / after the last
 * loaded bar clamp to the edge bar so they stay discoverable. Pure + exported
 * for tests. */
export function aggregateTradesByBar(
  trades: Trade[],
  bars: { timestamp: number; high: number }[],
): TradeCluster[] {
  if (bars.length === 0) return [];
  const barTimes = bars.map((b) => b.timestamp);
  const byBar = new Map<number, TradeCluster>();
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const entryMs = t.entry_time * 1000;
    const exitMs = t.exit_time * 1000;
    const idx = barIndexForTs(barTimes, entryMs);
    let cl = byBar.get(idx);
    if (!cl) {
      cl = {
        barTs: bars[idx].timestamp,
        high: bars[idx].high,
        trades: [],
        net: 0,
        fromTs: entryMs,
        toTs: exitMs,
      };
      byBar.set(idx, cl);
    }
    cl.trades.push({ trade: t, index: i });
    cl.net += t.pnl;
    cl.fromTs = Math.min(cl.fromTs, entryMs);
    cl.toTs = Math.max(cl.toTs, exitMs);
  }
  return [...byBar.values()].sort((a, b) => a.barTs - b.barTs);
}

/** One per-trade dash for the coarse-timeframe view: the containing display
 * bar, how far through it the entry sits (0..1, so the dash lands time-wise on
 * the candle, e.g. an entry 3h into a 4h bar draws at ¾ of its width), the
 * entry price (the dash's y), and how many display candles the trade covers
 * (drives hover: ≥2 shows the entry→exit overlay, 1 a details tooltip). */
export interface TradeDash {
  index: number; // index into result.trades (highlightTradeSignal key)
  trade: Trade;
  barTs: number; // containing display bar open (ms)
  frac: number; // 0..1 entry position within that bar
  price: number; // entry_price
  spanBars: number; // display candles covered entry→exit, inclusive
}

/** Per-trade dash anchors for the aggregate (coarser-than-native) view. The
 * within-bar fraction divides by the NOMINAL bar interval — `nominalMs` when
 * the caller knows the display interval (preferred: the min-gap fallback is
 * poisoned by one DST-short session or calendar-length bars), else the minimum
 * gap between consecutive loaded bars — not the gap to the next bar, so a
 * session closure after the containing bar can't smear an entry leftward; an
 * entry inside a closure gap clamps to its bar's right edge. Trades entering
 * OUTSIDE the loaded window are dropped on both sides (the cluster pill still
 * counts them; a clamped dash would mark a made-up position). An exit past the
 * loaded window forces spanBars >= 2 — the trade outlives the last candle even
 * though its clamped exit index says otherwise. Fewer than two bars gives no
 * interval to place within -> []. Pure + exported for tests. */
export function tradeDashes(
  clusters: TradeCluster[],
  bars: readonly { timestamp: number }[],
  nominalMs?: number,
): TradeDash[] {
  if (bars.length < 2) return [];
  const barTimes = bars.map((b) => b.timestamp);
  let intervalMs = nominalMs ?? Infinity;
  if (nominalMs == null) {
    for (let i = 1; i < barTimes.length; i++) {
      const d = barTimes[i] - barTimes[i - 1];
      if (d > 0 && d < intervalMs) intervalMs = d;
    }
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return [];
  const last = barTimes[barTimes.length - 1];
  const out: TradeDash[] = [];
  for (const cl of clusters) {
    for (const { trade: t, index } of cl.trades) {
      const entryMs = t.entry_time * 1000;
      if (entryMs < barTimes[0] || entryMs >= last + intervalMs) continue;
      const exitMs = t.exit_time * 1000;
      const entryIdx = barIndexForTs(barTimes, entryMs);
      const exitIdx = barIndexForTs(barTimes, exitMs);
      let spanBars = Math.max(exitIdx - entryIdx, 0) + 1;
      if (exitMs >= last + intervalMs) spanBars = Math.max(spanBars, 2);
      out.push({
        index,
        trade: t,
        barTs: barTimes[entryIdx],
        frac: Math.min((entryMs - barTimes[entryIdx]) / intervalMs, 1),
        price: t.entry_price,
        spanBars,
      });
    }
  }
  return out;
}

/** [start, end) bounds of the dashes whose barTs falls in [fromTs, toTs] — two
 * binary searches over the barTs-ascending dash list, so the per-frame
 * projection touches O(log n + visible) dashes instead of every trade. Pure +
 * exported for tests (the caller, useChartPaint, feeds it the visible range). */
export function dashSliceBounds(
  dashes: readonly { barTs: number }[],
  fromTs: number,
  toTs: number,
): [number, number] {
  let lo = 0;
  let hi = dashes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dashes[mid].barTs < fromTs) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  hi = dashes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dashes[mid].barTs <= toTs) lo = mid + 1;
    else hi = mid;
  }
  return [start, lo];
}

/** Snap a timestamp (ms) to the closest bar in an ascending `barTimes` (ms).
 * Used to anchor native fill arrows on a finer view whose interval doesn't
 * evenly divide the native one (3m viewing a 5m run) — the fill falls between
 * two bars, so it lands on whichever is nearer. A fill already on a bar returns
 * that same bar; empty `barTimes` returns the input unchanged. Exported for tests. */
export function snapNearestBar(ms: number, barTimes: number[]): number {
  const n = barTimes.length;
  if (n === 0) return ms;
  if (ms <= barTimes[0]) return barTimes[0];
  if (ms >= barTimes[n - 1]) return barTimes[n - 1];
  // Binary search for the first bar at or after `ms`, then pick the nearer of it
  // and the bar before it (ties go to the earlier bar).
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (barTimes[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  const after = barTimes[lo];
  const before = barTimes[lo - 1];
  return ms - before <= after - ms ? before : after;
}

/** Whether a fill at `ms` falls within the loaded bar window `[first, last]`
 * (inclusive). A finer timeframe loads far less history than the backtest's own
 * resolution (a fixed bar count spans a much shorter time), so a trade older
 * than the loaded window can't be placed on a real candle: `snapNearestBar`
 * would clamp EVERY such fill onto the edge bar, stacking them into one
 * misleading vertical pile floating above the visible candles. Native markers
 * outside the window are skipped instead — the trade stays listed in the panel
 * and remains discoverable via any coarser view's aggregate pill. Empty
 * `barTimes` => false (nothing loaded to anchor to). Pure + exported for tests. */
export function fillWithinLoadedWindow(ms: number, barTimes: number[]): boolean {
  const n = barTimes.length;
  if (n === 0) return false;
  return ms >= barTimes[0] && ms <= barTimes[n - 1];
}

/** Right edge for a trade overlay whose exit happened at `exitExactMs`, rounded
 * UP to the close of the display candle that contains it, so the overlay covers
 * at least the trade's real duration. Floors at one display bar so a first-bar
 * exit still shows. `bars` are the currently loaded candles (ascending). */
export function overlayEndTs(
  exitExactMs: number,
  bars: readonly { timestamp: number }[],
  barMs: number,
  entryTs: number,
): number {
  const floor = entryTs + barMs;
  if (bars.length === 0) return Math.max(floor, exitExactMs);
  // The display candle containing exitExactMs is the last bar whose open <= it.
  let containing = bars[0].timestamp;
  for (const b of bars) {
    if (b.timestamp <= exitExactMs) containing = b.timestamp;
    else break;
  }
  return Math.max(floor, containing + barMs); // round up to that candle's close
}

/** The ms time span to draw a strategy zone over, or null when the zone lies
 * entirely outside the loaded bar window [firstTs, lastTs] — klinecharts would
 * clamp every point onto the edge bar and draw a degenerate sliver (same guard
 * as the risk/reward zone). A PARTIAL overlap still draws: clamping only one
 * edge reads fine. */
export function strategyZoneSpan(
  z: TradeZoneWire,
  firstTs: number,
  lastTs: number,
): { fromTs: number; toTs: number } | null {
  const fromTs = z.from_time * 1000;
  const toTs = z.to_time * 1000;
  if (toTs < firstTs || fromTs > lastTs) return null;
  return { fromTs, toTs };
}

/** The oldest bar timestamp (ms) a set of fill markers needs loaded so ALL their
 * on-chart artifacts can be drawn — the min over each marker's fill time AND its
 * `signal_time`. A rule-based fill's signal caret anchors ONE bar before the fill
 * (the signal bar), so covering only the oldest fill can leave the leftmost
 * entry's signal bar just outside the loaded window: reanchor then draws the fill
 * but the caret's window guard (see drawMarkers) skips it, and no later reanchor
 * fires to add it. Folding signal_time in pages back the extra bar so the caret
 * draws too. null when there are no markers. Pure + exported for tests. */
export function oldestBacktestAnchorMs(markers: Marker[]): number | null {
  let min = Infinity;
  for (const m of markers) {
    min = Math.min(min, m.time * 1000);
    if (m.signal_time != null) min = Math.min(min, m.signal_time * 1000);
  }
  return Number.isFinite(min) ? min : null;
}

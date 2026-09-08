// Session-lifetime cache of each series' last-known bars, so a chart cell that
// remounts (tab switch, hydrate remount) can paint candles IMMEDIATELY instead
// of sitting blank for the ~1-2s the backend needs to refresh the live edge
// from the broker. The fresh fetch still runs and replaces/merges what was
// painted — this cache only buys back the perceived latency, it is never the
// source of truth.
//
// Keyed by the load effect's series key (`broker|epic|resolution|priceSide`),
// module-level and in-memory only: bars are cheap to refetch, so persisting
// them would add staleness risk for no win. Never fed from replay or detached
// loads — those bars are a masked slice / a deep-history window, not the live
// series (the callers guard).

import type { KLineData } from "klinecharts";

/** Distinct series kept; least-recently-used beyond this is dropped. */
export const BAR_CACHE_MAX_SERIES = 32;
/** Bars kept per series: the ~500-bar recent window plus scroll-back headroom.
 * ~56 bytes/bar means a full cache tops out around a few MB. */
export const BAR_CACHE_MAX_BARS = 2500;

// Map iteration order is insertion order, so delete+set on every touch makes
// the first key the least recently used.
const cache = new Map<string, KLineData[]>();

const copy = (bars: KLineData[]): KLineData[] => bars.map((b) => ({ ...b }));

/** Last-known bars for a series, or null. Serves per-bar copies — the chart
 * annotates bar objects in place, and that must never leak back in here. */
export function getCachedBars(key: string): KLineData[] | null {
  const bars = cache.get(key);
  if (!bars) return null;
  cache.delete(key); // LRU touch
  cache.set(key, bars);
  return copy(bars);
}

/** Remember a series' bars (newest tail only, see BAR_CACHE_MAX_BARS). Copies
 * on the way in: callers hand over live arrays the stream keeps mutating. */
export function putCachedBars(key: string, bars: KLineData[]): void {
  if (bars.length === 0) return; // nothing a pre-paint could use
  cache.delete(key);
  cache.set(key, copy(bars.slice(-BAR_CACHE_MAX_BARS)));
  if (cache.size > BAR_CACHE_MAX_SERIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Union of a painted (cached) series and a freshly fetched window, deduped by
 * timestamp with the fresh bar winning, sorted ascending. Applying the fresh
 * ~500-bar window alone would SHRINK a chart whose cache held deeper history —
 * merging keeps the depth while the live edge gets the up-to-date bars. */
export function mergeBars(painted: KLineData[], fresh: KLineData[]): KLineData[] {
  if (painted.length === 0) return fresh;
  if (fresh.length === 0) return painted;
  const byTs = new Map<number, KLineData>();
  for (const b of painted) byTs.set(b.timestamp, b);
  for (const b of fresh) byTs.set(b.timestamp, b);
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** The load-settle rule: merge the fresh recent window over the painted
 * (pre-painted) bars ONLY when the two windows overlap — an overlap proves the
 * merged series is continuous. A cache stale enough that the fresh window
 * starts after its last bar cannot be stitched safely (the missing span might
 * be real bars, not a market closure — klinecharts renders index-adjacent, so
 * a gap would hide inside a seamless-looking chart): drop the painted bars and
 * serve the fresh window alone, exactly what an uncached load does. */
export function mergeFreshWindow(painted: KLineData[], fresh: KLineData[]): KLineData[] {
  if (painted.length === 0 || fresh.length === 0) return fresh;
  return fresh[0].timestamp <= painted[painted.length - 1].timestamp
    ? mergeBars(painted, fresh)
    : fresh;
}

/** Tests only. */
export function clearBarCache(): void {
  cache.clear();
}

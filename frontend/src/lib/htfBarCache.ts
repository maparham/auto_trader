// Ownership of higher-timeframe candles, in one place.
//
// THE PROBLEM THIS EXISTS FOR. Every MTF indicator instance used to be both a
// data fetcher and a computation: each ran its own paged walk back over the HTF
// candles it needed, even when another indicator on the same chart was pinned to
// the SAME epic and timeframe and was walking the same bars at the same moment.
// The instrumentation in perfDiag caught the result as a fetch-storm: 63
// windowed requests in one 15s window, returning 1500 bars between them.
//
// WHAT IT DOES NOW. One stored INTERVAL of bars per (broker, epic, timeframe,
// price side): `[fromMs, toMs]`, contiguous and ascending. A request covered by
// the entry is served without a network touch; a request that extends it
// fetches ONLY the missing span (left gap, right gap, or both) and merges; a
// request disjoint from the entry replaces it, mirroring the stash's rebase
// rule, so a years-deep pattern jump never drags the whole in-between span in.
// Work per key is serialized on a promise chain, which is what collapses the
// refreshMtfIndicators fan-out: concurrent identical asks ride one walk.
//
// Compared to the previous live-edge-bucketed cache: the key no longer encodes
// the newest bar. Bars strictly older than the entry's last bucket are closed
// history and immutable; only the right edge can grow or still be forming, so
// freshness is a right-edge question. A request whose right end reaches the
// entry's last bucket is served within HTF_CACHE_TTL_MS and revalidated past
// it, refetching from the LAST STORED BAR (it may have been forming when
// stored). Replay cells share entries with live cells safely because the
// no-lookahead clamp is applied per caller AFTER the fetch (see fetchHtfBars).
//
// Failures never extend the stored ask: a span that failed must be retried,
// and the existing per-indicator retry/backoff owns that decision.

import type { KLineData } from "klinecharts";

/** How long the RIGHT EDGE of an entry stays trusted without revalidation.
 * Deliberately short: it absorbs the burst of refreshes a scroll or settle
 * produces, not staleness. Tiny next to any HTF bucket, so a bar closing
 * inside the window is picked up by the next trigger. */
export const HTF_CACHE_TTL_MS = 5_000;

/** Cap on retained entries, so browsing many symbols cannot grow this without
 * bound. Entries now hold real bar arrays, so this matters more than it did. */
const MAX_ENTRIES = 24;

export interface HtfIntervalResult {
  /** Ascending bars covering [askFromMs, askToMs], as far as data exists. */
  bars: KLineData[];
  /** A span load failed. Partial bars are still returned; the caller's retry
   * path owns what happens next, and must not treat the ask as settled. */
  failed: boolean;
  askFromMs: number;
  askToMs: number;
}

/** Fetches the bars for one span. Supplied by the caller so this module owns
 * sharing and nothing else. A failed load returns its contiguous newest-side
 * prefix with `failed: true` (see historyPaging.fetchSpanParallel). */
export type HtfSpanLoader = (
  fromMs: number,
  toMs: number,
) => Promise<{ bars: KLineData[]; failed: boolean }>;

interface Entry {
  fromMs: number; // how far left the stored bars' ask settled
  toMs: number; // how far right
  bars: KLineData[]; // ascending, contiguous
  at: number; // when the right edge was last (re)validated
}

const cache = new Map<string, Entry>();
/** Per-key serialization chain. Presence = work in flight for that key. */
const chains = new Map<string, Promise<unknown>>();

/** The identity of a set of HTF bars. Price side is in here because it changes
 * the bars themselves (bid vs mid decides trendline breaks). No live-edge
 * bucket: freshness is handled per entry, and the replay clamp is per caller. */
export function htfIntervalKey(parts: {
  brokerId: string | undefined;
  epic: string;
  timeframe: string;
  priceSide: string;
}): string {
  return `${parts.brokerId ?? ""}|${parts.epic}|${parts.timeframe}|${parts.priceSide}`;
}

function mergeBars(a: KLineData[], b: KLineData[]): KLineData[] {
  const by = new Map<number, KLineData>();
  for (const x of a) by.set(x.timestamp, x);
  for (const x of b) by.set(x.timestamp, x); // the newer fetch wins a collision
  return [...by.values()].sort((x, y) => x.timestamp - y.timestamp);
}

function evictOverflow(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * The HTF bars for `key` covering `[fromMs, toMs]`, fetching only what the
 * stored interval is missing. `htfMs` is the nominal bucket width, used for
 * the touching/disjoint test and the strictly-historical freshness test.
 */
export function fetchHtfInterval(
  key: string,
  fromMs: number,
  toMs: number,
  htfMs: number,
  loadSpan: HtfSpanLoader,
): Promise<HtfIntervalResult> {
  const prev = chains.get(key) ?? Promise.resolve();
  const work = (): Promise<HtfIntervalResult> =>
    resolveInterval(key, fromMs, toMs, htfMs, loadSpan);
  const run = prev.then(work, work);
  const wrapped = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, wrapped);
  void wrapped.then(() => {
    if (chains.get(key) === wrapped) chains.delete(key);
  });
  return run;
}

async function resolveInterval(
  key: string,
  fromMs: number,
  toMs: number,
  htfMs: number,
  loadSpan: HtfSpanLoader,
): Promise<HtfIntervalResult> {
  const width = htfMs > 0 ? htfMs : 3_600_000;
  const slice = (bars: KLineData[]): KLineData[] =>
    bars.filter((b) => b.timestamp >= fromMs && b.timestamp <= toMs);

  let entry = cache.get(key);
  // Disjoint by more than one bucket: replace rather than drag the gap in.
  if (
    entry &&
    (toMs < entry.fromMs - width || fromMs > entry.toMs + width)
  ) {
    cache.delete(key);
    entry = undefined;
  }

  if (!entry) {
    const r = await loadSpan(fromMs, toMs);
    if (r.bars.length || !r.failed) {
      cache.set(key, {
        // A failed load must not record the full ask as settled, or the retry
        // would be served the hole. The bars' own left edge is what landed.
        fromMs: r.failed ? (r.bars[0]?.timestamp ?? toMs) : fromMs,
        toMs,
        bars: r.bars,
        at: Date.now(),
      });
      evictOverflow();
    }
    return { bars: slice(r.bars), failed: r.failed, askFromMs: fromMs, askToMs: toMs };
  }

  let failed = false;

  // Left gap.
  if (fromMs < entry.fromMs) {
    const r = await loadSpan(fromMs, entry.fromMs - 1);
    entry.bars = mergeBars(r.bars, entry.bars);
    if (r.failed) failed = true;
    entry.fromMs = r.failed
      ? Math.min(entry.fromMs, r.bars[0]?.timestamp ?? entry.fromMs)
      : fromMs;
  }

  // Right gap, or a right edge due for revalidation. Refetch FROM the last
  // stored bar: it may have been forming when stored, and its bucket is the
  // first thing that can have changed.
  const lastBarMs = entry.bars.length
    ? entry.bars[entry.bars.length - 1].timestamp
    : entry.fromMs;
  const wantsEdge = toMs > entry.toMs - width; // reaches the entry's last bucket
  const stale = Date.now() - entry.at >= HTF_CACHE_TTL_MS;
  if (toMs > entry.toMs || (wantsEdge && stale)) {
    const r = await loadSpan(lastBarMs, Math.max(toMs, entry.toMs));
    entry.bars = mergeBars(entry.bars, r.bars);
    if (r.failed) failed = true;
    else {
      entry.toMs = Math.max(toMs, entry.toMs);
      entry.at = Date.now();
    }
  }

  return { bars: slice(entry.bars), failed, askFromMs: fromMs, askToMs: toMs };
}

/** Drop everything. For tests, and for any caller that knows the underlying
 * bars are no longer trustworthy. */
export function clearHtfCache(): void {
  cache.clear();
  chains.clear();
}

/** Entry counts, for tests and console poking. Never read by the app. */
export function htfCacheStats(): { cached: number; inflight: number } {
  return { cached: cache.size, inflight: chains.size };
}

// Ownership of higher-timeframe candles, in one place.
//
// THE PROBLEM THIS EXISTS FOR. Every MTF indicator instance used to be both a
// data fetcher and a computation: each ran its own paged walk back over the HTF
// candles it needed, even when another indicator on the same chart was pinned to
// the SAME epic and timeframe and was walking the same bars at the same moment.
// A US100 layout with FVG on DAY, FVG2 on HOUR_4, Trendlines on HOUR,
// Trendlines2 on DAY and S/R on HOUR_4 issues five independent walks, two pairs
// of which are pure duplication; each walk is bounded at HTF_MAX_PAGES pages
// plus a few empty probes, and refreshMtfIndicators fans all five out again on
// every history-growth event. The instrumentation in perfDiag caught the result
// as a fetch-storm: 63 windowed requests in one 15s window, returning 1500 bars
// between them.
//
// WHAT IT DOES. One in-flight walk per (broker, epic, timeframe, price side,
// live edge), shared by everyone who wants those bars, plus a short-lived result
// so a burst of refreshes triggered by consecutive page landings does not re-walk
// what just landed. Nothing else moves: the caller still computes its own series
// and still applies its own replay clamp, because those are genuinely per-pane.
//
// COVERAGE, and the one deliberate behaviour change. Indicators ask for
// different depths, since warmup differs per detector (FVG's reach-back is its
// gap-age cap; Trendlines' is pairing width plus projection). A walk that
// reached FURTHER back than you need already contains your window, so it serves
// you. The consequence is that a shallower-need indicator can receive more
// history than it would have fetched alone — never less. That is the point of a
// shared owner rather than an accident of it: which bars an indicator sees stops
// depending on who happened to fetch first. In practice the spread is small
// (~500 vs ~494 daily bars for the DAY pair above), and more warmup can only
// make a detector's left edge better fed.
//
// Failures are never cached: a walk that failed must be retried, and the
// existing per-indicator retry/backoff owns that decision.

import type { KLineData } from "klinecharts";

/** How long a completed walk stays reusable. Deliberately short: it exists to
 * absorb the burst of refreshes a scroll-back produces (consecutive pages land
 * milliseconds apart), not to serve stale bars. Tiny next to any HTF bucket —
 * the smallest is an hour — so a bar closing inside the window is picked up by
 * the next trigger, and MTF consumers only read CLOSED bars anyway. */
export const HTF_CACHE_TTL_MS = 5_000;

/** Cap on retained results, so browsing many symbols cannot grow this without
 * bound. Entries are cheap (one array reference each) and expire on their own;
 * this is a backstop, not a policy. */
const MAX_ENTRIES = 24;

export interface HtfWindow {
  htf: KLineData[];
  failed: boolean;
}

/** Runs the actual paged walk back to `fromMs`. Supplied by the caller so this
 * module owns sharing and nothing else. */
export type HtfLoader = (fromMs: number) => Promise<HtfWindow>;

interface CacheEntry {
  fromMs: number; // how far back this result actually reaches
  window: HtfWindow;
  at: number;
}

interface InflightEntry {
  fromMs: number;
  promise: Promise<HtfWindow>;
  /** Identity of THIS walk, so it only ever clears its own slot. */
  tag: object;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, InflightEntry>();

/** The identity of a set of HTF bars. Price side is in here because it changes
 * the bars themselves (bid vs mid decides trendline breaks, see fetchHtfBars),
 * and the live edge is bucketed so a replaying cell — whose newest bar sits in
 * the past — never shares a walk with a live one. */
export function htfKey(parts: {
  brokerId: string | undefined;
  epic: string;
  timeframe: string;
  priceSide: string;
  newestMs: number;
  htfMs: number;
}): string {
  const edge =
    parts.htfMs > 0 ? Math.floor(parts.newestMs / parts.htfMs) : parts.newestMs;
  return `${parts.brokerId ?? ""}|${parts.epic}|${parts.timeframe}|${parts.priceSide}|${edge}`;
}

function evictStale(now: number): void {
  for (const [k, e] of cache)
    if (now - e.at >= HTF_CACHE_TTL_MS) cache.delete(k);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * The HTF bars for `key` reaching back to at least `fromMs`, fetched at most
 * once across every caller that wants them.
 *
 * A walk already in flight that reaches at least as far back serves you. So does
 * a fresh enough completed one. Anything deeper than both starts its own walk
 * and becomes the one others ride.
 */
export async function fetchHtfShared(
  key: string,
  fromMs: number,
  load: HtfLoader,
): Promise<HtfWindow> {
  const now = Date.now();

  // A walk already running that covers our window: ride it rather than issuing
  // a second identical request. This is what collapses the simultaneous fan-out
  // (refreshMtfIndicators starts every indicator's job at once), and it is exact
  // — concurrent callers by definition wanted the same moment's bars.
  const running = inflight.get(key);
  if (running && running.fromMs <= fromMs) return running.promise;

  evictStale(now);
  const hit = cache.get(key);
  if (hit && hit.fromMs <= fromMs && now - hit.at < HTF_CACHE_TTL_MS)
    return hit.window;

  const tag = {};
  const promise = (async () => {
    try {
      const window = await load(fromMs);
      // Only a successful walk is reusable. A failed one must stay retryable, or
      // a single outage would be pinned for the whole TTL.
      if (!window.failed) {
        cache.set(key, { fromMs, window, at: Date.now() });
        evictStale(Date.now());
      }
      return window;
    } finally {
      // Only clear the slot if it is still ours: a deeper walk may have replaced
      // it while this one was running, and it must keep serving its riders.
      if (inflight.get(key)?.tag === tag) inflight.delete(key);
    }
  })();

  inflight.set(key, { fromMs, promise, tag });
  return promise;
}

/** Drop everything. For tests, and for any caller that knows the underlying
 * bars are no longer trustworthy. */
export function clearHtfCache(): void {
  cache.clear();
  inflight.clear();
}

/** Entry counts, for tests and console poking. Never read by the app. */
export function htfCacheStats(): { cached: number; inflight: number } {
  return { cached: cache.size, inflight: inflight.size };
}

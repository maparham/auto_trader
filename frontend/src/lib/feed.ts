// Data layer for the klinecharts-core chart: history fetch, live stream, and
// instrument search, wired to our FastAPI backend. We own the chart instance,
// so these just return data the caller pushes through the chart data facade
// (setBars for a full load, pushBar for a realtime tick).

import type { KLineData } from "klinecharts";
import type { PriceSide } from "../theme";
import { API_BASE as BASE, errorDetail } from "./http";
import { getSynthetic, isSynthetic } from "./syntheticRegistry";

export interface Period {
  resolution: string; // backend Resolution value, or a SECONDS_INTERVALS key
  label: string;
  liveOnly?: boolean; // sub-minute: no history, built live from the tick stream
}

// Quick-bar (fixed): the native Capital resolutions, which have full history.
export const PERIODS: Period[] = [
  { resolution: "MINUTE", label: "1m" },
  { resolution: "MINUTE_5", label: "5m" },
  { resolution: "MINUTE_15", label: "15m" },
  { resolution: "MINUTE_30", label: "30m" },
  { resolution: "HOUR", label: "1H" },
  { resolution: "HOUR_4", label: "4H" },
  { resolution: "DAY", label: "1D" },
  { resolution: "WEEK", label: "1W" },
];

// 3m isn't a native Capital resolution (their API rejects it) — the backend
// folds native 1m bars into 3-minute buckets on read, like the coarser derived
// timeframes below. It's the one derived TF finer than a native, so it slots
// into the Minutes group right after 1m rather than into its own group.
const MINUTE_DERIVED_PERIODS: Period[] = [{ resolution: "MINUTE_3", label: "3m" }];

// Derived (non-native) timeframes: the backend folds cached DAY/WEEK base bars
// into calendar buckets — full history + live, but not Capital resolutions. Like
// the seconds group, these live only in the grouped dropdown, not the quick-bar.
const DERIVED_PERIODS: Period[] = [
  { resolution: "WEEK_2", label: "2W" },
  { resolution: "WEEK_3", label: "3W" },
  { resolution: "WEEK_6", label: "6W" },
  { resolution: "MONTH", label: "1M" },
  { resolution: "MONTH_2", label: "2M" },
  { resolution: "MONTH_3", label: "3M" },
  { resolution: "YEAR", label: "1Y" },
];

// Sub-minute intervals, built live by bucketing the tick stream (no history).
// Keys must match the backend's SECONDS_INTERVALS.
const SECONDS_PERIODS: Period[] = [
  { resolution: "SECOND", label: "1s", liveOnly: true },
  { resolution: "SECOND_5", label: "5s", liveOnly: true },
  { resolution: "SECOND_10", label: "10s", liveOnly: true },
  { resolution: "SECOND_15", label: "15s", liveOnly: true },
  { resolution: "SECOND_30", label: "30s", liveOnly: true },
  { resolution: "SECOND_45", label: "45s", liveOnly: true },
];

// Grouped interval menu (TradingView-style). The quick-bar holds the native
// resolutions; this dropdown adds the live-only seconds group above them.
export interface PeriodGroup {
  label: string;
  periods: Period[];
}

export const PERIOD_GROUPS: PeriodGroup[] = [
  { label: "Seconds", periods: SECONDS_PERIODS },
  {
    label: "Minutes",
    // 1m, then derived 3m, then native 5m/15m/30m (ascending by duration).
    periods: [
      ...PERIODS.filter((p) => p.resolution === "MINUTE"),
      ...MINUTE_DERIVED_PERIODS,
      ...PERIODS.filter((p) => p.resolution.startsWith("MINUTE_")),
    ],
  },
  {
    label: "Hours",
    periods: PERIODS.filter((p) => p.resolution.startsWith("HOUR")),
  },
  {
    label: "Days",
    periods: PERIODS.filter((p) => p.resolution === "DAY" || p.resolution === "WEEK"),
  },
  {
    label: "Weeks",
    periods: DERIVED_PERIODS.filter((p) => p.resolution.startsWith("WEEK_")),
  },
  {
    label: "Months",
    periods: DERIVED_PERIODS.filter((p) => p.resolution.startsWith("MONTH")),
  },
  {
    label: "Years",
    periods: DERIVED_PERIODS.filter((p) => p.resolution === "YEAR"),
  },
];

// Every selectable timeframe (seconds → derived), used to resolve a favorite
// resolution key back to its Period and to build the merged quick bar.
export const ALL_PERIODS: Period[] = [
  ...SECONDS_PERIODS,
  ...PERIODS,
  ...MINUTE_DERIVED_PERIODS,
  ...DERIVED_PERIODS,
];

const PERIOD_BY_RESOLUTION = new Map(ALL_PERIODS.map((p) => [p.resolution, p]));

// The fixed defaults that always occupy the quick bar and can't be removed.
export const DEFAULT_RESOLUTIONS = new Set(PERIODS.map((p) => p.resolution));

export function periodByResolution(resolution: string): Period | undefined {
  return PERIOD_BY_RESOLUTION.get(resolution);
}

export interface Instrument {
  epic: string;
  name: string;
  status: string | null;
  type?: string | null; // Capital.com instrumentType: CURRENCIES, SHARES, INDICES…
  pricePrecision?: number; // decimals; FX ~5, indices ~2
}

// Quote currencies used to split FX/crypto pair epics for the logo slug
// (BTCUSD -> btc-usd). Longest-first so USDT matches before USD.
const QUOTE_CCYS = [
  "USDT", "USD", "EUR", "BTC", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD",
  "PLN", "ZAR", "TRY", "SEK", "NOK", "DKK", "MXN", "SGD", "HKD", "CNH",
];

// Capital.com's (undocumented) instrument-logo CDN — the same one their platform
// uses. There are two complementary paths, and which one holds a given logo
// depends on the asset type:
//   - {slug}.svg          lowercase, '_'->'-', hyphen before the pair's quote
//                         currency (BTCUSD -> btc-usd). Holds indices, forex,
//                         crypto, commodities, and megacap stocks (AAPL, TSLA).
//   - logos/{EPIC}.svg    original (upper) case. Holds most other stocks
//                         (COST, ARM, MRK) that are absent from the slug path.
// Coverage is partial and skews to popular instruments, so callers must fall
// back to a glyph on load error. CORS is open; <img> works with no API key.
const LOGO_BASE = "https://static.capital.com/instrument-icons/instrument-logos";

function epicSlug(epic: string, type?: string | null): string {
  let slug = epic.toLowerCase().replace(/_/g, "-");
  if (type === "CURRENCIES" || type === "CRYPTOCURRENCIES") {
    const up = epic.toUpperCase();
    const q = QUOTE_CCYS.find((c) => up.endsWith(c) && up.length > c.length);
    if (q) slug = `${up.slice(0, -q.length)}-${q}`.toLowerCase();
  }
  return slug;
}

// Ordered logo-URL candidates to try before giving up to a glyph. Non-stocks
// only ever live on the slug path, so we return a single URL for them (a second
// attempt would be guaranteed-waste requests). Stocks are split across both
// paths, so we try the slug first (megacaps/favorites) then the cased epic.
export function logoCandidates(epic: string, type?: string | null): string[] {
  const slug = `${LOGO_BASE}/${epicSlug(epic, type)}.svg`;
  if (type === "SHARES") return [slug, `${LOGO_BASE}/logos/${epic}.svg`];
  return [slug];
}

interface RawCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function toKLine(c: RawCandle): KLineData {
  return {
    timestamp: c.time * 1000, // klinecharts wants ms
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
}

// Every market call carries the active broker id (epics are broker-specific).
// Defaults to "capital" so existing call sites keep working; the chart and
// symbol-search modal pass the user's active broker explicitly.
export const DEFAULT_BROKER = "capital";

// Keyword search against the broker (used while the user types). Category
// browsing instead filters the cached full catalogue (fetchAllMarkets).
export async function searchInstruments(
  q: string,
  brokerId: string = DEFAULT_BROKER,
): Promise<Instrument[]> {
  const qs = new URLSearchParams({ q: q.trim(), broker: brokerId });
  const res = await fetch(`${BASE}/api/markets?${qs}`);
  if (!res.ok) return [];
  return res.json();
}

// Session-cache an instrument-list fetch per broker, WITHOUT caching failures.
// A transient failure (backend restarting mid-dev, a blip) used to be cached as a
// resolved [] for the rest of the tab's life — the symbol-search modal then
// resolved the Recent list against an empty catalogue and rendered "No recently
// opened symbols yet" forever. On failure we still resolve [] (callers render an
// empty list for THAT open), but evict the cache entry so the next open retries.
function cachedInstrumentFetch(
  cache: Map<string, Promise<Instrument[]>>,
  brokerId: string,
  url: string,
): Promise<Instrument[]> {
  let cached = cache.get(brokerId);
  if (!cached) {
    cached = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`instrument fetch failed: ${r.status}`);
        return r.json() as Promise<Instrument[]>;
      })
      .catch(() => {
        cache.delete(brokerId);
        return [];
      });
    cache.set(brokerId, cached);
  }
  return cached;
}

// The full instrument catalogue (~4000) in one call, cached for the session: the
// symbol-search modal filters it client-side by `type` for the category chips.
// Keyed by broker so switching brokers can't serve the wrong broker's catalogue.
const allMarketsCache = new Map<string, Promise<Instrument[]>>();
export function fetchAllMarkets(brokerId: string = DEFAULT_BROKER): Promise<Instrument[]> {
  return cachedInstrumentFetch(
    allMarketsCache,
    brokerId,
    `${BASE}/api/markets/all?broker=${encodeURIComponent(brokerId)}`,
  );
}

// The account's FAVORITES watchlist — the modal's opening view. Cached per broker.
const favoritesCache = new Map<string, Promise<Instrument[]>>();
export function fetchFavorites(brokerId: string = DEFAULT_BROKER): Promise<Instrument[]> {
  return cachedInstrumentFetch(
    favoritesCache,
    brokerId,
    `${BASE}/api/favorites?broker=${encodeURIComponent(brokerId)}`,
  );
}

// Drop one broker's favorites cache so the next fetchFavorites() re-reads from
// the broker. Call after a mutation so a later modal open reflects the edit.
function invalidateFavorites(brokerId: string = DEFAULT_BROKER): void {
  favoritesCache.delete(brokerId);
}

/** Add an epic to the FAVORITES watchlist. Throws on failure (caller rolls back). */
export async function addFavorite(
  epic: string,
  brokerId: string = DEFAULT_BROKER,
): Promise<void> {
  const url = `${BASE}/api/favorites/${encodeURIComponent(epic)}?broker=${encodeURIComponent(brokerId)}`;
  const r = await fetch(url, { method: "PUT" });
  if (!r.ok) throw new Error(`add favorite failed: ${r.status}`);
  invalidateFavorites(brokerId);
}

/** Remove an epic from the FAVORITES watchlist. Throws on failure. */
export async function removeFavorite(
  epic: string,
  brokerId: string = DEFAULT_BROKER,
): Promise<void> {
  const url = `${BASE}/api/favorites/${encodeURIComponent(epic)}?broker=${encodeURIComponent(brokerId)}`;
  const r = await fetch(url, { method: "DELETE" });
  if (!r.ok) throw new Error(`remove favorite failed: ${r.status}`);
  invalidateFavorites(brokerId);
}

export interface MarketMeta {
  // Authoritative display precision (decimals), or null if unknown. The chart
  // uses this on load: a symbol persisted without pricePrecision (the bulk
  // markets list omits it) would otherwise fall back to 2 (e.g. oil at 71.88
  // instead of 71.884).
  pricePrecision: number | null;
  // Whether the market is currently closed, derived server-side from the
  // instrument's opening hours (authoritative on both demo and live, unlike the
  // raw marketStatus which can wrongly report CLOSED on demo). null = unknown
  // (failed lookup) — the chart treats unknown as open so a failed fetch never
  // badges a live market closed.
  closed: boolean | null;
  // When closed, the next opening time as an ISO-8601 UTC string (else null) —
  // shown in the closed-badge tooltip.
  nextOpen: string | null;
}

// The full broker instrument detail, passed through verbatim. Three sections of
// raw key/value data (the field set varies per instrument), rendered generically
// in the instrument-details modal — so this is intentionally untyped beyond the
// section shape.
export interface MarketDetail {
  instrument: Record<string, unknown>;
  dealingRules: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  // Account-effective leverage for this instrument's asset class (Capital's
  // /accounts/preferences). The instrument's marginFactor is a static base that
  // ignores the account setting — this is what the broker's own app shows.
  // Absent for brokers without the concept (IG) or when preferences fail.
  accountLeverage?: number;
}

/** Full instrument detail for the details modal. Fetched once on open (not
 * polled). Returns null on any failure so the caller can show an error/empty. */
export async function fetchMarketDetail(
  epic: string,
  brokerId: string = DEFAULT_BROKER,
): Promise<MarketDetail | null> {
  try {
    const url = `${BASE}/api/market/${encodeURIComponent(epic)}/details?broker=${encodeURIComponent(brokerId)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<MarketDetail>;
    return {
      instrument: d.instrument ?? {},
      dealingRules: d.dealingRules ?? {},
      snapshot: d.snapshot ?? {},
      ...(typeof d.accountLeverage === "number" ? { accountLeverage: d.accountLeverage } : {}),
    };
  } catch {
    return null;
  }
}

export interface CandleCacheStats {
  oldestTs: number | null;
  newestTs: number | null;
  cachedBarCount: number;
  hits: number;
  misses: number;
  lastFetchTs: number | null;
}

export interface CandleCacheGlobalStats {
  totalBars: number;
  totalHits: number;
  totalMisses: number;
  dbSizeBytes: number;
}

// Cache-stats fetches are debug reads, not chart-critical — same short bound as
// the market-meta poll so a hung request can't tie up the connection budget.
const CACHE_STATS_TIMEOUT_MS = 6_000;

/** Per-series candle-cache stats (coverage, hit/miss, last fetch) for the chart
 * legend's cache-stats badge/popover. Returns null on any failure. */
export async function fetchCandleCacheStats(
  epic: string,
  resolution: string,
  priceSide: PriceSide = "mid",
  brokerId: string = DEFAULT_BROKER,
): Promise<CandleCacheStats | null> {
  try {
    const qs = new URLSearchParams({ epic, resolution, priceSide, broker: brokerId });
    const res = await fetchWithTimeout(
      `${BASE}/api/candle-cache/stats?${qs}`,
      CACHE_STATS_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const d = (await res.json()) as {
      oldest_ts: number | null;
      newest_ts: number | null;
      cached_bar_count: number;
      hits: number;
      misses: number;
      last_fetch_ts: number | null;
    };
    return {
      oldestTs: d.oldest_ts,
      newestTs: d.newest_ts,
      cachedBarCount: d.cached_bar_count,
      hits: d.hits,
      misses: d.misses,
      lastFetchTs: d.last_fetch_ts,
    };
  } catch {
    return null;
  }
}

/** Cache-wide stats (all series) shown alongside the per-series stats in the
 * cache-stats popover. Returns null on any failure. */
export async function fetchCandleCacheGlobalStats(): Promise<CandleCacheGlobalStats | null> {
  try {
    const res = await fetchWithTimeout(
      `${BASE}/api/candle-cache/stats/global`,
      CACHE_STATS_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const d = (await res.json()) as {
      total_bars: number;
      total_hits: number;
      total_misses: number;
      db_size_bytes: number;
    };
    return {
      totalBars: d.total_bars,
      totalHits: d.total_hits,
      totalMisses: d.total_misses,
      dbSizeBytes: d.db_size_bytes,
    };
  } catch {
    return null;
  }
}

/** Display precision + open/closed status for an epic, from one snapshot call.
 * Returns nulls (never throws) so callers can keep their existing fallbacks.
 * The chart fetches this on load and polls it so the tab badge / price label
 * flip when a market closes while the chart is open. */
export async function fetchMarketMeta(
  epic: string,
  brokerId: string = DEFAULT_BROKER,
): Promise<MarketMeta> {
  try {
    const url = `${BASE}/api/market/${encodeURIComponent(epic)}?broker=${encodeURIComponent(brokerId)}`;
    // Bounded: a hung poll must free its connection fast (see META_TIMEOUT_MS). A
    // timeout/throw lands in the catch below and is treated as "unknown" (open).
    const res = await fetchWithTimeout(url, META_TIMEOUT_MS);
    if (!res.ok) return { pricePrecision: null, closed: null, nextOpen: null };
    const d = (await res.json()) as {
      pricePrecision?: number | null;
      closed?: boolean | null;
      nextOpen?: string | null;
    };
    return {
      pricePrecision: typeof d.pricePrecision === "number" ? d.pricePrecision : null,
      closed: typeof d.closed === "boolean" ? d.closed : null,
      nextOpen: typeof d.nextOpen === "string" ? d.nextOpen : null,
    };
  } catch {
    return { pricePrecision: null, closed: null, nextOpen: null };
  }
}

/** Most recent `bars` candles (no date window). Used for the initial load. */
export async function fetchRecent(
  epic: string,
  resolution: string,
  bars = 500,
  priceSide: PriceSide = "mid",
  brokerId: string = DEFAULT_BROKER,
): Promise<KLineData[]> {
  const syn = getSynthetic(epic);
  if (syn) {
    const qs = new URLSearchParams({
      expr: syn.canonical,
      resolution,
      bars: String(bars),
      priceSide,
      broker: brokerId,
    });
    const res = await fetchWithTimeout(`${BASE}/api/candles/synthetic?${qs}`);
    if (res.ok) return ((await res.json()) as RawCandle[]).map(toKLine);
    if (res.status === 404) return [];
    throw new Error(await errorDetail(res));
  }
  const qs = new URLSearchParams({
    epic,
    resolution,
    bars: String(bars),
    priceSide,
    broker: brokerId,
  });
  const res = await fetchWithTimeout(`${BASE}/api/candles?${qs}`);
  if (res.ok) return ((await res.json()) as RawCandle[]).map(toKLine);
  // 404 = no data for this epic (unknown / no history) — empty, not an error.
  if (res.status === 404) return [];
  // Anything else (e.g. 502 from a broker auth / maintenance failure) carries a
  // detail worth surfacing — throw it so the chart can show why it's blank.
  throw new Error(await errorDetail(res));
}

// History fetch timeout. A hung backend (broker maintenance) would otherwise leave
// the request pending forever — no candles, no error. Aborting after this surfaces
// a clear "timed out" message in the chart's no-data banner.
const HISTORY_TIMEOUT_MS = 10_000;

// Status-poll timeout. Shorter than the history one: the per-tab open/closed poll
// fans out one request per open tab, so a hung broker must release each connection
// quickly or it saturates the browser's per-host connection budget and starves the
// other brokers (and the account-selector fetch). The backend circuit breaker
// fast-fails a down broker, but this bounds the client side too.
const META_TIMEOUT_MS = 6_000;

/** fetch() that aborts after `timeoutMs`, throwing a readable timeout error. */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number = HISTORY_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err; // genuine network error (refused / DNS / offline) — surface as-is
  } finally {
    clearTimeout(timer);
  }
}

/** A non-2xx /api/candles response (e.g. the 503 a broker returns while
 * reconnecting). fetchRange flattens exactly this to an empty page; genuine
 * network errors (refused / DNS / offline) propagate from both variants. */
export class CandlesFetchError extends Error {
  status: number;
  constructor(status: number) {
    super(`candles fetch failed: ${status}`);
    this.status = status;
  }
}

/**
 * Candles in [fromSec, toSec]. Throws CandlesFetchError on a non-2xx response
 * so callers that must tell "broker down" apart from "no data" can (the MTF
 * coordinator's retry). Most call sites want the forgiving shape — use
 * fetchRange.
 */
export async function fetchRangeStrict(
  epic: string,
  resolution: string,
  fromSec: number,
  toSec: number,
  priceSide: PriceSide = "mid",
  brokerId: string = DEFAULT_BROKER,
): Promise<KLineData[]> {
  const syn = getSynthetic(epic);
  const qs = syn
    ? new URLSearchParams({
        expr: syn.canonical,
        resolution,
        from_ts: String(fromSec),
        to_ts: String(toSec),
        priceSide,
        broker: brokerId,
      })
    : new URLSearchParams({
        epic,
        resolution,
        from_ts: String(fromSec),
        to_ts: String(toSec),
        priceSide,
        broker: brokerId,
      });
  const res = await fetch(`${BASE}/api/candles${syn ? "/synthetic" : ""}?${qs}`);
  if (!res.ok) throw new CandlesFetchError(res.status);
  return ((await res.json()) as RawCandle[]).map(toKLine);
}

/** Candles in [fromSec, toSec], a failed response as an empty page. Used for
 * scroll-back pagination, where paging just stops at what's loaded. */
export async function fetchRange(
  epic: string,
  resolution: string,
  fromSec: number,
  toSec: number,
  priceSide: PriceSide = "mid",
  brokerId: string = DEFAULT_BROKER,
): Promise<KLineData[]> {
  try {
    return await fetchRangeStrict(epic, resolution, fromSec, toSec, priceSide, brokerId);
  } catch (e) {
    if (e instanceof CandlesFetchError) return [];
    throw e;
  }
}

export type LiveStatus = "connecting" | "live" | "down";

/**
 * Whether a connected live feed has gone silent long enough to be flagged stale.
 *
 * Silence is measured from the LATER of the last candle and the current
 * connection's open time (`streamLiveAt`), so a stream that connects and then
 * never delivers a tick is caught too — measuring from the last candle alone
 * (which stays 0 in that case) would miss it. Only meaningful while the socket
 * reports "live" and the market is open: a "down" feed already shows via status,
 * and a closed market legitimately has no ticks. `lastCandleAt`/`streamLiveAt`
 * are ms epochs (0 = none yet).
 */
export function isFeedStale(args: {
  status: LiveStatus;
  marketClosed: boolean;
  lastCandleAt: number;
  streamLiveAt: number;
  now: number;
  staleMs: number;
}): boolean {
  const base = Math.max(args.lastCandleAt, args.streamLiveAt);
  return (
    base > 0 &&
    args.status === "live" &&
    !args.marketClosed &&
    args.now - base > args.staleMs
  );
}

export interface LiveHandle {
  close: () => void;
}

/**
 * Open a live candle stream with client-side auto-reconnect. The previous
 * version returned a bare WebSocket with no reconnect, so a dropped browser
 * socket (network blip, backend restart) silently froze updates until the user
 * changed symbol — a likely cause of "no change" reports. Reports status changes
 * so the UI can show a live/down indicator.
 */
export function openLive(
  epic: string,
  resolution: string,
  // bid/ask are the live raw spread sides for the optional bid & ask lines; null
  // until the first quote names them. Consumers that don't need them ignore them.
  onCandle: (k: KLineData, bid: number | null, ask: number | null) => void,
  onStatus?: (s: LiveStatus) => void,
  priceSide: PriceSide = "mid",
  brokerId: string = DEFAULT_BROKER,
): LiveHandle {
  if (isSynthetic(epic)) {
    // Synthetic charts are history-only (no tick stream). Return an inert handle
    // so callers can treat them uniformly; status stays non-live.
    onStatus?.("down");
    return { close: () => {} };
  }
  const wsBase = BASE.replace(/^http/, "ws");
  const url = `${wsBase}/ws/candles?epic=${encodeURIComponent(epic)}&resolution=${resolution}&priceSide=${priceSide}&broker=${encodeURIComponent(brokerId)}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    onStatus?.("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      // Deliberately do NOT reset `retry` here: the handshake succeeding proves
      // nothing when the server accepts and then drops the relay immediately
      // (e.g. a wedged MT5 upstream). Resetting on open pinned every reconnect
      // to the 1s floor — a ~2s open/close storm for as long as the upstream
      // was down. Only a real candle frame (below) proves the stream is healthy.
      onStatus?.("live");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "candle") {
          retry = 0; // data flowing = healthy; future drops back off from 1s again
          onStatus?.("live");
          onCandle(toKLine(msg.candle), msg.bid ?? null, msg.ask ?? null);
        } else if (msg.type === "error") {
          // The server sends an error frame then closes. `fatal` distinguishes a
          // permanent fault the client must NOT retry (e.g. a bad/unknown
          // resolution — reconnecting hits the same bad URL forever) from a
          // recoverable one (the server exhausted its reconnect attempts during a
          // sustained outage). For a recoverable error we leave `closed` false so
          // onclose reconnects and the chart self-heals when connectivity returns;
          // only a fatal frame stops. Default a missing flag to fatal so an
          // untagged error frame keeps the conservative stop-and-report behavior.
          const fatal = msg.fatal !== false;
          console.warn(
            `[live] stream error for ${epic}/${resolution} (fatal=${fatal}):`,
            msg.detail,
          );
          if (fatal) closed = true;
          onStatus?.("down");
        }
      } catch (e) {
        console.warn("[live] bad frame", e);
      }
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus?.("down");
      const delay = Math.min(1000 * 2 ** retry, 15000); // capped exponential backoff
      retry += 1;
      timer = setTimeout(connect, delay);
    };
    ws.onerror = () => ws?.close(); // triggers onclose -> reconnect
  };

  connect();
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}

// Seconds per resolution bucket — used for scroll-back window math (task 6).
export const RESOLUTION_SECONDS: Record<string, number> = {
  SECOND: 1,
  SECOND_5: 5,
  SECOND_10: 10,
  SECOND_15: 15,
  SECOND_30: 30,
  SECOND_45: 45,
  MINUTE: 60,
  MINUTE_3: 180, // derived: folded from native 1m bars
  MINUTE_5: 300,
  MINUTE_15: 900,
  MINUTE_30: 1800,
  HOUR: 3600,
  HOUR_4: 14400,
  DAY: 86400,
  WEEK: 604800,
  // Derived timeframes — approximate widths (months/years aren't fixed); used
  // only for scroll-back window math, never for bucketing (the backend folds).
  WEEK_2: 1209600,
  WEEK_3: 1814400,
  WEEK_6: 3628800,
  MONTH: 2592000,
  MONTH_2: 5184000,
  MONTH_3: 7776000,
  YEAR: 31536000,
};

// The quick-access timeframe bar: the fixed defaults merged with the user's
// favorite resolutions, de-duped and sorted ascending by duration. The favorite
// list's own order is irrelevant — display order is always by RESOLUTION_SECONDS.
export function quickBarPeriods(favoriteResolutions: string[]): Period[] {
  const byRes = new Map(PERIODS.map((p) => [p.resolution, p]));
  for (const r of favoriteResolutions) {
    const p = periodByResolution(r);
    if (p) byRes.set(r, p);
  }
  return [...byRes.values()].sort(
    (a, b) =>
      (RESOLUTION_SECONDS[a.resolution] ?? 0) -
      (RESOLUTION_SECONDS[b.resolution] ?? 0),
  );
}

// The enabled quick-bar period immediately FINER than `currentResolution`
// (largest duration strictly below it), or null when there is none (the user
// is already on their lowest enabled timeframe). Duration-based so it works
// even when `currentResolution` itself is not on the quick bar. Used by the
// zoom-to-range tool to drop one timeframe on release.
export function oneTfLower(
  currentResolution: string,
  favoriteResolutions: string[],
): Period | null {
  const curSecs = RESOLUTION_SECONDS[currentResolution];
  if (curSecs == null) return null;
  const ladder = quickBarPeriods(favoriteResolutions); // ascending by duration
  let best: Period | null = null;
  for (const p of ladder) {
    if (p.liveOnly) continue; // live-only seconds TFs have no history to zoom into
    const secs = RESOLUTION_SECONDS[p.resolution] ?? 0;
    if (secs < curSecs) best = p; // ascending, so the last one below wins
  }
  return best;
}

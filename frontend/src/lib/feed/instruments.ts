// Instruments and market metadata: search, the per-broker catalogue and
// favourites caches, epic resolution, logos, market detail/meta and the candle
// cache stats.
import type { PriceSide } from "../../theme";
import { API_BASE as BASE, apiFetch } from "../http";
import { DEFAULT_BROKER, META_TIMEOUT_MS, fetchWithTimeout } from "./common";

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
//   - logos/{epic}.svg    lowercase. A third set (INTC, MU, SPCX) that neither
//                         of the above carries.
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

// Row types that name a stock or fund: Capital's (also MT5/IG) SHARES, and
// yfinance's own stock/etf/fund words.
const SHARE_TYPES = new Set(["SHARES", "stock", "etf", "fund"]);

// Ordered logo-URL candidates to try before giving up to a glyph. Non-stocks
// only ever live on the slug path, so we return a single URL for them (a second
// attempt would be guaranteed-waste requests). Stocks are split across all
// three paths, so we try the slug first (megacaps/favorites) then both cases
// under logos/. A symbol with no type (jumpToEpic's placeholder, opened from
// the trade list or the agent bridge) could be either, so it gets the full list.
export function logoCandidates(epic: string, type?: string | null): string[] {
  const slug = `${LOGO_BASE}/${epicSlug(epic, type)}.svg`;
  if (!type || SHARE_TYPES.has(type)) {
    return [slug, `${LOGO_BASE}/logos/${epic}.svg`, `${LOGO_BASE}/logos/${epic.toLowerCase()}.svg`];
  }
  return [slug];
}

// Keyword search against the broker (used while the user types). Category
// browsing instead filters the cached full catalogue (fetchAllMarkets).
export async function searchInstruments(
  q: string,
  brokerId: string = DEFAULT_BROKER,
): Promise<Instrument[]> {
  const qs = new URLSearchParams({ q: q.trim(), broker: brokerId });
  const res = await apiFetch(`${BASE}/api/markets?${qs}`);
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
    cached = apiFetch(url)
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

/** A bare instrument known only by its epic: no name, type or status. The
 * fallback when the catalogue has no row for the epic. */
export function bareInstrument(epic: string, pricePrecision = 2): Instrument {
  return { epic, name: epic, status: null, pricePrecision };
}

// How long a chart open waits on the catalogue before settling for a bare
// instrument. The backend caches it (core/catalog_cache.py), so this normally
// answers well inside the wait; only the backend's first upstream call (Capital:
// ~8000 rows, ~2 s) runs past it, and a click must not hang on that. The fetch
// keeps going and fills the session cache for the next open.
const RESOLVE_WAIT_MS = 500;

/** The canonical epic -> Instrument lookup for every path that opens a chart
 * from a bare epic (trade list, alerts, positions, agent, mobile): the broker
 * catalogue row, so the chart carries the same name/type/status as a symbol
 * picked in search, else a bare instrument. `precisionGuess` fills in when the
 * row has no precision of its own. Never rejects (a failed catalogue fetch
 * resolves []), and never waits longer than `waitMs`. */
export async function resolveInstrument(
  epic: string,
  brokerId: string = DEFAULT_BROKER,
  precisionGuess = 2,
  waitMs = RESOLVE_WAIT_MS,
): Promise<Instrument> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Instrument[]>((resolve) => {
    timer = setTimeout(() => resolve([]), waitMs);
  });
  const list = await Promise.race([fetchAllMarkets(brokerId), timeout]);
  clearTimeout(timer);
  const hit = list.find((i) => i.epic === epic);
  return hit
    ? { ...hit, pricePrecision: hit.pricePrecision ?? precisionGuess }
    : bareInstrument(epic, precisionGuess);
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
  const r = await apiFetch(url, { method: "PUT" });
  if (!r.ok) throw new Error(`add favorite failed: ${r.status}`);
  invalidateFavorites(brokerId);
}

/** Remove an epic from the FAVORITES watchlist. Throws on failure. */
export async function removeFavorite(
  epic: string,
  brokerId: string = DEFAULT_BROKER,
): Promise<void> {
  const url = `${BASE}/api/favorites/${encodeURIComponent(epic)}?broker=${encodeURIComponent(brokerId)}`;
  const r = await apiFetch(url, { method: "DELETE" });
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
    const res = await apiFetch(url);
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
      total_hits: number;
      total_misses: number;
      db_size_bytes: number;
    };
    return {
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

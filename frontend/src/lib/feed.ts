// Data layer for the klinecharts-core chart: history fetch, live stream, and
// instrument search, wired to our FastAPI backend. We own the chart instance,
// so these just return data the caller pushes via applyNewData / updateData.

import type { KLineData } from "klinecharts";
import type { PriceSide } from "../theme";

const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

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
    periods: PERIODS.filter((p) => p.resolution.startsWith("MINUTE")),
  },
  {
    label: "Hours",
    periods: PERIODS.filter((p) => p.resolution.startsWith("HOUR")),
  },
  {
    label: "Days",
    periods: PERIODS.filter((p) => p.resolution === "DAY" || p.resolution === "WEEK"),
  },
];

// Every selectable period, by resolution key — used to resolve a chosen interval.
export const PERIOD_BY_RESOLUTION: Record<string, Period> = Object.fromEntries(
  PERIOD_GROUPS.flatMap((g) => g.periods).map((p) => [p.resolution, p]),
);

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

// Keyword search against the broker (used while the user types). Category
// browsing instead filters the cached full catalogue (fetchAllMarkets).
export async function searchInstruments(q: string): Promise<Instrument[]> {
  const res = await fetch(`${BASE}/api/markets?q=${encodeURIComponent(q.trim())}`);
  if (!res.ok) return [];
  return res.json();
}

// The full instrument catalogue (~4000) in one call, cached for the session: the
// symbol-search modal filters it client-side by `type` for the category chips.
let allMarketsCache: Promise<Instrument[]> | null = null;
export function fetchAllMarkets(): Promise<Instrument[]> {
  allMarketsCache ??= fetch(`${BASE}/api/markets/all`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  return allMarketsCache;
}

// The account's FAVORITES watchlist — the modal's opening view. Cached too.
let favoritesCache: Promise<Instrument[]> | null = null;
export function fetchFavorites(): Promise<Instrument[]> {
  favoritesCache ??= fetch(`${BASE}/api/favorites`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  return favoritesCache;
}

// Drop the session cache so the next fetchFavorites() re-reads from the broker.
// Call after a mutation so a later modal open reflects the edit.
export function invalidateFavorites(): void {
  favoritesCache = null;
}

/** Add an epic to the FAVORITES watchlist. Throws on failure (caller rolls back). */
export async function addFavorite(epic: string): Promise<void> {
  const r = await fetch(`${BASE}/api/favorites/${encodeURIComponent(epic)}`, {
    method: "PUT",
  });
  if (!r.ok) throw new Error(`add favorite failed: ${r.status}`);
  invalidateFavorites();
}

/** Remove an epic from the FAVORITES watchlist. Throws on failure. */
export async function removeFavorite(epic: string): Promise<void> {
  const r = await fetch(`${BASE}/api/favorites/${encodeURIComponent(epic)}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`remove favorite failed: ${r.status}`);
  invalidateFavorites();
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
}

/** Full instrument detail for the details modal. Fetched once on open (not
 * polled). Returns null on any failure so the caller can show an error/empty. */
export async function fetchMarketDetail(epic: string): Promise<MarketDetail | null> {
  try {
    const res = await fetch(`${BASE}/api/market/${encodeURIComponent(epic)}/details`);
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<MarketDetail>;
    return {
      instrument: d.instrument ?? {},
      dealingRules: d.dealingRules ?? {},
      snapshot: d.snapshot ?? {},
    };
  } catch {
    return null;
  }
}

/** Display precision + open/closed status for an epic, from one snapshot call.
 * Returns nulls (never throws) so callers can keep their existing fallbacks.
 * The chart fetches this on load and polls it so the tab badge / price label
 * flip when a market closes while the chart is open. */
export async function fetchMarketMeta(epic: string): Promise<MarketMeta> {
  try {
    const res = await fetch(`${BASE}/api/market/${encodeURIComponent(epic)}`);
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
): Promise<KLineData[]> {
  const qs = new URLSearchParams({ epic, resolution, bars: String(bars), priceSide });
  const res = await fetch(`${BASE}/api/candles?${qs}`);
  if (!res.ok) return [];
  return ((await res.json()) as RawCandle[]).map(toKLine);
}

/** Candles in [fromSec, toSec]. Used for scroll-back pagination. */
export async function fetchRange(
  epic: string,
  resolution: string,
  fromSec: number,
  toSec: number,
  priceSide: PriceSide = "mid",
): Promise<KLineData[]> {
  const qs = new URLSearchParams({
    epic,
    resolution,
    from_ts: String(fromSec),
    to_ts: String(toSec),
    priceSide,
  });
  const res = await fetch(`${BASE}/api/candles?${qs}`);
  if (!res.ok) return [];
  return ((await res.json()) as RawCandle[]).map(toKLine);
}

export type LiveStatus = "connecting" | "live" | "down";

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
): LiveHandle {
  const wsBase = BASE.replace(/^http/, "ws");
  const url = `${wsBase}/ws/candles?epic=${encodeURIComponent(epic)}&resolution=${resolution}&priceSide=${priceSide}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    onStatus?.("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      onStatus?.("live");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "candle") {
          onStatus?.("live");
          onCandle(toKLine(msg.candle), msg.bid ?? null, msg.ask ?? null);
        } else if (msg.type === "error") {
          // The server sends an error frame then closes (e.g. a bad/unknown
          // resolution). It's fatal — don't let onclose reconnect to the same
          // bad URL forever; stop and report down.
          console.warn(`[live] stream error for ${epic}/${resolution}:`, msg.detail);
          closed = true;
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
  MINUTE_5: 300,
  MINUTE_15: 900,
  MINUTE_30: 1800,
  HOUR: 3600,
  HOUR_4: 14400,
  DAY: 86400,
  WEEK: 604800,
};

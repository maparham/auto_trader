// Candle history: the coalesced recent-bars fetch, strict and lenient range
// fetches, and the degraded/partial-fill headers they report.
import type { KLineData } from "klinecharts";
import type { PriceSide } from "../../theme";
import { API_BASE as BASE, apiFetch, errorDetail } from "../http";
import { PERF_DIAG_ON, recordBars, recordFetch } from "../perfDiag";
import { getSynthetic } from "../syntheticRegistry";
import { type RawCandle, toKLine, DEFAULT_BROKER, fetchWithTimeout } from "./common";

/**
 * Candle payload plus the backend's degraded-serve marker: `degraded` carries
 * the X-Candles-Degraded header (or a client-side classification) when the
 * broker was unreachable and the bars came from the backend's candle cache —
 * possibly missing the unreachable portion. null = a normal, complete answer.
 */
/** How far the backend got through a history fill it ran out of time for. */
export interface FillProgress {
  /** Chunks downloaded during THIS request. */
  done: number;
  /** Chunks the whole gap needs. */
  total: number;
}

/** `degraded`: the broker could not be reached and the payload may be
 * permanently short. `partial`: the backend ran out of its fill budget with the
 * download unfinished, so asking again gets more. Two markers because they need
 * two different words in front of a user, and because only one of them means
 * something is wrong (see _mark_partial in the backend's charts router). */
export type CandlesResult = {
  bars: KLineData[];
  degraded: string | null;
  partial: FillProgress | null;
};

function degradedHeader(res: Response): string | null {
  // Optional chaining: unit tests (and defensive callers) stub fetch with
  // minimal response objects that may not carry headers at all.
  return res.headers?.get("X-Candles-Degraded") ?? null;
}

function partialHeader(res: Response): FillProgress | null {
  const raw = res.headers?.get("X-Candles-Partial");
  if (!raw) return null;
  const [done, total] = raw.split("/").map((n) => Number(n));
  // A malformed value still means "unfinished" — the fact matters more than the
  // numbers, and a caller can show the fact without them.
  return {
    done: Number.isFinite(done) ? done : 0,
    total: Number.isFinite(total) ? total : 0,
  };
}

// Identical recent-candle requests already in flight, shared instead of
// re-issued. A chart cell's mount, its HTF indicator loads, and (in dev)
// StrictMode's double-mount all ask for the same recent window within the same
// tick — and each backend miss is a full broker round trip, so the duplicates
// used to double the tab-switch delay's cost for nothing. Keyed by the full
// request identity; entries are dropped on settle, so this never serves stale
// data — it only merges truly concurrent requests.
const inflightRecent = new Map<string, Promise<CandlesResult>>();

/** fetchRecent, but keeping the degraded-serve marker (see CandlesResult).
 * Concurrent identical calls share one network request; each caller still gets
 * its own bar objects (the chart annotates bars in place, so a shared array
 * would leak one cell's mutations into another). */
export async function fetchRecentWithStatus(
  epic: string,
  resolution: string,
  bars = 500,
  priceSide: PriceSide = "mid",
  brokerId: string = DEFAULT_BROKER,
): Promise<CandlesResult> {
  const key = `${brokerId}|${epic}|${resolution}|${bars}|${priceSide}`;
  let shared = inflightRecent.get(key);
  if (!shared) {
    shared = fetchRecentUncoalesced(epic, resolution, bars, priceSide, brokerId);
    inflightRecent.set(key, shared);
    // Drop on settle (success OR failure — a cached rejection would block every
    // retry). The catch keeps the cleanup chain from surfacing as an unhandled
    // rejection; callers still see the rejection through `shared` itself.
    shared.finally(() => inflightRecent.delete(key)).catch(() => {});
  }
  const r = await shared;
  return { ...r, bars: r.bars.map((b) => ({ ...b })) };
}

async function fetchRecentUncoalesced(
  epic: string,
  resolution: string,
  bars: number,
  priceSide: PriceSide,
  brokerId: string,
): Promise<CandlesResult> {
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
    if (res.ok)
      return {
        bars: ((await res.json()) as RawCandle[]).map(toKLine),
        degraded: degradedHeader(res),
        partial: partialHeader(res),
      };
    if (res.status === 404) return { bars: [], degraded: null, partial: null };
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
  if (res.ok) {
    const rows = (await res.json()) as RawCandle[];
    if (PERF_DIAG_ON) recordFetch("recent", rows.length);
    return {
      bars: rows.map(toKLine),
      degraded: degradedHeader(res),
      partial: partialHeader(res),
    };
  }
  // 404 = no data for this epic (unknown / no history) — empty, not an error.
  if (res.status === 404) return { bars: [], degraded: null, partial: null };
  // Anything else (e.g. 502 from a broker auth / maintenance failure) carries a
  // detail worth surfacing — throw it so the chart can show why it's blank.
  throw new Error(await errorDetail(res));
}

/** Most recent `bars` candles (no date window). Used for the initial load. */
export async function fetchRecent(
  epic: string,
  resolution: string,
  bars = 500,
  priceSide: PriceSide = "mid",
  brokerId: string = DEFAULT_BROKER,
): Promise<KLineData[]> {
  return (await fetchRecentWithStatus(epic, resolution, bars, priceSide, brokerId)).bars;
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
  signal?: AbortSignal,
  // A callback rather than a richer return type on purpose: the parallel cover
  // marks a hole by a THROW and needs the bare bar array, so this is the only
  // seam that can carry the still-filling marker out without changing what the
  // pager consumes.
  onPartial?: (progress: FillProgress) => void,
): Promise<KLineData[]> {
  const res = await rangeResponse(epic, resolution, fromSec, toSec, priceSide, brokerId, signal);
  if (!res.ok) throw new CandlesFetchError(res.status);
  const progress = partialHeader(res);
  if (progress) onPartial?.(progress);
  const rows = (await res.json()) as RawCandle[];
  // The MTF/HTF walk fetches through THIS function, not fetchRangeWithStatus,
  // so its rows have to be counted here too -- otherwise every windowed request
  // the coordinator makes reads as returning nothing.
  if (PERF_DIAG_ON) recordBars(rows.length);
  return rows.map(toKLine);
}

/** The raw /api/candles date-window request shared by the range variants. */
async function rangeResponse(
  epic: string,
  resolution: string,
  fromSec: number,
  toSec: number,
  priceSide: PriceSide,
  brokerId: string,
  signal?: AbortSignal,
): Promise<Response> {
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
  if (PERF_DIAG_ON) recordFetch("range", 0); // bars land in the callers' parse
  return apiFetch(`${BASE}/api/candles${syn ? "/synthetic" : ""}?${qs}`, { signal });
}

/** Statuses that mean "the broker/backend path is unreachable right now" (retry
 * later, data may exist) rather than "this data does not exist" (404/422). */
function isOutageStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Candles in [fromSec, toSec] with the degraded-serve marker kept (see
 * CandlesResult): a 200 whose X-Candles-Degraded header is set (the backend
 * served possibly-short cached bars during a broker outage) or an outage-status
 * failure both come back as `degraded`, so callers can tell "broker down" apart
 * from genuine end-of-history instead of seeing a bare empty page.
 */
export async function fetchRangeWithStatus(
  epic: string,
  resolution: string,
  fromSec: number,
  toSec: number,
  priceSide: PriceSide = "mid",
  brokerId: string = DEFAULT_BROKER,
  signal?: AbortSignal,
): Promise<CandlesResult> {
  const res = await rangeResponse(epic, resolution, fromSec, toSec, priceSide, brokerId, signal);
  if (!res.ok) {
    if (!isOutageStatus(res.status)) return { bars: [], degraded: null, partial: null };
    // Surface the backend's own detail (e.g. the WAF "blocked by your network"
    // message from X-Broker-Blocked 503s) — it's the actionable part; the bare
    // status code is only the fallback for detail-less responses.
    return {
      bars: [],
      degraded: await errorDetail(res, `broker unreachable (${res.status})`),
      partial: null,
    };
  }
  const rows = (await res.json()) as RawCandle[];
  if (PERF_DIAG_ON) recordBars(rows.length);
  return {
    bars: rows.map(toKLine),
    degraded: degradedHeader(res),
    partial: partialHeader(res),
  };
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
  signal?: AbortSignal,
): Promise<KLineData[]> {
  return (await fetchRangeWithStatus(epic, resolution, fromSec, toSec, priceSide, brokerId, signal))
    .bars;
}

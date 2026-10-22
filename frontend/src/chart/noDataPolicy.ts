// Policy for the chart's "couldn't load data" recovery path.
//
// The no-data banner promises "Retrying automatically…" — these helpers make
// that promise concrete. Recovery used to rely solely on a live tick arriving,
// which never happens while the market is closed: one transient load failure
// (backend reload, broker maintenance) latched the banner until a manual page
// reload. useLiveMarketData now schedules real history re-fetches on this
// backoff, and ChartCore picks the banner variant from what's actually painted.

import type { FailureCause } from "../lib/http";

/** A load the backend served from its candle cache because the broker call
 * failed: the failure text and, when the backend knew, who it was on. */
export type DegradedServe = { reason: string; cause: FailureCause | null };

/** The degraded pill's text: names the broker when it is the broker's
 * outage, our server when it stalled, and the network when it is blocked. */
export function degradedPillText(serve: DegradedServe, brokerName: string): string {
  switch (serve.cause) {
    case "broker":
      return `${brokerName} isn't responding: showing cached data. Retrying automatically…`;
    case "server":
      return "Chartkar's server is overloaded: showing cached data. Retrying automatically…";
    case "blocked":
      return "Your network is blocking the broker: showing cached data. Retrying automatically…";
    default:
      return "Broker unreachable: showing cached data. Retrying automatically…";
  }
}

/** Delay before history-load retry number `attempt` (0-based): 5s doubling to a 60s cap. */
export function nextHistoryRetryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt), 60_000);
}

export type NoDataKind = "empty" | "stale";

/**
 * Which banner a failed load should show: the full "No data to display" card
 * only when the chart is genuinely blank; a compact "showing stale data" pill
 * when bars from a previous load are still painted (a failed refresh must not
 * claim there's no data over a chart visibly full of candles).
 */
export function classifyNoData(paintedBarCount: number): NoDataKind {
  return paintedBarCount > 0 ? "stale" : "empty";
}

/**
 * Why a history load came back with nothing, from the failed response's status.
 * The banner's headline turns on this: a dead session (401) is fixed by
 * signing in again, a refused broker (403) only by an account with access, a
 * broker outage (5xx/429) by waiting, and none is worth naming when the status
 * says none.
 *
 * 403 is its own case. The backend refuses a WS dial or candle fetch to a
 * restricted broker with 403 for a non-admin, and signing in again cannot fix
 * that, so the banner must not tell them their session expired.
 */
export type LoadFailure = "auth" | "forbidden" | "broker" | "unknown";

export function classifyLoadFailure(status: number | null | undefined): LoadFailure {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429 || (status != null && status >= 500)) return "broker";
  return "unknown";
}

/**
 * Whether a settled history load should schedule a backoff re-fetch: an empty
 * load (nothing painted), or a degraded one — the backend served cached bars
 * because the broker was unreachable, so the missing tail heals only by
 * re-fetching once the broker returns.
 */
export function shouldRetryHistory(barCount: number, degraded: string | null): boolean {
  return barCount === 0 || degraded != null;
}

/**
 * Whether an empty reload should LEAVE the currently painted bars on screen
 * instead of applying the empty result. Only for a same-series re-run (a
 * backoff retry, or a side/broker refresh that failed): wiping a chart the
 * user is looking at because one retry failed is strictly worse than keeping
 * the stale bars under the stale pill until a retry succeeds. A series switch
 * must still clear — the old series' bars must not masquerade as the new one.
 */
export function shouldKeepPaintedBars(
  loadedBarCount: number,
  paintedBarCount: number,
  sameSeries: boolean,
): boolean {
  return loadedBarCount === 0 && paintedBarCount > 0 && sameSeries;
}

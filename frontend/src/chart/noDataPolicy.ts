// Policy for the chart's "couldn't load data" recovery path.
//
// The no-data banner promises "Retrying automatically…" — these helpers make
// that promise concrete. Recovery used to rely solely on a live tick arriving,
// which never happens while the market is closed: one transient load failure
// (backend reload, broker maintenance) latched the banner until a manual page
// reload. useLiveMarketData now schedules real history re-fetches on this
// backoff, and ChartCore picks the banner variant from what's actually painted.

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
 * The banner's headline turns on this: a dead session (401/403) is fixed by
 * signing in again, a broker outage (5xx/429) by waiting, and neither is worth
 * naming when the status says neither.
 *
 * 403 is grouped with 401 deliberately. The backend refuses a WS dial to a
 * restricted broker with 403, and a candle fetch for a non-admin the same way,
 * so "your session can't see this broker" is the honest reading for both.
 */
export type LoadFailure = "auth" | "broker" | "unknown";

export function classifyLoadFailure(status: number | null | undefined): LoadFailure {
  if (status === 401 || status === 403) return "auth";
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

// Honest messaging for backtests that ran (or failed) against degraded candle
// data. A broker outage no longer aborts the candle fetch: the backend serves
// whatever its cache holds and marks the response degraded (see
// feed.CandlesResult). These helpers keep the UI truthful about that state —
// a shortage caused by an unreachable broker must not masquerade as "the data
// doesn't exist" (the old behavior, which sent users chasing range/indicator
// settings during outages).

/** The "no candles in the selected range" error, outage-aware. */
export function emptyRangeError(degraded: string | null): string {
  if (degraded == null) return "no candles in the selected range";
  return (
    `${degraded}: no cached candles cover the selected range. ` +
    "The range may be fine: retry when the connection to the broker is back."
  );
}

/** A warm-up shortage error, attributed to the outage when one occurred. */
export function warmupError(base: string, degraded: string | null): string {
  if (degraded == null) return base;
  return (
    `${base} Note: ${degraded} during the candle fetch, so this run only saw ` +
    "cached data; the missing bars may simply be unreachable right now."
  );
}

/**
 * Toast text for a run that proceeded on cached data during an outage; null
 * when the fetch was healthy. Mentions the effective data end only when the
 * cached tail stops meaningfully short of the requested end (the forming bar
 * is never cached, so being a bar or two behind is normal, not a shortage).
 */
export function cachedRunNotice(
  degraded: string | null,
  lastBarMs: number | null,
  toSec: number,
  resSeconds: number,
): string | null {
  if (degraded == null) return null;
  let msg = "Broker unreachable: backtest ran on cached candles.";
  if (lastBarMs != null && lastBarMs / 1000 < toSec - 2 * resSeconds) {
    const stamp = new Date(lastBarMs).toISOString().slice(0, 16).replace("T", " ");
    msg += ` Data ends ${stamp} UTC, before the requested end.`;
  }
  return msg;
}

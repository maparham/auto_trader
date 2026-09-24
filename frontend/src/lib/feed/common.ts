// What every feed request shares: the default broker, the wire candle shape
// and its KLineData mapping, and the timeout-bounded fetch.
import type { KLineData } from "klinecharts";
import { defaultBrokerId } from "../brokerDefaults";
import { apiFetch } from "../http";

export interface RawCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function toKLine(c: RawCandle): KLineData {
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
// The chart and symbol-search modal pass the user's active broker explicitly;
// this default only covers call sites that name none. Capital when the backend
// has it, else the first registered broker (see brokerDefaults).
export const DEFAULT_BROKER = defaultBrokerId();

// History fetch timeout. A hung backend (broker maintenance) would otherwise leave
// the request pending forever — no candles, no error. Aborting after this surfaces
// a clear "timed out" message in the chart's no-data banner.
const HISTORY_TIMEOUT_MS = 10_000;

// Status-poll timeout. Shorter than the history one: the per-tab open/closed poll
// fans out one request per open tab, so a hung broker must release each connection
// quickly or it saturates the browser's per-host connection budget and starves the
// other brokers (and the account-selector fetch). The backend circuit breaker
// fast-fails a down broker, but this bounds the client side too.
export const META_TIMEOUT_MS = 6_000;

/** apiFetch() that aborts after `timeoutMs`, throwing a readable timeout error. */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number = HISTORY_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await apiFetch(url, { signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err; // genuine network error (refused / DNS / offline) — surface as-is
  } finally {
    clearTimeout(timer);
  }
}

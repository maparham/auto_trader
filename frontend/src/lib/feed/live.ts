// The live stream: the WebSocket feed handle, its status, and the staleness
// check.
import type { KLineData } from "klinecharts";
import type { PriceSide } from "../../theme";
import { API_BASE as BASE } from "../http";
import { getAuthToken, hasTokenGetter } from "../authToken";
import { isSynthetic } from "../syntheticRegistry";
import { withImpersonation } from "../impersonation";
import { isDemoMode } from "../demoMode";
import { toKLine, DEFAULT_BROKER } from "./common";

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
 *
 * A DETACHED cell is never stale, because it has no stream to have gone silent:
 * useLiveMarketData returns before opening one, so `status` keeps whatever it
 * said when the cell detached ("live", usually) and no candle ever arrives.
 * Left ungated, the silence trips this watchdog ~90s into every detached view
 * and the legend puts up a "stale feed" warning about a feed that was closed on
 * purpose. The DetachedPill is the cell's status while detached.
 */
export function isFeedStale(args: {
  status: LiveStatus;
  marketClosed: boolean;
  lastCandleAt: number;
  streamLiveAt: number;
  now: number;
  staleMs: number;
  detached?: boolean;
}): boolean {
  const base = Math.max(args.lastCandleAt, args.streamLiveAt);
  return (
    base > 0 &&
    !args.detached &&
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
  if (isDemoMode()) {
    // Demo runs pinned to dukascopy (supports_streaming=False: no upstream tick
    // feed exists at all), and the demo principal carries no auth token, so a
    // dial here would only ever get closed 4401 by verify_ws and retry forever
    // with backoff, spamming hosted logs. Short-circuit exactly like the
    // synthetic case above: no dial, no retry loop, chart stays on its fetched
    // candles.
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
    const dial = (token: string | null) => {
      ws = new WebSocket(
        withImpersonation(
          token ? `${url}&token=${encodeURIComponent(token)}` : url,
        ),
      );
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
    // Dev/test (no token getter registered): dial synchronously —
    // byte-identical to pre-auth behavior. Once one is registered, a token
    // must be fetched fresh per (re)connect (Clerk tokens live ~60s).
    if (!hasTokenGetter()) {
      dial(null);
      return;
    }
    void (async () => {
      // getAuthToken() (Clerk's getToken()) can reject (network blip, torn-down
      // session). A tokenless dial here — rather than leaving the handle dead —
      // lets the backend reject the socket and the existing onclose/backoff
      // machinery own the retry.
      const token = await getAuthToken().catch(() => null);
      if (closed) return;
      dial(token);
    })();
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

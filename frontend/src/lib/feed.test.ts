import { describe, it, expect, beforeEach, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { fetchAllMarkets, fetchFavorites, fetchRecent, isFeedStale, openLive } from "./feed";
import { registerSynthetic } from "./syntheticRegistry";

// The catalogue/favorites caches are module-level and keyed by broker; each test
// uses a unique broker id instead of resetting modules, so tests stay independent.
let n = 0;
const freshBroker = () => `test-broker-${n++}`;

const MARKETS = [
  { epic: "US100", name: "US Tech 100", status: "TRADEABLE", type: "INDICES" },
];

function okResponse() {
  return { ok: true, json: () => Promise.resolve(MARKETS) };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAllMarkets failure caching", () => {
  it("does not cache a rejected fetch — the next call retries and succeeds", async () => {
    const broker = freshBroker();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    // First call hits the outage: resolves [] so callers keep working…
    expect(await fetchAllMarkets(broker)).toEqual([]);
    // …but the failure must NOT be cached: the next call retries.
    expect(await fetchAllMarkets(broker)).toEqual(MARKETS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a non-ok response", async () => {
    const broker = freshBroker();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) })
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchAllMarkets(broker)).toEqual([]);
    expect(await fetchAllMarkets(broker)).toEqual(MARKETS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still caches a successful catalogue for the session", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchAllMarkets(broker)).toEqual(MARKETS);
    expect(await fetchAllMarkets(broker)).toEqual(MARKETS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchFavorites failure caching", () => {
  it("does not cache a rejected fetch — the next call retries and succeeds", async () => {
    const broker = freshBroker();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchFavorites(broker)).toEqual([]);
    expect(await fetchFavorites(broker)).toEqual(MARKETS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("synthetic routing", () => {
  it("fetchRecent routes a synthetic id to /api/candles/synthetic with expr", async () => {
    const e = registerSynthetic("A/B", "capital");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchRecent(e.id, "MINUTE", 500, "mid", "capital");

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/candles/synthetic");
    // canonical of "A/B" is "A / B"; URLSearchParams encodes space as '+' and '/' as '%2F'.
    expect(url).toContain("expr=A+%2F+B");
    expect(decodeURIComponent(new URL(url).searchParams.get("expr")!)).toBe("A / B");
  });

  it("openLive is inert for a synthetic id", () => {
    const e = registerSynthetic("A/B", "capital");
    const onCandle = vi.fn();
    const onStatus = vi.fn();
    const h = openLive(e.id, "MINUTE", onCandle, onStatus, "mid", "capital");
    expect(onCandle).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("down");
    expect(() => h.close()).not.toThrow();
  });
});

describe("isFeedStale", () => {
  const T = 1_000_000; // arbitrary "now"
  const base = {
    status: "live" as const,
    marketClosed: false,
    lastCandleAt: T - 200_000, // last tick 200s ago
    streamLiveAt: T - 300_000, // connected 300s ago
    now: T,
    staleMs: 90_000,
  };

  it("flags a connected, open feed silent past the threshold", () => {
    expect(isFeedStale(base)).toBe(true);
  });

  it("is not stale within the threshold", () => {
    // A tick 30s ago (< 90s) → fresh, even though the connection is older.
    expect(isFeedStale({ ...base, lastCandleAt: T - 30_000 })).toBe(false);
  });

  it("measures from the LATER of connect and last candle (never-ticked hang)", () => {
    // No candle ever (0), connected 300s ago → silence is 300s → stale. A
    // last-candle-only baseline (0) would wrongly read as "no connection".
    expect(isFeedStale({ ...base, lastCandleAt: 0 })).toBe(true);
    // Same connection, but only 30s old → not yet stale.
    expect(isFeedStale({ ...base, lastCandleAt: 0, streamLiveAt: T - 30_000 })).toBe(false);
  });

  it("never stale before anything has connected or ticked", () => {
    expect(isFeedStale({ ...base, lastCandleAt: 0, streamLiveAt: 0 })).toBe(false);
  });

  it("is suppressed when the market is closed (no ticks expected)", () => {
    expect(isFeedStale({ ...base, marketClosed: true })).toBe(false);
  });

  it("only applies while the socket reports live", () => {
    expect(isFeedStale({ ...base, status: "down" })).toBe(false);
    expect(isFeedStale({ ...base, status: "connecting" })).toBe(false);
  });
});

describe("openLive reconnect backoff", () => {
  // Minimal WebSocket stand-in: the test drives onopen/onmessage/onclose by hand.
  class FakeWS {
    static instances: FakeWS[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    url: string;
    constructor(url: string) {
      this.url = url;
      FakeWS.instances.push(this);
    }
    close() {
      this.onclose?.();
    }
  }

  beforeEach(() => {
    FakeWS.instances = [];
    vi.stubGlobal("WebSocket", FakeWS);
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  // The dial delay before attempt N, driven via fake timers.
  const dropAndMeasureDelay = (): number => {
    const before = FakeWS.instances.length;
    const ws = FakeWS.instances[before - 1];
    ws.onopen?.();
    ws.onclose?.(); // server accepted, then dropped the relay immediately
    let delay = 0;
    while (FakeWS.instances.length === before && delay < 60000) {
      vi.advanceTimersByTime(1000);
      delay += 1000;
    }
    return delay;
  };

  it("keeps backing off when sockets open but die without data (wedged upstream)", () => {
    const h = openLive("CrudeOIL", "MINUTE", vi.fn(), undefined, "mid", "mt5");
    expect(FakeWS.instances.length).toBe(1);

    // A successful HANDSHAKE must not reset the backoff — only data may.
    expect(dropAndMeasureDelay()).toBe(1000);
    expect(dropAndMeasureDelay()).toBe(2000);
    expect(dropAndMeasureDelay()).toBe(4000);
    expect(dropAndMeasureDelay()).toBe(8000);
    expect(dropAndMeasureDelay()).toBe(15000); // capped
    expect(dropAndMeasureDelay()).toBe(15000);
    h.close();
  });

  it("a real candle frame resets the backoff to the 1s floor", () => {
    const onCandle = vi.fn();
    const h = openLive("CrudeOIL", "MINUTE", onCandle, undefined, "mid", "mt5");

    expect(dropAndMeasureDelay()).toBe(1000);
    expect(dropAndMeasureDelay()).toBe(2000);

    // Healthy stream: data flows, so the next drop starts over at 1s.
    const ws = FakeWS.instances[FakeWS.instances.length - 1];
    ws.onopen?.();
    ws.onmessage?.({
      data: JSON.stringify({
        type: "candle",
        candle: { time: "2026-07-11T00:00:00Z", open: 1, high: 1, low: 1, close: 1, volume: 0 },
        bid: null,
        ask: null,
      }),
    });
    expect(onCandle).toHaveBeenCalledTimes(1);

    expect(dropAndMeasureDelay()).toBe(1000);
    h.close();
  });
});

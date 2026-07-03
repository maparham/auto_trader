import { describe, it, expect, beforeEach, vi } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { fetchAllMarkets, fetchFavorites, fetchRecent, openLive } from "./feed";
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

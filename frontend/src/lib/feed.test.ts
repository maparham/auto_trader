import { describe, it, expect, beforeEach, vi } from "vitest";
import { fetchAllMarkets, fetchFavorites } from "./feed";

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

// @vitest-environment node
// publishDemo / fetchDemoLive / fetchCurrentDemo: thin POST/GET wrappers around
// the admin demo router (see backend/tests/test_demo_router.py for the wire
// shapes). apiFetch and captureDemoLayout are mocked so these tests exercise
// only this module's request-building and response-parsing.
import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("./http", () => ({
  API_BASE: "http://localhost:8000",
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  errorDetail: async (res: Response, fallback?: string) => {
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") return body.detail;
    } catch {
      /* non-JSON */
    }
    return fallback ?? `${res.status}`;
  },
}));

let persistBroker = "dukascopy";
vi.mock("./persist/core", () => ({
  getPersistBroker: () => persistBroker,
}));

vi.mock("./demoSnapshot", () => ({
  captureDemoLayout: () => ({ layouts: "[]" }),
  captureDemoLayoutFor: (id: string) =>
    id === "L1"
      ? { layouts: '[{"id":"L1","name":"Alpha"}]', defaultLayoutId: '"L1"' }
      : null,
}));

// The yfinance catalogue the remap resolves against (see demoRemap.test.ts
// for the remap's own behavior; here it only needs to pass symbols through).
vi.mock("./feed", () => ({
  fetchAllMarkets: async () => [
    { epic: "US100", name: "Nasdaq 100", status: null, pricePrecision: 1 },
    { epic: "EURUSD", name: "EUR/USD", status: null, pricePrecision: 5 },
    { epic: "XAUUSD", name: "Gold (COMEX)", status: null, pricePrecision: 3 },
  ],
}));

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  apiFetch.mockReset();
  persistBroker = "dukascopy";
});

describe("publishDemo", () => {
  it("POSTs the captured layout plus watchlist/backtests and resolves the version", async () => {
    apiFetch.mockResolvedValue(jsonRes(200, { version: 3 }));
    const { publishDemo } = await import("./demoPublish");

    const version = await publishDemo({
      watchlist: ["US100", "EURUSD"],
      backtests: [{ name: "NQ breakout", result: { trades: [] } }],
    });

    expect(version).toBe(3);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/admin/demo/publish");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      layout: { layouts: "[]" },
      broker: "yfinance",
      watchlist: ["US100", "EURUSD"],
      backtests: [{ name: "NQ breakout", result: { trades: [] } }],
    });
  });

  it("remaps aliased watchlist epics onto the yfinance names", async () => {
    apiFetch.mockResolvedValue(jsonRes(200, { version: 1 }));
    const { publishDemo } = await import("./demoPublish");

    await publishDemo({ watchlist: ["GOLD"], backtests: [] });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body).watchlist).toEqual(["XAUUSD"]);
  });

  it("keeps a watchlist symbol outside the catalogue verbatim (Yahoo charts raw tickers)", async () => {
    apiFetch.mockResolvedValue(jsonRes(200, { version: 2 }));
    const { publishDemo } = await import("./demoPublish");

    await publishDemo({ watchlist: ["NKE", "GOLD"], backtests: [] });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body).watchlist).toEqual(["NKE", "XAUUSD"]);
  });

  it("skips the remap entirely when publishing FROM a yfinance workspace", async () => {
    persistBroker = "yfinance";
    apiFetch.mockResolvedValue(jsonRes(200, { version: 3 }));
    const { publishDemo } = await import("./demoPublish");

    await publishDemo({ watchlist: ["GOLD", "NKE", "NKE"], backtests: [] });
    const body = JSON.parse(apiFetch.mock.calls[0][1].body);
    // GOLD is NOT aliased here: on a yfinance workspace the epics are already
    // Yahoo's, so they publish exactly as charted (deduped only).
    expect(body.watchlist).toEqual(["GOLD", "NKE"]);
    expect(body.layout).toEqual({ layouts: "[]" });
  });

  it("throws the server's 422 message", async () => {
    apiFetch.mockResolvedValue(jsonRes(422, { detail: "layout is empty" }));
    const { publishDemo } = await import("./demoPublish");

    await expect(
      publishDemo({ watchlist: ["US100"], backtests: [] }),
    ).rejects.toThrow("layout is empty");
  });
});

describe("publishDemoLayoutOnly", () => {
  it("publishes the single-layout capture, carrying the live watchlist/backtests forward", async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.endsWith("/api/demo/snapshot")
        ? jsonRes(200, {
            version: 5,
            payload: { watchlist: ["GOLD"], backtests: [{ name: "A", result: {} }] },
          })
        : jsonRes(200, { version: 6 }),
    );
    const { publishDemoLayoutOnly } = await import("./demoPublish");

    expect(await publishDemoLayoutOnly("L1")).toBe(6);
    const post = apiFetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeTruthy();
    expect(JSON.parse(post![1].body)).toEqual({
      layout: { layouts: '[{"id":"L1","name":"Alpha"}]', defaultLayoutId: '"L1"' },
      broker: "yfinance",
      watchlist: ["XAUUSD"], // the live demo's GOLD, remapped like any publish
      backtests: [{ name: "A", result: {} }],
    });
  });

  it("treats no published demo (404) as empty watchlist and backtests", async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.endsWith("/api/demo/snapshot")
        ? jsonRes(404, { detail: "nothing published" })
        : jsonRes(200, { version: 1 }),
    );
    const { publishDemoLayoutOnly } = await import("./demoPublish");

    expect(await publishDemoLayoutOnly("L1")).toBe(1);
    const post = apiFetch.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(post![1].body);
    expect(body.watchlist).toEqual([]);
    expect(body.backtests).toEqual([]);
  });

  it("throws before any request when the layout is not saved", async () => {
    const { publishDemoLayoutOnly } = await import("./demoPublish");

    await expect(publishDemoLayoutOnly("NOPE")).rejects.toThrow("layout not found");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("fetchDemoLive", () => {
  it("returns the newest row only, converting createdAt seconds to ms", async () => {
    const versions = [
      { version: 2, publishedBy: "a@b.com", createdAt: 1789221839, size: 10 },
      { version: 1, publishedBy: "a@b.com", createdAt: 1789000000, size: 9 },
    ];
    apiFetch.mockResolvedValue(jsonRes(200, { versions }));
    const { fetchDemoLive } = await import("./demoPublish");

    expect(await fetchDemoLive()).toEqual({ ...versions[0], createdAt: 1789221839000 });
    expect(apiFetch).toHaveBeenCalledWith("http://localhost:8000/api/admin/demo/versions");
  });

  it("returns null when nothing has been published", async () => {
    apiFetch.mockResolvedValue(jsonRes(200, { versions: [] }));
    const { fetchDemoLive } = await import("./demoPublish");

    expect(await fetchDemoLive()).toBeNull();
  });
});

describe("fetchCurrentDemo", () => {
  it("returns the current version's watchlist and backtests", async () => {
    apiFetch.mockResolvedValue(
      jsonRes(200, {
        version: 5,
        payload: { watchlist: ["US100"], backtests: [{ name: "NQ breakout", result: { trades: [] } }] },
      }),
    );
    const { fetchCurrentDemo } = await import("./demoPublish");

    expect(await fetchCurrentDemo()).toEqual({
      version: 5,
      watchlist: ["US100"],
      backtests: [{ name: "NQ breakout", result: { trades: [] } }],
    });
    expect(apiFetch).toHaveBeenCalledWith("http://localhost:8000/api/demo/snapshot");
  });

  it("returns null when nothing has been published yet (404)", async () => {
    apiFetch.mockResolvedValue(jsonRes(404, { detail: "no demo published" }));
    const { fetchCurrentDemo } = await import("./demoPublish");

    expect(await fetchCurrentDemo()).toBeNull();
  });
});

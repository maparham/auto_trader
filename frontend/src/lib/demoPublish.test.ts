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

vi.mock("./demoSnapshot", () => ({
  captureDemoLayout: () => ({ layouts: "[]" }),
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

  it("refuses (before any POST) a watchlist symbol with no yfinance match", async () => {
    const { publishDemo } = await import("./demoPublish");

    await expect(
      publishDemo({ watchlist: ["NOPE"], backtests: [] }),
    ).rejects.toThrow("not available on Yahoo Finance: NOPE");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("throws the server's 422 message", async () => {
    apiFetch.mockResolvedValue(jsonRes(422, { detail: "layout is empty" }));
    const { publishDemo } = await import("./demoPublish");

    await expect(
      publishDemo({ watchlist: ["US100"], backtests: [] }),
    ).rejects.toThrow("layout is empty");
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

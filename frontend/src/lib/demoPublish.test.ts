// @vitest-environment node
// publishDemo / listDemoVersions / rollbackDemo: thin POST/GET wrappers around
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
      watchlist: ["US100", "EURUSD"],
      backtests: [{ name: "NQ breakout", result: { trades: [] } }],
    });
  });

  it("throws the server's 422 message", async () => {
    apiFetch.mockResolvedValue(jsonRes(422, { detail: "unknown epic NOPE" }));
    const { publishDemo } = await import("./demoPublish");

    await expect(
      publishDemo({ watchlist: ["NOPE"], backtests: [] }),
    ).rejects.toThrow("unknown epic NOPE");
  });
});

describe("listDemoVersions", () => {
  it("GETs and returns the versions array", async () => {
    const versions = [{ version: 2, publishedBy: "a@b.com", createdAt: 1, size: 10 }];
    apiFetch.mockResolvedValue(jsonRes(200, { versions }));
    const { listDemoVersions } = await import("./demoPublish");

    expect(await listDemoVersions()).toEqual(versions);
    expect(apiFetch).toHaveBeenCalledWith("http://localhost:8000/api/admin/demo/versions");
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

describe("rollbackDemo", () => {
  it("POSTs {version} and resolves the new version", async () => {
    apiFetch.mockResolvedValue(jsonRes(200, { version: 4 }));
    const { rollbackDemo } = await import("./demoPublish");

    expect(await rollbackDemo(1)).toBe(4);
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/admin/demo/rollback");
    expect(JSON.parse(init.body)).toEqual({ version: 1 });
  });
});

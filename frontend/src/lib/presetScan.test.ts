import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchFamilies,
  runPresetScan,
  listUserPresets,
  createUserPreset,
  renameUserPreset,
  deleteUserPreset,
} from "./presetScan";

afterEach(() => vi.restoreAllMocks());

describe("fetchFamilies", () => {
  it("parses the manifest", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        families: [
          {
            family: "double-top",
            title: "Double Top",
            params: [
              { name: "tolerance", type: "float", min: 0, max: 1, default: 0.05, help: "how close" },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchFamilies();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/patterns/families");
    expect(init?.method ?? "GET").toBe("GET");
    expect(out).toEqual([
      {
        family: "double-top",
        title: "Double Top",
        params: [
          { name: "tolerance", type: "float", min: 0, max: 1, default: 0.05, help: "how close" },
        ],
      },
    ]);
  });

  it("throws the server's detail on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ detail: "families unavailable" }),
      text: async () => "",
    }));
    await expect(fetchFamilies()).rejects.toThrow(/families unavailable/);
  });
});

describe("runPresetScan", () => {
  const req = {
    charts: [{ epic: "US100", resolution: "MINUTE_5" }],
    families: [{ family: "double-top", params: { tolerance: 0.05 } }],
    broker: "capital",
    priceSide: "bid",
  };

  it("posts the exact body and returns the parsed result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        charts: [
          { epic: "US100", resolution: "MINUTE_5", status: "ok", error: null, hits: [] },
        ],
        elapsedMs: 42,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await runPresetScan(req);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/patterns/scan");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(req);
    expect(out.elapsedMs).toBe(42);
    expect(out.charts[0].status).toBe("ok");
  });

  it("throws the server's detail on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 409,
      json: async () => ({ detail: "a scan is already running" }),
      text: async () => "",
    }));
    await expect(runPresetScan(req)).rejects.toThrow(/scan is already running/);
  });

  // Belt-and-braces: no caller (seeded or not) may ever produce the backend's
  // 422 string_pattern_mismatch on an empty priceSide — omit it (and an empty
  // broker) from the body instead of sending "", so the server applies its own
  // defaults ("bid" for priceSide, its resolved default broker).
  it("omits priceSide and broker from the body when they're empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ charts: [], elapsedMs: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await runPresetScan({ ...req, broker: "", priceSide: "" });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty("priceSide");
    expect(body).not.toHaveProperty("broker");
    expect(body.charts).toEqual(req.charts);
    expect(body.families).toEqual(req.families);
  });

  it("keeps priceSide and broker in the body when they're set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ charts: [], elapsedMs: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await runPresetScan(req);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.broker).toBe("capital");
    expect(body.priceSide).toBe("bid");
  });
});

describe("listUserPresets", () => {
  it("GETs the presets endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        presets: [
          { id: "1", name: "My preset", epic: "US100", resolution: "MINUTE_5", bars: [], created_at: 123 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await listUserPresets();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/patterns/presets");
    expect(init?.method ?? "GET").toBe("GET");
    expect(out).toHaveLength(1);
    expect(out[0].created_at).toBe(123);
  });

  it("throws the server's detail on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ detail: "presets unavailable" }),
      text: async () => "",
    }));
    await expect(listUserPresets()).rejects.toThrow(/presets unavailable/);
  });
});

describe("createUserPreset", () => {
  it("POSTs the preset and returns the created row", async () => {
    const body = { name: "My preset", epic: "US100", resolution: "MINUTE_5", bars: [] };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "1", ...body, created_at: 123 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await createUserPreset(body);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/patterns/presets");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(body);
    expect(out.id).toBe("1");
  });

  it("throws the server's detail on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ detail: "name is required" }),
      text: async () => "",
    }));
    await expect(
      createUserPreset({ name: "", epic: "US100", resolution: "MINUTE_5", bars: [] }),
    ).rejects.toThrow(/name is required/);
  });
});

describe("renameUserPreset", () => {
  it("PATCHes the preset by id with the new name", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    await renameUserPreset("42", "New name");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/patterns/presets/42");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ name: "New name" });
  });

  it("throws the server's detail on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 404,
      json: async () => ({ detail: "preset not found" }),
      text: async () => "",
    }));
    await expect(renameUserPreset("missing", "x")).rejects.toThrow(/preset not found/);
  });
});

describe("deleteUserPreset", () => {
  it("DELETEs the preset by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    await deleteUserPreset("42");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/patterns/presets/42");
    expect(init.method).toBe("DELETE");
  });

  it("throws the server's detail on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 404,
      json: async () => ({ detail: "preset not found" }),
      text: async () => "",
    }));
    await expect(deleteUserPreset("missing")).rejects.toThrow(/preset not found/);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchStrategies, fetchStrategySource } from "../api";

afterEach(() => vi.restoreAllMocks());

function mockFetch(body: unknown, ok = true) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe("strategies api", () => {
  it("fetchStrategies GETs /api/strategies", async () => {
    const spy = mockFetch([
      { filename: "a.py", name: "A", description: "d", hedged: false, error: null },
    ]);
    const list = await fetchStrategies();
    expect(String(spy.mock.calls[0][0])).toContain("/api/strategies");
    expect(list[0].name).toBe("A");
  });

  it("fetchStrategySource returns the source text", async () => {
    const spy = mockFetch({ filename: "a.py", source: "def on_bar(ctx): ..." });
    const src = await fetchStrategySource("a.py");
    expect(String(spy.mock.calls[0][0])).toContain("/api/strategies/a.py/source");
    expect(src).toContain("def on_bar");
  });

  it("fetchStrategies throws on error responses", async () => {
    mockFetch({ detail: "boom" }, false);
    await expect(fetchStrategies()).rejects.toThrow();
  });
});

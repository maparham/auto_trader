import { afterEach, expect, it, vi } from "vitest";
import { fetchClosenessHeatmap } from "./api";

afterEach(() => vi.restoreAllMocks());

it("posts the closeness request and returns times/values", async () => {
  const body = { times: [0, 60], values: [0.5, null] };
  const fetchMock = vi.fn(
    async (_url?: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, json: async () => body }) as Response,
  );
  vi.stubGlobal("fetch", fetchMock);

  const out = await fetchClosenessHeatmap({
    broker: "capital", epic: "X", priceSide: "mid",
    rows: ["close > 100"], combine: "AND",
    baseResolution: "MINUTE", displayResolution: "HOUR",
    fromTime: 0, toTime: 3600,
    norm: { basis: "volatility", width: 2, window: 50, atrLength: 14 },
    agg: "max",
  });

  expect(out).toEqual(body);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toContain("/api/expr/closeness");
  expect(JSON.parse((init as RequestInit).body as string).rows).toEqual(["close > 100"]);
});

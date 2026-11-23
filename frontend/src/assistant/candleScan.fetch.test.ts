import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchRangeWithStatus = vi.fn();
vi.mock("../lib/feed/candles", () => ({
  fetchRangeWithStatus: (...a: unknown[]) => fetchRangeWithStatus(...a),
}));

import { fetchFilled } from "./candleScan";

const bars = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: i, open: 1, high: 1, low: 1, close: 1 }));
const res = (n: number, partial: boolean, degraded: string | null = null) =>
  ({ bars: bars(n), degraded, cause: null, partial: partial ? { done: 1, total: 2 } : null });
const base = {
  epic: "X", resolution: "DAY", fromMs: 1_000_000, toMs: 2_000_500,
  priceSide: "mid" as const, broker: "capital",
};

beforeEach(() => fetchRangeWithStatus.mockReset());

describe("fetchFilled", () => {
  it("asks again while the backend is still filling", async () => {
    fetchRangeWithStatus.mockResolvedValueOnce(res(3, true)).mockResolvedValueOnce(res(5, false));
    const out = await fetchFilled({ ...base, signal: new AbortController().signal });
    expect(fetchRangeWithStatus).toHaveBeenCalledTimes(2);
    expect(out.partial).toBe(false);
    expect(out.bars).toHaveLength(5);
    expect(fetchRangeWithStatus.mock.calls[0].slice(0, 6)).toEqual(["X", "DAY", 1000, 2001, "mid", "capital"]);
  });

  it("gives up after the budget and reports partial", async () => {
    fetchRangeWithStatus.mockResolvedValue(res(3, true));
    let clock = 0;
    const now = () => (clock += 20_000);
    const out = await fetchFilled({ ...base, signal: new AbortController().signal, budgetMs: 30_000, now });
    expect(out.partial).toBe(true);
    expect(fetchRangeWithStatus.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("passes a degraded reason through", async () => {
    fetchRangeWithStatus.mockResolvedValueOnce(res(0, false, "broker unreachable (503)"));
    const out = await fetchFilled({ ...base, signal: new AbortController().signal });
    expect(out.degraded).toBe("broker unreachable (503)");
  });

  it("rejects when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    fetchRangeWithStatus.mockResolvedValue(res(3, false));
    await expect(fetchFilled({ ...base, signal: ac.signal })).rejects.toThrow();
  });
});

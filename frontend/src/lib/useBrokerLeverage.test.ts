// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const feed = vi.hoisted(() => ({ fetchMarketDetail: vi.fn() }));
vi.mock("./feed", () => feed);

import { clearBrokerLeverageCache, useBrokerLeverage } from "./useBrokerLeverage";

beforeEach(() => {
  vi.useFakeTimers();
  clearBrokerLeverageCache();
  feed.fetchMarketDetail.mockReset();
});
afterEach(() => vi.useRealTimers());

const flush = () => act(async () => {});

describe("useBrokerLeverage", () => {
  it("retries once when the broker has no figure yet (mt5-self cold start)", async () => {
    feed.fetchMarketDetail.mockResolvedValueOnce({}).mockResolvedValueOnce({ accountLeverage: 20 });
    const { result } = renderHook(() => useBrokerLeverage("GOLD", "mt5-self"));
    await flush();
    expect(result.current).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe(20);
    expect(feed.fetchMarketDetail).toHaveBeenCalledTimes(2);
  });

  it("keeps a null answer only briefly", async () => {
    feed.fetchMarketDetail.mockRejectedValue(new Error("429"));
    const a = renderHook(() => useBrokerLeverage("GOLD", "capital"));
    await flush();
    a.unmount();
    expect(feed.fetchMarketDetail).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31_000);
    feed.fetchMarketDetail.mockResolvedValue({ accountLeverage: 20 });
    const b = renderHook(() => useBrokerLeverage("GOLD", "capital"));
    await flush();
    expect(b.result.current).toBe(20);
    expect(feed.fetchMarketDetail).toHaveBeenCalledTimes(2);
  });

  it("keeps a real answer for the long TTL", async () => {
    feed.fetchMarketDetail.mockResolvedValue({ accountLeverage: 20 });
    renderHook(() => useBrokerLeverage("GOLD", "capital")).unmount();
    await flush();
    vi.advanceTimersByTime(60_000);
    const b = renderHook(() => useBrokerLeverage("GOLD", "capital"));
    await flush();
    expect(b.result.current).toBe(20);
    expect(feed.fetchMarketDetail).toHaveBeenCalledTimes(1);
  });
});

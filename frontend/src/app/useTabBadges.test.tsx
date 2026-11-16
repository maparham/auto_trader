// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { alertFired } from "../lib/signals";
import { installMemStorage } from "../lib/testMemStorage";
import type { ChartTab } from "../lib/persist";
import { useMarketClosedBadges, useUnseenAlertTabs } from "./useTabBadges";
import * as feed from "../lib/feed";

const tab = (id: string, epic: string) =>
  ({ id, cells: [{ id: `${id}.c`, symbol: { epic }, period: {}, scope: id }] }) as unknown as ChartTab;

beforeEach(() => installMemStorage());

afterEach(() => {
  vi.restoreAllMocks();
  delete (document as { visibilityState?: string }).visibilityState;
  alertFired.set(null);
});

describe("useUnseenAlertTabs", () => {
  it("re-syncs a badge the alert subscription finds in storage but not in state", () => {
    const home = tab("home", "B");
    const gold = tab("gold", "A");
    const gold2 = tab("gold2", "A");
    const tabs = [home, gold, gold2];
    const { result, rerender } = renderHook(({ active }) => useUnseenAlertTabs(tabs, active), {
      initialProps: { active: home },
    });

    act(() => alertFired.set({ epic: "A" }));
    expect([...result.current].sort()).toEqual(["gold", "gold2"]);

    // Visiting a tab that shows A marks it seen, but the storage write is
    // dropped (quota): state clears while storage still holds A.
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    rerender({ active: gold });
    expect([...result.current]).toEqual([]);
    vi.restoreAllMocks();

    // A second fire for A behind a hidden browser tab must bring the badge
    // back on the OTHER tab holding A, even though storage already had it.
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => alertFired.set({ epic: "A" }));
    expect([...result.current]).toEqual(["gold2"]);
  });
});

describe("useMarketClosedBadges", () => {
  afterEach(() => vi.useRealTimers());

  it("asks for every lead epic in one call and badges the closed ones", async () => {
    const spy = vi.spyOn(feed, "fetchMarketsStatus").mockResolvedValue({
      NVDA: { closed: true, nextOpen: "2099-01-01T00:00:00+00:00" },
      US100: { closed: false, nextOpen: null },
    });
    const tabs = [tab("a", "NVDA"), tab("b", "US100"), tab("c", "NVDA")];
    const { result } = renderHook(() => useMarketClosedBadges(tabs, "capital"));
    await act(async () => {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual(["NVDA", "US100"]);
    expect(result.current).toEqual({
      NVDA: { closed: true, nextOpen: "2099-01-01T00:00:00+00:00" },
      US100: { closed: false, nextOpen: null },
    });
  });

  it("retries soon when an epic's lookup failed", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(feed, "fetchMarketsStatus")
      .mockResolvedValueOnce({ NVDA: { closed: null, nextOpen: null, error: true } })
      .mockResolvedValueOnce({ NVDA: { closed: true, nextOpen: null } });
    const tabs = [tab("a", "NVDA")];
    const { result } = renderHook(() => useMarketClosedBadges(tabs, "capital"));
    await act(async () => {});
    expect(result.current.NVDA.closed).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.NVDA.closed).toBe(true);
  });

  it("does not retry fast for a broker that never reports open/closed", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(feed, "fetchMarketsStatus")
      .mockResolvedValue({ AAPL: { closed: null, nextOpen: null } });
    renderHook(() => useMarketClosedBadges([tab("a", "AAPL")], "yfinance"));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-checks a closed market right after its reopen time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T00:59:00Z"));
    const spy = vi
      .spyOn(feed, "fetchMarketsStatus")
      .mockResolvedValueOnce({ NVDA: { closed: true, nextOpen: "2026-11-16T01:00:00+00:00" } })
      .mockResolvedValueOnce({ NVDA: { closed: false, nextOpen: null } });
    const tabs = [tab("a", "NVDA")];
    const { result } = renderHook(() => useMarketClosedBadges(tabs, "capital"));
    await act(async () => {});
    expect(result.current.NVDA.closed).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(62_000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.NVDA.closed).toBe(false);
  });
});

// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/allAccounts", async (orig) => {
  const real = await orig<typeof import("../lib/allAccounts")>();
  return {
    ...real,
    fetchSnapshot: vi.fn(),
    loadHiddenAccounts: vi.fn(() => []),
    saveHiddenAccounts: vi.fn(),
  };
});

import { useAllAccounts, ALL_ACCOUNTS_OPEN_MS, ALL_ACCOUNTS_CLOSED_MS } from "./useAllAccounts";
import { fetchSnapshot, loadHiddenAccounts, saveHiddenAccounts } from "../lib/allAccounts";
import type { BrokerAccount, TradeView } from "../lib/trading";

const acct = (key: string): BrokerAccount => ({
  key,
  broker: key.split(":")[0],
  env: key.split(":")[1],
  isRealMoney: key.endsWith(":live"),
});
const ACCOUNTS = [acct("capital:paper"), acct("capital:demo"), acct("ig-live:live"), acct("mt5-self:live")];
const pos = (id: string): TradeView => ({
  kind: "position", id, epic: "US100", side: "buy", quantity: 1, priceLevel: 1,
  stop: null, takeProfit: null, upnl: null, openedAt: null, expiresAt: null, leverage: null, margin: null,
});

let docHidden = false;
const fetched = () => vi.mocked(fetchSnapshot).mock.calls.map((c) => [c[1], c[2]]);

beforeEach(() => {
  vi.useFakeTimers();
  docHidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => docHidden });
  vi.mocked(fetchSnapshot).mockReset();
  vi.mocked(fetchSnapshot).mockImplementation(async (_prev, account) => ({
    account, positions: [pos(`${account}-1`)], summary: null, error: null, fetchedAt: Date.now(),
  }));
  vi.mocked(loadHiddenAccounts).mockReturnValue([]);
  vi.mocked(saveHiddenAccounts).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const base = { accounts: ACCOUNTS, active: "capital:demo", activePositions: [] as TradeView[], activeSummary: null, open: false };

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useAllAccounts", () => {
  it("closed: fetches other accounts without summary at mount and every 2 min", async () => {
    renderHook(() => useAllAccounts(base));
    await flush();
    expect(fetched()).toEqual([["ig-live:live", false], ["mt5-self:live", false]]);
    await act(async () => { vi.advanceTimersByTime(ALL_ACCOUNTS_OPEN_MS); });
    expect(fetched()).toHaveLength(2);
    await act(async () => { vi.advanceTimersByTime(ALL_ACCOUNTS_CLOSED_MS - ALL_ACCOUNTS_OPEN_MS); });
    expect(fetched()).toHaveLength(4);
  });

  it("open: fetches with summary every 30 s", async () => {
    renderHook(() => useAllAccounts({ ...base, open: true }));
    await flush();
    expect(fetched()).toEqual([["ig-live:live", true], ["mt5-self:live", true]]);
    await act(async () => { vi.advanceTimersByTime(ALL_ACCOUNTS_OPEN_MS); });
    expect(fetched()).toHaveLength(4);
  });

  it("opening fetches at once", async () => {
    const { rerender } = renderHook((p) => useAllAccounts(p), { initialProps: base });
    await flush();
    vi.mocked(fetchSnapshot).mockClear();
    rerender({ ...base, open: true });
    await flush();
    expect(fetched()).toEqual([["ig-live:live", true], ["mt5-self:live", true]]);
  });

  it("never fetches the active account and shows the dock's own positions for it", async () => {
    const { result } = renderHook(() => useAllAccounts({ ...base, activePositions: [pos("A")] }));
    await flush();
    expect(fetched().map((c) => c[0])).not.toContain("capital:demo");
    expect(result.current.snaps["capital:demo"].positions?.map((p) => p.id)).toEqual(["A"]);
  });

  it("does not fetch hidden accounts and persists a hide", async () => {
    vi.mocked(loadHiddenAccounts).mockReturnValue(["mt5-self:live"]);
    const { result } = renderHook(() => useAllAccounts(base));
    await flush();
    expect(fetched()).toEqual([["ig-live:live", false]]);
    expect(result.current.hidden.map((a) => a.key)).toEqual(["mt5-self:live"]);
    act(() => result.current.setHidden("ig-live:live", true));
    expect(saveHiddenAccounts).toHaveBeenLastCalledWith(["mt5-self:live", "ig-live:live"]);
    vi.mocked(fetchSnapshot).mockClear();
    await act(async () => { vi.advanceTimersByTime(ALL_ACCOUNTS_CLOSED_MS); });
    expect(fetched()).toEqual([]);
  });

  it("pauses while the page is hidden and fetches once on becoming visible", async () => {
    docHidden = true;
    renderHook(() => useAllAccounts(base));
    await flush();
    await act(async () => { vi.advanceTimersByTime(ALL_ACCOUNTS_CLOSED_MS); });
    expect(fetched()).toEqual([]);
    docHidden = false;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(fetched()).toHaveLength(2);
  });

  it("does not refetch an account whose fetch is still pending", async () => {
    vi.mocked(fetchSnapshot).mockImplementation(async (_prev, account) =>
      account === "ig-live:live"
        ? new Promise(() => {})
        : { account, positions: [], summary: null, error: null, fetchedAt: Date.now() },
    );
    renderHook(() => useAllAccounts({ ...base, open: true }));
    await flush();
    await act(async () => { vi.advanceTimersByTime(ALL_ACCOUNTS_OPEN_MS); });
    const calls = fetched().map((c) => c[0]);
    expect(calls.filter((a) => a === "ig-live:live")).toHaveLength(1);
    expect(calls.filter((a) => a === "mt5-self:live")).toHaveLength(2);
  });

  it("follows a new active account", async () => {
    const { result, rerender } = renderHook((p) => useAllAccounts(p), { initialProps: base });
    await flush();
    expect(result.current.count).toBe(2);
    vi.mocked(fetchSnapshot).mockClear();
    rerender({ ...base, active: "ig-live:live" });
    await flush();
    expect(fetched().map((c) => c[0])).toEqual(["capital:demo", "mt5-self:live"]);
    expect(result.current.count).toBe(2); // capital:demo 1 + mt5 1, ig-live excluded
  });

  it("reports no accounts when only paper and data exist", () => {
    const { result } = renderHook(() =>
      useAllAccounts({ ...base, accounts: [acct("capital:paper")], active: "capital:paper" }),
    );
    expect(result.current.hasAccounts).toBe(false);
  });

  it("fetches nothing when disabled", async () => {
    renderHook(() => useAllAccounts({ ...base, open: true, enabled: false }));
    await flush();
    await act(async () => { vi.advanceTimersByTime(ALL_ACCOUNTS_CLOSED_MS); });
    expect(fetched()).toEqual([]);
  });

  it("fetches the summary after a positions-only fetch still running when the tab opens", async () => {
    let release!: () => void;
    vi.mocked(fetchSnapshot).mockImplementation((_prev, account) => {
      const s = { account, positions: [], summary: null, error: null, fetchedAt: Date.now() };
      return account === "ig-live:live" && vi.mocked(fetchSnapshot).mock.calls.length <= 2
        ? new Promise((r) => { release = () => r(s); })
        : Promise.resolve(s);
    });
    const { rerender } = renderHook((p) => useAllAccounts(p), { initialProps: base });
    await flush();
    rerender({ ...base, open: true });
    await flush();
    expect(fetched().filter((c) => c[0] === "ig-live:live")).toEqual([["ig-live:live", false]]);
    await act(async () => { release(); });
    await flush();
    expect(fetched().filter((c) => c[0] === "ig-live:live")).toEqual([
      ["ig-live:live", false],
      ["ig-live:live", true],
    ]);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("./http", async (orig) => ({
  ...(await orig<typeof import("./http")>()),
  apiFetch: (...a: unknown[]) => fetchMock(...a),
}));

import {
  fetchAccountHistory,
  subscribeHistory,
  subscribeMarkerHistory,
  selectHistoryTrade,
  setHistoryShowAll,
  HISTORY_POLL_MS,
  _resetHistoryForTests,
  type HistoryState,
  type MarkerHistory,
} from "./accountHistory";
import { BrokerBlockedError } from "./http";
import { noteHistoryAccounts, setTradesAccount } from "./trading";
import { tradesSignal } from "./signals";

function payload(dealId = "D1") {
  return {
    supported: true,
    since: 0,
    until: 1,
    trades: [{
      deal_id: dealId, epic: "TSLA", side: "buy", size: 1, entry_price: 400, exit_price: 430,
      opened_at: null, closed_at: 5_000, close_source: "TP", pnl: 12.5, currency: "EUR",
    }],
    ledger: [],
    totals: { realized: 12.5, funding: 0, deposits: 0, withdrawals: 0, currency: "EUR" },
  };
}
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
// setTradesAccount also refetches positions/orders through apiFetch; count only history calls.
const historyCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/history"));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  fetchMock.mockReset();
  _resetHistoryForTests();
  noteHistoryAccounts([
    { key: "capital:demo", broker: "capital", env: "demo", isRealMoney: false, history: true },
    { key: "capital:paper", broker: "capital", env: "paper", isRealMoney: false, history: false },
  ]);
});
afterEach(() => vi.useRealTimers());

describe("subscribeHistory", () => {
  it("loads, maps snake_case to the view shape and ms times", async () => {
    fetchMock.mockReturnValue(ok(payload()));
    const seen: HistoryState[] = [];
    const off = subscribeHistory("capital:demo", 30, (s) => seen.push(s));
    await flush();
    const last = seen.at(-1)!;
    expect(last.loading).toBe(false);
    expect(last.data!.trades[0]).toMatchObject({ dealId: "D1", entry: 400, exit: 430, closedAt: 5_000, openedAt: null });
    expect(String(historyCalls()[0][0])).toContain("/api/history?account=capital%3Ademo&days=30");
    expect(last.data!.ledgerTruncated).toBe(false);
    off();
  });

  it("maps the ledger truncation flag", async () => {
    fetchMock.mockReturnValue(ok({ ...payload(), ledger_truncated: true }));
    let last: HistoryState | null = null;
    const off = subscribeHistory("capital:demo", 30, (s) => (last = s));
    await flush();
    expect(last!.data!.ledgerTruncated).toBe(true);
    off();
  });

  it("surfaces an error with the server detail", async () => {
    fetchMock.mockReturnValue(Promise.resolve(new Response(JSON.stringify({ detail: "history failed: boom" }), { status: 502 })));
    let last: HistoryState | null = null;
    const off = subscribeHistory("capital:demo", 30, (s) => (last = s));
    await flush();
    expect(last!.error).toContain("boom");
    off();
  });

  it("refetches on the poll timer while subscribed, and stops after", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    const off = subscribeHistory("capital:demo", 7, () => {});
    await flush();
    vi.advanceTimersByTime(HISTORY_POLL_MS);
    await flush();
    expect(historyCalls()).toHaveLength(2);
    off();
    vi.advanceTimersByTime(HISTORY_POLL_MS * 3);
    expect(historyCalls()).toHaveLength(2);
  });

  it("refetches when a position disappears from the trades book", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    setTradesAccount("capital:demo");
    const off = subscribeHistory("capital:demo", 30, () => {});
    await flush();
    const pos = { kind: "position", id: "D1", epic: "TSLA", side: "buy", quantity: 1, priceLevel: 400,
      stop: null, takeProfit: null, upnl: null, openedAt: 1, expiresAt: null, leverage: null, margin: null } as const;
    tradesSignal.set([pos]);
    tradesSignal.set([]);
    await flush();
    expect(historyCalls()).toHaveLength(2);
    off();
  });

  it("refetches when the tab regains visibility while subscribed, not once the last subscriber leaves", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    const off = subscribeHistory("capital:demo", 30, () => {});
    await flush();
    expect(historyCalls()).toHaveLength(1);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(historyCalls()).toHaveLength(2);
    off();
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(historyCalls()).toHaveLength(2); // listener torn down: no subscribers left
  });

  it("does not refetch on visibilitychange while the tab is hidden", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    const off = subscribeHistory("capital:demo", 30, () => {});
    await flush();
    expect(historyCalls()).toHaveLength(1);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(historyCalls()).toHaveLength(1);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    off();
  });

  it("throws BrokerBlockedError (not a plain Error) when the response is marked broker-blocked", async () => {
    fetchMock.mockReturnValue(
      Promise.resolve(new Response(JSON.stringify({ detail: "broker blocked" }), {
        status: 503,
        headers: { "X-Broker-Blocked": "1" },
      })),
    );
    await expect(fetchAccountHistory("capital:demo", 30)).rejects.toBeInstanceOf(BrokerBlockedError);
  });

  it("keys state by account, so a late response never lands on another account", async () => {
    let resolveDemo!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolveDemo = r)));
    let demoState: HistoryState | null = null;
    const offDemo = subscribeHistory("capital:demo", 30, (s) => (demoState = s));
    offDemo();
    fetchMock.mockReturnValueOnce(ok({ supported: false }));
    let paperState: HistoryState | null = null;
    const offPaper = subscribeHistory("capital:paper", 30, (s) => (paperState = s));
    resolveDemo(new Response(JSON.stringify(payload()), { status: 200 }));
    await flush();
    expect(paperState!.data).toBeNull();
    expect(demoState!.data).toBeNull(); // unsubscribed before it landed: no delivery
    offPaper();
  });
});

describe("subscribeMarkerHistory", () => {
  it("follows the trades account: inactive without history, 30d trades with Show all on", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    setHistoryShowAll(true);
    setTradesAccount("capital:paper");
    const seen: MarkerHistory[] = [];
    const off = subscribeMarkerHistory((h) => seen.push(h));
    expect(seen.at(-1)).toEqual({ active: false, trades: [] });
    setTradesAccount("capital:demo");
    await flush();
    expect(seen.at(-1)!.active).toBe(true);
    expect(seen.at(-1)!.trades.map((t) => t.dealId)).toEqual(["D1"]);
    expect(String(historyCalls().at(-1)![0])).toContain("days=30");
    off();
  });

  it("with Show all off draws only the selected trade, and fetches nothing", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    setTradesAccount("capital:demo");
    const before = historyCalls().length;
    const seen: MarkerHistory[] = [];
    const off = subscribeMarkerHistory((h) => seen.push(h));
    await flush();
    // Active (journal exits stay suppressed) but empty.
    expect(seen.at(-1)).toEqual({ active: true, trades: [] });
    const picked = { dealId: "OLD", epic: "TSLA", side: "buy" as const, size: 1, entry: 1, exit: 2,
      openedAt: 1, closedAt: 2, closeSource: "TP", pnl: 1, currency: "EUR" };
    selectHistoryTrade("capital:demo", picked);
    expect(seen.at(-1)!.trades.map((t) => t.dealId)).toEqual(["OLD"]);
    // Another account's pick does not leak onto this chart.
    selectHistoryTrade("capital:demo", null);
    selectHistoryTrade("capital-live:live", picked);
    expect(seen.at(-1)!.trades).toEqual([]);
    expect(historyCalls().length).toBe(before);
    off();
  });

  it("with Show all on keeps a selected trade older than the 30d window", async () => {
    fetchMock.mockImplementation(() => ok(payload()));
    setTradesAccount("capital:demo");
    const picked = { dealId: "OLD", epic: "TSLA", side: "buy" as const, size: 1, entry: 1, exit: 2,
      openedAt: 1, closedAt: 2, closeSource: "TP", pnl: 1, currency: "EUR" };
    selectHistoryTrade("capital:demo", picked);
    const seen: MarkerHistory[] = [];
    const off = subscribeMarkerHistory((h) => seen.push(h));
    setHistoryShowAll(true);
    await flush();
    expect(seen.at(-1)!.trades.map((t) => t.dealId).sort()).toEqual(["D1", "OLD"]);
    setHistoryShowAll(false);
    expect(seen.at(-1)!.trades.map((t) => t.dealId)).toEqual(["OLD"]);
    off();
  });
});

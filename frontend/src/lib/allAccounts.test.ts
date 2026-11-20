import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./trading", async (orig) => {
  const real = await orig<typeof import("./trading")>();
  return {
    ...real,
    fetchOpenPositions: vi.fn(),
    fetchAccountSummary: vi.fn(),
  };
});

import {
  dealingAccounts,
  fetchSnapshot,
  loadHiddenAccounts,
  orderSections,
  otherOpenCount,
  saveHiddenAccounts,
  sectionFigures,
  visibleAndHidden,
  waitForTrade,
  type AccountSnapshot,
} from "./allAccounts";
import {
  fetchAccountSummary,
  fetchOpenPositions,
  tradesAccountSignal,
  type AccountSummary,
  type BrokerAccount,
  type TradeView,
} from "./trading";
import { tradesSignal } from "./signals";
import { accountStats } from "./accountStats";
import type { TradingSettings } from "../theme";

const acct = (key: string, extra: Partial<BrokerAccount> = {}): BrokerAccount => ({
  key,
  broker: key.split(":")[0],
  env: key.split(":")[1],
  isRealMoney: key.endsWith(":live"),
  ...extra,
});

const pos = (id: string, extra: Partial<TradeView> = {}): TradeView => ({
  kind: "position",
  id,
  epic: "US100",
  side: "buy",
  quantity: 1,
  priceLevel: 100,
  stop: null,
  takeProfit: null,
  upnl: null,
  openedAt: null,
  expiresAt: null,
  leverage: null,
  margin: null,
  mark: null,
  ...extra,
});

const snap = (account: string, extra: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  account,
  positions: null,
  summary: null,
  error: null,
  fetchedAt: null,
  ...extra,
});

const trading = { defaultLeverage: 20, accountBalance: 10000 } as TradingSettings;

describe("dealingAccounts", () => {
  it("drops paper and data-only accounts, keeps order", () => {
    const out = dealingAccounts([
      acct("capital:paper"),
      acct("capital:demo"),
      acct("dukascopy:data", { dataOnly: true }),
      acct("ig-live:live"),
    ]);
    expect(out.map((a) => a.key)).toEqual(["capital:demo", "ig-live:live"]);
  });
});

describe("visibleAndHidden", () => {
  it("splits by the hidden list and ignores unknown ids", () => {
    const { visible, hidden } = visibleAndHidden(
      [acct("capital:demo"), acct("ig-live:live")],
      ["ig-live:live", "gone:live"],
    );
    expect(visible.map((a) => a.key)).toEqual(["capital:demo"]);
    expect(hidden.map((a) => a.key)).toEqual(["ig-live:live"]);
  });
});

describe("otherOpenCount", () => {
  const visible = [acct("capital:demo"), acct("ig-live:live"), acct("mt5-self:live")];
  it("is null until another account has been tried", () => {
    expect(otherOpenCount({}, visible, "capital:demo")).toBeNull();
  });
  it("sums the other accounts and skips the active one", () => {
    const snaps = {
      "capital:demo": snap("capital:demo", { positions: [pos("a")], fetchedAt: 1 }),
      "ig-live:live": snap("ig-live:live", { positions: [pos("b"), pos("c")], fetchedAt: 1 }),
      "mt5-self:live": snap("mt5-self:live", { error: "down" }),
    };
    expect(otherOpenCount(snaps, visible, "capital:demo")).toBe(2);
  });
  it("still counts an errored account's last positions", () => {
    const snaps = {
      "ig-live:live": snap("ig-live:live", { positions: [pos("b")], error: "down", fetchedAt: 1 }),
    };
    expect(otherOpenCount(snaps, visible, "capital:demo")).toBe(1);
  });
});

describe("orderSections", () => {
  it("puts accounts with positions first, the active one first in its group", () => {
    const visible = [acct("capital:demo"), acct("ig-demo:demo"), acct("ig-live:live"), acct("mt5-self:live")];
    const snaps = {
      "ig-live:live": snap("ig-live:live", { positions: [pos("b")] }),
      "mt5-self:live": snap("mt5-self:live", { positions: [pos("c")] }),
      "ig-demo:demo": snap("ig-demo:demo", { positions: [] }),
    };
    expect(orderSections(visible, snaps, "mt5-self:live").map((a) => a.key)).toEqual([
      "mt5-self:live",
      "ig-live:live",
      "capital:demo",
      "ig-demo:demo",
    ]);
    expect(orderSections(visible, snaps, "ig-demo:demo").map((a) => a.key)).toEqual([
      "ig-live:live",
      "mt5-self:live",
      "ig-demo:demo",
      "capital:demo",
    ]);
  });
});

describe("sectionFigures", () => {
  it("sums P&L only when there is no summary", () => {
    const f = sectionFigures(
      snap("ig-live:live", { positions: [pos("a", { upnl: 5 }), pos("b", { upnl: null }), pos("c", { upnl: -2 })] }),
      acct("ig-live:live"),
      trading,
    );
    expect(f).toEqual({ pnl: 3, equity: null, marginLevel: null, currency: null });
  });
  it("matches accountStats with no orders when there is a summary", () => {
    const summary: AccountSummary = {
      balance: 1000,
      available: 800,
      deposit: null,
      profitLoss: null,
      currency: "EUR",
    };
    const positions = [pos("a", { upnl: 10 })];
    const a = acct("capital-live:live");
    const f = sectionFigures(snap(a.key, { positions, summary }), a, trading);
    const s = accountStats({
      positions,
      orders: [],
      summary,
      trading,
      broker: a.broker,
      isLive: a.isRealMoney,
      livePrice: () => undefined,
    });
    expect(f).toEqual({ pnl: s.pnl, equity: s.equity, marginLevel: s.marginLevel, currency: "EUR" });
  });
});

describe("fetchSnapshot", () => {
  beforeEach(() => {
    vi.mocked(fetchOpenPositions).mockReset();
    vi.mocked(fetchAccountSummary).mockReset();
  });
  it("fills positions and summary and clears the error", async () => {
    vi.mocked(fetchOpenPositions).mockResolvedValue([pos("a")]);
    const summary = { balance: 1, available: 1, deposit: null, profitLoss: null, currency: "USD" };
    vi.mocked(fetchAccountSummary).mockResolvedValue(summary);
    const out = await fetchSnapshot(snap("ig-live:live", { error: "old" }), "ig-live:live", true);
    expect(out.positions).toHaveLength(1);
    expect(out.summary).toEqual(summary);
    expect(out.error).toBeNull();
    expect(out.fetchedAt).not.toBeNull();
  });
  it("keeps the last positions and records the error on failure", async () => {
    vi.mocked(fetchOpenPositions).mockRejectedValue(new Error("positions failed (502)"));
    vi.mocked(fetchAccountSummary).mockResolvedValue(null);
    const prev = snap("ig-live:live", { positions: [pos("a")], fetchedAt: 5 });
    const out = await fetchSnapshot(prev, "ig-live:live", true);
    expect(out.positions).toEqual(prev.positions);
    expect(out.error).toBe("positions failed (502)");
    expect(out.fetchedAt).toBe(5);
  });
  it("skips the summary when asked", async () => {
    vi.mocked(fetchOpenPositions).mockResolvedValue([]);
    const summary = { balance: 1, available: 1, deposit: null, profitLoss: null, currency: "USD" };
    const out = await fetchSnapshot(snap("ig-live:live", { summary }), "ig-live:live", false);
    expect(fetchAccountSummary).not.toHaveBeenCalled();
    expect(out.summary).toEqual(summary);
  });
});

describe("hidden accounts storage", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("returns [] when missing or corrupt", () => {
    expect(loadHiddenAccounts()).toEqual([]);
    localStorage.setItem("auto-trader.allAccounts.hidden", "{bad");
    expect(loadHiddenAccounts()).toEqual([]);
  });
  it("round-trips", () => {
    saveHiddenAccounts(["ig-live:live"]);
    expect(loadHiddenAccounts()).toEqual(["ig-live:live"]);
  });
});

describe("waitForTrade", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tradesAccountSignal.set("capital:paper");
    tradesSignal.set([]);
  });
  afterEach(() => vi.useRealTimers());

  it("resolves at once when the trade is already there", async () => {
    tradesAccountSignal.set("ig-live:live");
    tradesSignal.set([pos("D1")]);
    await expect(waitForTrade("ig-live:live", "D1")).resolves.toBe("D1");
  });
  it("resolves when the trade arrives later", async () => {
    tradesAccountSignal.set("ig-live:live");
    const p = waitForTrade("ig-live:live", "D1");
    tradesSignal.set([pos("D1")]);
    await expect(p).resolves.toBe("D1");
  });
  it("waits while the feed still points at the old account (signal flips later)", async () => {
    const p = waitForTrade("capital:demo", "D1");
    tradesSignal.set([pos("D1")]); // old account's feed holding the same id: ignored
    tradesAccountSignal.set("capital:demo");
    tradesSignal.set([]);
    tradesSignal.set([pos("D1")]);
    await expect(p).resolves.toBe("D1");
  });
  it("gives up after 15 s", async () => {
    tradesAccountSignal.set("ig-live:live");
    const p = waitForTrade("ig-live:live", "D1");
    vi.advanceTimersByTime(15_000);
    await expect(p).resolves.toBeNull();
  });
  it("gives up when the feed moves to a third account", async () => {
    const p = waitForTrade("ig-live:live", "D1");
    tradesAccountSignal.set("mt5-self:live");
    await expect(p).resolves.toBeNull();
  });
  it("gives up when the feed leaves the account after reaching it", async () => {
    const p = waitForTrade("ig-live:live", "D1");
    tradesAccountSignal.set("ig-live:live");
    tradesAccountSignal.set("capital:paper");
    await expect(p).resolves.toBeNull();
  });
});

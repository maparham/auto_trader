import { describe, expect, it } from "vitest";
import { accountStats, enrichTrade } from "./accountStats";
import { DEFAULT_SETTINGS } from "../theme";
import type { TradeView } from "./trading";

const pos = (o: Partial<TradeView>): TradeView => ({
  kind: "position",
  id: "p",
  epic: "US100",
  side: "buy",
  quantity: 2,
  priceLevel: 100,
  stop: null,
  takeProfit: null,
  upnl: 10,
  openedAt: null,
  expiresAt: null,
  leverage: null,
  margin: null,
  ...o,
});

const trading = { ...DEFAULT_SETTINGS.trading, accountBalance: 1000, defaultLeverage: 10 };

describe("accountStats", () => {
  it("paper: marks P&L to the live price and derives margin from leverage", () => {
    const s = accountStats({
      positions: [pos({})],
      orders: [],
      summary: null,
      trading,
      broker: "capital",
      isLive: false,
      livePrice: () => 105,
    });
    expect(s.pnl).toBe(10); // 2 × (105 − 100)
    expect(s.accountMargin).toBe(20); // 200 notional ÷ 10
    expect(s.available).toBe(990); // 1000 + 10 − 20
    expect(s.equity).toBe(1010);
    expect(s.noBrokerData).toBe(false);
  });

  it("live Capital: the balance already includes P&L, and per-position margin sums", () => {
    const s = accountStats({
      positions: [pos({ upnl: 50, margin: 30 }), pos({ id: "q", upnl: -5, margin: 20 })],
      orders: [],
      summary: { balance: 2000, available: 1950, deposit: null, profitLoss: 45, currency: "EUR" },
      trading,
      broker: "capital",
      isLive: true,
      livePrice: () => 999, // ignored on a live account
    });
    expect(s.pnl).toBe(45);
    expect(s.accountMargin).toBe(50);
    expect(s.equity).toBe(2000); // available + margin
    expect(s.marginLevel).toBeCloseTo(4000);
  });

  it("live with no summary yet blanks the broker-derived stats", () => {
    const s = accountStats({ positions: [], orders: [], summary: null, trading, broker: "ig", isLive: true });
    expect(s.noBrokerData).toBe(true);
  });
});

describe("enrichTrade", () => {
  it("paper: backs the last price out of the marked P&L", () => {
    const s = accountStats({
      positions: [],
      orders: [],
      summary: null,
      trading,
      broker: "capital",
      isLive: false,
      livePrice: () => 110,
    });
    const r = enrichTrade(pos({}), s, false, () => 110);
    expect(r.upnl).toBe(20);
    expect(r.last).toBe(110);
    expect(r.pnlPct).toBe(10);
    expect(r.leverage).toBe(10);
    expect(r.margin).toBe(20);
  });

  it("live: uses the stream or the broker mark for last, and leaves orders blank", () => {
    const s = accountStats({ positions: [], orders: [], summary: null, trading, broker: "capital", isLive: true });
    const r = enrichTrade(pos({ side: "sell", mark: 90, leverage: 5, margin: 40 }), s, true, () => undefined);
    expect(r.last).toBe(90);
    expect(r.pnlPct).toBe(10); // short, price fell 10%
    expect(r.leverage).toBe(5);
    expect(r.margin).toBe(40);
    const o = enrichTrade(pos({ kind: "order", upnl: null }), s, true);
    expect(o.last).toBeNull();
    expect(o.pnlPct).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import {
  advanceBar,
  canPlaceAt,
  cancelOrder,
  cellTradeBook,
  isReplayTradeId,
  closeAt,
  editLevels,
  emptyLedger,
  placeLimit,
  placeMarket,
  shouldAdvanceAt,
  summarize,
  toTradeViews,
} from "./replayLedger";

const T = Date.UTC(2026, 2, 2, 12);
const HOUR = 3_600_000;
const candle = (o: number, h: number, l: number, c: number, ts = T): KLineData => ({
  timestamp: ts,
  open: o,
  high: h,
  low: l,
  close: c,
});

describe("market orders", () => {
  it("fills instantly at the price the user is looking at", () => {
    const s = placeMarket(emptyLedger(), {
      side: "buy", quantity: 2, price: 100, stop: 95, takeProfit: 110, atMs: T,
    });
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]).toMatchObject({ side: "buy", quantity: 2, entry: 100, stop: 95 });
  });

  it("closes at a given price and books the P&L", () => {
    let s = placeMarket(emptyLedger(), { side: "buy", quantity: 2, price: 100, stop: null, takeProfit: null, atMs: T });
    s = closeAt(s, s.positions[0].id, 105, T + HOUR);
    expect(s.positions).toHaveLength(0);
    expect(s.closed[0]).toMatchObject({ pnl: 10, reason: "manual" });
  });

  it("books a short's P&L in the opposite direction", () => {
    let s = placeMarket(emptyLedger(), { side: "sell", quantity: 1, price: 100, stop: null, takeProfit: null, atMs: T });
    s = closeAt(s, s.positions[0].id, 90, T + HOUR);
    expect(s.closed[0].pnl).toBe(10);
  });
});

describe("limit orders", () => {
  it("fills a buy limit at the limit when the bar's low crosses it", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 99, stop: null, takeProfit: null, atMs: T });
    s = advanceBar(s, candle(100, 101, 98, 100), T + HOUR);
    expect(s.orders).toHaveLength(0);
    expect(s.positions[0].entry).toBe(99);
  });

  it("fills at the OPEN when the market gapped through the limit (never worse)", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 99, stop: null, takeProfit: null, atMs: T });
    s = advanceBar(s, candle(97, 98, 96, 97), T + HOUR);
    expect(s.positions[0].entry).toBe(97);
  });

  it("leaves an untouched limit resting", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 90, stop: null, takeProfit: null, atMs: T });
    s = advanceBar(s, candle(100, 101, 98, 100), T + HOUR);
    expect(s.orders).toHaveLength(1);
    expect(s.positions).toHaveLength(0);
  });

  it("cancels a resting order", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 90, stop: null, takeProfit: null, atMs: T });
    s = cancelOrder(s, s.orders[0].id);
    expect(s.orders).toHaveLength(0);
  });
});

describe("intrabar exits (mirrors backend engine/backtest.py::_intrabar_exit)", () => {
  const long = () =>
    placeMarket(emptyLedger(), { side: "buy", quantity: 1, price: 100, stop: 95, takeProfit: 110, atMs: T });

  it("resolves a gap through the target at the open, filling at the target", () => {
    const s = advanceBar(long(), candle(112, 115, 111, 114), T + HOUR);
    expect(s.closed[0]).toMatchObject({ exit: 110, reason: "target" });
  });

  it("gives the STOP priority when one bar spans both levels", () => {
    const s = advanceBar(long(), candle(100, 111, 94, 105), T + HOUR);
    expect(s.closed[0]).toMatchObject({ exit: 95, reason: "stop" });
  });

  it("fills a gapped-through stop at the open (pessimistic)", () => {
    const s = advanceBar(long(), candle(90, 92, 88, 91), T + HOUR);
    expect(s.closed[0]).toMatchObject({ exit: 90, reason: "stop" });
  });

  it("takes the target when only the high reaches it", () => {
    const s = advanceBar(long(), candle(100, 111, 99, 108), T + HOUR);
    expect(s.closed[0]).toMatchObject({ exit: 110, reason: "target" });
  });

  it("mirrors the rules for a short", () => {
    const short = placeMarket(emptyLedger(), {
      side: "sell", quantity: 1, price: 100, stop: 105, takeProfit: 90, atMs: T,
    });
    expect(advanceBar(short, candle(88, 89, 87, 88), T + HOUR).closed[0]).toMatchObject({
      exit: 90, reason: "target",
    });
    expect(advanceBar(short, candle(100, 106, 89, 95), T + HOUR).closed[0]).toMatchObject({
      exit: 105, reason: "stop",
    });
  });

  it("lets a position opened by a limit fill stop out on the SAME bar", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 99, stop: 97, takeProfit: null, atMs: T });
    s = advanceBar(s, candle(100, 101, 96, 98), T + HOUR);
    expect(s.positions).toHaveLength(0);
    expect(s.closed[0]).toMatchObject({ entry: 99, exit: 97, reason: "stop" });
  });

  it("stamps the exit at the bar's close time", () => {
    const s = advanceBar(long(), candle(100, 111, 99, 108), T + HOUR);
    expect(s.closed[0].exitMs).toBe(T + HOUR);
  });

  it("prefers the gap-through-target-at-open over a stop the same bar also crossed", () => {
    // Under _intrabar_exit's elif chain, branch 1 (open >= target) pre-empts the
    // stop test entirely. A stop-first implementation would exit at 95 instead.
    const s = advanceBar(long(), candle(112, 115, 94, 100), T + HOUR);
    expect(s.closed[0]).toMatchObject({ exit: 110, reason: "target" });
  });

  it("fills a short's gapped-through stop at the open, not at the stop level", () => {
    // max(open, stop): a gap UP through a short's stop fills worse than the stop.
    const short = placeMarket(emptyLedger(), {
      side: "sell", quantity: 1, price: 100, stop: 105, takeProfit: 90, atMs: T,
    });
    const s = advanceBar(short, candle(110, 112, 108, 111), T + HOUR);
    expect(s.closed[0]).toMatchObject({ exit: 110, reason: "stop" });
  });
});

describe("editLevels", () => {
  it("moves a position's stop and target", () => {
    let s = placeMarket(emptyLedger(), { side: "buy", quantity: 1, price: 100, stop: 95, takeProfit: null, atMs: T });
    s = editLevels(s, s.positions[0].id, { stop: 98, takeProfit: 105 });
    expect(s.positions[0]).toMatchObject({ stop: 98, takeProfit: 105 });
  });

  it("moves a resting order's limit price", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 90, stop: null, takeProfit: null, atMs: T });
    s = editLevels(s, s.orders[0].id, { price: 92 });
    expect(s.orders[0].limit).toBe(92);
  });
});

describe("toTradeViews / summarize", () => {
  it("projects positions and orders into the shape the chart lines consume", () => {
    let s = placeMarket(emptyLedger(), { side: "buy", quantity: 2, price: 100, stop: 95, takeProfit: null, atMs: T });
    s = placeLimit(s, { side: "sell", quantity: 1, limit: 120, stop: null, takeProfit: null, atMs: T });
    const views = toTradeViews(s, "US100", 103);
    expect(views.map((v) => v.kind)).toEqual(["position", "order"]);
    expect(views[0]).toMatchObject({ epic: "US100", side: "buy", priceLevel: 100, upnl: 6 });
    expect(views[1]).toMatchObject({ kind: "order", priceLevel: 120, upnl: null });
  });

  it("summarizes the session", () => {
    let s = placeMarket(emptyLedger(), { side: "buy", quantity: 1, price: 100, stop: null, takeProfit: null, atMs: T });
    s = closeAt(s, s.positions[0].id, 110, T + HOUR);
    s = placeMarket(s, { side: "buy", quantity: 1, price: 100, stop: null, takeProfit: null, atMs: T });
    s = closeAt(s, s.positions[0].id, 96, T + 2 * HOUR);
    expect(summarize(s)).toMatchObject({ trades: 2, wins: 1, winRate: 0.5, netPnl: 6, openPositions: 0 });
  });

  it("gates trading and bar advance on the high-water mark", () => {
    // The rewind-and-cheat loophole: a rewound cursor may neither place orders
    // nor re-run the bars it already played (which would re-fill filled orders).
    expect(canPlaceAt(100, 100)).toBe(true);
    expect(canPlaceAt(99, 100)).toBe(false);
    expect(shouldAdvanceAt(101, 100)).toBe(true);
    expect(shouldAdvanceAt(100, 100)).toBe(false);
  });

  it("mints stable ids without crypto, so a persisted session resumes intact", () => {
    const s = placeMarket(emptyLedger(), { side: "buy", quantity: 1, price: 100, stop: null, takeProfit: null, atMs: T });
    expect(s.positions[0].id).toBe("rp1");
    expect(s.seq).toBe(1);
  });
});

describe("cellTradeBook", () => {
  it("keeps a live cell on the account book", () => {
    expect(cellTradeBook(false)).toEqual({ acceptAccountTrades: true, dealing: "account" });
  });

  it("cuts a REPLAYING cell off from the account, in both directions at once", () => {
    // Reading: the account poll must not write the cell's drawn book (its real
    // positions sit at today's levels, on a chart that hides today).
    // Writing: the pills must deal into the ledger, never the broker.
    expect(cellTradeBook(true)).toEqual({ acceptAccountTrades: false, dealing: "ledger" });
  });
});

describe("isReplayTradeId", () => {
  it("recognises the ids placeMarket / placeLimit mint", () => {
    const pos = placeMarket(emptyLedger(), { side: "buy", quantity: 1, price: 100, stop: null, takeProfit: null, atMs: T });
    expect(isReplayTradeId(pos.positions[0].id)).toBe(true);
    const ord = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 99, stop: null, takeProfit: null, atMs: T });
    expect(isReplayTradeId(ord.orders[0].id)).toBe(true);
  });

  it("rejects a broker deal id", () => {
    expect(isReplayTradeId("DIAAAAAB1234567")).toBe(false);
    expect(isReplayTradeId("006ab3f2-...")).toBe(false);
    expect(isReplayTradeId("rp")).toBe(false);
    expect(isReplayTradeId("rp1x")).toBe(false);
  });
});

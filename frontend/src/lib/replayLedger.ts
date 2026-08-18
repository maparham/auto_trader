// The per-session trading book for chart replay: pure, bar-driven, and entirely
// separate from the real paper journal.
//
// Why not the paper executor: that one lives in the BACKEND
// (auto_trader/brokers/paper_exec.py), prices fills from the live tick snapshot,
// and books into the real paper account. A replay fill must price off the bar
// the user is looking at, in the past, in a book nobody else can see.
//
// The intrabar convention is copied verbatim from the BACKTESTER
// (backend/auto_trader/engine/backtest.py::_intrabar_exit) so a replay trade and
// a revealed strategy trade on the same bar resolve identically:
//   1. a gap through the target at the open exits AT the target,
//   2. otherwise the STOP wins when one bar's range spans both (risk first),
//      filling at min(open, stop) for a long — the pessimistic side,
//   3. otherwise the target when the extreme reaches it.
// A position opened on a bar may also exit on that bar.
//
// No cost model: fills use raw bar prices (the chart's priceSide already selects
// bid/mid/ask candles). The report card says so.
import type { KLineData } from "klinecharts";
import type { OrderSide, TradeView } from "./trading";

export interface ReplayOrder {
  id: string;
  side: OrderSide;
  quantity: number;
  limit: number;
  stop: number | null;
  takeProfit: number | null;
  placedMs: number;
}

export interface ReplayPosition {
  id: string;
  side: OrderSide;
  quantity: number;
  entry: number;
  stop: number | null;
  takeProfit: number | null;
  openedMs: number;
}

export interface ReplayClosedTrade {
  side: OrderSide;
  quantity: number;
  entry: number;
  exit: number;
  entryMs: number;
  exitMs: number;
  pnl: number;
  reason: "stop" | "target" | "manual";
}

export interface ReplayLedgerState {
  orders: ReplayOrder[];
  positions: ReplayPosition[];
  closed: ReplayClosedTrade[];
  /** Monotonic id counter. Deliberately NOT crypto.randomUUID: ids must survive
   * a JSON round-trip through the persisted session and stay reproducible in tests. */
  seq: number;
}

export function emptyLedger(): ReplayLedgerState {
  return { orders: [], positions: [], closed: [], seq: 0 };
}

const pnlOf = (side: OrderSide, entry: number, exit: number, qty: number): number =>
  (side === "buy" ? exit - entry : entry - exit) * qty;

export function placeMarket(
  s: ReplayLedgerState,
  a: {
    side: OrderSide;
    quantity: number;
    price: number;
    stop: number | null;
    takeProfit: number | null;
    atMs: number;
  },
): ReplayLedgerState {
  const seq = s.seq + 1;
  return {
    ...s,
    seq,
    positions: [
      ...s.positions,
      {
        id: `rp${seq}`,
        side: a.side,
        quantity: a.quantity,
        entry: a.price,
        stop: a.stop,
        takeProfit: a.takeProfit,
        openedMs: a.atMs,
      },
    ],
  };
}

export function placeLimit(
  s: ReplayLedgerState,
  a: {
    side: OrderSide;
    quantity: number;
    limit: number;
    stop: number | null;
    takeProfit: number | null;
    atMs: number;
  },
): ReplayLedgerState {
  const seq = s.seq + 1;
  return {
    ...s,
    seq,
    orders: [
      ...s.orders,
      {
        id: `ro${seq}`,
        side: a.side,
        quantity: a.quantity,
        limit: a.limit,
        stop: a.stop,
        takeProfit: a.takeProfit,
        placedMs: a.atMs,
      },
    ],
  };
}

export function cancelOrder(s: ReplayLedgerState, id: string): ReplayLedgerState {
  const filtered = s.orders.filter((o) => o.id !== id);
  if (filtered.length === s.orders.length) return s;
  return { ...s, orders: filtered };
}

export function closeAt(
  s: ReplayLedgerState,
  id: string,
  price: number,
  atMs: number,
): ReplayLedgerState {
  const p = s.positions.find((x) => x.id === id);
  if (!p) return s;
  return {
    ...s,
    positions: s.positions.filter((x) => x.id !== id),
    closed: [
      ...s.closed,
      {
        side: p.side,
        quantity: p.quantity,
        entry: p.entry,
        exit: price,
        entryMs: p.openedMs,
        exitMs: atMs,
        pnl: pnlOf(p.side, p.entry, price, p.quantity),
        reason: "manual",
      },
    ],
  };
}

/** Apply dragged/edited levels. `price` moves a RESTING order's limit (a filled
 * position's entry is history); `stop`/`takeProfit` apply to either. Undefined
 * means "unchanged"; null means "removed" (e.g., `{ stop: null }` clears the stop).
 * `price` is applied only to orders, checked against null since `ReplayOrder.limit`
 * is always a number. Returns `s` unchanged if the id matches nothing. */
export function editLevels(
  s: ReplayLedgerState,
  id: string,
  e: { price?: number | null; stop?: number | null; takeProfit?: number | null },
): ReplayLedgerState {
  const patch = <T extends { stop: number | null; takeProfit: number | null }>(t: T): T => ({
    ...t,
    stop: e.stop !== undefined ? e.stop : t.stop,
    takeProfit: e.takeProfit !== undefined ? e.takeProfit : t.takeProfit,
  });
  const orders = s.orders.map((o) =>
    o.id === id ? { ...patch(o), limit: e.price != null ? e.price : o.limit } : o,
  );
  const positions = s.positions.map((p) => (p.id === id ? patch(p) : p));
  if (orders === s.orders && positions === s.positions) return s;
  return { ...s, orders, positions };
}

/** Advance the book over one newly revealed bar: resting limits fill first, then
 * every open position (including one just filled) is tested for stop/target.
 * `closeMs` is the bar's close — the instant every fill on this bar is stamped
 * with, so the ledger's times line up with the replay cursor. */
export function advanceBar(
  s: ReplayLedgerState,
  bar: KLineData,
  closeMs: number,
): ReplayLedgerState {
  let next = s;

  // 1) Resting limit orders. A buy fills when the market trades at or below the
  //    limit, at the limit — or better if the bar OPENED through it.
  for (const o of s.orders) {
    const crossed = o.side === "buy" ? bar.low <= o.limit : bar.high >= o.limit;
    if (!crossed) continue;
    const fill = o.side === "buy" ? Math.min(o.limit, bar.open) : Math.max(o.limit, bar.open);
    next = {
      ...next,
      seq: next.seq + 1,
      orders: next.orders.filter((x) => x.id !== o.id),
      positions: [
        ...next.positions,
        {
          id: `rp${next.seq + 1}`,
          side: o.side,
          quantity: o.quantity,
          entry: fill,
          stop: o.stop,
          takeProfit: o.takeProfit,
          openedMs: closeMs,
        },
      ],
    };
  }

  // 2) Stop / target for every open position, backtester order.
  for (const p of [...next.positions]) {
    if (p.stop == null && p.takeProfit == null) continue;
    let hit: { price: number; reason: "stop" | "target" } | null = null;
    if (p.side === "buy") {
      if (p.takeProfit != null && bar.open >= p.takeProfit) {
        hit = { price: p.takeProfit, reason: "target" };
      } else if (p.stop != null && bar.low <= p.stop) {
        hit = { price: Math.min(bar.open, p.stop), reason: "stop" };
      } else if (p.takeProfit != null && bar.high >= p.takeProfit) {
        hit = { price: p.takeProfit, reason: "target" };
      }
    } else {
      if (p.takeProfit != null && bar.open <= p.takeProfit) {
        hit = { price: p.takeProfit, reason: "target" };
      } else if (p.stop != null && bar.high >= p.stop) {
        hit = { price: Math.max(bar.open, p.stop), reason: "stop" };
      } else if (p.takeProfit != null && bar.low <= p.takeProfit) {
        hit = { price: p.takeProfit, reason: "target" };
      }
    }
    if (!hit) continue;
    next = {
      ...next,
      positions: next.positions.filter((x) => x.id !== p.id),
      closed: [
        ...next.closed,
        {
          side: p.side,
          quantity: p.quantity,
          entry: p.entry,
          exit: hit.price,
          entryMs: p.openedMs,
          exitMs: closeMs,
          pnl: pnlOf(p.side, p.entry, hit.price, p.quantity),
          reason: hit.reason,
        },
      ],
    };
  }

  return next;
}

/** Project the book into the shape the chart's position lines, pills and bracket
 * already consume, so replay reuses that whole layer untouched. `mark` is the
 * cursor bar's close (null before any bar is revealed). */
export function toTradeViews(
  s: ReplayLedgerState,
  epic: string,
  mark: number | null,
): TradeView[] {
  return [
    ...s.positions.map(
      (p): TradeView => ({
        kind: "position",
        id: p.id,
        epic,
        side: p.side,
        quantity: p.quantity,
        priceLevel: p.entry,
        stop: p.stop,
        takeProfit: p.takeProfit,
        upnl: mark == null ? null : pnlOf(p.side, p.entry, mark, p.quantity),
        openedAt: p.openedMs,
        expiresAt: null,
        leverage: null,
        margin: null,
        source: "manual",
      }),
    ),
    ...s.orders.map(
      (o): TradeView => ({
        kind: "order",
        id: o.id,
        epic,
        side: o.side,
        quantity: o.quantity,
        priceLevel: o.limit,
        stop: o.stop,
        takeProfit: o.takeProfit,
        upnl: null,
        openedAt: o.placedMs,
        expiresAt: null,
        leverage: null,
        margin: null,
        source: "manual",
      }),
    ),
  ];
}

/** What a chart cell's trade book does while it is (or is not) replaying — the
 * ONE fact behind two gates that were previously two unrelated inline checks in
 * ChartCore, either of which could be deleted without the other noticing:
 *
 *  - the account trades poll must not write a replaying cell's drawn book (its
 *    book is the ledger; real positions belong to real time, and their levels
 *    print today's market on a chart that exists to hide it), and
 *  - the pills' Apply / Close / Cancel must go to the ledger, never the broker.
 *
 * Trivial to compute and deliberately so: the value is that both readers name
 * the same decision, and that TradePills can fail CLOSED on `dealing` when it
 * was handed no ledger actions instead of quietly dealing for real. */
export interface CellTradeBook {
  /** May an ACCOUNT trades update write this cell's drawn book? */
  acceptAccountTrades: boolean;
  /** Where a pill's Apply / Close / Cancel must land. */
  dealing: "account" | "ledger";
}
/** Does this trade id come out of a replay ledger? The ids are minted only here
 * (`rp{seq}` for a position, `ro{seq}` for a resting order — see placeMarket /
 * placeLimit, which use a monotonic counter precisely so they stay predictable),
 * so the shape is a reliable "this trade exists only inside a session".
 *
 * Used to fail CLOSED where a replaying cell's drawn book is built: an ACCOUNT
 * trade appearing there is a bug in the gate upstream, and drawing it would put
 * a real position's levels (today's market) on a chart that hides today, with
 * pills on them. A real broker id that happened to match this shape would be
 * dropped too, but only while replaying, where it had to be dropped anyway. */
export function isReplayTradeId(id: string): boolean {
  return /^r[po]\d+$/.test(id);
}

export function cellTradeBook(replaying: boolean): CellTradeBook {
  return replaying
    ? { acceptAccountTrades: false, dealing: "ledger" }
    : { acceptAccountTrades: true, dealing: "account" };
}

export interface ReplaySummary {
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  openPositions: number;
}

/** The high-water trading gate. Trading is legal only at the session's leading
 * edge: step-back is a VIEW-ONLY rewind, so trades never un-happen and the user
 * must not be able to act on bars they have already seen. */
export function canPlaceAt(cursorMs: number, highWaterMs: number): boolean {
  return cursorMs >= highWaterMs;
}

/** Whether a step should ADVANCE the book over its newly revealed bar. Only a
 * cursor moving past the high-water mark reaches new market data; replaying a
 * bar already played must not re-fill the orders it already filled. */
export function shouldAdvanceAt(cursorMs: number, highWaterMs: number): boolean {
  return cursorMs > highWaterMs;
}

export function summarize(s: ReplayLedgerState): ReplaySummary {
  const trades = s.closed.length;
  const wins = s.closed.filter((t) => t.pnl > 0).length;
  const netPnl = s.closed.reduce((a, t) => a + t.pnl, 0);
  return {
    trades,
    wins,
    winRate: trades ? wins / trades : 0,
    netPnl,
    openPositions: s.positions.length,
  };
}

// The account strip's figures and the per-row derived columns, shared by the
// desktop positions dock (PositionsPanel.tsx) and the mobile positions tab
// (mobile/MobilePositionsView.tsx) so the two never drift. Pure: every input
// is passed in, including the live-price lookup, so it is unit-testable and
// the caller decides when to recompute.
//
// Modelled on TradingView's account strip. For a LIVE account the balance /
// available / currency are the broker's real figures (`summary`); for paper
// they come from usedMargin + the configured balance + summed uPnL. Realized
// P&L is the one TV stat missing (the book does not track closed trades).
import { getLivePrice, isCapital, type TradeView } from "./trading";
import { usedMargin } from "./orderInfo";
import type { AccountSummary } from "./trading";
import type { TradingSettings } from "../theme";

export interface AccountStatsInput {
  positions: TradeView[];
  orders: TradeView[];
  summary: AccountSummary | null | undefined;
  trading: TradingSettings;
  /** Broker id of the account ("capital" for "capital:live"). */
  broker: string;
  /** A real-money account: trust the broker's server-marked uPnL and never
   * show paper fallbacks for the broker-derived stats. */
  isLive: boolean;
  /** Live mark for an epic (defaults to the chart stream's price cache). */
  livePrice?: (epic: string) => number | undefined;
}

export interface AccountStats {
  /** Open P&L across all positions, marked to live prices. */
  pnl: number;
  balance: number;
  equity: number;
  available: number;
  accountMargin: number;
  ordersMargin: number;
  /** Free margin as a share of equity, percent. */
  marginBuffer: number;
  /** Equity as a share of margin in use, percent; null with nothing at margin. */
  marginLevel: number | null;
  /** A real-money account whose broker summary has not landed: the
   * broker-derived stats must print blank rather than paper figures. */
  noBrokerData: boolean;
  /** The configured leverage, floored at 1:1. */
  lev: number;
  /** P&L for one trade: broker-marked on a live account, marked to the live
   * price on paper (instrument currency throughout). */
  liveUpnl: (t: TradeView) => number | null;
}

/** A trade row with the derived columns the table shows. */
export interface EnrichedTrade extends TradeView {
  last: number | null;
  pnlPct: number | null;
  tradeValue: number;
  marketValue: number | null;
  leverage: number;
  margin: number;
}

export function accountStats(input: AccountStatsInput): AccountStats {
  const { positions, orders, summary, trading, broker, isLive } = input;
  const livePrice = input.livePrice ?? getLivePrice;
  const lev = trading.defaultLeverage > 0 ? trading.defaultLeverage : 1;
  // P&L per position. For a LIVE account, trust the broker's server uPnL,
  // already in the ACCOUNT currency: client-side marking from the chart's
  // price stream would compute it in the INSTRUMENT currency and mis-mix
  // currencies (a USD stock in a EUR account). Paper marks to market from the
  // live price (same currency throughout) so P&L stays live without a poll.
  const liveUpnl = (t: TradeView): number | null => {
    if (t.kind !== "position" || t.quantity <= 0) return t.upnl;
    if (isLive) return t.upnl;
    const live = livePrice(t.epic);
    if (live == null) return t.upnl;
    return (t.side === "buy" ? 1 : -1) * t.quantity * (live - t.priceLevel);
  };
  const pnl = positions.reduce((s, p) => s + (liveUpnl(p) ?? 0), 0);
  const ordersMargin = usedMargin(orders, lev); // reserved by resting orders
  const balance = summary?.balance ?? trading.accountBalance;
  const brokerMarginAllKnown = positions.length > 0 && positions.every((p) => p.margin != null);
  // Available: the broker's real free margin for a live account; for paper
  // the configured balance + open P&L less the leverage-based margin.
  const available =
    summary?.available ?? Math.max(0, balance + pnl - usedMargin(positions, lev) - ordersMargin);
  // Does the LIVE broker's `balance` already include open P&L? Capital's does
  // (balance = account value incl uPnL); IG / cash-balance brokers report a
  // cash balance that EXCLUDES it. Decides whether adding `pnl` would
  // double-count. (Capital's `deposit` field is unrelated to used margin, so
  // used margin derives from balance/available, not deposit.)
  const liveBalanceInclPnl = summary != null && isCapital(broker);
  // Some brokers (MT5) report account value + margin-in-use authoritatively.
  // When both are present they are used verbatim for equity / margin / margin
  // level instead of the balance−available derivation (which drifts by swap
  // and commission). MetaApi's identity freeMargin = equity − margin keeps
  // `available + margin = equity` exact.
  const brokerEquity = summary?.equity ?? null;
  const brokerMargin = summary?.margin ?? null;
  const brokerFiguresKnown = brokerEquity != null && brokerMargin != null;
  // Account margin (deposit tied up by open positions). When the broker
  // reports per-position margin (Capital) sum those rows so the strip adds up
  // to the MARGIN column exactly. Otherwise derive from balance − available,
  // adding `pnl` ONLY for cash-balance brokers. Paper: from leverage.
  const accountMargin = brokerFiguresKnown
    ? brokerMargin
    : summary
      ? brokerMarginAllKnown
        ? positions.reduce((s, p) => s + (p.margin ?? 0), 0) + ordersMargin
        : Math.max(0, balance + (liveBalanceInclPnl ? 0 : pnl) - available - ordersMargin)
      : usedMargin(positions, lev);
  // Equity (account value). With per-position margin known, equity =
  // available + margin-in-use (broker-agnostic). Otherwise Capital's balance
  // IS the equity (adding `pnl` would double-count); a cash balance (IG /
  // paper) needs balance + open P&L.
  const equity = brokerFiguresKnown
    ? brokerEquity
    : summary && brokerMarginAllKnown
      ? available + accountMargin
      : liveBalanceInclPnl
        ? balance
        : balance + pnl;
  const marginBuffer = equity > 0 ? (available / equity) * 100 : 0;
  // Capital's "CFD Margin %": equity ÷ margin in use.
  const marginLevel = accountMargin > 0 ? (equity / accountMargin) * 100 : null;
  // A real-money account must NEVER show fabricated paper figures. Until the
  // broker's summary lands (or if the fetch fails), the broker-derived stats
  // print blank. uPnL stays: it is real (server-marked per position).
  const noBrokerData = isLive && summary?.balance == null;
  return {
    pnl,
    balance,
    equity,
    available,
    accountMargin,
    ordersMargin,
    marginBuffer,
    marginLevel,
    noBrokerData,
    lev,
    liveUpnl,
  };
}

/** The derived columns for one row. P&L is marked to market (see liveUpnl);
 * on paper the last price is backed out of it so the two columns agree;
 * market / trade value and per-row margin follow. Orders have no P&L, so
 * their last / market / % are blank. */
export function enrichTrade(
  t: TradeView,
  stats: Pick<AccountStats, "lev" | "liveUpnl">,
  isLive: boolean,
  livePrice: (epic: string) => number | undefined = getLivePrice,
): EnrichedTrade {
  const tradeValue = t.priceLevel * t.quantity;
  // Prefer the broker's real per-position leverage + margin (Capital varies
  // the ratio per instrument, and its margin is in the account currency);
  // fall back to the configured leverage for paper and silent brokers.
  const leverage = t.leverage ?? stats.lev;
  const margin = t.margin ?? tradeValue / leverage;
  let last: number | null = null;
  let marketValue: number | null = null;
  let pnlPct: number | null = null;
  const upnl = stats.liveUpnl(t);
  if (t.kind === "position" && t.quantity > 0) {
    const sign = t.side === "buy" ? 1 : -1;
    if (isLive) {
      // `upnl` is account-currency, so no price can be backed out of it. Use
      // the streamed price as `last`, or the broker's own mark from the
      // positions poll when no chart streams this epic; P&L% is a price move
      // (currency-invariant).
      last = livePrice(t.epic) ?? t.mark ?? null;
      marketValue = last != null ? last * t.quantity : null;
      pnlPct =
        last != null && t.priceLevel !== 0 ? ((sign * (last - t.priceLevel)) / t.priceLevel) * 100 : null;
    } else if (upnl != null) {
      // Paper: P&L is instrument-currency, so back out `last` to stay consistent.
      last = t.priceLevel + (sign * upnl) / t.quantity;
      marketValue = last * t.quantity;
      pnlPct = tradeValue !== 0 ? (upnl / tradeValue) * 100 : null;
    }
  }
  return { ...t, upnl, last, marketValue, pnlPct, tradeValue, margin, leverage };
}

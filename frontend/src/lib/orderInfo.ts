// Order-ticket info math (margin / trade value / reward) for the paper account.
// Pure + display-only — NEVER gates submit (an over-leveraged order still places,
// like TradingView). Approximate: trade value = quantity × price (no contract
// size / FX), so figures are internally coherent, not broker-accurate. All
// outputs are prices/cash/percent — no ticks.

export interface OrderInfoInput {
  quantity: number;
  price: number | null; // entry: the limit price, or current market for a market order
  stop: number | null;
  takeProfit: number | null;
  leverage: number; // for this instrument's type
  balance: number;
  usedMargin: number; // margin already tied up by open positions
}

export interface OrderInfo {
  tradeValue: number;
  margin: number;
  available: number;
  marginRatio: number; // margin / available, clamped [0,1] for the bar
  overLeveraged: boolean; // margin > available
  rewardCash: number | null;
  rewardPct: number | null; // reward move as % of entry
  riskCash: number | null;
  rr: number | null; // reward-to-risk ratio
}

export function computeOrderInfo(i: OrderInfoInput): OrderInfo | null {
  if (i.price == null || !(i.quantity > 0)) return null;
  const tradeValue = i.quantity * i.price;
  const lev = i.leverage > 0 ? i.leverage : 1;
  const margin = tradeValue / lev;
  const available = Math.max(0, i.balance - i.usedMargin);
  const overLeveraged = margin > available;
  const marginRatio = available > 0 ? Math.min(1, margin / available) : 1;

  const rewardCash =
    i.takeProfit != null ? Math.abs(i.takeProfit - i.price) * i.quantity : null;
  const rewardPct =
    i.takeProfit != null ? (Math.abs(i.takeProfit - i.price) / i.price) * 100 : null;
  const riskCash =
    i.stop != null ? Math.abs(i.price - i.stop) * i.quantity : null;
  const rr =
    rewardCash != null && riskCash != null && riskCash > 0
      ? rewardCash / riskCash
      : null;

  return {
    tradeValue,
    margin,
    available,
    marginRatio,
    overLeveraged,
    rewardCash,
    rewardPct,
    riskCash,
    rr,
  };
}

/** Margin tied up by open positions. Approximate — positions don't carry their
 *  instrument type, so all are valued at `leverage` (the account default). */
export function usedMargin(
  positions: { priceLevel: number; quantity: number }[],
  leverage: number,
): number {
  const lev = leverage > 0 ? leverage : 1;
  return positions.reduce((sum, p) => sum + (p.priceLevel * p.quantity) / lev, 0);
}

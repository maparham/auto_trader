// Group open positions by symbol and roll each group up into the aggregate figures
// the positions dock shows on its group header row (net side + size, size-weighted
// average entry, summed P&L / notionals / margin, notional-weighted P&L %). Pure so
// the roll-up is unit-testable apart from the table.

export interface GroupPosition {
  epic: string;
  side: "buy" | "sell";
  quantity: number;
  priceLevel: number;
  upnl: number | null;
  last: number | null;
  pnlPct: number | null;
  tradeValue: number;
  marketValue: number | null;
  leverage: number;
  margin: number;
  openedAt: number | null;
}

export interface PositionGroup<T extends GroupPosition> {
  epic: string;
  positions: T[];
  /** Net direction: "mixed" when the positions hedge each other. */
  side: "buy" | "sell" | "mixed";
  /** Absolute net size across the positions. */
  quantity: number;
  /** Size-weighted average entry across every pos. */
  priceLevel: number;
  last: number | null;
  upnl: number | null;
  /** Trade-value-weighted mean of the positions' P&L % (null when no position has one). */
  pnlPct: number | null;
  tradeValue: number;
  marketValue: number | null;
  /** The shared leverage, or null when the positions differ. */
  leverage: number | null;
  margin: number;
  /** Earliest open time across the positions. */
  openedAt: number | null;
}

/** Roll `positions` (all the same epic) up into one group. */
export function aggregatePositions<T extends GroupPosition>(positions: T[]): PositionGroup<T> {
  const epic = positions[0]?.epic ?? "";
  let signed = 0;
  let size = 0;
  let entryWeighted = 0;
  let upnl: number | null = null;
  let tradeValue = 0;
  let marketValue: number | null = null;
  let margin = 0;
  let pctWeighted = 0;
  let pctWeight = 0;
  let openedAt: number | null = null;
  let hasBuy = false;
  let hasSell = false;
  for (const l of positions) {
    const s = l.side === "buy" ? 1 : -1;
    if (l.side === "buy") hasBuy = true;
    else hasSell = true;
    signed += s * l.quantity;
    size += l.quantity;
    entryWeighted += l.priceLevel * l.quantity;
    tradeValue += l.tradeValue;
    margin += l.margin;
    if (l.upnl != null) upnl = (upnl ?? 0) + l.upnl;
    if (l.marketValue != null) marketValue = (marketValue ?? 0) + l.marketValue;
    if (l.pnlPct != null && l.tradeValue > 0) {
      pctWeighted += l.pnlPct * l.tradeValue;
      pctWeight += l.tradeValue;
    }
    if (l.openedAt != null && (openedAt == null || l.openedAt < openedAt)) openedAt = l.openedAt;
  }
  const leverage = positions.every((l) => l.leverage === positions[0].leverage) ? positions[0].leverage : null;
  return {
    epic,
    positions,
    side: hasBuy && hasSell ? "mixed" : hasBuy ? "buy" : "sell",
    quantity: Math.abs(signed),
    priceLevel: size > 0 ? entryWeighted / size : 0,
    last: positions.find((l) => l.last != null)?.last ?? null,
    upnl,
    pnlPct: pctWeight > 0 ? pctWeighted / pctWeight : null,
    tradeValue,
    marketValue,
    leverage,
    margin,
    openedAt,
  };
}

/** Group `positions` by epic, preserving first-appearance order of both groups and positions. */
export function groupPositions<T extends GroupPosition>(positions: T[]): PositionGroup<T>[] {
  const byEpic = new Map<string, T[]>();
  for (const l of positions) {
    const list = byEpic.get(l.epic);
    if (list) list.push(l);
    else byEpic.set(l.epic, [l]);
  }
  return [...byEpic.values()].map(aggregatePositions);
}

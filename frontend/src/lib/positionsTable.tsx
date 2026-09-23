// The positions/orders table shared by the desktop dock (PositionsPanel.tsx) and
// the phone's Positions tab (mobile/MobilePositionsView.tsx). One column list
// drives the header (PositionsTable.tsx) and every row's cells, so the two
// tables cannot drift out of order. Each caller keeps its own <tr> (click,
// hover, editing and action cells differ) and passes a `level` formatter,
// since the dock prints levels at the symbol's precision and the phone has no
// precision source.
import { Fragment, type ReactNode } from "react";
import Tooltip from "../components/Tooltip";
import { tradeLabel } from "./trading";
import type { EnrichedTrade } from "./accountStats";
import type { PositionGroup } from "./positionGroups";

export type TableTab = "positions" | "orders";
// Sortable columns map 1:1 to EnrichedTrade fields, so the comparator reads row[key].
export type SortKey =
  | "epic"
  | "side"
  | "quantity"
  | "priceLevel"
  | "last"
  | "takeProfit"
  | "stop"
  | "upnl"
  | "pnlPct"
  | "tradeValue"
  | "marketValue"
  | "leverage"
  | "margin"
  | "openedAt";
export type SortDir = "asc" | "desc";
export type SortState = { key: SortKey; dir: SortDir };
export const DEFAULT_SORT: SortState = { key: "openedAt", dir: "desc" };

// Text columns read more naturally A→Z; numbers and time most-recent/largest-first.
const defaultDir = (key: SortKey): SortDir => (key === "epic" || key === "side" ? "asc" : "desc");

export const nextSort = (s: SortState, key: SortKey): SortState =>
  s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir(key) };

// Nulls (no TP/SL/P&L/last/value/time) always sink to the bottom regardless of
// direction, so missing values never crowd the top. Works on a position and a
// group roll-up alike (a group has no TP/SL, so sorting on those keeps groups in
// their original order).
type Sortable = Partial<Record<SortKey, string | number | null>>;
export const sortCompare =
  (sort: SortState) =>
  (a: Sortable, b: Sortable): number => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const d = sort.dir === "asc" ? 1 : -1;
    return (typeof av === "string" ? av.localeCompare(bv as string) : av - (bv as number)) * d;
  };

export const fmtPnl = (v: number | null) =>
  v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
export const pnlClass = (v: number | null) => (v == null ? "" : v >= 0 ? "pp-pos" : "pp-neg");
export const cash = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtPct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;

// Full date and time on every row (e.g. "24 Sep 2026, 17:13:12"), never a
// bare time for today, so a row reads the same whenever you look at it.
export function fmtTime(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString([], {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface Column {
  key: SortKey;
  cls: string;
  label: (tab: TableTab) => string;
  tip: (tab: TableTab) => string;
}
const col = (key: SortKey, cls: string, label: string, tip: string): Column => ({
  key,
  cls,
  label: () => label,
  tip: () => tip,
});

export const POSITION_COLUMNS: Column[] = [
  col("epic", "pp-c-sym", "Symbol", "Instrument"),
  col("side", "pp-c-side", "Side", "Direction: long (buy) profits when price rises, short (sell) when it falls"),
  col("quantity", "pp-c-num", "Qty", "Position size (number of contracts / shares)"),
  col("upnl", "pp-c-num", "P&L", "Unrealized profit / loss in the account currency (broker-reported for live accounts)"),
  col("pnlPct", "pp-c-num", "P&L %", "Unrealized P&L as a percentage of the price move from entry"),
  {
    key: "priceLevel",
    cls: "pp-c-num",
    label: (tab) => (tab === "positions" ? "Avg fill" : "Limit"),
    tip: (tab) =>
      tab === "positions" ? "Average price you opened the position at" : "Limit price the resting order will fill at",
  },
  col("takeProfit", "pp-c-num", "TP", "Take-profit: auto-closes the position in profit at this price"),
  col("stop", "pp-c-num", "SL", "Stop-loss: auto-closes the position to cap the loss at this price"),
  col("last", "pp-c-num", "Last", "Latest market price"),
  col("tradeValue", "pp-c-num", "Trade val", "Notional at entry = entry price × quantity (instrument currency)"),
  col("marketValue", "pp-c-num", "Mkt val", "Current notional = last price × quantity (instrument currency)"),
  col("leverage", "pp-c-num", "Lev", "Leverage on this position, from the broker for live accounts (Capital varies it by instrument, e.g. 5:1 on US shares)"),
  col("margin", "pp-c-num", "Margin", "Deposit required to hold this position, in the account currency = current notional ÷ leverage (broker figure for live accounts)"),
  {
    key: "openedAt",
    cls: "pp-c-time",
    label: () => "Time",
    tip: (tab) => (tab === "positions" ? "When the position was opened" : "When the order was placed"),
  },
];

// Lays a row's cells (each a full <td>) out in column order.
const inOrder = (cells: Record<SortKey, ReactNode>) =>
  POSITION_COLUMNS.map((c) => <Fragment key={c.key}>{cells[c.key]}</Fragment>);

// One position / order's cells. `level` formats a price ("—" for null).
// `tips` off leaves the "strat" tag bare: on the phone a tap on it would open
// the tooltip and the row's detail sheet together.
export function positionCells(
  t: EnrichedTrade,
  level: (n: number | null) => string,
  { tips = true }: { tips?: boolean } = {},
): ReactNode[] {
  const long = t.side === "buy";
  return inOrder({
    epic: (
      <td className="pp-c-sym">
        {t.epic}
        {t.source === "strategy" && (
          <Tooltip content={tips ? "Opened by the live trading engine" : undefined}>
            <span className="pp-strat-tag">strat</span>
          </Tooltip>
        )}
      </td>
    ),
    side: <td className={`pp-c-side ${long ? "pp-side-long" : "pp-side-short"}`}>{tradeLabel(t.kind, t.side)}</td>,
    quantity: <td className="pp-c-num">{t.quantity}</td>,
    upnl: (
      <td className="pp-c-num">
        {t.kind === "order" ? (
          <span className="pp-resting">resting</span>
        ) : (
          <span className={`pp-pnl ${pnlClass(t.upnl)}`}>{fmtPnl(t.upnl)}</span>
        )}
      </td>
    ),
    pnlPct: (
      <td className={`pp-c-num${t.pnlPct == null ? " pp-dash" : ` ${pnlClass(t.pnlPct)}`}`}>
        {t.pnlPct != null ? fmtPct(t.pnlPct) : "—"}
      </td>
    ),
    priceLevel: <td className="pp-c-num">{level(t.priceLevel)}</td>,
    takeProfit: (
      <td className={`pp-c-num${t.takeProfit != null ? " pp-lvl-tp" : " pp-dash"}`}>{level(t.takeProfit)}</td>
    ),
    stop: <td className={`pp-c-num${t.stop != null ? " pp-lvl-sl" : " pp-dash"}`}>{level(t.stop)}</td>,
    last: <td className={`pp-c-num${t.last == null ? " pp-dash" : ""}`}>{level(t.last)}</td>,
    tradeValue: <td className="pp-c-num">{cash(t.tradeValue)}</td>,
    marketValue: (
      <td className={`pp-c-num${t.marketValue == null ? " pp-dash" : ""}`}>
        {t.marketValue != null ? cash(t.marketValue) : "—"}
      </td>
    ),
    leverage: <td className="pp-c-num pp-c-lev">{t.leverage}:1</td>,
    margin: <td className="pp-c-num">{cash(t.margin)}</td>,
    openedAt: (
      <td className="pp-c-time">
        {fmtTime(t.openedAt)}
        {t.kind === "order" && t.expiresAt != null && (
          <span className="pp-expiry">
            exp {fmtTime(t.expiresAt)}
          </span>
        )}
      </td>
    ),
  });
}

// A symbol group's roll-up cells. The symbol cell (fold toggle, count badge) is
// the caller's, since the fold state lives there.
export function groupCells(
  g: PositionGroup<EnrichedTrade>,
  symbolCell: ReactNode,
  level: (n: number | null) => string,
): ReactNode[] {
  return inOrder({
    epic: symbolCell,
    side: (
      <td
        className={`pp-c-side ${g.side === "buy" ? "pp-side-long" : g.side === "sell" ? "pp-side-short" : "pp-side-mixed"}`}
      >
        {g.side === "buy" ? "Long" : g.side === "sell" ? "Short" : "Mixed"}
      </td>
    ),
    quantity: <td className="pp-c-num">{+g.quantity.toFixed(8)}</td>,
    upnl: (
      <td className="pp-c-num">
        <span className={`pp-pnl ${pnlClass(g.upnl)}`}>{fmtPnl(g.upnl)}</span>
      </td>
    ),
    pnlPct: (
      <td className={`pp-c-num${g.pnlPct == null ? " pp-dash" : ` ${pnlClass(g.pnlPct)}`}`}>
        {g.pnlPct != null ? fmtPct(g.pnlPct) : "—"}
      </td>
    ),
    priceLevel: <td className="pp-c-num">{level(g.priceLevel)}</td>,
    takeProfit: <td className="pp-c-num pp-dash">—</td>,
    stop: <td className="pp-c-num pp-dash">—</td>,
    last: <td className={`pp-c-num${g.last == null ? " pp-dash" : ""}`}>{level(g.last)}</td>,
    tradeValue: <td className="pp-c-num">{cash(g.tradeValue)}</td>,
    marketValue: (
      <td className={`pp-c-num${g.marketValue == null ? " pp-dash" : ""}`}>
        {g.marketValue != null ? cash(g.marketValue) : "—"}
      </td>
    ),
    leverage: (
      <td className={`pp-c-num pp-c-lev${g.leverage == null ? " pp-dash" : ""}`}>
        {g.leverage != null ? `${g.leverage}:1` : "—"}
      </td>
    ),
    margin: <td className="pp-c-num">{cash(g.margin)}</td>,
    openedAt: <td className="pp-c-time">{fmtTime(g.openedAt)}</td>,
  });
}

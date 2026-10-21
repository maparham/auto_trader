// History tab body (spec 2026-10-21-capital-account-history): range chips, a
// Trades | Ledger toggle, a totals line, and the table. Shared by the desktop
// dock (PositionsPanel) and the phone view (MobilePositionsView).
import { useEffect, useState } from "react";
import {
  refreshHistory,
  subscribeHistory,
  type HistoryDays,
  type HistoryState,
} from "./lib/accountHistory";
import {
  closedByLabel,
  DEFAULT_HISTORY_SORT,
  ledgerKindLabel,
  sortClosedTrades,
  type HistorySort,
  type HistorySortKey,
} from "./lib/historyTable";
import { cash, fmtPnl, fmtTime, pnlClass } from "./lib/positionsTable";
import { SortHeader } from "./PositionsTable";
import InfoTip from "./components/InfoTip";

const RANGES: HistoryDays[] = [7, 30, 90];

interface Props {
  account: string;
  precisionFor?: (epic: string) => number;
  // `price` (the trade's entry) lets a caller without a precision source guess
  // the symbol's decimals.
  onJumpToEpic?: (epic: string, price: number) => void;
  tips?: boolean;
}

// Column list for the closed-trades table; `cls` reuses the house pp-table
// column classes (pp-c-sym / pp-c-num / pp-c-time) so these rows inherit the
// same alignment and color rules as the open-positions table.
const TRADE_COLS: { key: HistorySortKey; label: string; cls: string; tip: string }[] = [
  { key: "epic", label: "Symbol", cls: "pp-c-sym", tip: "Instrument" },
  { key: "side", label: "Side", cls: "", tip: "Direction the position was opened" },
  { key: "size", label: "Qty", cls: "pp-c-num", tip: "Position size" },
  { key: "entry", label: "Entry", cls: "pp-c-num", tip: "Price the position opened at" },
  { key: "exit", label: "Exit", cls: "pp-c-num", tip: "Price the position closed at" },
  { key: "openedAt", label: "Opened", cls: "pp-c-time", tip: "When the position was opened" },
  { key: "closedAt", label: "Closed", cls: "pp-c-time", tip: "When the position was closed" },
  { key: "closeSource", label: "Closed by", cls: "", tip: "What triggered the close" },
  { key: "pnl", label: "P&L", cls: "pp-c-num", tip: "Realized profit or loss, account currency" },
];

export default function HistoryPane({ account, precisionFor, onJumpToEpic, tips = true }: Props) {
  const [days, setDays] = useState<HistoryDays>(30);
  const [view, setView] = useState<"trades" | "ledger">("trades");
  const [sort, setSort] = useState<HistorySort>(DEFAULT_HISTORY_SORT);
  const [state, setState] = useState<HistoryState>({ loading: false, error: null, data: null });

  useEffect(() => subscribeHistory(account, days, setState), [account, days]);

  // With a precision source, format at the symbol's own decimals (toFixed);
  // without one (the phone view has none), print the raw value unrounded
  // rather than clamp every symbol to 2dp.
  const fmtPrice = (epic: string, v: number) =>
    precisionFor ? v.toFixed(precisionFor(epic)) : v.toLocaleString(undefined, {
      maximumFractionDigits: 6,
      useGrouping: false,
    });
  const toggleSort = (key: HistorySortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  const data = state.data;
  const totals = data?.totals;
  const ccy = totals?.currency ?? "";

  return (
    <div className="pp-history">
      <div className="pp-history-bar">
        <div className="pp-history-chips" role="group" aria-label="Range">
          {RANGES.map((d) => (
            <button
              key={d}
              className={`pp-chip${d === days ? " on" : ""}`}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
            >
              {d}d
            </button>
          ))}
        </div>
        <div className="pp-history-chips" role="group" aria-label="View">
          <button
            className={`pp-chip${view === "trades" ? " on" : ""}`}
            aria-pressed={view === "trades"}
            onClick={() => setView("trades")}
          >
            Trades
          </button>
          <button
            className={`pp-chip${view === "ledger" ? " on" : ""}`}
            aria-pressed={view === "ledger"}
            onClick={() => setView("ledger")}
          >
            Ledger
          </button>
        </div>
        {totals && (
          <div className="pp-history-totals">
            <span>
              <span className="pp-stat-label">Realized</span>{" "}
              <span className={pnlClass(totals.realized)}>
                {cash(totals.realized)} {ccy}
              </span>
            </span>
            <span>
              <span className="pp-stat-label">Overnight fees</span>{" "}
              {tips && (
                <InfoTip
                  title="Overnight fees"
                  text={[
                    "Capital's overnight funding charges in this range.",
                    "Daily premium adjustments are not included: Capital's API does not report them.",
                  ]}
                />
              )}{" "}
              <span className={pnlClass(totals.funding)}>
                {cash(totals.funding)} {ccy}
              </span>
            </span>
            <span>
              <span className="pp-stat-label">Net cash in/out</span>{" "}
              {cash(totals.deposits + totals.withdrawals)} {ccy}
            </span>
            {data?.ledgerTruncated && (
              <span className="pp-stat-label">Totals partial: older ledger rows not loaded</span>
            )}
          </div>
        )}
      </div>

      {state.error && (
        <div className="pp-error">
          {state.error}{" "}
          <button className="pp-chip" onClick={() => refreshHistory(account)}>
            Retry
          </button>
        </div>
      )}

      {!data && state.loading && <div className="pp-empty">Loading history…</div>}

      {data &&
        view === "trades" &&
        (data.trades.length === 0 ? (
          <div className="pp-empty">No closed trades in this range.</div>
        ) : (
          <div className="pp-table-wrap">
            <table className="pp-table">
              <thead>
                <tr>
                  {TRADE_COLS.map((c) => (
                    <th key={c.key} className={c.cls}>
                      <SortHeader
                        label={c.label}
                        col={c.key}
                        sort={sort}
                        onSort={toggleSort}
                        title={tips ? c.tip : undefined}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortClosedTrades(data.trades, sort).map((t) => (
                  <tr
                    key={`${t.dealId}:${t.closedAt}`}
                    className={`pp-row pp-dir-${t.side === "buy" ? "long" : "short"}${onJumpToEpic ? " pp-clickable" : ""}`}
                    onClick={() => onJumpToEpic?.(t.epic, t.entry)}
                  >
                    <td className="pp-c-sym">{t.epic}</td>
                    <td>{t.side === "buy" ? "Long" : "Short"}</td>
                    <td className="pp-c-num">{t.size}</td>
                    <td className="pp-c-num">{fmtPrice(t.epic, t.entry)}</td>
                    <td className="pp-c-num">{fmtPrice(t.epic, t.exit)}</td>
                    <td className="pp-c-time">
                      {t.openedAt == null ? <span className="pp-dash">before range</span> : fmtTime(t.openedAt)}
                    </td>
                    <td className="pp-c-time">{fmtTime(t.closedAt)}</td>
                    <td>{closedByLabel(t.closeSource)}</td>
                    <td className={`pp-c-num ${pnlClass(t.pnl)}`}>{fmtPnl(t.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {data &&
        view === "ledger" &&
        (data.ledger.length === 0 ? (
          <div className="pp-empty">No ledger entries in this range.</div>
        ) : (
          <div className="pp-table-wrap">
            <table className="pp-table">
              <thead>
                <tr>
                  <th className="pp-c-time">Time</th>
                  <th>Type</th>
                  <th className="pp-c-sym">Symbol</th>
                  <th>Note</th>
                  <th className="pp-c-num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {[...data.ledger]
                  .sort((a, b) => b.at - a.at)
                  .map((e) => (
                    <tr key={e.reference || `${e.at}:${e.kind}`} className="pp-row">
                      <td className="pp-c-time">{fmtTime(e.at)}</td>
                      <td>{ledgerKindLabel(e.kind)}</td>
                      <td className={`pp-c-sym${e.epic ? "" : " pp-dash"}`}>{e.epic ?? "—"}</td>
                      <td>{e.note}</td>
                      <td className={`pp-c-num ${pnlClass(e.amount)}`}>
                        {cash(e.amount)} {e.currency}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

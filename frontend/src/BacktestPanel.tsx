// Backtest results — embedded in the config side panel's "Results" tab
// (BacktestButton publishes the result onto backtestResultSignal). Shows an
// empty-state prompt until the first run completes.
//
// Overview tab: metricRows() as a wrapped grid of label/value cards (tone
// coloured pos/neg). Trades tab: a sortable table of every trade
// (tradeRows()/sortTradeRows()). Each row carries data-trade-index — a hook
// Phase C uses to highlight the matching chart marker on hover/click.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  backtestResultSignal,
  highlightTradeSignal,
  selectedTradeSignal,
  backtestMessagesSignal,
  backtestSelectNoticeSignal,
  backtestPeriodsShownSignal,
  backtestRunningSignal,
  requestBacktestClear,
} from "./lib/signals";
import { saveBacktestPeriodsShown } from "./lib/persist";
import { metricGroups, METRIC_INFO, tradeRows, sortTradeRows, type TradeRow } from "./lib/backtestPanelData";
import InfoTip from "./components/InfoTip";
import { RESOLUTION_SECONDS } from "./lib/feed";
import { formatExpiryShort } from "./lib/alertUi";

// Module-singleton signal — the subscribe fn never changes, so memoize it (matches
// Toolbar's useSyncExternalStore pattern) instead of resubscribing on every render.
const subscribeResult = (cb: () => void) => backtestResultSignal.subscribe(cb);
const subscribeHighlight = (cb: () => void) => highlightTradeSignal.subscribe(cb);
const subscribeSelected = (cb: () => void) => selectedTradeSignal.subscribe(cb);
const subscribeMessages = (cb: () => void) => backtestMessagesSignal.subscribe(cb);
const subscribeSelectNotice = (cb: () => void) => backtestSelectNoticeSignal.subscribe(cb);
const subscribeRunning = (cb: () => void) => backtestRunningSignal.subscribe(cb);

type Tab = "overview" | "trades";
type SortDir = "asc" | "desc";

// Text columns read more naturally A→Z on first click; numeric/time columns
// most-significant-first (mirrors PositionsPanel's defaultDir).
const TEXT_KEYS: (keyof TradeRow)[] = ["leg", "reason"];
const defaultDir = (key: keyof TradeRow): SortDir => (TEXT_KEYS.includes(key) ? "asc" : "desc");

const fmtPrice = (n: number): string => n.toFixed(2);
const fmtPnl = (n: number): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const fmtPct = (n: number): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
const toneOf = (n: number): string => (n > 0 ? "pos" : n < 0 ? "neg" : "");

export default function BacktestPanel() {
  const result = useSyncExternalStore(subscribeResult, () => backtestResultSignal.value);
  const highlighted = useSyncExternalStore(subscribeHighlight, () => highlightTradeSignal.value);
  const selected = useSyncExternalStore(subscribeSelected, () => selectedTradeSignal.value);
  const messages = useSyncExternalStore(subscribeMessages, () => backtestMessagesSignal.value);
  const selectNotice = useSyncExternalStore(subscribeSelectNotice, () => backtestSelectNoticeSignal.value);
  const running = useSyncExternalStore(subscribeRunning, () => backtestRunningSignal.value);
  const periodsShown = useSyncExternalStore(
    (cb) => backtestPeriodsShownSignal.subscribe(cb),
    () => backtestPeriodsShownSignal.value,
  );
  const toggleBacktestPeriods = () => {
    const next = !backtestPeriodsShownSignal.value;
    backtestPeriodsShownSignal.set(next);
    saveBacktestPeriodsShown(next);
  };
  const [tab, setTab] = useState<Tab>("overview");
  const [sort, setSort] = useState<{ key: keyof TradeRow; dir: SortDir }>({ key: "i", dir: "asc" });

  // Keep the highlighted row in view whether the highlight originated here (a
  // hover in this same list — scrollIntoView is a no-op when already visible)
  // or from outside (Phase C Task 2: a chart marker hover/click).
  const highlightedRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    highlightedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  // Transient run messages (fetch error / short warm-up) — shown whether or not
  // a result exists, since an errored run leaves no result to render.
  const msgRow =
    messages.error || messages.warning || selectNotice ? (
      <div className="bt-results-messages">
        {messages.warning && (
          <span className="bt-warning" title={messages.warning}>
            ⚠ short warm-up
          </span>
        )}
        {messages.error && <span className="bt-error">{messages.error}</span>}
        {selectNotice && <span className="bt-notice">{selectNotice}</span>}
      </div>
    ) : null;

  if (result == null) {
    return (
      <div className="bt-results">
        {msgRow}
        <div className="bt-results-empty">
          {running ? "Backtest running…" : "Run a backtest to see results here."}
        </div>
      </div>
    );
  }

  const s = result.summary;
  const summaryRow = (
    <div className="bt-results-summary">
      <span className="bt-summary">
        <span className={s.net_pnl >= 0 ? "pos" : "neg"}>
          {s.net_pnl >= 0 ? "+" : ""}
          {s.net_pnl.toFixed(2)}
        </span>
        <span>{s.n_trades} trades</span>
        <span title="Largest equity drop from a high to a low">−{s.max_drawdown.toFixed(2)} dd</span>
        <span>{(s.win_rate * 100).toFixed(0)}% win</span>
        {(() => {
          // Effective reward:risk actually realized (avg win ÷ avg loss) — the true
          // payoff, which can differ sharply from the configured stop/target RR.
          const rr = result.metrics.avg_win_loss_ratio;
          const rrTitle =
            "Effective reward:risk — average win ÷ average loss. Contrast with your configured stop/target RR.";
          if (rr != null) return <span title={rrTitle}>{rr.toFixed(2)} RR</span>;
          // null = no losing trades: infinite RR when there were any winners, else nothing to show.
          return s.win_rate > 0 ? <span title={rrTitle}>∞ RR</span> : null;
        })()}
      </span>
      <button
        className={`bt-periods-toggle${periodsShown ? " on" : ""}`}
        title={periodsShown ? "Hide the trading periods shaded on the chart" : "Show the trading periods shaded on the chart"}
        aria-pressed={periodsShown}
        onClick={toggleBacktestPeriods}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          {/* shaded period bands standing on the time axis */}
          <rect x="1.5" y="3.5" width="3" height="8" rx="1" fill="currentColor" />
          <rect x="6.5" y="3.5" width="3" height="8" rx="1" fill="currentColor" opacity="0.55" />
          <rect x="11.5" y="3.5" width="3" height="8" rx="1" fill="currentColor" />
        </svg>
        <span>Periods</span>
      </button>
      <button className="bt-clear" title="Clear backtest" onClick={requestBacktestClear}>
        ✕
      </button>
    </div>
  );

  const toggleSort = (key: keyof TradeRow) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir(key) }));

  const resSeconds = RESOLUTION_SECONDS[result.resolution] ?? 60;
  const rows = sortTradeRows(tradeRows(result, resSeconds), sort.key, sort.dir);
  const nTrades = result.trades.length;

  return (
    <div className="bt-results">
      {summaryRow}
      {msgRow}
      <div className="bt-results-head">
        <div className="seg" role="tablist" aria-label="Backtest results view">
          <button
            className={tab === "overview" ? "seg-on" : ""}
            role="tab"
            aria-selected={tab === "overview"}
            onClick={() => setTab("overview")}
          >
            Overview
          </button>
          <button
            className={tab === "trades" ? "seg-on" : ""}
            role="tab"
            aria-selected={tab === "trades"}
            onClick={() => setTab("trades")}
          >
            Trades
          </button>
        </div>
        <span className="bt-panel-count">
          {nTrades} {nTrades === 1 ? "trade" : "trades"}
        </span>
      </div>

      {(
        tab === "overview" ? (
          <div className="bt-panel-overview">
            {metricGroups(result).map((g) => (
              <section className="bt-panel-group" key={g.title}>
                <h4 className="bt-panel-group-title">{g.title}</h4>
                <div className="bt-panel-grid">
                  {g.rows.map((m) => (
                    <div className="bt-panel-stat" key={m.label}>
                      <span className="bt-panel-stat-label">
                        <span className="bt-panel-stat-name">{m.label}</span>
                        {METRIC_INFO[m.label] && <InfoTip title={m.label} text={METRIC_INFO[m.label]} />}
                      </span>
                      <span className={`bt-panel-stat-value${m.tone ? ` ${m.tone}` : ""}`}>{m.value}</span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="bt-panel-trades-wrap">
            <table className="bt-panel-table">
              <thead>
                <tr>
                  <th><SortHeader label="#" col="i" sort={sort} onSort={toggleSort} /></th>
                  <th><SortHeader label="Side" col="leg" sort={sort} onSort={toggleSort} /></th>
                  <th><SortHeader label="Entry time" col="entryTime" sort={sort} onSort={toggleSort} /></th>
                  <th className="bt-panel-c-num"><SortHeader label="Entry" col="entryPrice" sort={sort} onSort={toggleSort} /></th>
                  <th><SortHeader label="Exit time" col="exitTime" sort={sort} onSort={toggleSort} /></th>
                  <th className="bt-panel-c-num"><SortHeader label="Exit" col="exitPrice" sort={sort} onSort={toggleSort} /></th>
                  <th className="bt-panel-c-num"><SortHeader label="P&L" col="pnl" sort={sort} onSort={toggleSort} /></th>
                  <th className="bt-panel-c-num"><SortHeader label="P&L %" col="pnlPct" sort={sort} onSort={toggleSort} /></th>
                  <th><SortHeader label="Reason" col="reason" sort={sort} onSort={toggleSort} /></th>
                  <th className="bt-panel-c-num"><SortHeader label="Duration" col="durationBars" sort={sort} onSort={toggleSort} /></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.i}
                    data-trade-index={row.i}
                    ref={row.i === highlighted ? highlightedRowRef : undefined}
                    className={`bt-trade-row${row.i === highlighted ? " highlighted" : ""}${row.i === selected ? " selected" : ""}`}
                    onMouseEnter={() => highlightTradeSignal.set(row.i)}
                    onMouseLeave={() => highlightTradeSignal.set(null)}
                    onClick={() => selectedTradeSignal.set(selected === row.i ? null : row.i)}
                  >
                    <td>{row.i + 1}</td>
                    <td className={row.leg === "long" ? "bt-panel-side-long" : "bt-panel-side-short"}>
                      {row.leg === "long" ? "Long" : "Short"}
                    </td>
                    <td className="bt-panel-c-time">{formatExpiryShort(row.entryTime * 1000)}</td>
                    <td className="bt-panel-c-num">{fmtPrice(row.entryPrice)}</td>
                    <td className="bt-panel-c-time">{formatExpiryShort(row.exitTime * 1000)}</td>
                    <td className="bt-panel-c-num">{fmtPrice(row.exitPrice)}</td>
                    <td className={`bt-panel-c-num ${toneOf(row.pnl)}`}>{fmtPnl(row.pnl)}</td>
                    <td className={`bt-panel-c-num ${toneOf(row.pnlPct)}`}>{fmtPct(row.pnlPct)}</td>
                    <td>{row.reason}</td>
                    <td className="bt-panel-c-num">{row.durationBars.toFixed(1)} bars</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// Clickable column header: click to sort by this column, click again to flip
// direction (mirrors PositionsPanel's SortHeader).
function SortHeader({
  label,
  col,
  sort,
  onSort,
}: {
  label: string;
  col: keyof TradeRow;
  sort: { key: keyof TradeRow; dir: SortDir };
  onSort: (key: keyof TradeRow) => void;
}) {
  const active = sort.key === col;
  return (
    <button
      className={`bt-panel-sort${active ? " on" : ""}`}
      onClick={() => onSort(col)}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span>{label}</span>
      <span className="bt-panel-sort-caret" aria-hidden="true">
        {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
      </span>
    </button>
  );
}

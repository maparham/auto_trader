// Backtest results — embedded in the config side panel's "Results" tab
// (BacktestButton publishes the result onto backtestResultSignal). Shows an
// empty-state prompt until the first run completes.
//
// Overview tab: metricRows() as a wrapped grid of label/value cards (tone
// coloured pos/neg). Trades tab: a sortable table of every trade
// (tradeRows()/sortTradeRows()). Each row carries data-trade-index — a hook
// Phase C uses to highlight the matching chart marker on hover/click.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  backtestResultSignal,
  highlightTradeSignal,
  selectedTradeSignal,
  backtestMessagesSignal,
  backtestSelectNoticeSignal,
  backtestPeriodsShownSignal,
  backtestMarkersShownSignal,
  backtestEquityShownSignal,
  backtestRunningSignal,
  requestBacktestClear,
} from "./lib/signals";
import { saveBacktestPeriodsShown, saveBacktestMarkersShown, saveBacktestEquityShown } from "./lib/persist";
import { metricGroups, METRIC_INFO, legTable, tradeRows, sortTradeRows, rowWindow, type TradeRow, type LegTable } from "./lib/backtestPanelData";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import { RESOLUTION_SECONDS } from "./lib/feed";
import { formatExpiryShort } from "./lib/alertUi";
import BacktestInspectorPanel from "./BacktestInspectorPanel";
import BacktestAnalysisPanel from "./BacktestAnalysisPanel";
import { inspectModeSignal, inspectTraceSignal } from "./lib/backtestInspect";
import { formatDayWindow } from "./lib/backtestSchedule";
import { formatPeriodDateRange } from "./lib/backtestPeriods";

// Module-singleton signal — the subscribe fn never changes, so memoize it (matches
// Toolbar's useSyncExternalStore pattern) instead of resubscribing on every render.
const subscribeResult = (cb: () => void) => backtestResultSignal.subscribe(cb);
const subscribeHighlight = (cb: () => void) => highlightTradeSignal.subscribe(cb);
const subscribeSelected = (cb: () => void) => selectedTradeSignal.subscribe(cb);
const subscribeMessages = (cb: () => void) => backtestMessagesSignal.subscribe(cb);
const subscribeSelectNotice = (cb: () => void) => backtestSelectNoticeSignal.subscribe(cb);
const subscribeRunning = (cb: () => void) => backtestRunningSignal.subscribe(cb);

type Tab = "overview" | "trades" | "analysis" | "inspect";
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
  const markersShown = useSyncExternalStore(
    (cb) => backtestMarkersShownSignal.subscribe(cb),
    () => backtestMarkersShownSignal.value,
  );
  const toggleBacktestMarkers = () => {
    const next = !backtestMarkersShownSignal.value;
    backtestMarkersShownSignal.set(next);
    saveBacktestMarkersShown(next);
  };
  const equityShown = useSyncExternalStore(
    (cb) => backtestEquityShownSignal.subscribe(cb),
    () => backtestEquityShownSignal.value,
  );
  const toggleBacktestEquity = () => {
    const next = !backtestEquityShownSignal.value;
    backtestEquityShownSignal.set(next);
    saveBacktestEquityShown(next);
  };
  // The three chart-display toggles above live in one compact "Display" dropdown
  // so the Results row doesn't spend its width on three labeled pills. Own open
  // state + outside-click/Esc close, following the shared .menu/.dropdown idiom.
  const [displayOpen, setDisplayOpen] = useState(false);
  const displayMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!displayOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (displayMenuRef.current && !displayMenuRef.current.contains(t)) setDisplayOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDisplayOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [displayOpen]);
  const inspectMode = useSyncExternalStore(
    (cb) => inspectModeSignal.subscribe(cb),
    () => inspectModeSignal.value,
  );
  const inspectTrace = useSyncExternalStore(
    (cb) => inspectTraceSignal.subscribe(cb),
    () => inspectTraceSignal.value,
  );
  const [tab, setTab] = useState<Tab>("overview");
  // The Inspect toggle now lives in the modal footer (next to Run backtest). Turning
  // it on there should still jump this panel to the Inspect tab, so react to the
  // shared signal here rather than switching the tab inside the button's handler.
  useEffect(() => {
    if (inspectMode) setTab("inspect");
  }, [inspectMode]);
  const [sort, setSort] = useState<{ key: keyof TradeRow; dir: SortDir }>({ key: "i", dir: "asc" });

  // Row building and sorting are memoized so panel re-renders (row hover sets
  // highlightTradeSignal on every mouseenter) don't rebuild and re-sort the
  // whole list — with tens of thousands of trades that made hovering laggy.
  const resSeconds = result ? RESOLUTION_SECONDS[result.resolution] ?? 60 : 60;
  const baseRows = useMemo(() => (result ? tradeRows(result, resSeconds) : []), [result, resSeconds]);
  const rows = useMemo(() => sortTradeRows(baseRows, sort.key, sort.dir), [baseRows, sort.key, sort.dir]);

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
        {result.fileBracketsOverridden && (
          <Tooltip content="The strategy file passed sl=/tp= but panel risk is configured — panel risk was applied.">
            <span className="bt-chip-muted">file sl/tp overridden</span>
          </Tooltip>
        )}
      </span>
      {result.period && (
        <span className="bt-period-label" title="The date span this backtest traded over">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            {/* calendar */}
            <rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <line x1="2" y1="6.5" x2="14" y2="6.5" stroke="currentColor" strokeWidth="1.3" />
            <line x1="5" y1="1.5" x2="5" y2="4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <line x1="11" y1="1.5" x2="11" y2="4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          {formatPeriodDateRange(result.period.fromMs, result.period.toMs)}
        </span>
      )}
      {result.period?.mask?.timeOfDay && (
        <span
          className="bt-period-label"
          title={`Daily trading window${result.period.mask.tz ? ` (${result.period.mask.tz})` : ""}`}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            {/* clock */}
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 4.5 L8 8 L10.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {formatDayWindow(result.period.mask.timeOfDay)}
        </span>
      )}
      <div className="menu bt-display-menu" ref={displayMenuRef}>
        <button
          className={`bt-display-btn${displayOpen ? " on" : ""}`}
          title="Choose what the backtest draws on the chart"
          aria-haspopup="menu"
          aria-expanded={displayOpen}
          onClick={() => setDisplayOpen((v) => !v)}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            {/* stacked layers glyph */}
            <path d="M8 1.5 L14.5 5 L8 8.5 L1.5 5 Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path d="M2 8 L8 11 L14 8 M2 11 L8 14 L14 11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <span>Display</span>
          <svg className="tb-caret" width="9" height="9" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6 L8 10 L12 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {displayOpen && (
          <div className="dropdown bt-display-dropdown" role="menu">
            <ul>
              <li
                className={markersShown ? "on" : ""}
                role="menuitemcheckbox"
                aria-checked={markersShown}
                onClick={toggleBacktestMarkers}
              >
                <span className="check">{markersShown ? "✓" : ""}</span>
                <span>Trade markers</span>
              </li>
              <li
                className={periodsShown ? "on" : ""}
                role="menuitemcheckbox"
                aria-checked={periodsShown}
                onClick={toggleBacktestPeriods}
              >
                <span className="check">{periodsShown ? "✓" : ""}</span>
                <span>Trading periods</span>
              </li>
              <li
                className={equityShown ? "on" : ""}
                role="menuitemcheckbox"
                aria-checked={equityShown}
                onClick={toggleBacktestEquity}
              >
                <span className="check">{equityShown ? "✓" : ""}</span>
                <span>Equity curve</span>
              </li>
            </ul>
          </div>
        )}
      </div>
      <button className="bt-clear" title="Clear backtest" onClick={requestBacktestClear}>
        ✕
      </button>
    </div>
  );

  const toggleSort = (key: keyof TradeRow) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir(key) }));

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
          <button
            className={tab === "analysis" ? "seg-on" : ""}
            role="tab"
            aria-selected={tab === "analysis"}
            onClick={() => setTab("analysis")}
          >
            Analysis
          </button>
          <button
            className={tab === "inspect" ? "seg-on" : ""}
            role="tab"
            aria-selected={tab === "inspect"}
            onClick={() => setTab("inspect")}
          >
            Inspect
          </button>
        </div>
        <span className="bt-panel-count">
          {nTrades} {nTrades === 1 ? "trade" : "trades"}
        </span>
      </div>

      {(
        tab === "inspect" ? (
          <div className="bt-panel-inspect">
            {!inspectTrace ? (
              <div className="bt-insp-empty">
                {inspectMode
                  ? "Run the backtest, then click a bar on the chart to inspect its rules."
                  : "Turn on Inspect above, run the backtest, then click a bar to see every rule’s value and why a trade did or didn’t open."}
              </div>
            ) : (
              <BacktestInspectorPanel />
            )}
          </div>
        ) : tab === "analysis" ? (
          <BacktestAnalysisPanel analysis={result?.analysis} barSeconds={resSeconds} />
        ) : tab === "overview" ? (
          <div className="bt-panel-overview">
            {metricGroups(result).map((g) => (
              <section className="bt-panel-group" key={g.title}>
                <h4 className="bt-panel-group-title">{g.title}</h4>
                {g.title === "Trades" ? (
                  <LegBreakdownTable table={legTable(result)} />
                ) : (
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
                )}
              </section>
            ))}
          </div>
        ) : (
          <TradesTable rows={rows} sort={sort} onSort={toggleSort} highlighted={highlighted} selected={selected} />
        )
      )}
    </div>
  );
}

// Sortable trade list with windowed rendering: only the rows near the current
// scroll position exist in the DOM (spacer rows above/below keep the scrollbar
// sized for the full list), so a run with tens of thousands of trades opens
// instantly instead of mounting 10 cells per trade at once.
const OVERSCAN = 10;
// Estimate until the first real row is measured; only the first paint uses it.
const ROW_H_ESTIMATE = 27;

function TradesTable({
  rows,
  sort,
  onSort,
  highlighted,
  selected,
}: {
  rows: TradeRow[];
  sort: { key: keyof TradeRow; dir: SortDir };
  onSort: (key: keyof TradeRow) => void;
  highlighted: number | null;
  selected: number | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [rowH, setRowH] = useState(ROW_H_ESTIMATE);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setViewportH(wrap.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Replace the estimate with the real rendered row height (theme/zoom can
  // shift it); window maths and spacer heights must use the same value or the
  // slice drifts away from the scroll position over thousands of rows.
  useLayoutEffect(() => {
    const el = wrapRef.current?.querySelector<HTMLTableRowElement>("tr.bt-trade-row");
    const h = el?.getBoundingClientRect().height ?? 0;
    if (h > 0 && Math.abs(h - rowH) > 0.5) setRowH(h);
  }, [rows.length, rowH]);

  const { start, end, padTop, padBottom } = rowWindow(scrollTop, viewportH, rowH, rows.length, OVERSCAN);

  // Keep the highlighted row in view. When the highlight comes from this list's
  // own hover the row is already rendered and visible, so this is a no-op; when
  // it comes from a chart marker the row may not even be in the DOM — scroll
  // the container to its computed offset and let the window catch up.
  const highlightedRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (highlighted == null) return;
    if (highlightedRowRef.current) {
      highlightedRowRef.current.scrollIntoView({ block: "nearest" });
      return;
    }
    const wrap = wrapRef.current;
    const idx = rows.findIndex((r) => r.i === highlighted);
    if (!wrap || idx < 0 || rowH <= 0) return;
    wrap.scrollTop = Math.max(0, idx * rowH - wrap.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlighted]);

  return (
    <div
      className="bt-panel-trades-wrap"
      ref={wrapRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <table className="bt-panel-table">
        <thead>
          <tr>
            <th><SortHeader label="#" col="i" sort={sort} onSort={onSort} /></th>
            <th><SortHeader label="Side" col="leg" sort={sort} onSort={onSort} /></th>
            <th><SortHeader label="Entry time" col="entryTime" sort={sort} onSort={onSort} /></th>
            <th className="bt-panel-c-num"><SortHeader label="Entry" col="entryPrice" sort={sort} onSort={onSort} /></th>
            <th><SortHeader label="Exit time" col="exitTime" sort={sort} onSort={onSort} /></th>
            <th className="bt-panel-c-num"><SortHeader label="Exit" col="exitPrice" sort={sort} onSort={onSort} /></th>
            <th className="bt-panel-c-num"><SortHeader label="P&L" col="pnl" sort={sort} onSort={onSort} /></th>
            <th className="bt-panel-c-num"><SortHeader label="P&L %" col="pnlPct" sort={sort} onSort={onSort} /></th>
            <th><SortHeader label="Reason" col="reason" sort={sort} onSort={onSort} /></th>
            <th className="bt-panel-c-num"><SortHeader label="Duration" col="durationBars" sort={sort} onSort={onSort} /></th>
          </tr>
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={10} style={{ height: padTop, padding: 0, border: 0 }} />
            </tr>
          )}
          {rows.slice(start, end).map((row) => (
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
          {padBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={10} style={{ height: padBottom, padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Clickable column header: click to sort by this column, click again to flip
// direction (mirrors PositionsPanel's SortHeader).
// The TRADES section as an ALL / LONG / SHORT table: metric names (with their
// info tips) run across the header once; each row is one direction so the reader
// can compare long vs short contribution down a column.
function LegBreakdownTable({ table }: { table: LegTable }) {
  return (
    <div className="bt-leg-wrap">
      <table className="bt-leg-table">
        <thead>
          <tr>
            <th className="bt-leg-rowhead" aria-hidden="true" />
            {table.columns.map((c) => (
              <th key={c.label} className="bt-leg-col">
                <span className="bt-leg-colhead">
                  <span className="bt-leg-colname">{c.label}</span>
                  <InfoTip title={c.label} text={c.info} />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.leg}>
              <th className="bt-leg-rowhead" scope="row">{r.leg}</th>
              {r.cells.map((cell, i) => (
                <td key={table.columns[i].label} className={`bt-leg-cell${cell.tone ? ` ${cell.tone}` : ""}`}>
                  {cell.value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

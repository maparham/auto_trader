// The trading dock: the whole open book (positions + resting orders across every
// symbol) for the selected environment (paper), modelled on TradingView's bottom
// panel. Driven by the shared trades poll (one poll, fanned out — see trading.ts).
//
// Always docked under the chart; collapsible to just its header bar (persisted).
// A TV-style header strip shows account stats; Positions / Orders tabs split the
// book; the table carries Side / Qty / Avg fill / TP / SL / P&L with per-row
// pencil (edit) + ✕ (close/cancel) actions.
//
// Editing levels: double-click a row (or its pencil) to open the order ticket in
// edit mode; or drag a line on the chart (SL/TP any time; an order's price line
// after pressing Edit). A drag stages a PENDING change here; this panel shows a
// combined Apply / Discard for all staged changes, so a poll never snaps a
// half-edited line back. Apply writes them to the broker.

import { useEffect, useRef, useState } from "react";
import {
  applyLevels,
  cancelWorkingOrder,
  closePosition,
  getLivePrice,
  refreshTrades,
  subscribeLivePrices,
  subscribeTrades,
  tradeLabel,
  brokerLabel,
  brokerOf,
  isRealMoneyAccount,
  isCapital,
  type TradeView,
  type TradeAccount,
  type BrokerAccount,
  type AccountSummary,
} from "./lib/trading";
import {
  pendingEditsSignal,
  editTradeSignal,
  tradeLineUiSignal,
  toggleTradeHidden,
  setTradeHovered,
  toggleTradeSelected,
  setTradeSelected,
  draggingLineSignal,
  type PendingEdit,
} from "./lib/signals";
import { usedMargin } from "./lib/orderInfo";
import type { TradingSettings } from "./theme";
import Tooltip from "./components/Tooltip";

interface Props {
  account?: TradeAccount;
  // All registered accounts (from GET /api/brokers). The dock's account strip shows
  // a tab per account OF THE ACTIVE BROKER so you can switch env (paper/demo/live)
  // WITHOUT changing the workspace; switching broker is the tab-bar selector's job.
  accounts?: BrokerAccount[];
  onAccountChange?: (account: TradeAccount) => void;
  // Real per-account balance/currency for a live account (null for paper → the strip
  // uses the configured paper balance). Lets the dock show the account's TRUE figures.
  accountSummary?: AccountSummary | null;
  // The focused chart's symbol — used ONLY to highlight its rows, never to filter:
  // this panel shows the WHOLE book (every symbol with an open position/order).
  focusedEpic?: string;
  // Per-symbol price precision (the book spans symbols); falls back to `precision`.
  precisionFor?: (epic: string) => number;
  precision?: number;
  // Account math for the header stats strip (balance / leverage / currency).
  trading: TradingSettings;
  // Editing a row re-scopes the chart to its symbol; selecting then opens the order
  // ticket in edit mode (setTradeSelected reveals the panel — no separate callback).
  onJumpToEpic?: (epic: string) => void;
  // When false, a dragged level applies immediately (no Apply/Discard bar).
  confirmLineEdits?: boolean;
  // Dock maximized to fill the chart view (owned by App, which hides the workspace).
  maximized?: boolean;
  onToggleMaximize?: () => void;
}

type Tab = "positions" | "orders";
// A trade row enriched with the derived figures TV shows (last price, P&L %, trade
// /market value, per-row leverage + margin). All approximate, internally coherent
// with our paper P&L — see lib/orderInfo. Sortable columns read straight off this.
interface RowExt extends TradeView {
  last: number | null;
  pnlPct: number | null;
  tradeValue: number;
  marketValue: number | null;
  leverage: number;
  margin: number;
}
// Sortable columns map 1:1 to RowExt fields, so the comparator reads row[key].
type SortKey =
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
type SortDir = "asc" | "desc";
const COLLAPSE_KEY = "tradeDockCollapsed";

// Text columns read more naturally A→Z; numbers and time most-recent/largest-first.
const defaultDir = (key: SortKey): SortDir => (key === "epic" || key === "side" ? "asc" : "desc");

// Env tab label (paper/demo/live → Paper/Demo/Live) and its risk tier, mirroring the
// broker selector's old tiering so a real-money tab still reads red.
function envLabel(env: string): string {
  return env.charAt(0).toUpperCase() + env.slice(1);
}
function acctTier(a: BrokerAccount): "paper" | "demo" | "live" {
  if (a.isRealMoney) return "live";
  return a.env === "paper" ? "paper" : "demo";
}

function fmtTime(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { day: "2-digit", month: "short" })} ${time}`;
}

export default function PositionsPanel({
  account = "capital:paper",
  accounts = [],
  onAccountChange,
  accountSummary,
  focusedEpic,
  precisionFor,
  precision = 2,
  trading,
  onJumpToEpic,
  confirmLineEdits = true,
  maximized = false,
  onToggleMaximize,
}: Props) {
  const [all, setAll] = useState<TradeView[]>([]);
  const [pending, setPending] = useState<Record<string, PendingEdit>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(editTradeSignal.value);
  const [hidden, setHidden] = useState<string[]>(tradeLineUiSignal.value.hidden);
  // Hovered/selected trade ids, mirrored from the chart so a line hover/select
  // lights up its dock row (and vice-versa — the row writes these too).
  const [hoveredId, setHoveredId] = useState<string | null>(tradeLineUiSignal.value.hovered);
  const [selectedId, setSelectedId] = useState<string | null>(tradeLineUiSignal.value.selected);
  // Paused auto-apply while a chart line is being dragged (no-confirm mode).
  const [lineDragging, setLineDragging] = useState<boolean>(draggingLineSignal.value);
  const [tab, setTab] = useState<Tab>("positions");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "openedAt", dir: "desc" });
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => subscribeTrades(setAll), []);
  // Re-render on each streamed price so P&L marks to market live — without polling
  // the server (the dock fetches positions only on actual changes; see trading.ts).
  const [, setPriceTick] = useState(0);
  useEffect(() => subscribeLivePrices(() => setPriceTick((n) => n + 1)), []);
  useEffect(() => draggingLineSignal.subscribe(setLineDragging), []);
  useEffect(() => pendingEditsSignal.subscribe(setPending), []);
  useEffect(() => editTradeSignal.subscribe(setEditId), []);
  useEffect(
    () =>
      tradeLineUiSignal.subscribe((ui) => {
        setHidden(ui.hidden);
        setHoveredId(ui.hovered);
        setSelectedId(ui.selected);
      }),
    [],
  );

  // Account tabs for the active broker. Always render at least the active account
  // (so a single-account broker still shows its tab) even before /api/brokers loads.
  const activeBroker = brokerOf(account);
  const brokerAccounts =
    accounts.filter((a) => a.broker === activeBroker);
  const acctTabs: BrokerAccount[] =
    brokerAccounts.length > 0
      ? brokerAccounts
      : [{ key: account, broker: activeBroker, env: account.split(":")[1] ?? "paper", isRealMoney: false }];

  const trades = all; // whole book — every symbol, not just the focused chart
  const positions = trades.filter((t) => t.kind === "position");
  const orders = trades.filter((t) => t.kind === "order");
  const rows = tab === "positions" ? positions : orders;

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir(key) }));
  const precOf = (e: string) => precisionFor?.(e) ?? precision;
  const fmt = (n: number, p = precision) => n.toFixed(p);
  // A live account reports its real currency; otherwise the configured paper one.
  const isLive = isRealMoneyAccount(account);
  const cur = accountSummary?.currency ?? trading.accountCurrency;
  const cash = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  // Account stats — modelled on TV's account strip. For a LIVE account the balance/
  // available/currency are the broker's real figures (accountSummary); for paper they
  // come from usedMargin + the configured balance + summed upnl. Realized P&L is the
  // one TV stat we can't show yet (the book doesn't track closed trades).
  const lev = trading.defaultLeverage > 0 ? trading.defaultLeverage : 1;
  // P&L per position. For a LIVE account, trust the broker's server uPnL (`t.upnl`),
  // which is already in the ACCOUNT currency — client-side marking from the chart's
  // price stream would compute it in the INSTRUMENT currency and mis-mix currencies
  // (e.g. a USD stock in a EUR account). Paper marks to market from the live price
  // (same currency throughout) so P&L stays live without a poll.
  const liveUpnl = (t: TradeView): number | null => {
    if (t.kind !== "position" || t.quantity <= 0) return t.upnl;
    if (isLive) return t.upnl; // server-marked, account currency (refreshed by the live poll)
    const live = getLivePrice(t.epic);
    if (live == null) return t.upnl;
    return (t.side === "buy" ? 1 : -1) * t.quantity * (live - t.priceLevel);
  };
  const pnl = positions.reduce((s, p) => s + (liveUpnl(p) ?? 0), 0);
  const ordersMargin = usedMargin(orders, lev); // margin reserved by resting orders
  const balance = accountSummary?.balance ?? trading.accountBalance;
  const brokerMarginAllKnown =
    positions.length > 0 && positions.every((p) => p.margin != null);
  // Available: the broker's real free margin for a live account; for paper derive it
  // from the configured balance + open P&L less the leverage-based margin.
  const available =
    accountSummary?.available ??
    Math.max(0, balance + pnl - usedMargin(positions, lev) - ordersMargin);
  // Does the LIVE broker's `balance` already include open P&L? Capital's does (balance
  // = account value incl uPnL); IG / cash-balance brokers report a cash balance that
  // EXCLUDES it. This decides whether adding `pnl` would double-count it. (Capital's
  // `deposit` field is unrelated to used margin — see position-margin notes — so we
  // derive used margin from balance/available, not deposit.)
  const liveBalanceInclPnl = accountSummary != null && isCapital(activeBroker);
  // Account margin (deposit tied up by open positions). When the broker reports
  // per-position margin (Capital) sum those rows so the strip footer adds up to the
  // MARGIN column exactly. Otherwise derive used margin from the broker's balance −
  // available, adding `pnl` ONLY for cash-balance brokers (for Capital the balance
  // already includes it). For paper, compute from leverage.
  const accountMargin = accountSummary
    ? brokerMarginAllKnown
      ? positions.reduce((s, p) => s + (p.margin ?? 0), 0) + ordersMargin
      : Math.max(0, balance + (liveBalanceInclPnl ? 0 : pnl) - available - ordersMargin)
    : usedMargin(positions, lev);
  // Equity (account value). When the broker's per-position margin is known, equity =
  // available + margin-in-use (broker-agnostic). Otherwise: Capital's `balance` IS the
  // equity (already includes uPnL) — adding `pnl` would double-count it (the bug);
  // a cash balance (IG / paper) needs balance + open P&L.
  const equity =
    accountSummary && brokerMarginAllKnown
      ? available + accountMargin
      : liveBalanceInclPnl
        ? balance
        : balance + pnl;
  // Margin buffer: free margin as a share of equity (available ÷ equity).
  const marginBuffer = equity > 0 ? (available / equity) * 100 : 0;
  // Margin level: equity as a share of margin in use (equity ÷ account margin) — this
  // is Capital's "CFD Margin %"; null when nothing is at margin (no open positions).
  const marginLevel = accountMargin > 0 ? (equity / accountMargin) * 100 : null;
  // The broker's margin-call / close-out thresholds on the margin level above (a tooltip
  // note so a trader knows how far the % can fall). Capital.com publishes these; other
  // brokers omit the note until their levels are known.
  // https://capital.com/en-eu/ways-to-trade/margin-calls
  const marginCallNote =
    isCapital(activeBroker)
      ? " Capital.com issues a margin call at 100% (no new trades) and again at 75%; at 50% or below it starts closing positions (margin close-out)."
      : "";
  // P&L carries a directional caret + sign-driven tone (the one coloured stat).
  const pnlTone = pnl > 0 ? "pp-pos" : pnl < 0 ? "pp-neg" : "";
  const caret = pnl > 0 ? "▲" : pnl < 0 ? "▼" : "";
  const posCount = positions.length;

  // Enrich each row with the derived figures TV shows. P&L is marked to market from
  // the live price when available (see liveUpnl); last price is backed out of it so
  // it stays consistent with the P&L column; market/trade value + per-row margin
  // follow. Orders have no P&L, so their last/market/% are blank.
  const enrich = (t: TradeView): RowExt => {
    const tradeValue = t.priceLevel * t.quantity;
    // Prefer the broker's real per-position leverage + margin (Capital varies the
    // ratio per instrument, and its margin is in the account currency); fall back to
    // the configured leverage estimate for paper / brokers that don't report them.
    const leverage = t.leverage ?? lev;
    const margin = t.margin ?? tradeValue / leverage;
    let last: number | null = null;
    let marketValue: number | null = null;
    let pnlPct: number | null = null;
    const upnl = liveUpnl(t);
    if (t.kind === "position" && t.quantity > 0) {
      const sign = t.side === "buy" ? 1 : -1;
      if (isLive) {
        // `upnl` is account-currency, so we can't back out a price from it. Use the
        // real streamed price as `last`; P&L% is a price move (currency-invariant).
        const live = getLivePrice(t.epic);
        last = live ?? null;
        marketValue = last != null ? last * t.quantity : null;
        pnlPct =
          last != null && t.priceLevel !== 0
            ? (sign * (last - t.priceLevel)) / t.priceLevel * 100
            : null;
      } else if (upnl != null) {
        // Paper: P&L is instrument-currency, so back out `last` to stay consistent.
        last = t.priceLevel + (sign * upnl) / t.quantity;
        marketValue = last * t.quantity;
        pnlPct = tradeValue !== 0 ? (upnl / tradeValue) * 100 : null;
      }
    }
    return { ...t, upnl, last, marketValue, pnlPct, tradeValue, margin, leverage };
  };

  // Sorted view of the active tab. Nulls (no TP/SL/P&L/last/value/time) always sink
  // to the bottom regardless of direction, so missing values never crowd the top.
  const sorted = rows.map(enrich).sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const d = sort.dir === "asc" ? 1 : -1;
    return (typeof av === "string" ? av.localeCompare(bv as string) : av - (bv as number)) * d;
  });

  function applyCollapsed(next: boolean) {
    // Collapsing while maximized makes no sense (the workspace is hidden) — drop
    // out of maximize first so the chart comes back.
    if (next && maximized) onToggleMaximize?.();
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }
  // Maximize fills the chart view with the dock; expand first if collapsed so there
  // is something to fill.
  function clickMaximize() {
    if (collapsed) applyCollapsed(false);
    onToggleMaximize?.();
  }

  // Staged changes for the trades this panel shows, paired with their trade. The
  // trade currently open in the edit ticket is EXCLUDED — its pending edits are
  // owned by the ticket's Update/Cancel, so the panel must not also stage them
  // (which would double up the bar and, with auto-apply, fire on every keystroke).
  const staged = trades
    .map((t) => ({ trade: t, edit: pending[t.id] }))
    .filter(
      (x): x is { trade: TradeView; edit: PendingEdit } =>
        x.trade.id !== editId &&
        !!x.edit &&
        (x.edit.price != null || x.edit.stop != null || x.edit.takeProfit != null),
    );

  // Open the order ticket in edit mode for `t`: re-scope the chart to its symbol
  // (so the draggable SL/TP lines are visible), then SELECT it — setTradeSelected is
  // the single path that loads edit mode + reveals the panel + discards the outgoing
  // trade's un-applied edits. Triggered by a row click, double-click, or its pencil.
  function edit(t: TradeView) {
    onJumpToEpic?.(t.epic);
    setTradeSelected(t.id);
  }

  function clearStaged() {
    // Drop pending for the shown trades (leave other epics' pending intact, and
    // leave the trade open in the edit ticket alone — its pending is owned by
    // EditTicket's Update/Cancel, not the panel's Apply/Discard).
    const next = { ...pendingEditsSignal.value };
    for (const t of trades) if (t.id !== editId) delete next[t.id];
    pendingEditsSignal.set(next);
  }

  // Suppress-confirmation: when the user opted out, apply a staged drag at once
  // instead of waiting for the Apply button. Keyed on the staged CONTENT (levels,
  // not just count) so a NEW drag re-applies, but a drag the broker REJECTED isn't
  // retried in a tight loop — applyAll leaves `staged` intact on failure, and busy
  // cycling apply→null would otherwise re-fire this effect forever.
  const stagedKey = staged
    .map((s) => `${s.trade.id}:${s.edit.price ?? ""}:${s.edit.stop ?? ""}:${s.edit.takeProfit ?? ""}`)
    .join("|");
  const autoAppliedKey = useRef<string>("");
  useEffect(() => {
    if (
      !confirmLineEdits &&
      !lineDragging && // wait for the drag to END (no per-pixel broker writes)
      staged.length > 0 &&
      busy == null &&
      autoAppliedKey.current !== stagedKey
    ) {
      autoAppliedKey.current = stagedKey;
      void applyAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmLineEdits, stagedKey, busy, lineDragging]);

  async function applyAll() {
    setBusy("apply");
    setError(null);
    try {
      for (const { trade, edit } of staged) {
        await applyLevels(
          trade,
          {
            // Entry repricing only applies to a resting order.
            limit_level: trade.kind === "order" ? edit.price ?? null : null,
            stop_level: edit.stop ?? null,
            take_profit_level: edit.takeProfit ?? null,
          },
          account,
        );
      }
      clearStaged();
      refreshTrades();
      // Allow a later identical drag to auto-apply again (the guard only exists to
      // stop retrying a REJECTED set; a success clears it).
      autoAppliedKey.current = "";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed.");
    } finally {
      setBusy(null);
    }
  }

  async function act(t: TradeView) {
    setBusy(t.id);
    try {
      if (t.kind === "position") await closePosition(t.id, account);
      else await cancelWorkingOrder(t.id, account);
      refreshTrades();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  const fmtPnl = (v: number | null) =>
    v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
  const pnlClass = (v: number | null) => (v == null ? "" : v >= 0 ? "pp-pos" : "pp-neg");
  const entryLabel = tab === "positions" ? "Avg fill" : "Limit";

  return (
    <section className={`pp${collapsed ? " pp-collapsed" : ""}`}>
      {!collapsed && (
        <>
          {/* Positions / Orders tabs with live counts. Window controls (maximize fills
              the chart view with the dock; close collapses it) ride at the far right. */}
          <nav className="pp-tabs">
            <TabButton label="Positions" count={positions.length} on={tab === "positions"} onClick={() => setTab("positions")} />
            <TabButton label="Orders" count={orders.length} on={tab === "orders"} onClick={() => setTab("orders")} />
            <div className="pp-winctl">
              <button
                className="pp-iconbtn"
                onClick={clickMaximize}
                aria-pressed={maximized}
                title={maximized ? "Restore dock" : "Maximize dock"}
              >
                {maximized ? <RestoreIcon /> : <MaximizeIcon />}
              </button>
              <button
                className="pp-iconbtn"
                onClick={() => applyCollapsed(true)}
                title="Close book"
              >
                <CloseIcon />
              </button>
            </div>
          </nav>

          {/* The old "Pending changes" Apply/Discard bar lived here. Drag-staged
              edits now surface on the on-chart pill for the (auto-)selected trade,
              and confirmLineEdits=false still auto-applies via the effect below. */}

          {error && <div className="pp-error">{error}</div>}

          {rows.length === 0 ? (
            <div className="pp-empty">
              {tab === "positions" ? "No open positions." : "No working orders."}
            </div>
          ) : (
            <div className="pp-table-wrap">
              <table className="pp-table">
                <thead>
                  <tr>
                    <th className="pp-c-sym"><SortHeader label="Symbol" col="epic" sort={sort} onSort={toggleSort} title="Instrument" /></th>
                    <th className="pp-c-side"><SortHeader label="Side" col="side" sort={sort} onSort={toggleSort} title="Direction — long (buy) profits when price rises, short (sell) when it falls" /></th>
                    <th className="pp-c-num"><SortHeader label="Qty" col="quantity" sort={sort} onSort={toggleSort} title="Position size (number of contracts / shares)" /></th>
                    <th className="pp-c-num"><SortHeader label={entryLabel} col="priceLevel" sort={sort} onSort={toggleSort} title={tab === "positions" ? "Average price you opened the position at" : "Limit price the resting order will fill at"} /></th>
                    <th className="pp-c-num"><SortHeader label="TP" col="takeProfit" sort={sort} onSort={toggleSort} title="Take-profit — auto-closes the position in profit at this price" /></th>
                    <th className="pp-c-num"><SortHeader label="SL" col="stop" sort={sort} onSort={toggleSort} title="Stop-loss — auto-closes the position to cap the loss at this price" /></th>
                    <th className="pp-c-num"><SortHeader label="Last" col="last" sort={sort} onSort={toggleSort} title="Latest market price" /></th>
                    <th className="pp-c-num"><SortHeader label="P&L" col="upnl" sort={sort} onSort={toggleSort} title="Unrealized profit / loss in the account currency (broker-reported for live accounts)" /></th>
                    <th className="pp-c-num"><SortHeader label="P&L %" col="pnlPct" sort={sort} onSort={toggleSort} title="Unrealized P&L as a percentage of the price move from entry" /></th>
                    <th className="pp-c-num"><SortHeader label="Trade val" col="tradeValue" sort={sort} onSort={toggleSort} title="Notional at entry = entry price × quantity (instrument currency)" /></th>
                    <th className="pp-c-num"><SortHeader label="Mkt val" col="marketValue" sort={sort} onSort={toggleSort} title="Current notional = last price × quantity (instrument currency)" /></th>
                    <th className="pp-c-num"><SortHeader label="Lev" col="leverage" sort={sort} onSort={toggleSort} title="Leverage on this position — from the broker for live accounts (Capital varies it by instrument, e.g. 5:1 on US shares)" /></th>
                    <th className="pp-c-num"><SortHeader label="Margin" col="margin" sort={sort} onSort={toggleSort} title="Deposit required to hold this position, in the account currency = current notional ÷ leverage (broker figure for live accounts)" /></th>
                    <th className="pp-c-time"><SortHeader label="Time" col="openedAt" sort={sort} onSort={toggleSort} title={tab === "positions" ? "When the position was opened" : "When the order was placed"} /></th>
                    <th className="pp-c-act" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((t) => {
                    const long = t.side === "buy";
                    const isOrder = t.kind === "order";
                    const linesHidden = hidden.includes(t.id);
                    const prec = precOf(t.epic);
                    const isFocused = focusedEpic != null && t.epic === focusedEpic;
                    return (
                      <tr
                        className={`pp-row pp-dir-${long ? "long" : "short"}${
                          editId === t.id ? " pp-editing" : ""
                        }${isFocused ? " pp-focused" : ""}${
                          selectedId === t.id ? " pp-selected" : ""
                        }${hoveredId === t.id ? " pp-hovered" : ""}`}
                        key={t.id}
                        // Single click → open/focus the chart for this trade's symbol
                        // AND (de)select the trade, so its chart lines + this row light
                        // up together. Double click → also reveal the ticket in edit mode.
                        onClick={() => {
                          onJumpToEpic?.(t.epic);
                          toggleTradeSelected(t.id);
                        }}
                        onDoubleClick={() => edit(t)}
                        onMouseEnter={() => setTradeHovered(t.id)}
                        onMouseLeave={() => {
                          if (tradeLineUiSignal.value.hovered === t.id) setTradeHovered(null);
                        }}
                        title="Click to open chart · double-click to edit"
                      >
                        <td className="pp-c-sym">{t.epic}</td>
                        <td className={`pp-c-side ${long ? "pp-side-long" : "pp-side-short"}`}>
                          {tradeLabel(t.kind, t.side)}
                        </td>
                        <td className="pp-c-num">{t.quantity}</td>
                        <td className="pp-c-num">{fmt(t.priceLevel, prec)}</td>
                        <td className={`pp-c-num${t.takeProfit != null ? " pp-lvl-tp" : " pp-dash"}`}>
                          {t.takeProfit != null ? fmt(t.takeProfit, prec) : "—"}
                        </td>
                        <td className={`pp-c-num${t.stop != null ? " pp-lvl-sl" : " pp-dash"}`}>
                          {t.stop != null ? fmt(t.stop, prec) : "—"}
                        </td>
                        <td className={`pp-c-num${t.last == null ? " pp-dash" : ""}`}>
                          {t.last != null ? fmt(t.last, prec) : "—"}
                        </td>
                        <td className="pp-c-num">
                          {isOrder ? (
                            <span className="pp-resting">resting</span>
                          ) : (
                            <span className={`pp-pnl ${pnlClass(t.upnl)}`}>{fmtPnl(t.upnl)}</span>
                          )}
                        </td>
                        <td className={`pp-c-num${t.pnlPct == null ? " pp-dash" : ` ${pnlClass(t.pnlPct)}`}`}>
                          {t.pnlPct != null
                            ? `${t.pnlPct >= 0 ? "+" : "−"}${Math.abs(t.pnlPct).toFixed(2)}%`
                            : "—"}
                        </td>
                        <td className="pp-c-num">{cash(t.tradeValue)}</td>
                        <td className={`pp-c-num${t.marketValue == null ? " pp-dash" : ""}`}>
                          {t.marketValue != null ? cash(t.marketValue) : "—"}
                        </td>
                        <td className="pp-c-num pp-c-lev">{t.leverage}:1</td>
                        <td className="pp-c-num">{cash(t.margin)}</td>
                        <td className="pp-c-time">{fmtTime(t.openedAt)}</td>
                        <td className="pp-c-act">
                          <div className="pp-actions">
                            <button
                              className={`pp-iconbtn${linesHidden ? " off" : ""}`}
                              title={linesHidden ? "Show lines on chart" : "Hide lines on chart"}
                              aria-pressed={linesHidden}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleTradeHidden(t.id);
                              }}
                            >
                              <EyeIcon hidden={linesHidden} />
                            </button>
                            <button
                              className="pp-iconbtn"
                              title="Edit levels"
                              onClick={(e) => {
                                e.stopPropagation();
                                edit(t);
                              }}
                            >
                              <PencilIcon />
                            </button>
                            <button
                              className="pp-iconbtn pp-iconbtn-x"
                              title={isOrder ? "Cancel order" : "Close position"}
                              disabled={busy === t.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                act(t);
                              }}
                            >
                              <CloseIcon />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Account strip — sits BELOW the table (per request): collapse toggle + account
          identity on the left, TV's dense stat row on the right. Collapsed, the dock is
          just this bar and the stats compress to one live ticker line. */}
      <div className="pp-bar">
        {/* Account tabs — switch env (paper/demo/live) WITHIN the active broker
            without changing the workspace. Always shown, even for a single-account
            broker, so the active env always reads clearly. Each tab carries its own
            open/close chevron: the active tab's toggles the dock, an inactive tab's
            switches to that account and opens its book. */}
        <div className="pp-acct-tabs" role="tablist" aria-label="Account">
          {acctTabs.map((a) => {
            const isActive = a.key === account;
            const t = acctTier(a);
            // The book is on screen only for the active env while expanded; that's
            // the lone case the chevron points "down" (collapse). Every other tab
            // shows the "up" (open) affordance.
            const bookVisible = isActive && !collapsed;
            return (
              <button
                key={a.key}
                className={`pp-acct-tab ${t}${isActive ? " active" : ""}`}
                role="tab"
                aria-selected={isActive}
                aria-expanded={bookVisible}
                // The whole tab toggles its book: the active tab opens/closes the
                // dock, an inactive tab switches to that account and opens it.
                onClick={() => {
                  if (!isActive) onAccountChange?.(a.key);
                  applyCollapsed(isActive ? !collapsed : false);
                }}
                title={
                  bookVisible
                    ? `Collapse ${brokerLabel(a.broker)} · ${envLabel(a.env)} book`
                    : isActive
                      ? `Expand ${brokerLabel(a.broker)} · ${envLabel(a.env)} book`
                      : `Show ${brokerLabel(a.broker)} · ${envLabel(a.env)} book`
                }
              >
                <span className={`env-dot ${t}`} aria-hidden="true" />
                {envLabel(a.env)}
                <span className={`pp-chevron${bookVisible ? "" : " open"}`}>
                  <ChevronIcon />
                </span>
              </button>
            );
          })}
        </div>

        {collapsed ? (
          <div className="pp-ticker">
            <span className={`pp-ticker-pnl ${pnlTone}`}>
              {caret && <span className="pp-caret">{caret}</span>}
              {cash(Math.abs(pnl))} {cur}
            </span>
            <span className="pp-ticker-dot" />
            <span>
              {posCount} {posCount === 1 ? "position" : "positions"}
            </span>
            <span className="pp-ticker-dot" />
            <span>buffer {marginBuffer.toFixed(2)}%</span>
          </div>
        ) : (
          <div className="pp-acct">
            <div
              className="pp-stat"
              title="Open profit / loss across all positions, marked to live prices (broker-reported for live accounts)"
            >
              <span className="pp-stat-label">Unrealized P&amp;L</span>
              <span className={`pp-stat-val num ${pnlTone}`}>
                {pnl >= 0 ? "" : "−"}
                {cash(Math.abs(pnl))} {cur}
              </span>
            </div>
            <Stat
              label="Balance"
              value={`${cash(balance)} ${cur}`}
              title={
                isLive
                  ? "Account value reported by the broker (cash plus open P&L)"
                  : "Configured paper-trading cash balance"
              }
            />
            <Stat
              label="Equity"
              value={`${cash(equity)} ${cur}`}
              title="Account value = available margin + margin in use (cash plus open P&L). What the account is worth right now."
            />
            <Stat
              label="Account margin"
              value={`${cash(accountMargin)} ${cur}`}
              title="Total deposit currently tied up by open positions — the sum of each position's MARGIN (broker figures for live accounts)"
            />
            <Stat
              label="Available"
              value={`${cash(available)} ${cur}`}
              title="Free margin available to open new positions (broker-reported for live accounts)"
            />
            <Stat
              label="Orders margin"
              value={`${cash(ordersMargin)} ${cur}`}
              title="Margin reserved by resting (not-yet-filled) working orders"
            />
            <Stat
              label="Margin buffer"
              value={`${marginBuffer.toFixed(2)}%`}
              title={`Free margin as a share of equity (available ÷ equity). Higher = more headroom before a margin call.${marginCallNote}`}
            />
            <Stat
              label="Margin level"
              value={marginLevel != null ? `${marginLevel.toFixed(2)}%` : "—"}
              title={`Equity as a share of margin in use (equity ÷ account margin) — Capital's 'CFD Margin %'. Falls toward 100% as risk rises.${marginCallNote}`}
            />
          </div>
        )}
      </div>
    </section>
  );
}

export function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
  title?: string;
}) {
  return (
    <Tooltip content={title}>
      <div className="pp-stat">
        <span className="pp-stat-label">{label}</span>
        <span className={`pp-stat-val num${tone ? ` pp-${tone}` : ""}`}>{value}</span>
      </div>
    </Tooltip>
  );
}

// Clickable column header: click to sort by this column, click again to flip
// direction. A caret marks the active column; inactive heads stay quiet.
export function SortHeader({
  label,
  col,
  sort,
  onSort,
  title,
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  title?: string;
}) {
  const active = sort.key === col;
  return (
    <Tooltip content={title}>
      <button
        className={`pp-sort${active ? " on" : ""}`}
        onClick={() => onSort(col)}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <span>{label}</span>
        <span className="pp-sort-caret" aria-hidden="true">
          {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </Tooltip>
  );
}

function TabButton({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`pp-tab${on ? " on" : ""}`} onClick={onClick}>
      {label}
      {count > 0 && <span className="pp-count">{count}</span>}
    </button>
  );
}

// Eye (lines shown) / eye-with-slash (lines hidden) — toggles a trade's on-chart
// lines. Inherits colour from the button via currentColor.
function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {hidden && (
        <line
          x1="3"
          y1="21"
          x2="21"
          y2="3"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Chevron: a down-pointing V (collapse). Rotated 180° via `.open` to point up
// (expand) — the dock lives above the strip, so up = reveal, down = tuck away.
function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Maximize: a plain frame (the dock about to fill the view).
function MaximizeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

// Restore: two offset corners (shrink back from full view).
function RestoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M8 8h8v8H8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.5h9.5V16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.55"
      />
    </svg>
  );
}

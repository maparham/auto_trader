// Positions tab (spec: 2026-09-07-mobile-companion-design.md, Task 11). The
// desktop dock (PositionsPanel.tsx) at phone width: the same Positions /
// Orders tabs with live counts, the same table (PositionsTable.tsx: one
// column list, sortable heads with tooltips; it scrolls sideways), and the
// same account stat strip under it, all on the dock's `pp-*` classes so the
// two read as one control. mobile.css carries the few phone overrides (no
// table floor, scrolling stat strip). What stays mobile-specific: tapping a row opens a detail
// Sheet whose Close / Cancel button routes through the shared
// `requestConfirm` dialog before touching the broker, mirroring the chart
// pill's flow in chart/TradePills.tsx (same closePosition/cancelWorkingOrder
// call, same refreshTrades after). No optimistic removal: the row only
// disappears once the server confirms via the next trades poll.
//
// The stat math (P&L marking, equity, margins) is lib/accountStats.ts, shared
// with the dock.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  subscribeTrades,
  subscribeLivePrices,
  refreshTrades,
  getTradesAccount,
  fetchAccountSummary,
  closePosition,
  cancelWorkingOrder,
  tradeLabel,
  brokerLabel,
  brokerOf,
  isRealMoneyAccount,
  type TradeView,
  type AccountSummary,
} from "../lib/trading";
import { accountStats, enrichTrade, type EnrichedTrade } from "../lib/accountStats";
import { groupPositions, type PositionGroup } from "../lib/positionGroups";
import { loadSettings } from "../theme";
import { mobileSettingsVersion, showMobileEpic } from "./mobileChartState";
import { requestConfirm } from "../lib/signals";
import { toast } from "../lib/notify";
import Sheet from "./Sheet";
import { PositionsHead } from "../PositionsTable";
import {
  DEFAULT_SORT,
  cash,
  fmtPnl,
  groupCells,
  nextSort,
  pnlClass,
  positionCells,
  sortCompare,
  type SortKey,
  type SortState,
  type TableTab,
} from "../lib/positionsTable";

// The dock formats levels to the symbol's precision; the phone has no
// per-symbol precision source, so a level prints as stored, trimmed.
function fmtLevel(n: number | null): string {
  return n == null
    ? "—"
    : n.toLocaleString(undefined, {
        maximumFractionDigits: 6,
        useGrouping: false,
      });
}

// Decimals a stored level carries, so a roll-up's weighted average prints at
// its members' precision rather than at float noise.
function decimalsOf(n: number): number {
  const str = String(n);
  const i = str.indexOf(".");
  return i < 0 ? 0 : str.length - i - 1;
}

function fmtAvg(n: number | null, members: { priceLevel: number }[]): string {
  if (n == null) return "—";
  const d = Math.max(0, ...members.map((m) => decimalsOf(m.priceLevel)));
  return n.toFixed(Math.min(d, 6));
}

// Each row's and group's place in the table, from one sort of the current
// values. Groups rank under a `group:` prefix so they cannot collide with ids.
function rankRows(rows: EnrichedTrade[], sort: SortState, tab: TableTab, key: string) {
  const compare = sortCompare(sort);
  const sorted = [...rows].sort(compare);
  const rank = new Map(sorted.map((r, i) => [r.id, i]));
  if (tab === "positions")
    groupPositions(sorted)
      .sort(compare)
      .forEach((g, i) => rank.set(`group:${g.epic}`, i));
  return { key, rank };
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="pp-stat">
      <span className="pp-stat-label">{label}</span>
      <span className={`pp-stat-val num${tone ? ` ${tone}` : ""}`}>{value}</span>
    </div>
  );
}

export default function MobilePositionsView() {
  const [trades, setTrades] = useState<TradeView[]>([]);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [selected, setSelected] = useState<TradeView | null>(null);
  const [tab, setTab] = useState<TableTab>("positions");
  // Same-symbol positions fold under a roll-up header row, as in the dock.
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [, setTick] = useState(0);

  useEffect(() => subscribeTrades(setTrades), []);
  // Paper P&L marks to the chart's live price: re-render on each tick.
  useEffect(() => subscribeLivePrices(() => setTick((n) => n + 1)), []);

  useEffect(() => {
    let cancelled = false;
    fetchAccountSummary(getTradesAccount())
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const account = getTradesAccount();
  const broker = brokerOf(account);
  const live = isRealMoneyAccount(account);
  // Read once, and again when the settings sheet saves (not on every price tick).
  const settingsVersion = useSyncExternalStore(
    (fn) => mobileSettingsVersion.subscribe(fn),
    () => mobileSettingsVersion.value,
  );
  const trading = useMemo(() => loadSettings().trading, [settingsVersion]);
  const cur = summary?.currency ?? trading.accountCurrency;

  const positions = trades.filter((t) => t.kind === "position");
  const orders = trades.filter((t) => t.kind === "order");

  const stats = accountStats({ positions, orders, summary, trading, broker, isLive: live });
  const { pnl, balance, available, accountMargin, ordersMargin, equity, marginBuffer, marginLevel, noBrokerData } = stats;
  const money = (n: number) => (noBrokerData ? "—" : `${cash(n)} ${cur}`);
  const pct = (n: number | null) => (noBrokerData || n == null ? "—" : `${n.toFixed(2)}%`);
  const pnlTone = pnl > 0 ? "pp-pos" : pnl < 0 ? "pp-neg" : "";
  const enrich = (t: TradeView): EnrichedTrade => enrichTrade(t, stats, live);

  // Sorted as in the dock (positions by their own value, groups by their
  // roll-up), but the order is only worked out again when the sort or the set
  // of rows changes, never on a price tick: with P&L as the key a re-sort
  // under the finger would open the wrong row's detail sheet.
  const toggleSort = (key: SortKey) => setSort((s) => nextSort(s, key));
  const unsorted = (tab === "positions" ? positions : orders).map(enrich);
  const orderKey = [tab, sort.key, sort.dir, ...unsorted.map((r) => r.id).sort()].join("|");
  const [order, setOrder] = useState(() => rankRows(unsorted, sort, tab, orderKey));
  if (order.key !== orderKey) setOrder(rankRows(unsorted, sort, tab, orderKey));
  const byRank = (k: string) => order.rank.get(k) ?? Number.MAX_SAFE_INTEGER;
  const rows = unsorted.sort((a, b) => byRank(a.id) - byRank(b.id));
  const groups: PositionGroup<EnrichedTrade>[] | null =
    tab === "positions"
      ? groupPositions(rows).sort((a, b) => byRank(`group:${a.epic}`) - byRank(`group:${b.epic}`))
      : null;
  const toggleGroup = (epic: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (next.has(epic)) next.delete(epic);
      else next.add(epic);
      return next;
    });

  // One position / order row; `inGroup` rows sit under their symbol's header.
  const renderRow = (t: EnrichedTrade, inGroup: boolean) => {
    const long = t.side === "buy";
    return (
      <tr
        key={t.id}
        className={`pp-row pp-dir-${long ? "long" : "short"}${inGroup ? " pp-member" : ""}`}
        onClick={() => setSelected(t)}
      >
        {positionCells(t, fmtLevel, { tips: false })}
      </tr>
    );
  };

  function act(t: TradeView) {
    const isOrder = t.kind === "order";
    const label = tradeLabel(t.kind, t.side);
    requestConfirm({
      title: isOrder ? "Cancel order" : "Close position",
      message: isOrder
        ? `Cancel this ${label} order on ${t.epic}?`
        : `Close this ${label} position on ${t.epic} at market${live ? " (real money)" : ""}?`,
      confirmLabel: isOrder ? "Cancel order" : "Close position",
      onConfirm: async () => {
        try {
          if (isOrder) await cancelWorkingOrder(t.id, account);
          else await closePosition(t.id, account);
          refreshTrades();
          setSelected(null);
        } catch (err) {
          // Server-confirmed state only: the row stays and the sheet stays
          // open so the trader can retry, but the failure is surfaced
          // (matches TradePills' onConfirm catch).
          toast(err instanceof Error ? err.message : "Action failed");
        }
      },
    });
  }

  return (
    <div className="m-pos-view pp">
      <nav className="pp-tabs">
        <button className={`pp-tab${tab === "positions" ? " on" : ""}`} onClick={() => setTab("positions")}>
          Positions
          {positions.length > 0 && <span className="pp-count">{positions.length}</span>}
        </button>
        <button className={`pp-tab${tab === "orders" ? " on" : ""}`} onClick={() => setTab("orders")}>
          Orders
          {orders.length > 0 && <span className="pp-count">{orders.length}</span>}
        </button>
      </nav>

      {rows.length === 0 ? (
        <div className="pp-empty">{tab === "positions" ? "No open positions." : "No working orders."}</div>
      ) : (
        <div className="pp-table-wrap">
          <table className="pp-table">
            <thead>
              <PositionsHead tab={tab} sort={sort} onSort={toggleSort} tips={false} />
            </thead>
            <tbody>
              {groups == null
                ? rows.map((t) => renderRow(t, false))
                : groups.flatMap((g) => {
                    // A lone position is a plain row; several under one symbol get
                    // a header with the roll-up and the positions folded beneath.
                    if (g.positions.length < 2) return g.positions.map((t) => renderRow(t, false));
                    const isFolded = folded.has(g.epic);
                    const dir = g.side === "buy" ? "long" : g.side === "sell" ? "short" : "mixed";
                    const header = (
                      <tr
                        key={`group:${g.epic}`}
                        className={`pp-row pp-group pp-dir-${dir}${isFolded ? " pp-folded" : ""}`}
                        onClick={() => toggleGroup(g.epic)}
                      >
                        {groupCells(
                          g,
                          <td className="pp-c-sym">
                            <button
                              className="pp-group-toggle"
                              aria-expanded={!isFolded}
                              aria-label={isFolded ? "Show positions" : "Hide positions"}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleGroup(g.epic);
                              }}
                            >
                              <span className="pp-group-chevron" aria-hidden="true">
                                ›
                              </span>
                            </button>
                            {g.epic}
                            <span className="pp-group-count">{g.positions.length}</span>
                          </td>,
                          (n) => fmtAvg(n, g.positions),
                        )}
                      </tr>
                    );
                    return isFolded ? [header] : [header, ...g.positions.map((t) => renderRow(t, true))];
                  })}
            </tbody>
          </table>
        </div>
      )}

      <div className="pp-bar">
        <span className="pp-acct-broker">
          {brokerLabel(broker)}
          {summary == null && !live && " · Paper account"}
          {live && <span className="m-pos-live">LIVE</span>}
        </span>
        <div className="pp-acct">
          <Stat
            label="Unrealized P&L"
            value={`${pnl < 0 ? "−" : ""}${cash(Math.abs(pnl))} ${cur}`}
            tone={pnlTone}
          />
          <Stat label="Balance" value={money(balance)} />
          <Stat label="Equity" value={money(equity)} />
          <Stat label="Account margin" value={money(accountMargin)} />
          <Stat label="Available" value={money(available)} />
          <Stat label="Orders margin" value={money(ordersMargin)} />
          <Stat label="Margin buffer" value={pct(marginBuffer)} />
          <Stat label="Margin level" value={pct(marginLevel)} />
        </div>
      </div>

      {selected && (
        <Sheet
          title={`${tradeLabel(selected.kind, selected.side)} · ${selected.epic}`}
          onClose={() => setSelected(null)}
        >
          <div className="m-pos-detail">
            <div className="m-pos-detail-row">
              <span>Quantity</span>
              <span>{selected.quantity}</span>
            </div>
            <div className="m-pos-detail-row">
              <span>{selected.kind === "order" ? "Limit" : "Avg fill"}</span>
              <span>{fmtLevel(selected.priceLevel)}</span>
            </div>
            <div className="m-pos-detail-row">
              <span>Stop loss</span>
              <span>{fmtLevel(selected.stop)}</span>
            </div>
            <div className="m-pos-detail-row">
              <span>Take profit</span>
              <span>{fmtLevel(selected.takeProfit)}</span>
            </div>
            {selected.kind === "position" && (
              <div className="m-pos-detail-row">
                <span>uPnL</span>
                <span className={pnlClass(selected.upnl)}>{fmtPnl(selected.upnl)}</span>
              </div>
            )}
            <button
              className="m-pos-chart-btn"
              onClick={() => {
                showMobileEpic(selected.epic, decimalsOf(selected.priceLevel));
                setSelected(null);
              }}
            >
              Show on chart
            </button>
            <button className="m-pos-act-btn" onClick={() => act(selected)}>
              {selected.kind === "order" ? "Cancel order" : "Close position"}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

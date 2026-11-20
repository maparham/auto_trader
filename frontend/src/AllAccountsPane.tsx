// The dock's "All accounts" tab: every dealing account's open positions, one
// section per account. View-only: a row click opens that position (App asks
// before switching account). Data and polling come from app/useAllAccounts.
import { useEffect, useRef, useState } from "react";
import Tooltip from "./components/Tooltip";
import { PositionsHead } from "./PositionsTable";
import type { AllAccountsData } from "./app/useAllAccounts";
import { orderSections, sectionFigures } from "./lib/allAccounts";
import { enrichTrade, type EnrichedTrade } from "./lib/accountStats";
import { groupPositions } from "./lib/positionGroups";
import {
  DEFAULT_SORT,
  groupCells,
  nextSort,
  pnlClass,
  positionCells,
  sortCompare,
  type SortKey,
  type SortState,
} from "./lib/positionsTable";
import { brokerLabel, type BrokerAccount, type TradeAccount, type TradeView } from "./lib/trading";
import type { TradingSettings } from "./theme";

interface Props {
  data: AllAccountsData;
  active: TradeAccount;
  trading: TradingSettings;
  onOpen: (account: TradeAccount, epic: string, dealId: string) => void;
  /** Off on the phone: a tap would open a row or header tooltip with the tap's action. */
  tips?: boolean;
}

const decimalsOf = (n: number | null | undefined) =>
  n == null ? 0 : Math.min(6, (String(n).split(".")[1] ?? "").length);
const money = (n: number | null) =>
  n == null ? "-" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `Updated ${s} s ago` : `Updated ${Math.floor(s / 60)} min ago`;
}

export default function AllAccountsPane({ data, active, trading, onOpen, tips = true }: Props) {
  // Expanded per account: decided when its positions first load, then the user's.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const decided = useRef(new Set<string>());
  const [showHidden, setShowHidden] = useState(false);
  // One sort for every account's table, as in the Positions tab.
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const onSort = (key: SortKey) => setSort((s) => nextSort(s, key));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const a of data.visible) {
      const p = data.snaps[a.key]?.positions;
      if (p == null || decided.current.has(a.key)) continue;
      decided.current.add(a.key);
      next[a.key] = p.length > 0;
    }
    if (Object.keys(next).length) setExpanded((e) => ({ ...e, ...next }));
  }, [data.visible, data.snaps]);

  const toggle = (key: string) => {
    decided.current.add(key);
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  };

  const sections = orderSections(data.visible, data.snaps, active);

  return (
    <div className="aa-pane">
      <div className="aa-top">
        <span className="aa-updated">{data.updatedAt != null ? ago(now - data.updatedAt) : ""}</span>
        <Tooltip content="Refresh now">
          <button className="pp-iconbtn" aria-label="Refresh now" onClick={() => data.refresh()}>
            <RefreshIcon />
          </button>
        </Tooltip>
      </div>
      {sections.map((a) => (
        <AccountSection
          key={a.key}
          acct={a}
          data={data}
          isActive={a.key === active}
          open={!!expanded[a.key]}
          onToggle={() => toggle(a.key)}
          trading={trading}
          onOpen={onOpen}
          sort={sort}
          onSort={onSort}
          tips={tips}
        />
      ))}
      {data.hidden.length > 0 && (
        <div className="aa-hidden">
          <button className="aa-hidden-toggle" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)}>
            {`Hidden (${data.hidden.length})`}
          </button>
          {showHidden &&
            data.hidden.map((a) => (
              <div key={a.key} className="aa-hidden-row">
                <span>{brokerLabel(a.broker)}</span>
                <Tooltip content="Show this account">
                  <button className="pp-iconbtn" aria-label="Show this account" onClick={() => data.setHidden(a.key, false)}>
                    <EyeIcon off />
                  </button>
                </Tooltip>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function AccountSection({
  acct,
  data,
  isActive,
  open,
  onToggle,
  trading,
  onOpen,
  sort,
  onSort,
  tips,
}: {
  acct: BrokerAccount;
  data: AllAccountsData;
  isActive: boolean;
  open: boolean;
  onToggle: () => void;
  trading: TradingSettings;
  onOpen: Props["onOpen"];
  sort: SortState;
  onSort: (key: SortKey) => void;
  tips: boolean;
}) {
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const toggleGroup = (epic: string) =>
    setFolded((s) => {
      const next = new Set(s);
      if (next.has(epic)) next.delete(epic);
      else next.add(epic);
      return next;
    });
  const snap = data.snaps[acct.key];
  const name = brokerLabel(acct.broker);
  const positions = snap?.positions ?? [];
  const fig = snap ? sectionFigures(snap, acct, trading) : null;
  const cur = fig?.currency ? ` ${fig.currency}` : "";
  return (
    <section className="aa-acct" aria-label={name}>
      <div className="aa-head">
        <button className="aa-head-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="pp-group-chevron" aria-hidden="true">›</span>
          <span className="aa-name">{name}</span>
          {isActive && <span className="aa-current">current</span>}
          <span className="aa-npos">{snap?.positions == null ? "" : positions.length}</span>
        </button>
        {fig && (
          <span className="aa-figs">
            <span className={pnlClass(fig.pnl)}>P&amp;L {money(fig.pnl)}{cur}</span>
            {fig.equity != null && <span>Equity {money(fig.equity)}{cur}</span>}
            {fig.marginLevel != null && <span>Margin level {fig.marginLevel.toFixed(0)}%</span>}
          </span>
        )}
        <Tooltip content="Hide this account">
          <button className="pp-iconbtn" aria-label="Hide this account" onClick={() => data.setHidden(acct.key, true)}>
            <EyeIcon />
          </button>
        </Tooltip>
      </div>
      {snap?.error && <div className="pp-error">{snap.error}</div>}
      {open &&
        (snap?.positions == null ? (
          <div className="pp-empty">Not loaded yet</div>
        ) : positions.length === 0 ? (
          <div className="pp-empty">No open positions</div>
        ) : (
          <PositionsTable
            positions={positions}
            trading={trading}
            sort={sort}
            onSort={onSort}
            folded={folded}
            onToggleGroup={toggleGroup}
            onOpen={(t) => onOpen(acct.key, t.epic, t.id)}
            tips={tips}
          />
        ))}
    </section>
  );
}

// The broker's own figures throughout: the chart price cache belongs to the
// active broker, so P&L is the broker's and "Last" is its mark.
const brokerFigures = (trading: TradingSettings) => ({
  lev: trading.defaultLeverage > 0 ? trading.defaultLeverage : 1,
  liveUpnl: (t: TradeView) => t.upnl,
});

// Another broker's market precision is unknown here: use the most decimals any
// of the rows' prices carries.
function levelFormat(rows: TradeView[]): (n: number | null) => string {
  const d = Math.max(0, ...rows.flatMap((t) => [t.priceLevel, t.mark, t.stop, t.takeProfit].map(decimalsOf)));
  return (n) => (n == null ? "—" : n.toFixed(d));
}

// The Positions tab's table, read-only: same columns, cells, sort and symbol groups.
function PositionsTable({
  positions,
  trading,
  sort,
  onSort,
  folded,
  onToggleGroup,
  onOpen,
  tips,
}: {
  positions: TradeView[];
  trading: TradingSettings;
  sort: SortState;
  onSort: (key: SortKey) => void;
  folded: Set<string>;
  onToggleGroup: (epic: string) => void;
  onOpen: (t: TradeView) => void;
  tips: boolean;
}) {
  const stats = brokerFigures(trading);
  const compare = sortCompare(sort);
  const rows = positions.map((t) => enrichTrade(t, stats, true, () => undefined)).sort(compare);
  const groups = groupPositions(rows).sort(compare);
  const row = (t: EnrichedTrade, inGroup: boolean) => (
    <Tooltip key={t.id} asChild content={tips ? "Click: open this position." : undefined}>
      <tr
        className={`pp-row pp-dir-${t.side === "buy" ? "long" : "short"}${inGroup ? " pp-member" : ""}`}
        onClick={() => onOpen(t)}
      >
        {positionCells(t, levelFormat([t]), { tips })}
      </tr>
    </Tooltip>
  );
  return (
    <table className="pp-table aa-table">
      <thead>
        <PositionsHead tab="positions" sort={sort} onSort={onSort} tips={tips} />
      </thead>
      <tbody>
        {groups.flatMap((g) => {
          if (g.positions.length < 2) return g.positions.map((t) => row(t, false));
          const isFolded = folded.has(g.epic);
          const dir = g.side === "buy" ? "long" : g.side === "sell" ? "short" : "mixed";
          const header = (
            <Tooltip key={`group:${g.epic}`} asChild content={!tips ? undefined : isFolded ? "Click to show positions" : "Click to hide positions"}>
              <tr
                className={`pp-row pp-group pp-dir-${dir}${isFolded ? " pp-folded" : ""}`}
                onClick={() => onToggleGroup(g.epic)}
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
                        onToggleGroup(g.epic);
                      }}
                    >
                      <span className="pp-group-chevron" aria-hidden="true">›</span>
                    </button>
                    {g.epic}
                    <span className="pp-group-count">{g.positions.length}</span>
                  </td>,
                  levelFormat(g.positions),
                )}
              </tr>
            </Tooltip>
          );
          return isFolded ? [header] : [header, ...g.positions.map((t) => row(t, true))];
        })}
      </tbody>
    </table>
  );
}

function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.8" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

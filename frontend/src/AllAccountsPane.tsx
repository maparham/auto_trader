// The dock's "All accounts" tab: every dealing account's open positions, one
// section per account. View-only: a row click opens that position (App asks
// before switching account). Data and polling come from app/useAllAccounts.
import { useEffect, useRef, useState } from "react";
import Tooltip from "./components/Tooltip";
import type { AllAccountsData } from "./app/useAllAccounts";
import { orderSections, sectionFigures, slTpDistancePct } from "./lib/allAccounts";
import { pnlClass } from "./lib/positionsTable";
import { brokerLabel, type BrokerAccount, type TradeAccount, type TradeView } from "./lib/trading";
import type { TradingSettings } from "./theme";

interface Props {
  data: AllAccountsData;
  active: TradeAccount;
  trading: TradingSettings;
  onOpen: (account: TradeAccount, epic: string, dealId: string) => void;
}

const decimalsOf = (n: number | null | undefined) =>
  n == null ? 0 : Math.min(6, (String(n).split(".")[1] ?? "").length);
const price = (n: number | null | undefined, d: number) => (n == null ? "-" : n.toFixed(d));
const money = (n: number | null) =>
  n == null ? "-" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (label: string, n: number | null) => (n == null ? "-" : `${label} ${n.toFixed(1)}%`);

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `Updated ${s} s ago` : `Updated ${Math.floor(s / 60)} min ago`;
}

export default function AllAccountsPane({ data, active, trading, onOpen }: Props) {
  // Expanded per account: decided when its positions first load, then the user's.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const decided = useRef(new Set<string>());
  const [showHidden, setShowHidden] = useState(false);
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
}: {
  acct: BrokerAccount;
  data: AllAccountsData;
  isActive: boolean;
  open: boolean;
  onToggle: () => void;
  trading: TradingSettings;
  onOpen: Props["onOpen"];
}) {
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
          <table className="pp-table aa-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th className="pp-c-num">Size</th>
                <th className="pp-c-num">Entry</th>
                <th className="pp-c-num">Price</th>
                <th className="pp-c-num">P&amp;L</th>
                <th className="pp-c-num">SL</th>
                <th className="pp-c-num">TP</th>
                <th className="pp-c-num">To SL</th>
                <th className="pp-c-num">To TP</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((t) => (
                <Row key={t.id} t={t} onClick={() => onOpen(acct.key, t.epic, t.id)} />
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}

function Row({ t, onClick }: { t: TradeView; onClick: () => void }) {
  // The other broker's market precision is unknown here: use the most decimals
  // any of the row's prices carries.
  const d = Math.max(decimalsOf(t.priceLevel), decimalsOf(t.mark), decimalsOf(t.stop), decimalsOf(t.takeProfit));
  const dist = slTpDistancePct(t);
  return (
    <tr className={`pp-row pp-dir-${t.side === "buy" ? "long" : "short"}`} onClick={onClick}>
      <td className="pp-c-sym">{t.epic}</td>
      <td>{t.side === "buy" ? "Buy" : "Sell"}</td>
      <td className="pp-c-num">{t.quantity}</td>
      <td className="pp-c-num">{price(t.priceLevel, d)}</td>
      <td className="pp-c-num">{price(t.mark, d)}</td>
      <td className={`pp-c-num ${pnlClass(t.upnl)}`}>{money(t.upnl)}</td>
      <td className="pp-c-num">{price(t.stop, d)}</td>
      <td className="pp-c-num">{price(t.takeProfit, d)}</td>
      <td className="pp-c-num">{pct("SL", dist.sl)}</td>
      <td className="pp-c-num">{pct("TP", dist.tp)}</td>
    </tr>
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

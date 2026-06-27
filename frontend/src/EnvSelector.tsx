// Active broker / trading-account selector for the toolbar. The active account
// is a registry key "{broker}:{env}" (e.g. "capital:paper") that drives BOTH the
// chart's data feed (epics are broker-specific) and order/position routing.
//
// Live (real-money) accounts get a red affordance so they're unmistakable. The
// list comes from GET /api/brokers; with one account this is a static label, but
// it lights up the moment a second account (demo/live, or another broker) exists.

import { useEffect, useRef, useState } from "react";
import { brokerLabel, type BrokerAccount, type TradeAccount } from "./lib/trading";

interface Props {
  accounts: BrokerAccount[];
  activeAccount: TradeAccount;
  onChange: (account: TradeAccount) => void;
}

// "capital:paper" → "Capital.com · Paper". Falls back to the raw key if it's odd.
function accountLabel(account: BrokerAccount | undefined, key: TradeAccount): string {
  if (!account) return key;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${brokerLabel(account.broker)} · ${cap(account.env)}`;
}

export default function EnvSelector({ accounts, activeAccount, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = accounts.find((a) => a.key === activeAccount);
  const live = active?.isRealMoney ?? false;

  return (
    <div className="env-selector" ref={menuRef}>
      <button
        className={`anchor-btn env-selector-btn${live ? " live" : ""}`}
        title="Active broker / trading account"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`env-dot${live ? " live" : ""}`} aria-hidden="true" />
        <span className="env-label">{accountLabel(active, activeAccount)}</span>
        <svg
          className="tb-caret"
          viewBox="0 0 24 24" width="11" height="11" fill="none"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="env-menu">
          {accounts.length === 0 && <div className="env-menu-empty">No accounts</div>}
          {accounts.map((a) => (
            <button
              key={a.key}
              className={`env-menu-item${a.key === activeAccount ? " active" : ""}`}
              onClick={() => {
                onChange(a.key);
                setOpen(false);
              }}
            >
              <span className={`env-dot${a.isRealMoney ? " live" : ""}`} aria-hidden="true" />
              <span className="env-menu-label">{accountLabel(a, a.key)}</span>
              {a.isRealMoney && <span className="env-menu-badge">LIVE</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

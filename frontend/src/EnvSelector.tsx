// Active broker / trading-account selector for the toolbar. The active account
// is a registry key "{broker}:{env}" (e.g. "capital:paper") that drives BOTH the
// chart's data feed (epics are broker-specific) and order/position routing.
//
// The menu's job is to make the RISK TIER of each account unmistakable, so every
// row is marked by tier: paper (pure simulation), demo (real broker orders, play
// money), and live (real money) — the last gets a red dot, a "LIVE" pill, and an
// ambient red rail on the trigger so an armed real-money session is never a
// surprise. The list comes from GET /api/brokers.

import { useEffect, useRef, useState } from "react";
import { brokerLabel, type BrokerAccount, type TradeAccount } from "./lib/trading";

interface Props {
  accounts: BrokerAccount[];
  activeAccount: TradeAccount;
  onChange: (account: TradeAccount) => void;
}

type Tier = "paper" | "demo" | "live";

// Risk tier from the account: real money is always "live"; otherwise paper-sim vs
// real-broker demo dealing. Drives the dot colour and the env tag's emphasis.
function tier(a: BrokerAccount): Tier {
  if (a.isRealMoney) return "live";
  return a.env === "paper" ? "paper" : "demo";
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = accounts.find((a) => a.key === activeAccount);
  const activeTier: Tier = active ? tier(active) : "paper";

  return (
    <div className="env-selector" ref={menuRef}>
      <button
        className={`anchor-btn env-selector-btn ${activeTier}`}
        title="Active broker / trading account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`env-dot ${activeTier}`} aria-hidden="true" />
        <span className="env-label">
          {active ? brokerLabel(active.broker) : activeAccount}
        </span>
        {active && <span className={`env-tag ${activeTier}`}>{active.env}</span>}
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
        <div className="env-menu" role="menu">
          {accounts.length === 0 && (
            <div className="env-menu-empty">No accounts connected</div>
          )}
          {accounts.map((a) => {
            const t = tier(a);
            const isActive = a.key === activeAccount;
            return (
              <button
                key={a.key}
                className={`env-menu-item ${t}${isActive ? " active" : ""}`}
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => {
                  onChange(a.key);
                  setOpen(false);
                }}
              >
                <span className={`env-dot ${t}`} aria-hidden="true" />
                <span className="env-menu-label">{brokerLabel(a.broker)}</span>
                <span className={`env-tag ${t}`}>{a.env}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

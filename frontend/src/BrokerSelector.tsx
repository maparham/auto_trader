// Broker selector for the tab bar. Selecting a broker is a WORKSPACE-scope action:
// each data-broker (capital / ig-demo / ig-live) is its own isolated platform
// instance with its own charts/layouts/alerts, so switching brokers swaps the whole
// workspace. It lives at the far right of the tab bar, NOT the chart toolbar.
//
// This control picks the BROKER only. Which ACCOUNT (env: paper / demo / live) is
// active within the broker is chosen separately, in the trades dock's account strip
// — a different axis that keeps the same layout. The App maps a broker pick back to
// a concrete "{broker}:{env}" account (last-used for that broker, else paper).
//
// The broker list is derived from GET /api/brokers (one row per distinct broker).

import { useEffect, useMemo, useRef, useState } from "react";
import { brokerLabel, type BrokerAccount } from "./lib/trading";
import Tooltip from "./components/Tooltip";

interface Props {
  accounts: BrokerAccount[];
  activeBroker: string;
  onChange: (broker: string) => void;
}

export default function BrokerSelector({ accounts, activeBroker, onChange }: Props) {
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

  // Distinct brokers in registry order — the account list may carry several accounts
  // (paper/demo/…) per broker; the broker selector collapses them to one row each.
  const brokers = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of accounts) {
      if (!seen.has(a.broker)) {
        seen.add(a.broker);
        out.push(a.broker);
      }
    }
    return out;
  }, [accounts]);

  return (
    <div className="broker-selector" ref={menuRef}>
      <Tooltip content="Active broker (workspace)">
        <button
          className="anchor-btn broker-selector-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="broker-selector-label">{brokerLabel(activeBroker)}</span>
          <svg
            className="tb-caret"
            viewBox="0 0 24 24" width="11" height="11" fill="none"
            stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </Tooltip>

      {open && (
        <div className="broker-menu" role="menu">
          {brokers.length === 0 && (
            <div className="broker-menu-empty">No brokers connected</div>
          )}
          {brokers.map((broker) => {
            const isActive = broker === activeBroker;
            return (
              <button
                key={broker}
                className={`broker-menu-item${isActive ? " active" : ""}`}
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => {
                  onChange(broker);
                  setOpen(false);
                }}
              >
                <span className="broker-menu-label">{brokerLabel(broker)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

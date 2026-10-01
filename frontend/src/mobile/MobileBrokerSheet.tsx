// Broker picker for the mobile shell, opened from the chart top bar's broker
// chip. Like desktop's BrokerSelector it lists one row per BROKER (GET
// /api/brokers, seeded from the last-good cache so it renders instantly and
// survives a transient backend hiccup); the env within a broker (paper / demo
// / live) is picked on the positions tab, as desktop picks it in the dock. A
// pick lands on that broker's last-used account (mobileAccountFor) and goes
// through setMobileAccount, which repoints the whole shell (chart, trade tab,
// alerts, layout mirror).
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Sheet from "./Sheet";
import {
  brokerLabel,
  brokerOf,
  cachedBrokers,
  fetchBrokers,
  type BrokerAccount,
} from "../lib/trading";
import { mobileAccount, mobileAccountFor, setMobileAccount } from "./mobileChartState";

export default function MobileBrokerSheet({ onClose }: { onClose: () => void }) {
  const account = useSyncExternalStore(
    (fn) => mobileAccount.subscribe(fn),
    () => mobileAccount.value,
  );
  const [accounts, setAccounts] = useState<BrokerAccount[]>(() => cachedBrokers()?.exec ?? []);

  useEffect(() => {
    let alive = true;
    fetchBrokers()
      .then((info) => {
        if (alive) setAccounts(info.exec);
      })
      .catch(() => {
        /* cached seed stays; the list just doesn't refresh */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Distinct brokers in registry order.
  const brokers = useMemo(() => [...new Set(accounts.map((a) => a.broker))], [accounts]);
  const active = brokerOf(account);

  return (
    <Sheet title="Broker" onClose={onClose}>
      {brokers.length === 0 && <div className="m-broker-empty">No brokers registered.</div>}
      {brokers.map((b) => (
        <button
          key={b}
          className={`m-sheet-row${b === active ? " m-sheet-row-on" : ""}`}
          onClick={() => {
            if (b !== active) setMobileAccount(mobileAccountFor(b, accounts));
            onClose();
          }}
        >
          {brokerLabel(b)}
        </button>
      ))}
    </Sheet>
  );
}

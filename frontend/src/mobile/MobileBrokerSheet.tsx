// Broker/account picker for the mobile shell, opened from the chart top bar's
// broker chip. Lists the backend's registered accounts (GET /api/brokers,
// seeded from the last-good cache so it renders instantly and survives a
// transient backend hiccup — same pattern as desktop's selector) and hands the
// pick to setMobileAccount, which repoints the whole shell (chart, trade tab,
// alerts, layout mirror).
import { useEffect, useState, useSyncExternalStore } from "react";
import Sheet from "./Sheet";
import {
  brokerLabel,
  cachedBrokers,
  fetchBrokers,
  type BrokerAccount,
} from "../lib/trading";
import { mobileAccount, setMobileAccount } from "./mobileChartState";

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

  return (
    <Sheet title="Broker" onClose={onClose}>
      {accounts.length === 0 && <div className="m-broker-empty">No brokers registered.</div>}
      {accounts.map((a) => (
        <button
          key={a.key}
          className={`m-sheet-row${a.key === account ? " m-sheet-row-on" : ""}`}
          onClick={() => {
            setMobileAccount(a.key);
            onClose();
          }}
        >
          {brokerLabel(a.broker)} · {a.env}
        </button>
      ))}
    </Sheet>
  );
}

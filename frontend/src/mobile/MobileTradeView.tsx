// Trade tab (spec: 2026-09-07-mobile-companion-design.md, Task 12). Hosts the
// desktop OrderTicket full-width for whatever symbol the Chart tab currently
// has focused (`mobileSymbol`, Task 6) — no separate market picker here.
// OrderTicket itself owns `draftOrderSignal` (seeds from it, subscribes to
// it, clears it on submit/cancel); MobileModals (Task 7) already switches to
// this tab on a staged draft, so simply mounting OrderTicket picks it up —
// no extra wiring needed.
import { useEffect, useState, useSyncExternalStore } from "react";
import OrderTicket from "../OrderTicket";
import { mobileAccount, mobileSymbol } from "./mobileChartState";
import {
  getTradesAccount,
  fetchAccountSummary,
  isDataOnlyBroker,
  brokerOf,
  type AccountSummary,
} from "../lib/trading";
import { loadSettings } from "../theme";
import { isSynthetic } from "../lib/syntheticRegistry";

export default function MobileTradeView() {
  const symbol = useSyncExternalStore(
    (fn) => mobileSymbol.subscribe(fn),
    () => mobileSymbol.value,
  );
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  // A broker switch swaps the trades account (setMobileAccount → setTradesAccount);
  // subscribe so this view re-reads getTradesAccount() without waiting on a
  // symbol change to re-render it.
  useSyncExternalStore(
    (fn) => mobileAccount.subscribe(fn),
    () => mobileAccount.value,
  );

  const account = getTradesAccount();
  // Mirror desktop's gate exactly (App.tsx:2730): synthetic epics have no
  // dealable book, so they get the empty state too, same as a data-only broker.
  const tradeable =
    !!symbol && !isSynthetic(symbol.epic) && !isDataOnlyBroker(brokerOf(account));

  useEffect(() => {
    if (!tradeable) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    fetchAccountSummary(account)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tradeable, account]);

  if (!symbol || !tradeable) {
    return <div className="m-trade-empty">Pick a market on the Chart tab.</div>;
  }

  return (
    <div className="m-trade-view">
      <OrderTicket
        epic={symbol.epic}
        account={account}
        precision={symbol.pricePrecision ?? 2}
        instrumentType={symbol.type}
        trading={loadSettings().trading}
        accountSummary={summary}
        replaying={false}
      />
    </div>
  );
}

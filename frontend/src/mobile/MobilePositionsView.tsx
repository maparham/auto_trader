// Positions tab (spec: 2026-09-07-mobile-companion-design.md, Task 11). Lists
// the shared trades feed (positions + working orders, same `subscribeTrades`
// source the desktop dock and chart pills read) with a header strip of the
// account's real figures. Tapping a row opens a detail Sheet whose Close /
// Cancel button routes through the shared `requestConfirm` dialog (Task 7's
// hosted ConfirmDialog) before touching the broker — mirrors the chart pill's
// close/cancel flow in chart/TradePills.tsx exactly (same requestConfirm
// shape, same closePosition/cancelWorkingOrder call, same refreshTrades
// after). No optimistic removal: the row only disappears once the server
// confirms via the next trades poll.
import { useEffect, useState } from "react";
import {
  subscribeTrades,
  refreshTrades,
  getTradesAccount,
  fetchAccountSummary,
  closePosition,
  cancelWorkingOrder,
  tradeLabel,
  isRealMoneyAccount,
  type TradeView,
  type AccountSummary,
} from "../lib/trading";
import { requestConfirm } from "../lib/signals";
import { toast } from "../lib/notify";
import Sheet from "./Sheet";

function fmtMoney(n: number | null, currency: string | null): string {
  if (n == null) return "—";
  return `${n.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

function fmtPnl(n: number | null): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
}

function pnlClass(n: number | null): string {
  return n == null ? "" : n >= 0 ? "m-pos-pnl-pos" : "m-pos-pnl-neg";
}

function fmtLevel(n: number | null): string {
  return n == null ? "—" : String(n);
}

export default function MobilePositionsView() {
  const [trades, setTrades] = useState<TradeView[]>([]);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [selected, setSelected] = useState<TradeView | null>(null);

  useEffect(() => subscribeTrades(setTrades), []);

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
  const live = isRealMoneyAccount(account);

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
          // Server-confirmed state only: leave the row in place on failure —
          // the sheet stays open so the trader can retry — but the trader
          // still needs to know it failed (matches TradePills' onConfirm
          // catch, same toast(err.message) surfacing).
          toast(err instanceof Error ? err.message : "Action failed");
        }
      },
    });
  }

  return (
    <div className="m-pos-view">
      <div className="m-pos-head">
        <span className="m-pos-account">
          {account}
          {live && <span className="m-pos-live">LIVE</span>}
        </span>
        {summary == null ? (
          <span className="m-pos-paper">Paper account</span>
        ) : (
          <span className="m-pos-figures">
            Bal {fmtMoney(summary.balance, summary.currency)} · Avail{" "}
            {fmtMoney(summary.available, summary.currency)} ·{" "}
            <span className={pnlClass(summary.profitLoss)}>
              {fmtPnl(summary.profitLoss)}
            </span>
          </span>
        )}
      </div>
      <div className="m-pos-list">
        {trades.length === 0 ? (
          <div className="m-pos-empty">No open positions or orders.</div>
        ) : (
          trades.map((t) => (
            <div key={t.id} className="m-pos-row" onClick={() => setSelected(t)}>
              <div className="m-pos-row-main">
                <span className="m-pos-epic">{t.epic}</span>
                <span className="m-pos-label">{tradeLabel(t.kind, t.side)}</span>
                <span className={`m-pos-upnl ${pnlClass(t.upnl)}`}>
                  {t.kind === "position" ? fmtPnl(t.upnl) : ""}
                </span>
              </div>
              <div className="m-pos-row-sub">
                <span>Qty {t.quantity}</span>
                <span>@ {fmtLevel(t.priceLevel)}</span>
                {t.stop != null && <span>SL {t.stop}</span>}
                {t.takeProfit != null && <span>TP {t.takeProfit}</span>}
              </div>
            </div>
          ))
        )}
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
            <button className="m-pos-act-btn" onClick={() => act(selected)}>
              {selected.kind === "order" ? "Cancel order" : "Close position"}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

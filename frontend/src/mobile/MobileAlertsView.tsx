// Alerts tab (spec: 2026-09-07-mobile-companion-design.md, Task 10). Active/
// History segmented switch over the same backend-backed alerts store the
// desktop AlertsSidebar reads (lib/alertsApi) — enumeration mirrors
// AlertsSidebar's "all symbols" mode (loadAllAlerts(broker), grouped by
// epic) since mobile has no per-cell overlay list to fall back on. Editing
// and creating alerts reuse Task 7's hosted AlertModal via the same signals
// (alertGlobalEditRequest / alertModalRequest) — this view only fires them.
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  loadAllAlerts,
  loadAllServerAlerts,
  deleteStoredAlert,
  deleteIndicatorAlert,
  loadTriggered,
  clearTriggered,
  loadTriggeredSeen,
  pushTriggeredSeen,
  normalizeAlert,
  loadAccountAlerts,
  loadPositionAlerts,
  deleteAccountAlert,
  deletePositionAlert,
  TRIGGER_LABELS,
  type AccountAlert,
  type PositionAlert,
  alertLabel,
  type ServerAlert,
  type SavedAlert,
} from "../lib/alertsApi";
import { requestAlertEdit } from "../lib/alertEdit";
import {
  alertsChanged,
  alertGlobalEditRequest,
  alertModalRequest,
  accountAlertRequest,
  positionAlertRequest,
  tradesSignal,
  bumpAlerts,
  requestConfirm,
} from "../lib/signals";
import Tooltip from "../components/Tooltip";
import { brokerLabel, fetchQuote } from "../lib/trading";
import { ago } from "../lib/timeFormat";
import { accountRowView, decimalsOf, historyRowView, positionRowView, unseenCount, useAlertTick } from "../lib/alertRows";
import { mobileAccount, mobileBroker, mobileSymbol, openMobileAlert } from "./mobileChartState";

type SubTab = "active" | "history";

export default function MobileAlertsView() {
  const [tab, setTab] = useState<SubTab>("active");

  // Re-render (and re-pull loadAllAlerts/loadTriggered below) whenever an
  // alert is created/edited/deleted/fired on any tab/device — the same
  // signal AlertsSidebar re-reads on.
  useSyncExternalStore(
    (fn) => alertsChanged.subscribe(fn),
    () => alertsChanged.value,
  );
  const symbol = useSyncExternalStore(
    (fn) => mobileSymbol.subscribe(fn),
    () => mobileSymbol.value,
  );
  // Track the mobile account so a broker switch re-enumerates that broker's alerts.
  useSyncExternalStore(
    (fn) => mobileAccount.subscribe(fn),
    () => mobileAccount.value,
  );
  const broker = mobileBroker();

  // "x ago" labels, expiry and the account/position figures refresh on the
  // shared tick (lib/alertRows.ts), the same one the desktop panel runs.
  const now = useAlertTick();
  const groups = loadAllAlerts(broker);
  const rows: { epic: string; alert: SavedAlert }[] = [];
  // Normalized (legacy rows get their id) and expired ones dropped, as the
  // desktop's all-symbols list does: an expired alert can never fire.
  for (const g of groups) {
    g.alerts.forEach((r, i) => {
      const a = normalizeAlert(r, i);
      if (a.expiresAt != null && now > a.expiresAt) return;
      rows.push({ epic: g.epic, alert: a });
    });
  }
  const accountAlerts = loadAccountAlerts();
  const positionAlerts = loadPositionAlerts();
  const trades = useSyncExternalStore(
    (fn) => tradesSignal.subscribe(fn),
    () => tradesSignal.value,
  );
  // Indicator alerts sit after the price rows of their epic (an epic with only
  // indicator alerts still gets its block, at the end).
  const indByEpic = new Map<string, ServerAlert[]>();
  for (const a of loadAllServerAlerts(broker)) {
    const list = indByEpic.get(a.epic);
    if (list) list.push(a);
    else indByEpic.set(a.epic, [a]);
  }
  const epicOrder = [...new Set([...groups.map((g) => g.epic), ...indByEpic.keys()])];
  const items: Array<
    { kind: "price"; epic: string; alert: SavedAlert } | { kind: "indicator"; epic: string; alert: ServerAlert }
  > = [];
  for (const ep of epicOrder) {
    for (const r of rows) if (r.epic === ep) items.push({ kind: "price", ...r });
    for (const a of indByEpic.get(ep) ?? []) items.push({ kind: "indicator", epic: ep, alert: a });
  }

  const history = loadTriggered(); // already newest-first (see alertsApi.ts)
  // Unseen firings, against the same "seen" marker the desktop History uses,
  // so viewing History on either device clears the count on both.
  const seen = loadTriggeredSeen();
  const unseen = unseenCount(history, seen);
  const newest = history[0]?.time;
  useEffect(() => {
    if (tab !== "history" || newest == null) return;
    if (newest > seen) pushTriggeredSeen(newest);
  }, [tab, newest, seen]);

  // Precision for formatting an epic's levels: the open chart's symbol
  // supplies it when it matches; otherwise it is inferred from the levels
  // themselves (at least 2), as the desktop does for symbols with no open
  // cell, so an FX level like 1.08234 does not show as 1.08.
  function precisionFor(epic: string): number {
    if (symbol && symbol.epic === epic) return symbol.pricePrecision ?? 2;
    return Math.max(
      2,
      ...rows.filter((r) => r.epic === epic).map((r) => decimalsOf(r.alert.level)),
      ...(indByEpic.get(epic) ?? []).map((a) => a.precision),
    );
  }

  function handleDelete(epic: string, alert: SavedAlert) {
    const precision = precisionFor(epic);
    requestConfirm({
      message: `Delete alert ${alertLabel(alert, precision)} on ${epic}?`,
      onConfirm: () => {
        deleteStoredAlert(epic, alert.id, broker);
        bumpAlerts();
      },
    });
  }

  function handleDeleteIndicator(a: ServerAlert) {
    requestConfirm({
      message: `Delete this alert on ${a.epic}?`,
      onConfirm: () => deleteIndicatorAlert(a.id),
    });
  }

  async function handleCreate() {
    const sym = mobileSymbol.value;
    if (!sym) return;
    let price = 0;
    try {
      const q = await fetchQuote(sym.epic);
      price = q.mid ?? 0;
    } catch {
      // offline / quote failed: still open the modal, just unprefilled.
    }
    alertModalRequest.set({ price });
  }

  return (
    <div className="m-alerts-view">
      <div className="m-alerts-head">
        <div className="m-seg">
          <button className={tab === "active" ? "on" : ""} onClick={() => setTab("active")}>
            Active
          </button>
          <button
            className={tab === "history" ? "on" : ""}
            aria-label="History"
            onClick={() => setTab("history")}
          >
            History
            {tab !== "history" && unseen > 0 && <span className="m-seg-count">{unseen}</span>}
          </button>
        </div>
        <button className="m-alerts-add" onClick={() => void handleCreate()} aria-label="Create alert">
          +
        </button>
      </div>
      <div className="m-alerts-list">
        {tab === "active" ? (
          items.length + accountAlerts.length + positionAlerts.length === 0 ? (
            <div className="m-alerts-empty">No active alerts.</div>
          ) : (
            <>
            {accountAlerts.length > 0 && (
              <>
                <div className="m-alerts-group">Account</div>
                {accountAlerts.map((a) => <AccountRow key={a.id} a={a} />)}
              </>
            )}
            {positionAlerts.length > 0 && (
              <>
                <div className="m-alerts-group">Positions</div>
                {positionAlerts.map((a) => <PositionRow key={a.id} a={a} trades={trades} />)}
              </>
            )}
            {items.map((it) => {
              if (it.kind === "indicator") {
                const a = it.alert;
                return (
                  <div
                    key={`${it.epic}-${a.id}`}
                    className="m-alerts-row"
                    onClick={() => requestAlertEdit(a.id)}
                  >
                    <div className="m-alerts-row-main">
                      <span className="m-alerts-epic">{it.epic}</span>
                      <span className="m-alerts-cond">{alertLabel(a, a.precision)}</span>
                    </div>
                    {a.message && <div className="m-alerts-msg">{a.message}</div>}
                    {a.status === "waiting_for_data" && (
                      <Tooltip content={["Not enough candles yet, or the feed is down", "It fires once data arrives"]}>
                        <span className="m-alerts-wait">waiting for data</span>
                      </Tooltip>
                    )}
                    <button
                      className="m-alerts-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteIndicator(a);
                      }}
                      aria-label={`Delete alert on ${it.epic}`}
                    >
                      Delete
                    </button>
                  </div>
                );
              }
              const { epic, alert: a } = it;
              const precision = precisionFor(epic);
              return (
                <div
                  key={`${epic}-${a.id}`}
                  className="m-alerts-row"
                  onClick={() =>
                    alertGlobalEditRequest.set({ epic, savedId: a.id, precision })
                  }
                >
                  <div className="m-alerts-row-main">
                    <span className="m-alerts-epic">{epic}</span>
                    <span className="m-alerts-cond">{alertLabel(a, precision)}</span>
                  </div>
                  {a.message && <div className="m-alerts-msg">{a.message}</div>}
                  <span className="m-alerts-trigger">{TRIGGER_LABELS[a.trigger]}</span>
                  <button
                    className="m-alerts-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(epic, a);
                    }}
                    aria-label={`Delete alert on ${epic}`}
                  >
                    Delete
                  </button>
                </div>
              );
            })}
            </>
          )
        ) : history.length === 0 ? (
          <div className="m-alerts-empty">No alerts have triggered yet.</div>
        ) : (
          <>
            <div className="m-alerts-clear-row">
              <button className="m-alerts-clear" onClick={() => { clearTriggered(); bumpAlerts(); }}>
                Clear history
              </button>
            </div>
            {history.map((t, i) => {
              const view = historyRowView(t, broker, 2);
              return (
                <div
                  key={`${t.time}-${i}`}
                  className={`m-alerts-row m-alerts-hist${view.isAccount ? "" : " m-alerts-tappable"}`}
                  onClick={view.isAccount ? undefined : () => openMobileAlert(t.epic, t.broker, view.precision)}
                >
                  <div className="m-alerts-row-main">
                    <span className="m-alerts-epic">
                      {view.title}
                      {view.foreignBroker && <span className="m-alerts-broker">{brokerLabel(view.foreignBroker)}</span>}
                    </span>
                    <span className="m-alerts-time">{ago(t.time, now)}</span>
                  </div>
                  <div className="m-alerts-cond">{view.cond}</div>
                  {t.message && <div className="m-alerts-msg">{t.message}</div>}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// One account alert row: account, metric, "now" value, tier badges (fired ones
// dimmed), Unmonitored with its reason. Tap edits, Delete confirms first.
function AccountRow({ a }: { a: AccountAlert }) {
  const view = accountRowView(a);
  return (
    <div className="m-alerts-row" onClick={() => accountAlertRequest.set({ mode: "edit", id: a.id })}>
      <div className="m-alerts-row-main">
        <span className="m-alerts-epic">{view.title}</span>
        <span className="m-alerts-cond">
          {view.metric}
          {view.now != null && <> · now {view.now}</>}
        </span>
      </div>
      {a.message && <div className="m-alerts-msg">{a.message}</div>}
      <div className="m-alerts-badges">
        {view.tiers.map((t) => (
          <span key={t.level} className={`m-alerts-tier${t.fired ? " fired" : ""}`}>
            {t.text}
          </span>
        ))}
        {view.unmonitored != null && <span className="m-alerts-wait">Unmonitored</span>}
      </div>
      {/* No hover on a phone: the reason is shown as text, not a tooltip. */}
      {view.unmonitored != null && <div className="m-alerts-msg">{view.unmonitored}</div>}
      <button
        className="m-alerts-delete"
        onClick={(e) => {
          e.stopPropagation();
          requestConfirm({
            message: `Delete this ${view.metric} alert on ${view.title}?`,
            onConfirm: () => deleteAccountAlert(a.id),
          });
        }}
        aria-label={`Delete alert on ${view.title}`}
      >
        Delete
      </button>
    </div>
  );
}

// One SL/TP proximity row: `US100 long` / `SL · 0.5× ATR · now 0.8 ATR`.
function PositionRow({ a, trades }: { a: PositionAlert; trades: { id: string; side: "buy" | "sell" }[] }) {
  const view = positionRowView(a, trades);
  return (
    <div
      className="m-alerts-row"
      onClick={() =>
        positionAlertRequest.set({ account: a.account, epic: a.epic, dealId: a.dealId, precision: a.precision ?? 2 })
      }
    >
      <div className="m-alerts-row-main">
        <span className="m-alerts-epic">{view.title}</span>
        <span className="m-alerts-cond">{view.cond}</span>
      </div>
      {view.fired && (
        <div className="m-alerts-badges">
          <span className="m-alerts-tier fired">Fired</span>
        </div>
      )}
      <button
        className="m-alerts-delete"
        onClick={(e) => {
          e.stopPropagation();
          requestConfirm({
            message: `Delete this ${view.sideLabel} warning on ${a.epic}?`,
            onConfirm: () => deletePositionAlert(a.id),
          });
        }}
        aria-label={`Delete ${view.sideLabel} warning on ${a.epic}`}
      >
        Delete
      </button>
    </div>
  );
}

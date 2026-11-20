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
  alertLabel,
  type ServerAlert,
  type SavedAlert,
} from "../lib/alertsApi";
import { requestAlertEdit } from "../lib/alertEdit";
import {
  alertsChanged,
  alertGlobalEditRequest,
  alertModalRequest,
  bumpAlerts,
  requestConfirm,
} from "../lib/signals";
import Tooltip from "../components/Tooltip";
import { brokerLabel, fetchQuote } from "../lib/trading";
import { ago } from "../lib/timeFormat";
import { historyRowView, unseenCount, useAlertTick } from "../lib/alertRows";
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

  const groups = loadAllAlerts(broker);
  const rows: { epic: string; alert: SavedAlert }[] = [];
  for (const g of groups) for (const a of g.alerts) rows.push({ epic: g.epic, alert: a });
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
  // "x ago" labels and the account/position figures refresh on the shared tick.
  const now = useAlertTick();
  // Unseen firings, against the same "seen" marker the desktop History uses,
  // so viewing History on either device clears the count on both.
  const seen = loadTriggeredSeen();
  const unseen = unseenCount(history, seen);
  const newest = history[0]?.time;
  useEffect(() => {
    if (tab !== "history" || newest == null) return;
    if (newest > seen) pushTriggeredSeen(newest);
  }, [tab, newest, seen]);

  // Precision for formatting an epic's level: the currently-open chart's
  // symbol supplies it when it matches; otherwise mobile has nothing else to
  // infer from (no per-cell precision map like AlertsSidebar's all-symbols
  // mode), so fall back to 2 — same fallback AlertsSidebar uses.
  function precisionFor(epic: string): number {
    if (symbol && symbol.epic === epic) return symbol.pricePrecision ?? 2;
    return 2;
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
          items.length === 0 ? (
            <div className="m-alerts-empty">No active alerts.</div>
          ) : (
            items.map((it) => {
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
            })
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

// Re-hosts App.tsx's signal-driven modals inside the mobile shell (spec:
// 2026-09-07-mobile-companion-design.md, Task 7). Same signals, same DESKTOP
// modal components, wiring copied faithfully from App.tsx:2806-2960 — but
// routed to the mobile chart tab's controller/symbol/period (Task 6) instead
// of the desktop's focused cell, and mounted once for the whole app rather
// than per-cell. Desktop-only signals (backtest drill, trade editor) are not
// hosted here — they simply have no listener on mobile.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Signal } from "../lib/signals";
import {
  alertModalRequest,
  alertEditRequest,
  alertGlobalEditRequest,
  confirmRequest,
  requestConfirm,
  indicatorSettingsRequest,
  drawingSettingsRequest,
  draftOrderSignal,
  symbolSearchRequest,
  settingsRequest,
  settingsRequestTab,
  bumpAlerts,
} from "../lib/signals";
import { loadStoredAlert, updateStoredAlert, deleteStoredAlert } from "../lib/persist";
import { applyThemeToDocument, loadSettings, saveSettings, type Settings } from "../theme";
import type { Instrument } from "../lib/feed";
import { brokerOf } from "../lib/trading";
import AlertModal from "../AlertModal";
import SettingsModal from "../Settings";
import DrawingSettings from "../DrawingSettings";
import IndicatorSettings from "../IndicatorSettings";
import ConfirmDialog from "../ConfirmDialog";
import SymbolSearchModal from "../SymbolSearchModal";
import {
  mobileChartCtx,
  mobileSymbol,
  mobilePeriod,
  mobileTabSignal,
  setMobileSymbol,
  mobileAccount,
  mobileSettingsVersion,
} from "./mobileChartState";

function useSignal<T>(sig: Signal<T>): T {
  return useSyncExternalStore(
    (cb) => sig.subscribe(cb),
    () => sig.value,
  );
}

export default function MobileModals() {
  const alertReq = useSignal(alertModalRequest);
  const alertEdit = useSignal(alertEditRequest);
  const alertGlobalEdit = useSignal(alertGlobalEditRequest);
  const indSettings = useSignal(indicatorSettingsRequest);
  const drawSettings = useSignal(drawingSettingsRequest);
  const confirm = useSignal(confirmRequest);
  const draftOrder = useSignal(draftOrderSignal);
  const ctx = useSignal(mobileChartCtx);
  const symbol = useSignal(mobileSymbol);
  const period = useSignal(mobilePeriod);

  const controller = ctx?.controller ?? null;
  const account = useSignal(mobileAccount);
  const brokerId = brokerOf(account);
  // Stable identity across re-renders (mobileChartCtx/mobileSymbol/mobilePeriod
  // churn while a modal is open) — App.tsx holds `settings` in useState for the
  // same reason; a fresh object every render would otherwise be read by an
  // effect keyed on `defaults` inside AlertModal and reset an in-progress draft.
  const settings = useMemo(() => loadSettings(), []);

  // The symbol-search modal has no dedicated request signal (see App.tsx's
  // Toolbar hosting) — it's a bumped counter opened locally, same idiom.
  const [symModalOpen, setSymModalOpen] = useState(false);
  useEffect(() => symbolSearchRequest.subscribe(() => setSymModalOpen(true)), []);

  // Chart settings (the chart context menu's "Settings" item fires
  // settingsRequest — desktop App hosts SettingsModal for it; here we do).
  // Live state, not the memoized `settings` above: the modal edits it.
  const [chartSettingsOpen, setChartSettingsOpen] = useState(false);
  const [chartSettingsTab, setChartSettingsTab] = useState<"general" | "alerts" | "trading" | undefined>();
  const [liveSettings, setLiveSettings] = useState<Settings>(() => loadSettings());
  useEffect(
    () =>
      settingsRequest.subscribe(() => {
        setChartSettingsTab(
          (settingsRequestTab.value as "general" | "alerts" | "trading" | null) ?? undefined,
        );
        setLiveSettings(loadSettings());
        setChartSettingsOpen(true);
      }),
    [],
  );

  // draftOrderSignal → the trade tab consumes the draft (Task 12); we just
  // route, on the null→non-null edge only. Task 12's drag-to-adjust will
  // re-.set() the signal repeatedly while non-null (e.g. dragging a draft
  // line) — re-routing to "trade" on every one of those would yank the user
  // off the chart mid-drag.
  const prevDraftRef = useRef(draftOrder);
  useEffect(() => {
    if (draftOrder && !prevDraftRef.current) mobileTabSignal.set("trade");
    prevDraftRef.current = draftOrder;
  }, [draftOrder]);

  return (
    <div className="m-modal-host">
      {alertReq && symbol && (
        <AlertModal
          epic={symbol.epic}
          price={alertReq.price}
          defaults={settings.alertDefaults}
          now={Date.now()}
          onCreate={(level, cfg) => {
            controller?.overlays.addAlert(level, cfg);
            alertModalRequest.set(null);
          }}
          onClose={() => alertModalRequest.set(null)}
        />
      )}

      {alertEdit &&
        symbol &&
        (() => {
          const a = controller?.overlays.getAlert(alertEdit.id);
          if (!a) {
            alertEditRequest.set(null);
            return null;
          }
          return (
            <AlertModal
              epic={symbol.epic}
              price={a.level}
              mode="edit"
              initial={a.cfg}
              defaults={settings.alertDefaults}
              now={Date.now()}
              onCreate={(level, cfg) => {
                controller?.overlays.updateAlert(alertEdit.id, level, cfg);
                alertEditRequest.set(null);
              }}
              onDelete={() => {
                const id = alertEdit.id;
                requestConfirm({
                  message: `Delete this alert on ${symbol.epic}?`,
                  onConfirm: () => {
                    controller?.overlays.remove(id);
                    alertEditRequest.set(null);
                  },
                });
              }}
              onClose={() => alertEditRequest.set(null)}
            />
          );
        })()}

      {alertGlobalEdit &&
        (() => {
          const a = loadStoredAlert(alertGlobalEdit.epic, alertGlobalEdit.savedId, brokerId);
          if (!a) {
            alertGlobalEditRequest.set(null);
            return null;
          }
          const { epic: ep, savedId, precision } = alertGlobalEdit;
          const round = (n: number) => Number(n.toFixed(precision));
          return (
            <AlertModal
              epic={ep}
              price={a.level}
              mode="edit"
              initial={{
                condition: a.condition,
                trigger: a.trigger,
                message: a.message,
                expiresAt: a.expiresAt,
                notify: a.notify,
                startAtCreation: a.startAtCreation,
              }}
              defaults={settings.alertDefaults}
              now={Date.now()}
              onCreate={(level, cfg) => {
                updateStoredAlert(ep, savedId, round(level), cfg, brokerId);
                bumpAlerts();
                alertGlobalEditRequest.set(null);
              }}
              onDelete={() => {
                requestConfirm({
                  message: `Delete this alert on ${ep}?`,
                  onConfirm: () => {
                    deleteStoredAlert(ep, savedId, brokerId);
                    bumpAlerts();
                    alertGlobalEditRequest.set(null);
                  },
                });
              }}
              onClose={() => alertGlobalEditRequest.set(null)}
            />
          );
        })()}

      {indSettings && ctx && controller && symbol && period && (
        <IndicatorSettings
          key={`${indSettings.paneId}:${indSettings.name}`}
          chart={ctx.chart}
          scope={controller.scope}
          cellId="mobile"
          epic={symbol.epic}
          brokerId={brokerId}
          chartResolution={period.resolution}
          paneId={indSettings.paneId}
          name={indSettings.name}
          controller={controller}
          onClose={() => indicatorSettingsRequest.set(null)}
        />
      )}

      {drawSettings && controller && (
        <DrawingSettings
          overlays={controller.overlays}
          id={drawSettings.id}
          onIdChange={(id) => drawingSettingsRequest.set({ id })}
          onClose={() => drawingSettingsRequest.set(null)}
        />
      )}

      {chartSettingsOpen && (
        <SettingsModal
          settings={liveSettings}
          onChange={(next) => {
            setLiveSettings(next);
            saveSettings(next);
            applyThemeToDocument(next);
            // Imperative readers (chart center-pin) refresh on this, same as
            // desktop's persist effect.
            window.dispatchEvent(new Event("at:settings-saved"));
            // MobileChartView re-reads loadSettings() and re-props ChartCore.
            mobileSettingsVersion.set(mobileSettingsVersion.value + 1);
          }}
          onClose={() => {
            setChartSettingsOpen(false);
            setChartSettingsTab(undefined);
          }}
          initialTab={chartSettingsTab}
        />
      )}
      {symModalOpen && (
        <SymbolSearchModal
          current={symbol}
          brokerId={brokerId}
          onPick={(s: Instrument) => {
            setMobileSymbol(s, brokerId);
            setSymModalOpen(false);
          }}
          onClose={() => setSymModalOpen(false)}
        />
      )}

      {/* Confirmation dialog — rendered LAST so it stacks above any modal that
          opened it (e.g. the alert edit modal's delete button). */}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          details={confirm.details}
          onConfirm={confirm.onConfirm}
          onClose={() => confirmRequest.set(null)}
        />
      )}
    </div>
  );
}

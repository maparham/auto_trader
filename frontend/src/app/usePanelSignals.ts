// App-level panel and modal state that is driven by signals: the docked
// backtest and live panels (with their persisted open-state), the modal
// requests other components raise, and the side panels' open flags.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { claimSidePanel, endSidePanelRestore, registerSidePanel } from "../lib/sidePanels";
import {
  loadBacktestOpen,
  saveBacktestOpen,
  loadLiveOpen,
  saveLiveOpen,
  loadSnapshotMeta,
  type ChartTab,
} from "../lib/persist";
import {
  alertModalRequest,
  alertEditRequest,
  alertGlobalEditRequest,
  confirmRequest,
  saveDefaultTemplateRequest,
  indicatorSettingsRequest,
  drawingSettingsRequest,
  alertsPanelOpen,
  tradePanelOpen,
  tradeListPanelOpen,
  livePanelOpen,
  backtestSettingsRequest,
  backtestPanelOpenSignal,
  backtestPanelHiddenSignal,
  setTradeSelected,
  snapshotsGalleryOpen,
  snapshotViewChanged,
} from "../lib/signals";

export function useDockPanels() {
  // The toolbar Backtest button toggles the docked config panel via a signal.
  // Open-state is device-local so the panel reopens after a reload if it was
  // open (loadBacktestOpen), showing the persisted config/results without re-running.
  // Both this panel and the Live panel persist their open-state, so a reload can
  // find both saved open — which the one-panel-at-a-time rule forbids. Live wins
  // (it may have an armed strategy behind it) and the backtest panel just starts
  // closed; its saved flag is left alone rather than overwritten, so the panel
  // comes back on the next reload where live isn't restored.
  const [showBacktestCfg, setShowBacktestCfg] = useState(
    () => loadBacktestOpen() && !loadLiveOpen(),
  );
  const showBacktestCfgRef = useRef(showBacktestCfg);
  showBacktestCfgRef.current = showBacktestCfg;
  const openBacktestCfg = (open: boolean) => {
    // Taking the dock closes whichever other side panel was open.
    if (open) claimSidePanel("backtest");
    setShowBacktestCfg(open);
    backtestPanelOpenSignal.set(open);
    saveBacktestOpen(open);
  };
  // Restored open-state reaches the toolbar's Backtest button the same way.
  useEffect(() => { backtestPanelOpenSignal.set(showBacktestCfg); }, []);
  // The backtest panel's open-state is component state, so its "close yourself"
  // callback has to be registered from here (lib/sidePanels.ts). Registered once
  // with the first render's openBacktestCfg, which is safe because everything that
  // closure touches is render-stable (the setState setter plus two module-level
  // functions) — keep it that way or this registration goes stale.
  useEffect(() => registerSidePanel("backtest", () => openBacktestCfg(false)), []);
  useEffect(() => backtestSettingsRequest.subscribe(() => {
    // Toggle — but an open-yet-hidden overlay (chart interaction / range pick
    // tucked it away) re-reveals instead of closing: the panel isn't on screen,
    // so to the user this click is "open", not "close".
    if (showBacktestCfgRef.current && !backtestPanelHiddenSignal.value) {
      openBacktestCfg(false);
      return;
    }
    openBacktestCfg(true);
    backtestPanelHiddenSignal.set(false);
  }), []);
  // The Live trading panel — a separate docked surface from the backtest. Driven
  // by the livePanelOpen signal; open-state is device-local (loadLiveOpen) so an
  // armed strategy's panel reopens on reload.
  const [showLive, setShowLive] = useState(loadLiveOpen);
  useEffect(() => {
    if (loadLiveOpen()) livePanelOpen.set(true);
    return livePanelOpen.subscribe((v) => {
      setShowLive(v);
      saveLiveOpen(v);
    });
  }, []);
  // Persisted open-states are restored above; from here on, opening one side
  // panel closes the others.
  useEffect(() => endSidePanelRestore(), []);
  return { showBacktestCfg, openBacktestCfg, showLive };
}

export function useModalRequests() {
  const [alertReq, setAlertReq] = useState(alertModalRequest.value);
  useEffect(() => alertModalRequest.subscribe(setAlertReq), []);
  const [alertEdit, setAlertEdit] = useState(alertEditRequest.value);
  useEffect(() => alertEditRequest.subscribe(setAlertEdit), []);
  const [alertGlobalEdit, setAlertGlobalEdit] = useState(alertGlobalEditRequest.value);
  useEffect(() => alertGlobalEditRequest.subscribe(setAlertGlobalEdit), []);
  const [confirm, setConfirm] = useState(confirmRequest.value);
  useEffect(() => confirmRequest.subscribe(setConfirm), []);
  const [saveDefaultReq, setSaveDefaultReq] = useState(saveDefaultTemplateRequest.value);
  useEffect(() => saveDefaultTemplateRequest.subscribe(setSaveDefaultReq), []);
  const [indSettings, setIndSettings] = useState(indicatorSettingsRequest.value);
  useEffect(() => indicatorSettingsRequest.subscribe(setIndSettings), []);
  const [drawSettings, setDrawSettings] = useState(drawingSettingsRequest.value);
  useEffect(() => drawingSettingsRequest.subscribe(setDrawSettings), []);
  return { alertReq, alertEdit, alertGlobalEdit, confirm, saveDefaultReq, indSettings, drawSettings };
}

export function usePanelOpenStates(tabs: ChartTab[]) {
  const [panelOpen, setPanelOpen] = useState(alertsPanelOpen.value);
  useEffect(() => alertsPanelOpen.subscribe(setPanelOpen), []);
  const [tradeListOpen, setTradeListOpen] = useState(tradeListPanelOpen.value);
  useEffect(() => tradeListPanelOpen.subscribe(setTradeListOpen), []);
  const [tradeOpen, setTradeOpen] = useState(tradePanelOpen.value);
  useEffect(() => tradePanelOpen.subscribe(setTradeOpen), []);
  const [snapGalleryOpen, setSnapGalleryOpen] = useState(snapshotsGalleryOpen.value);
  useEffect(() => snapshotsGalleryOpen.subscribe(setSnapGalleryOpen), []);
  // Unlocking a snapshot view clears the cell controller's readOnly flag;
  // re-render so focusedReadOnly recomputes (toolbar swap, DrawSidebar, gallery
  // save button).
  const [snapViewTick, bumpSnapViewTick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => snapshotViewChanged.subscribe(() => bumpSnapViewTick()), []);
  // Tabs whose cells include a read-only snapshot view (scope still carries its
  // snapshotMeta), for the camera badge. snapViewTick re-runs this on Unlock.
  const snapshotTabIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tabs)
      if (t.cells.some((c) => loadSnapshotMeta(c.scope) != null)) ids.add(t.id);
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, snapViewTick]);
  // Closing the trading panel exits edit mode AND drops the trade selection (the
  // chart pills + row highlight clear). Done here — a state transition — rather than
  // in OrderTicket's unmount cleanup, which StrictMode fires spuriously on mount.
  useEffect(() => {
    if (!tradeOpen) setTradeSelected(null);
  }, [tradeOpen]);
  return { panelOpen, tradeListOpen, tradeOpen, snapGalleryOpen, snapshotTabIds };
}

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { Chart } from "klinecharts";
import ChartGrid from "./ChartGrid";
import { flushPendingAutoSaves } from "./lib/templateAutosave";
import Toolbar from "./Toolbar";
import SnapshotToolbar from "./SnapshotToolbar";
import DrawSidebar from "./DrawSidebar";
import WorkspacePatternPanel from "./WorkspacePatternPanel";
import TradeListPanel from "./TradeListPanel";
import { setPatternSeriesProvider } from "./lib/patternPanelStore";
import { anyCellInReadout, subscribeReplayingCells } from "./lib/replayingCells";
import LayoutPicker from "./LayoutPicker";
import BrokerSelector from "./BrokerSelector";
import {
  isCellReplaying,
} from "./lib/chartSync";
import AppearanceMenu from "./AppearanceMenu";
import SettingsModal from "./Settings";
import BacktestSettingsModal from "./BacktestSettingsModal";
import { defaultBacktestConfig } from "./lib/backtestConfig";
import { loadBacktestLastUsed, saveBacktestLastUsed } from "./lib/persist";
import LiveTradingPanel from "./LiveTradingPanel";
import AlertModal from "./AlertModal";
import IndicatorSettings from "./IndicatorSettings";
import DrawingSettings from "./DrawingSettings";
import AlertsSidebar, { type AlertNavTarget, type VisibleCell } from "./AlertsSidebar";
import ConfirmDialog from "./ConfirmDialog";
import AgentConfirmHost from "./agent/AgentConfirmHost";
import { initAgentBridge } from "./agent";
import { setFocusedDrawingsProvider } from "./agent/actions/drawings";
import { setFocusedChartProvider } from "./agent/actions/chart";
import SaveDefaultTemplateModal from "./SaveDefaultTemplateModal";
import BacktestClusterPopover from "./BacktestClusterPopover";
import TradeReviewCard from "./TradeReviewCard";
import TradeExitClusterPopover from "./TradeExitClusterPopover";
import TradeMarkerLabelPopover from "./TradeMarkerLabelPopover";
import BacktestSignalPopover from "./BacktestSignalPopover";
import Snackbar from "./Snackbar";
import OrderTicket from "./OrderTicket";
import PositionsPanel from "./PositionsPanel";
import SnapshotGallery from "./SnapshotGallery";
import DemoCta from "./DemoCta";
import { isDemoMode } from "./lib/demoMode";
import { registerCustomIndicators } from "./lib/customIndicators";
import {
  registerBacktestIndicators,
} from "./lib/backtest";
import { registerCustomOverlays } from "./lib/customOverlays";
import { installMagnetModifierKeys } from "./lib/magnet";
import { matchingCellIds } from "./lib/tabSearch";
import { registerPositionLine } from "./lib/positionLines";
import type { ChartController } from "./lib/chartController";
import {
  alertModalRequest,
  alertEditRequest,
  alertGlobalEditRequest,
  confirmRequest,
  requestConfirm,
  saveDefaultTemplateRequest,
  indicatorSettingsRequest,
  drawingSettingsRequest,
  tradeListPanelOpen,
  livePanelOpen,
  alertsChanged,
  alertNavHandler,
  bumpAlerts,
  settingsRequest,
  settingsRequestTab,
  requestBacktestRun,
  confirmLineEditsSignal,
  tradeLineUiSignal,
  pendingEditsSignal,
  setTradeSelected,
  discardPendingEdit,
  snapshotsGalleryOpen,
} from "./lib/signals";
import { reportView } from "./lib/viewHeartbeat";
import { jumpToEpic as runEpicJump, type EpicJumpDeps, type ReuseSlot } from "./lib/epicJump";
import {
  resolveInstrument,
  type Instrument,
} from "./lib/feed";
import {
  isDataOnlyBroker,
  migrateCapitalLiveAccountKeys,
} from "./lib/trading";
import {
  loadStoredAlert,
  updateStoredAlert,
  deleteStoredAlert,
  loadLayouts,
  saveLayout,
  saveActiveLayoutId,
  saveScratch,
  clearScratch,
  loadAutosave,
  canMergeTabs,
  loadSnapshotMeta,
  type ChartTab,
  type Workspace,
} from "./lib/persist";
import LayoutManager from "./LayoutManager";
import { applyThemeToDocument, loadSettings, saveSettings, type Settings } from "./theme";
import { browserTimezone } from "./chart/chartPainters";
import { useStrategyOverlaySync } from "./chart/useStrategyOverlaySync";
import TabBar from "./TabBar";
import Tooltip from "./components/Tooltip";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import { isSynthetic } from "./lib/syntheticRegistry";
import {
  DEFAULT_PERIOD,
  ACTIVE_TAB_SESSION_KEY,
  effectiveSyncCrosshair,
  effectiveSyncTime,
  makeTab,
  resolveStartup,
} from "./app/workspace";
import { useDockPanels, useModalRequests, usePanelOpenStates } from "./app/usePanelSignals";
import { useAccounts } from "./app/useAccounts";
import { useSearchGlow } from "./app/useSearchGlow";
import { useMarketClosedBadges, useUnseenAlertTabs } from "./app/useTabBadges";
import { useTradeBoxJump } from "./app/useTradeBoxJump";
import { useBackendSync } from "./app/useBackendSync";
import type { PendingUndo } from "./app/types";
import { useCellActions } from "./app/useCellActions";
import { useTabActions } from "./app/useTabActions";
import { useNamedLayouts } from "./app/useNamedLayouts";
import { useIndicatorSync } from "./app/useIndicatorSync";
import { useAppAgentActions } from "./app/useAppAgentActions";
import { useAlertFiredNotices } from "./app/useAlertFiredNotices";
import "./App.css";

// One-time rename of the persisted real-money Capital account key
// ("capital:live" -> "capital-live:live"). Must run before the activeAccount
// useState initializer below reads localStorage, else an unrecognized old key
// bounces the user to paper and swaps their whole workspace.
migrateCapitalLiveAccountKeys();

// Register VWAP / AVWAP and the backtest EQUITY indicator once, before any chart
// mounts, so they're available to the chart and the indicator menu.
registerCustomIndicators();
registerBacktestIndicators();
registerCustomOverlays();
registerPositionLine();

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  // The tab a settings deep link asked for (undefined = the modal's default).
  const [settingsTab, setSettingsTab] = useState<"general" | "alerts" | "trading" | undefined>();
  // Maximized view: hides the tab bar so the focused tab's chart reclaims that
  // vertical space. The per-chart toolbar stays (it carries the un-maximize
  // toggle + Backtest), so this is the only chrome that survives the switch.
  const [maximized, setMaximized] = useState(false);
  // The trading dock maximized to fill the chart view (the workspace is hidden).
  const [dockMaximized, setDockMaximized] = useState(false);
  // Per-cell maximize: one cell of a multi-cell layout expanded to fill the grid.
  // Transient view state (like `maximized` above) — never persisted. Siblings stay
  // mounted (hidden via CSS) so their live sockets/drawings/scroll survive restore.
  const [maximizedCellId, setMaximizedCellId] = useState<string | null>(null);
  // Tab chip currently being dragged (chart-drop merge gesture), or null.
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  // Agent UI Bridge: register the agent-callable actions and (when enabled)
  // connect to the relay. Idempotent, so StrictMode's double invoke is a no-op.
  useEffect(() => { initAgentBridge(); }, []);
  // Mirror confirmLineEdits onto a signal so the chart (no settings prop) can read it.
  useEffect(() => {
    confirmLineEditsSignal.set(settings.trading.confirmLineEdits);
  }, [settings.trading.confirmLineEdits]);
  // Toolbar gear + chart context menu request the Settings modal via a signal.
  // A deep link (openSettings("alerts")) also names the tab to land on.
  useEffect(
    () =>
      settingsRequest.subscribe(() => {
        setSettingsTab((settingsRequestTab.value as "general" | "alerts" | "trading" | null) ?? undefined);
        setShowSettings(true);
      }),
    [],
  );
  const { showBacktestCfg, openBacktestCfg, showLive } = useDockPanels();
  const { alertReq, alertEdit, alertGlobalEdit, confirm, saveDefaultReq, indSettings, drawSettings } =
    useModalRequests();
  // Esc on the selected trade: discard un-applied drag edits first (keeping it
  // selected), then a second Esc deselects. Window-level so it fires even when focus
  // isn't on the chart (e.g. selected via a dock row). Yields to any open modal/
  // dialog — those own Esc — so a close-position confirm isn't pre-empted. (Placed
  // after the modal-state declarations so its dep array can read them.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showSettings || alertReq || alertEdit || alertGlobalEdit || confirm) return;
      const sel = tradeLineUiSignal.value.selected;
      if (!sel) return;
      if (pendingEditsSignal.value[sel]) discardPendingEdit(sel);
      else setTradeSelected(null);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings, alertReq, alertEdit, alertGlobalEdit, confirm]);

  // The workspace = the current set of tabs + which tab is active. It belongs to a
  // NAMED layout (activeLayoutId) or to the device-local unsaved scratch (null).
  // `tabs` MAY be empty (blank launch with no default) — every consumer below is
  // written to tolerate zero tabs and an undefined active/focusedCell. Resolved ONCE
  // (a brand-new broker seeds a fresh default workspace with newly-minted ids, so the
  // three slices must share ONE resolveStartup() call, not three divergent ones).
  const [startup] = useState(resolveStartup);
  const [tabs, setTabs] = useState<ChartTab[]>(() => startup.ws.tabs);
  const [activeId, setActiveId] = useState<string>(() => {
    // Deep-link from "detach to browser tab": ?tab=<id> selects that tab on
    // launch (if it exists in the resolved workspace). The query string is
    // stripped in a mount effect below (not here) so a reload behaves
    // normally. Device-local activation only — never persisted. Kept pure:
    // no history mutation in this initializer, since StrictMode double-runs
    // it in dev.
    const want = new URLSearchParams(location.search).get("tab");
    if (want && startup.ws.tabs.some((t) => t.id === want)) return want;
    // Persist the active tab PER BROWSER TAB across reloads via sessionStorage
    // (scoped to this tab, not shared with siblings — matching the per-instance,
    // never-synced design of the active selection). Tab ids are globally-unique,
    // so the existence check self-corrects across broker/layout switches; fall
    // back to the body seed when the remembered tab is gone.
    const remembered = sessionStorage.getItem(ACTIVE_TAB_SESSION_KEY);
    if (remembered && startup.ws.tabs.some((t) => t.id === remembered))
      return remembered;
    return startup.ws.activeTabId;
  });
  // Find-open-symbol query (transient, never persisted). Lifted here because
  // it drives both TabBar chip highlights and cell glow in ChartGrid.
  const [tabSearchQuery, setTabSearchQuery] = useState("");
  const { searchGlow, flashCells } = useSearchGlow();
  // Remember the active tab for this browser tab so a reload restores it.
  useEffect(() => {
    if (activeId) sessionStorage.setItem(ACTIVE_TAB_SESSION_KEY, activeId);
  }, [activeId]);
  // Reload/close within the template-autosave debounce (~800ms after an edit)
  // would drop the pending capture with the page timer, leaving the symbol's
  // template one edit behind. Land it now: the capture is a synchronous
  // localStorage write, so it reliably completes inside pagehide (which, unlike
  // beforeunload, also fires on mobile and bfcache navigations).
  useEffect(() => {
    const flush = () => flushPendingAutoSaves();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);
  // Strip a deep-link ?tab= param after mount (not in the useState
  // initializer above) so a reload behaves normally without risking the
  // StrictMode double-invoke racing the read against the strip.
  useEffect(() => {
    if (new URLSearchParams(location.search).get("tab")) {
      history.replaceState(null, "", location.pathname);
    }
  }, []);
  // The named layout THIS BROWSER TAB currently shows (null = scratch).
  // Session-first with a device-local seed — see saveActiveLayoutId.
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(
    () => startup.activeLayoutId,
  );
  // Bumped after any layout mutation so LayoutManager re-reads the persisted index.
  const [layoutRev, setLayoutRev] = useState(0);
  // Autosave: when off, edits accumulate as dirty until the user manually saves.
  const [autosave, setAutosaveState] = useState<boolean>(loadAutosave);
  const [isDirty, setIsDirty] = useState(false);
  // One-shot undo offer for the last merge: the pre-merge snapshot plus the
  // scope moves to reverse. Cleared by time (Snackbar), by undo/dismiss, or by
  // the structure-signature effect in useTabActions when anything structural changes.
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);

  const { accounts, activeAccount, setActiveAccount, brokerId, selectBroker, accountSummary } = useAccounts(
    isDirty,
    settings.trading,
  );

  // Live chart instances + controllers, keyed by cell id. Declared ahead of
  // useBackendSync, whose push handler reads it.
  const readyRef = useRef(new Map<string, { chart: Chart; controller: ChartController }>());
  const { hydrateEpoch, setHydrateEpoch } = useBackendSync({
    brokerId,
    tabs,
    activeId,
    activeLayoutId,
    settings,
    setSettings,
    setTabs,
    setActiveId,
    setActiveLayoutId,
    setLayoutRev,
    setPendingUndo,
    readyRef,
  });

  // Resolve the active tab / focused cell — BOTH may be undefined when no tabs are
  // open (blank workspace). Downstream rendering guards on `active`.
  const active: ChartTab | undefined =
    tabs.find((t) => t.id === activeId) ?? tabs[0];
  const focusedCell =
    active?.cells.find((c) => c.id === active.activeCellId) ?? active?.cells[0];
  const symbol = focusedCell?.symbol;
  const period = focusedCell?.period;

  // Tab click from the bar. With a search active and the tab matching, also
  // re-home the focused cell onto the first match and flash all matches
  // (spec: click-to-jump).
  const selectTabFromBar = useCallback(
    (id: string) => {
      setActiveId(id);
      const tab = tabs.find((t) => t.id === id);
      if (tab == null) return;
      const hits = matchingCellIds(tab, tabSearchQuery);
      if (hits.length === 0) return;
      setTabs((ts) =>
        ts.map((t) => (t.id === id ? { ...t, activeCellId: hits[0] } : t)),
      );
      flashCells(hits);
    },
    [tabs, tabSearchQuery, flashCells],
  );

  // Every searchable chart series across ALL tabs, for the pattern search's
  // all-charts scope. Same gates as a cell's own patternCapable: synthetic
  // epics have no stored history, sub-minute resolutions aren't served, and a
  // snapshot cell is a frozen picture. Called at search time, so it reflects
  // the tabs as they are then.
  const getPatternSeries = useCallback(
    () =>
      tabs.flatMap((t) =>
        t.cells
          .filter(
            (c) =>
              !isSynthetic(c.symbol.epic) &&
              !c.period.liveOnly &&
              loadSnapshotMeta(c.scope) == null,
          )
          .map((c) => ({
            cellId: c.id,
            tabId: t.id,
            epic: c.symbol.epic,
            resolution: c.period.resolution,
            label: c.period.label,
          })),
      ),
    [tabs],
  );

  // A pattern-match jump to a chart on ANOTHER tab: activate the tab, focus
  // the cell and flash it (the same glow as the symbol search), while the
  // match itself waits in the pending-jump map for the cell to mount.
  const revealPatternCell = useCallback(
    (cellId: string) => {
      // Looked up in the workspace as it is NOW, not by the tab the match was
      // tagged with: the cell may have moved tabs since the search.
      const tab = tabs.find((t) => t.cells.some((c) => c.id === cellId));
      if (!tab) return false;
      setActiveId(tab.id);
      setTabs((ts) =>
        ts.map((t) => (t.id === tab.id ? { ...t, activeCellId: cellId } : t)),
      );
      flashCells([cellId]);
      return true;
    },
    [tabs, flashCells],
  );

  // The workspace pattern panel's search fans out over this enumeration; the
  // store is module-level, so the provider must be (re)registered as the tabs
  // change rather than passed through the chart tree.
  useEffect(() => setPatternSeriesProvider(getPatternSeries), [getPatternSeries]);

  // Hide (never dismiss) the pattern panel while an ON-SCREEN cell is in a
  // readout — picking a blind start point or an active session: its rows
  // carry the real dates a masked session exists to conceal, and during
  // picking they would place the concealed present on the calendar. Only
  // mounted cells register, so a session parked on another tab hides nothing
  // — the panel is workspace-level and the replaying chart is not on screen.
  const patternPanelHidden = useSyncExternalStore(subscribeReplayingCells, anyCellInReadout);

  // Typing in the search flashes the ACTIVE tab's matches immediately —
  // no tab click needed when the symbol is already in front of you.
  useEffect(() => {
    if (tabSearchQuery.trim() === "" || active == null) return;
    flashCells(matchingCellIds(active, tabSearchQuery));
    // Deliberately keyed on the query only: re-flashing on every tabs-array
    // identity change would loop (flash → activeCellId write → new tabs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabSearchQuery]);

  // A ready/focus change bumps a counter so the derived `focused` recomputes
  // (the map itself is readyRef, a ref).
  const [readyTick, bumpReady] = useReducer((n: number) => n + 1, 0);
  const focused = focusedCell ? readyRef.current.get(focusedCell.id) ?? null : null;

  // --- alert → chart navigation (sidebar "go to chart" icon) ------------------
  // A deferred select: when the sidebar asks to open an alert, we switch to / create
  // the cell that shows its epic and stash the request here. The target cell's overlay
  // lines don't exist until it mounts AND rehydrates (rehydrate even nulls any early
  // select), so we can't select synchronously across tabs — we resolve once the
  // cell's overlays report hydratedEpic === the target epic. `savedId` is the stable
  // alert id (all-symbols rows / stamped history); `hint` is the content match for
  // older history rows. Either may resolve to nothing (a "once" alert that already
  // fired and was removed) — then we just leave the freshly-opened chart unselected.
  const pendingSelectRef = useRef<
    { epic: string; cellId: string } & AlertNavTarget | null
  >(null);
  const resolvePendingSelect = useCallback(() => {
    const p = pendingSelectRef.current;
    if (!p) return;
    const entry = readyRef.current.get(p.cellId);
    if (!entry) return; // cell not mounted yet (will retry on ready / alertsChanged)
    const ov = entry.controller.overlays;
    if (ov.getHydratedEpic() !== p.epic) return; // rehydrate hasn't run yet
    const ovId = p.savedId
      ? ov.findAlertOverlayId(p.savedId)
      : p.hint
        ? ov.findAlertOverlayIdByMatch(p.hint.condition, p.hint.level, p.hint.precision)
        : null;
    pendingSelectRef.current = null; // clear BEFORE select so its alertsChanged bump can't loop
    if (ovId) ov.selectAlert(ovId);
  }, []);
  // rehydrate() ends with notifyAlerts() → alertsChanged, so a remounted target cell
  // resolves here. (The ready + readyTick effect covers the already-mounted case.)
  useEffect(() => alertsChanged.subscribe(resolvePendingSelect), [resolvePendingSelect]);
  useEffect(() => resolvePendingSelect(), [readyTick, resolvePendingSelect]);

  const onCellReady = (cellId: string, chart: Chart, controller: ChartController) => {
    readyRef.current.set(cellId, { chart, controller });
    bumpReady();
    reportCellView(cellId);
  };

  // Passive "what is the user looking at" heartbeat (mirrored, for the backend's
  // headless alert-time chart snapshot — see lib/viewHeartbeat.ts). Debounced and
  // cheap to over-call, so it's wired at symbol/period/focus/ready — the points
  // where the view actually changes identity — never on scroll/zoom ticks.
  // Reads the cell fresh off tabsRef (not a render closure) since it's called
  // from callbacks defined at various points in the component body.
  function reportCellView(cellId: string) {
    const cell = tabsRef.current.flatMap((t) => t.cells).find((c) => c.id === cellId);
    const entry = readyRef.current.get(cellId);
    if (!cell || !entry) return;
    const el = entry.chart.getDom?.() ?? null;
    reportView({
      scope: cell.scope,
      epic: cell.symbol.epic,
      broker: brokerIdRef.current,
      resolution: cell.period.resolution,
      symbol: cell.symbol,
      barSpace: entry.chart.getBarSpace().bar,
      width: el?.clientWidth ?? 1280,
      height: el?.clientHeight ?? 640,
    });
  }

  const { seedIndicatorSync, replicateRef } = useIndicatorSync({
    tabs,
    readyRef,
  });

  // Tab writes from jumpToEpic land in the refs at once as well as in state.
  // Its awaits resume outside any React event, so the render that would refresh
  // tabsRef can come after the next queued jump has already read it: without
  // this, two overlapping jumps open the same epic twice, or miss the tab the
  // first one opened. The update fn must be pure (React may call it twice).
  const applyTabs = (fn: (ts: ChartTab[]) => ChartTab[]) => {
    tabsRef.current = fn(tabsRef.current);
    setTabs(fn);
  };
  const applyActiveId = (id: string) => {
    activeIdRef.current = id;
    setActiveId(id);
  };

  // Every path that opens a new tab: build it, append it, make it active.
  const openTab = (symbol: Instrument): ChartTab => {
    const t = makeTab(symbol, DEFAULT_PERIOD);
    applyTabs((ts) => [...ts, t]);
    applyActiveId(t.id);
    return t;
  };

  // Focus (or open) a chart showing `epic`: lib/epicJump.ts, over this App's
  // tab refs/state and the broker catalogue.
  const epicJumpDeps: EpicJumpDeps = {
    tabs: () => tabsRef.current,
    activeId: () => activeIdRef.current,
    applyTabs,
    setActive: applyActiveId,
    openTab,
    resolve: (epic, precisionGuess) => resolveInstrument(epic, brokerIdRef.current, precisionGuess),
    isReplaying: isCellReplaying,
  };
  const jumpToEpic = (epic: string, precisionGuess = 2, reuse?: ReuseSlot) =>
    runEpicJump(epicJumpDeps, epic, precisionGuess, reuse);

  const jumpToEpicRef = useRef(jumpToEpic);
  jumpToEpicRef.current = jumpToEpic;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  useAppAgentActions(jumpToEpicRef, tabsRef, activeIdRef);

  // --- trade-list panel → chart navigation -----------------------------------
  const brokerIdRef = useRef(brokerId);
  brokerIdRef.current = brokerId;
  const jumpToTrade = useTradeBoxJump({ readyRef, readyTick, tabsRef, brokerIdRef, setTabs, jumpToEpic });

  // Open (or reuse) the chart for an alert and select its line. The select is
  // deferred via pendingSelectRef (see resolvePendingSelect) — resolvePendingSelect
  // is idempotent and guarded, so calling it now resolves an already-mounted cell
  // and harmlessly no-ops for a freshly-opened tab (the alertsChanged/ready path
  // resolves that later).
  const openAlert = async (epic: string, target: AlertNavTarget, precisionGuess: number) => {
    const { cellId } = await jumpToEpic(epic, precisionGuess);
    pendingSelectRef.current = { epic, cellId, ...target };
    resolvePendingSelect();
  };

  // A fired alert's toast/banner clicks navigate through this handler (the
  // fired callback is registered outside React and can't reach openAlert
  // directly). Re-assigned every render so it always closes over current tabs.
  useEffect(() => {
    alertNavHandler.current = (epic, savedId, precision) =>
      void openAlert(epic, { savedId }, precision);
  });
  useEffect(() => () => { alertNavHandler.current = null; }, []);

  const alertTabIds = useUnseenAlertTabs(tabs, active);
  const epicClosed = useMarketClosedBadges(tabs, brokerId);

  // Pointer-down in a cell focuses it (routes the chrome to that cell).
  const onCellFocus = (cellId: string) => {
    if (!active || cellId === active.activeCellId) return;
    setTabs((ts) =>
      ts.map((t) => (t.id === active.id ? { ...t, activeCellId: cellId } : t)),
    );
    reportCellView(cellId);
  };

  const { panelOpen, tradeListOpen, tradeOpen, snapGalleryOpen, snapshotTabIds } =
    usePanelOpenStates(tabs);

  useEffect(() => {
    // data-theme + the --chart-bg override, via the shared helper (theme.ts) so
    // the headless SnapshotApp stamps the identical theme onto its document —
    // the alert screenshot rendered on the CSS dark default before it did.
    applyThemeToDocument(settings);
    // Don't re-mirror a change that came FROM a remote sync. persist writes the
    // pushed value to localStorage before calling syncSettingsFromLocal, so if our
    // state already equals localStorage this update is that sync echo — re-saving it
    // would push it back out and two tabs holding different settings (e.g. priceSide
    // mid vs bid) ping-pong forever via /ws/state, thrashing the live feed. A genuine
    // local edit differs from localStorage until this save writes it.
    if (JSON.stringify(settings) === JSON.stringify(loadSettings())) return;
    saveSettings(settings);
    // Imperative readers (the chart's center-pin in useLiveMarketData reads
    // loadSettings outside React) refresh on this instead of a prop thread.
    window.dispatchEvent(new Event("at:settings-saved"));
  }, [settings]);

  // Persist the workspace. When autosave is on (default), every edit writes back to
  // the active named layout (mirrored → syncs to other devices). An unnamed workspace
  // always writes to the device-local scratch regardless of autosave. When autosave is
  // off, named-layout edits are NOT persisted automatically — isDirty flags the
  // pending change and the user must hit Save (⌘S) to commit.
  const layoutName = loadLayouts().find((l) => l.id === activeLayoutId)?.name;
  useEffect(() => {
    // activeTabId is deliberately "" — the active tab is per-instance and never
    // persisted to the (mirrored) body, so a selection here can't sync to a sibling.
    // `active?.id` is NOT a dependency for the same reason: selecting a tab must not
    // trigger a save/mirror at all.
    const ws: Workspace = { tabs, activeTabId: "" };
    if (activeLayoutId && layoutName != null) {
      if (autosave) {
        saveLayout(activeLayoutId, layoutName, ws);
        setIsDirty(false);
      } else {
        setIsDirty(true);
      }
    } else if (tabs.length > 0) {
      saveScratch(ws);
    } else {
      clearScratch();
    }
  }, [tabs, activeLayoutId, layoutName, autosave]);

  useAlertFiredNotices();
  // Keep activeId valid (heal to first tab) and persist this device's active layout.
  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);
  useEffect(() => {
    saveActiveLayoutId(activeLayoutId); // device-local, not mirrored
  }, [activeLayoutId]);

  const {
    setSymbol,
    setCellPeriod,
    setPeriod,
    setLayout,
    setCellSizes,
    toggleSync,
    toggleLock,
  } = useCellActions({
    active,
    focusedCell,
    setTabs,
    tabsRef,
    readyRef,
    replicateRef,
    seedIndicatorSync,
    reportCellView,
  });

  const {
    addTab,
    openSymbolTab,
    detachCell,
    restoreSnapshot,
    saveCurrentSnapshot,
    closeCell,
    swapCells,
    mergeTabs,
    undoMerge,
    reorderTab,
    closeTab,
  } = useTabActions({
    active,
    focused,
    focusedCell,
    tabs,
    activeId,
    setTabs,
    setActiveId,
    activeLayoutId,
    layoutName,
    setIsDirty,
    pendingUndo,
    setPendingUndo,
    openTab,
  });

  const {
    switchLayout,
    saveActiveLayout,
    saveLayoutAs,
    importLayoutFromFile,
    removeLayout,
    toggleAutosave,
  } = useNamedLayouts({
    tabs,
    active,
    activeLayoutId,
    layoutName,
    autosave,
    setTabs,
    setActiveId,
    setActiveLayoutId,
    setHydrateEpoch,
    setLayoutRev,
    setIsDirty,
    setAutosaveState,
  });

  // Magnet mode's momentary-invert modifier (hold Ctrl/Cmd while drawing to flip
  // snapping). Installed once for the app; OverlayManagers react via magnetInvertSignal.
  useEffect(() => installMagnetModifierKeys(), []);

  // Esc leaves maximized view (matches the fullscreen idiom). Deferred while a
  // cell is maximized so nested Esc presses unwind the cell first.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !maximizedCellId) setMaximized(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [maximized, maximizedCellId]);

  // Esc restores a maximized cell. Takes priority over the workspace-maximize
  // Esc handler above so nested maximizes unwind one level at a time.
  useCloseOnEscape(() => {
    if (maximizedCellId) setMaximizedCellId(null);
  });

  // A maximized cell is a transient view; switching tabs or changing the layout
  // must clear it so a now-hidden/absent cell can't strand the grid blank.
  useEffect(() => {
    setMaximizedCellId(null);
  }, [active?.id, active?.layout]);

  const focusedController = focused?.controller ?? null;

  // Agent drawing actions target the focused chart. Re-set every render so the
  // provider closure never goes stale (same ref-each-render idiom as
  // jumpToEpicRef/tabsRef above, but as an effect without deps for clarity).
  useEffect(() => {
    setFocusedDrawingsProvider(() =>
      focusedController && focusedCell && symbol
        ? { overlays: focusedController.overlays, epic: symbol.epic, cellId: focusedCell.id }
        : null,
    );
    setFocusedChartProvider(() =>
      focusedController && focusedController.chart && focusedCell && symbol
        ? {
            chart: focusedController.chart,
            controller: focusedController,
            scope: focusedController.scope,
            epic: symbol.epic,
            cellId: focusedCell.id,
            resolution: focusedCell.period.resolution,
            broker: brokerId,
            setPeriod,
          }
        : null,
    );
  });

  // Strategy-declared chart overlays (e.g. BB Regime's BOLL band) on the
  // focused cell, synced to the backtest strategy setup from ANY writer —
  // panel edits, preset restores, or the agent bridge with the panel closed.
  useStrategyOverlaySync(focusedController, symbol?.epic ?? null);

  // Whether the FOCUSED cell is a read-only snapshot view. The controller's
  // readOnly flag is the sentinel (seeded at cell mount, cleared by Unlock, which
  // also bumps snapshotViewChanged so this re-renders); for the brief window
  // before the cell's controller registers, fall back to the scope's stored
  // snapshotMeta so a restoring tab never flashes the full editing chrome.
  const focusedReadOnly = focusedController
    ? focusedController.readOnly.value
    : focusedCell != null && loadSnapshotMeta(focusedCell.scope) != null;

  // Whether the FOCUSED cell is inside a chart-replay session. Subscribed rather
  // than read during render like readOnly above, because nothing else re-renders
  // App when a session starts or ends and the order ticket below has to stop
  // being the live one the moment it does. useSyncExternalStore (not the
  // useEffect + useState idiom next door) so the very first render already has
  // the right answer: focus can land on a cell that is ALREADY replaying, and a
  // frame of the live ticket beside a blind session is the whole defect.
  const focusedReplaying = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => focusedController?.replaying.subscribe(onChange) ?? (() => {}),
      [focusedController],
    ),
    () => focusedController?.replaying.value ?? false,
  );

  // Per-epic price precision for the whole-book trading dock: its rows span every
  // symbol that has an open position/order, not just the focused chart, so each row
  // formats prices with its own symbol's precision (gleaned from any open cell on
  // that epic) rather than the focused chart's.
  const epicPrecision = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tabs)
      for (const c of t.cells)
        if (c.symbol.pricePrecision != null) m.set(c.symbol.epic, c.symbol.pricePrecision);
    return m;
  }, [tabs]);
  const precisionForEpic = (epic: string) =>
    epicPrecision.get(epic) ?? symbol?.pricePrecision ?? 2;

  // The active tab's on-screen cells that have a live controller, for the alerts
  // panel's cross-cell hover/select: an alert whose epic is shown in ANY visible
  // split cell (not only the focused one) highlights that cell's line. Recomputed
  // on readyTick so a cell mounting after the panel opens is picked up.
  const visibleCells: VisibleCell[] = (active?.cells ?? [])
    .map((c) => {
      const entry = readyRef.current.get(c.id);
      return entry ? { epic: c.symbol.epic, overlays: entry.controller.overlays } : null;
    })
    .filter((v): v is VisibleCell => v !== null);
  void readyTick; // visibleCells reads the mutable readyRef; readyTick forces the recompute

  return (
    <div className="app">
      {/* TradingView-style chart tabs: topmost strip, above the toolbar. The
          workspace-level controls (broker selector, named layouts, split picker,
          theme) ride at the right of this bar — they act on the tab/workspace, not
          on a single chart, so they don't belong in the per-chart toolbar below.
          The broker selector especially: switching broker swaps the ENTIRE
          workspace. Hidden in maximized view; Backtest lives in the toolbar so it
          survives that. */}
      {!maximized && (
      <TabBar
        tabs={tabs}
        activeId={active?.id ?? ""}
        closedEpics={epicClosed}
        alertTabIds={alertTabIds}
        snapshotTabIds={snapshotTabIds}
        onSelect={selectTabFromBar}
        onAdd={addTab}
        onClose={closeTab}
        onReorder={reorderTab}
        canMerge={(s, d) => canMergeTabs(tabs, s, d)}
        onMerge={mergeTabs}
        onDragActive={setDragTabId}
        searchQuery={tabSearchQuery}
        onSearchQuery={setTabSearchQuery}
        brokerId={brokerId}
        onOpenSymbol={openSymbolTab}
        strip={settings.tabStrip}
        showBarChange={settings.tabBarChange}
        onToggleBarChange={(id) =>
          setTabs((ts) =>
            ts.map((t) =>
              t.id === id ? { ...t, barChange: !(t.barChange ?? settings.tabBarChange) } : t,
            ),
          )
        }
        priceSide={settings.priceSide}
        trailing={
          <>
            <LayoutManager
              activeLayoutId={activeLayoutId}
              hasWorkspace={tabs.length > 0}
              autosave={autosave}
              isDirty={isDirty}
              onToggleAutosave={toggleAutosave}
              onSwitch={switchLayout}
              onSave={saveActiveLayout}
              onSaveAs={saveLayoutAs}
              onDelete={removeLayout}
              onImport={importLayoutFromFile}
              revision={layoutRev}
            />
            {active?.layout && (
              <LayoutPicker
                layout={active.layout}
                onLayout={setLayout}
                syncSymbol={!!active.syncSymbol}
                syncInterval={!!active.syncInterval}
                syncCrosshair={!!active.syncCrosshair}
                syncTime={!!active.syncTime}
                syncIndicators={!!active.syncIndicators}
                locked={!!active.locked}
                onToggleSync={toggleSync}
                onToggleLock={toggleLock}
              />
            )}
            <AppearanceMenu
              settings={settings}
              onChange={setSettings}
              onBarChangeAll={(on) => {
                setSettings((s) => ({ ...s, tabBarChange: on }));
                // All tabs means all: drop the per-tab overrides.
                setTabs((ts) =>
                  ts.some((t) => t.barChange !== undefined)
                    ? ts.map((t) => ({ ...t, barChange: undefined }))
                    : ts,
                );
              }}
            />
            <Tooltip content="Settings">
              <button
                className="tabbar-action icon-only gear"
                onClick={() => setShowSettings(true)}
              >
                ⚙
              </button>
            </Tooltip>
            {/* Active broker / trading account, pinned to the FAR RIGHT of the tab
                bar. Lives here (not the chart toolbar) because switching broker swaps
                the WHOLE workspace — a workspace-scope action; the toolbar holds only
                chart-scope actions. */}
            {isDemoMode() ? <DemoCta /> : (
              <BrokerSelector
                accounts={accounts}
                activeBroker={brokerId}
                onChange={selectBroker}
              />
            )}
          </>
        }
      />
      )}
      {/* One engine, two chromes: a snapshot view gets the whitelist-only
          SnapshotToolbar; everything else gets the full Toolbar. */}
      {focusedReadOnly ? (
        <SnapshotToolbar
          controller={focusedController}
          symbol={symbol}
          period={period}
          onPeriod={setPeriod}
          brokerId={brokerId}
          accounts={accounts}
          onSelectBroker={selectBroker}
          maximized={maximized}
          onToggleMaximize={() => setMaximized((m) => !m)}
        />
      ) : (
        <Toolbar
          controller={focusedController}
          symbol={symbol}
          period={period}
          onSymbol={setSymbol}
          onPeriod={setPeriod}
          brokerId={brokerId}
          priceSide={settings.priceSide}
          accounts={accounts}
          onSelectBroker={selectBroker}
          maximized={maximized}
          onToggleMaximize={() => setMaximized((m) => !m)}
        />
      )}
      <div className={`workspace${dockMaximized ? " dock-hidden" : ""}`}>
        <main className="chart">
          {/* No draw sidebar in a read-only snapshot view (nothing may be drawn). */}
          {active && !focusedReadOnly && (
            <DrawSidebar
              controller={focusedController}
              preserveCenterOnTf={settings.preserveCenterOnTfChange}
              onTogglePreserveCenterOnTf={() =>
                setSettings((s) => ({
                  ...s,
                  preserveCenterOnTfChange: !s.preserveCenterOnTfChange,
                }))
              }
            />
          )}
          <div className="chart-cells">
          {active ? (
            /* Multi-chart grid for the active tab. Switching tabs swaps the cell
               set; each cell keys on cell.id so it remounts and re-reads its scope. */
            <ChartGrid
              // hydrateEpoch forces a remount after a backend hydrate so cells
              // re-read freshly-overwritten per-cell state (drawings/indicators/
              // alerts) even when the tab/cell ids are unchanged.
              key={`${active.id}:${hydrateEpoch}`}
              tabId={active.id}
              cells={active.cells}
              layout={active.layout}
              focusedCellId={active.activeCellId}
              searchGlowCellIds={searchGlow}
              brokerId={brokerId}
              theme={settings.theme}
              timezone={settings.timezone}
              clock={settings.clock}
              dateFormat={settings.dateFormat}
              showWeekday={settings.showWeekday}
              priceSide={settings.priceSide}
              bidAsk={settings.bidAsk}
              bidAskStyle={settings.bidAskStyle}
              crosshair={settings.crosshair}
              goLivePillPos={settings.goLivePillPos}
              syncCrosshair={effectiveSyncCrosshair(active)}
              syncTime={effectiveSyncTime(active)}
              locked={!!active.locked}
              onReady={onCellReady}
              onFocus={onCellFocus}
              onPeriod={setCellPeriod}
              maximizedCellId={maximizedCellId}
              onToggleMaximizeCell={(cellId) =>
                setMaximizedCellId((cur) => (cur === cellId ? null : cellId))
              }
              onDetachCell={detachCell}
              onCloseCell={closeCell}
              onSwapCells={swapCells}
              sizes={active.sizes}
              onSizes={setCellSizes}
              tabDrag={
                dragTabId && active && dragTabId !== active.id
                  ? { canMerge: canMergeTabs(tabs, dragTabId, active.id) }
                  : null
              }
              onMergeDrop={(pos) => {
                if (dragTabId && active) mergeTabs(active.id, [dragTabId], pos);
                setDragTabId(null);
              }}
            />
          ) : (
            /* Blank workspace: no default layout and nothing open. Offer the two
               ways forward — open a saved layout (the manager lives in the toolbar)
               or start a fresh chart. */
            <div className="empty-workspace">
              <p>No charts open</p>
              <p className="empty-workspace-hint">
                Open a saved layout from the menu above, or
              </p>
              <button onClick={addTab}>+ New chart</button>
            </div>
          )}
          </div>
          {/* "Find similar" results, docked as a full-height sidebar on the
              chart area's right, OUTSIDE the grid: the results span every
              chart in every open tab, so the panel belongs to the workspace
              and survives tab switches, series changes and cells closing —
              only its own ✕ takes it down. */}
          <WorkspacePatternPanel
            timezone={settings.timezone}
            hidden={patternPanelHidden}
            onReveal={revealPatternCell}
            broker={brokerId}
            priceSide={settings.priceSide}
          />
          {/* Imported trade list, docked like the pattern panel (workspace-level:
              rows span symbols across tabs). Hidden — state intact — while a
              replay readout is masking dates: its rows carry the real dates a
              masked session exists to conceal. */}
          {tradeListOpen && (
            <TradeListPanel
              onSelect={jumpToTrade}
              onClose={() => tradeListPanelOpen.set(false)}
              brokerId={brokerId}
              hidden={patternPanelHidden}
            />
          )}
        </main>
        {/* Panel is toggled by the toolbar bell; closed = chart uses full width. */}
        {!isDemoMode() && panelOpen && symbol && !isSynthetic(symbol.epic) && (
          <AlertsSidebar
            controller={focusedController}
            epic={symbol.epic}
            precision={symbol.pricePrecision ?? 2}
            tabs={tabs}
            visibleCells={visibleCells}
            brokerId={brokerId}
            onOpenAlert={openAlert}
          />
        )}
        {/* Order ticket (paper): compose a new order for the focused symbol. The
            open book lives in the bottom dock, not here. Toggled by the toolbar's
            trade button. */}
        {!isDemoMode() && tradeOpen && symbol && !isSynthetic(symbol.epic) && !isDataOnlyBroker(brokerId) && (
          <aside className="trade-sidebar">
            <OrderTicket
              epic={symbol.epic}
              account={activeAccount}
              precision={symbol.pricePrecision ?? 2}
              instrumentType={symbol.type}
              trading={settings.trading}
              accountSummary={accountSummary}
              replaying={focusedReplaying}
            />
          </aside>
        )}
        {/* Backtest config: docked right, like the alerts sidebar. Non-modal —
            the chart shrinks beside it and stays interactive; running keeps it
            open so you can iterate. */}
        {showBacktestCfg && symbol && period && (
          <BacktestSettingsModal
            initial={loadBacktestLastUsed() ?? defaultBacktestConfig()}
            epic={symbol.epic}
            brokerId={brokerId}
            resolution={period.resolution}
            controller={focusedController}
            chartTimezone={settings.timezone || browserTimezone()}
            onRun={(cfg) => {
              saveBacktestLastUsed(cfg);
              requestBacktestRun();
            }}
            onClose={() => openBacktestCfg(false)}
          />
        )}
        {/* Live trading: a separate docked surface from the backtest, so trading
            real money is never confused with testing. */}
        {!isDemoMode() && showLive && symbol && period && !isDataOnlyBroker(brokerId) && (
          <LiveTradingPanel
            epic={symbol.epic}
            resolution={period.resolution}
            brokerId={brokerId}
            accounts={accounts}
            defaultAccount={activeAccount}
            controller={focusedController}
            onClose={() => livePanelOpen.set(false)}
          />
        )}
      </div>
      {/* Trading dock (paper): the whole open book — positions + resting orders
          across ALL symbols — docked full-width under the chart, TV-style. ALWAYS
          shown (the book is global, independent of the order ticket) but
          collapsible to its header bar. Double-clicking a row focuses that symbol's
          chart and opens its edit ticket in the (revealed) sidebar. */}
      {!isDemoMode() && (
        <div className={`trading-dock${dockMaximized ? " maximized" : ""}`}>
          <PositionsPanel
            account={activeAccount}
            accounts={accounts}
            onAccountChange={setActiveAccount}
            accountSummary={accountSummary}
            focusedEpic={symbol?.epic}
            precisionFor={precisionForEpic}
            trading={settings.trading}
            confirmLineEdits={settings.trading.confirmLineEdits}
            onJumpToEpic={jumpToEpic}
            maximized={dockMaximized}
            onToggleMaximize={() => setDockMaximized((m) => !m)}
          />
        </div>
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          onClose={() => { setShowSettings(false); setSettingsTab(undefined); }}
          initialTab={settingsTab}
        />
      )}

      {!isDemoMode() && alertReq && symbol && (
        <AlertModal
          epic={symbol.epic}
          price={alertReq.price}
          defaults={settings.alertDefaults}
          now={Date.now()}
          onCreate={(level, cfg) => {
            focusedController?.overlays.addAlert(level, cfg);
            alertModalRequest.set(null);
          }}
          onClose={() => alertModalRequest.set(null)}
        />
      )}

      {!isDemoMode() &&
        alertEdit &&
        symbol &&
        (() => {
          // Prefill from the focused cell's live overlay. If gone (e.g. deleted), close.
          const a = focusedController?.overlays.getAlert(alertEdit.id);
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
                focusedController?.overlays.updateAlert(alertEdit.id, level, cfg);
                alertEditRequest.set(null);
              }}
              onDelete={() => {
                const id = alertEdit.id;
                // Confirm over the still-open edit modal; on confirm, delete + close it.
                requestConfirm({
                  message: `Delete this alert on ${symbol.epic}?`,
                  onConfirm: () => {
                    focusedController?.overlays.remove(id);
                    alertEditRequest.set(null);
                  },
                });
              }}
              onClose={() => alertEditRequest.set(null)}
            />
          );
        })()}

      {/* Global alert edit: the all-symbols panel rows edit alerts whose chart may
          not be open, so this reads/writes storage directly (no overlay/controller).
          bumpAlerts() makes every open cell + the engine reconcile the change. */}
      {!isDemoMode() &&
        alertGlobalEdit &&
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

      {indSettings && focused && focusedCell && symbol && period && (
        <IndicatorSettings
          key={`${indSettings.paneId}:${indSettings.name}`}
          chart={focused.chart}
          scope={focusedCell.scope}
          cellId={focusedCell.id}
          epic={symbol.epic}
          brokerId={brokerId}
          chartResolution={period.resolution}
          paneId={indSettings.paneId}
          name={indSettings.name}
          controller={focusedController}
          onClose={() => indicatorSettingsRequest.set(null)}
        />
      )}

      {drawSettings && focused && focusedController && (
        <DrawingSettings
          overlays={focusedController.overlays}
          id={drawSettings.id}
          onIdChange={(id) => drawingSettingsRequest.set({ id })}
          onClose={() => drawingSettingsRequest.set(null)}
        />
      )}

      {/* Transient undo offer for the last tab merge (bottom-center). */}
      {pendingUndo && (
        <Snackbar
          message={pendingUndo.label}
          actionLabel="Undo"
          onAction={undoMerge}
          onDismiss={() => setPendingUndo(null)}
          anchorSelector={`.tab-bar .tab[data-tab-id="${pendingUndo.targetId}"]`}
        />
      )}

      {!isDemoMode() && snapGalleryOpen && (
        <SnapshotGallery
          onRestore={restoreSnapshot}
          onClose={() => snapshotsGalleryOpen.set(false)}
          onSaveCurrent={
            // No "Save current chart" while the focused tab is itself a restored
            // snapshot — same rule as the hidden toolbar camera.
            focusedReadOnly ? undefined : saveCurrentSnapshot
          }
        />
      )}

      {/* Confirmation dialog — rendered LAST so it stacks above any modal that opened
          it (e.g. the alert edit modal's delete button). */}
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

      <AgentConfirmHost />

      {saveDefaultReq && (
        <SaveDefaultTemplateModal
          req={saveDefaultReq}
          onClose={() => saveDefaultTemplateRequest.set(null)}
        />
      )}

      {/* Hover popover for a backtest aggregate marker (higher-timeframe view).
          Self-driven by backtestClusterHoverSignal; renders nothing when idle. */}
      <BacktestClusterPopover />
      {/* The trade-review tour card — step through one cohort of the active
          backtest's trades with entry context. Self-driven by tradeReviewSignal
          (entered from the backtest panel's Review button); nothing when idle. */}
      <TradeReviewCard />
      {/* Hover popover for a coarse-timeframe LIVE exit pill — that bar's journaled
          closes. Self-driven by liveExitClusterHoverSignal; nothing when idle. */}
      <TradeExitClusterPopover />
      {/* Hover label for a LIVE trade marker glyph — its full entry/exit text.
          Self-driven by tradeMarkerHoverSignal; renders nothing when idle. */}
      <TradeMarkerLabelPopover />
      {/* Hover popover for a backtest signal-candle glyph — the passing rules'
          values that fired the trade. Self-driven by backtestSignalHoverSignal. */}
      <BacktestSignalPopover />
    </div>
  );
}

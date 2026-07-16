import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Chart } from "klinecharts";
import ChartGrid from "./ChartGrid";
import Toolbar from "./Toolbar";
import SnapshotToolbar from "./SnapshotToolbar";
import DrawSidebar from "./DrawSidebar";
import LayoutPicker from "./LayoutPicker";
import BrokerSelector from "./BrokerSelector";
import { rangeSync, readVisibleRange, readExactAnchor, getAlignAnchor, clearAlignAnchor } from "./lib/chartSync";
import AppearanceMenu from "./AppearanceMenu";
import SettingsModal from "./Settings";
import BacktestSettingsModal from "./BacktestSettingsModal";
import { defaultBacktestConfig } from "./lib/backtestConfig";
import { loadBacktestLastUsed, saveBacktestLastUsed, loadBacktestOpen, saveBacktestOpen, loadLiveOpen, saveLiveOpen } from "./lib/persist";
import LiveTradingPanel from "./LiveTradingPanel";
import AlertModal from "./AlertModal";
import IndicatorSettings from "./IndicatorSettings";
import DrawingSettings from "./DrawingSettings";
import AlertsSidebar, { type AlertNavTarget, type VisibleCell } from "./AlertsSidebar";
import ConfirmDialog from "./ConfirmDialog";
import SaveDefaultTemplateModal from "./SaveDefaultTemplateModal";
import BacktestClusterPopover from "./BacktestClusterPopover";
import TradeExitClusterPopover from "./TradeExitClusterPopover";
import TradeMarkerLabelPopover from "./TradeMarkerLabelPopover";
import BacktestSignalPopover from "./BacktestSignalPopover";
import Snackbar from "./Snackbar";
import OrderTicket from "./OrderTicket";
import PositionsPanel from "./PositionsPanel";
import SnapshotGallery from "./SnapshotGallery";
import { writeSnapshotToScope } from "./lib/snapshots";
import { saveSnapshotOfChart } from "./lib/snapshotSave";
import { registerCustomIndicators } from "./lib/customIndicators";
import { registerBacktestIndicators } from "./lib/backtest";
import { registerCustomOverlays } from "./lib/customOverlays";
import { installMagnetModifierKeys } from "./lib/magnet";
import { compositeOverHex } from "./lib/lineStyle";
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
  alertsPanelOpen,
  tradePanelOpen,
  livePanelOpen,
  alertsChanged,
  bumpAlerts,
  settingsRequest,
  backtestSettingsRequest,
  requestBacktestRun,
  confirmLineEditsSignal,
  tradeLineUiSignal,
  pendingEditsSignal,
  setTradeSelected,
  discardPendingEdit,
  snapshotsGalleryOpen,
  snapshotViewChanged,
} from "./lib/signals";
import { alertEngine } from "./lib/alertEngine";
import {
  PERIODS,
  fetchMarketMeta,
  type Instrument,
  type Period,
} from "./lib/feed";
import {
  fetchBrokers,
  cachedBrokers,
  setTradesAccount,
  DEFAULT_ACCOUNT,
  brokerOf,
  isDataOnlyBroker,
  isRealMoneyAccount,
  fetchAccountSummary,
  loadLastAccountByBroker,
  saveLastAccountByBroker,
  migrateCapitalLiveAccountKeys,
  type BrokerAccount,
  type TradeAccount,
  type AccountSummary,
} from "./lib/trading";
import {
  hydrateFromBackend,
  subscribeToBackendUpdates,
  PREFIX,
  parseAlertsStateKey,
  purgeTabScope,
  purgeScope,
  primaryCellScope,
  cellScope,
  copyScopeContent,
  LAYOUT_CELLS,
  KIND_FOR_COUNT,
  pruneLegacyGlobalWorkspace,
  pruneLegacyTabsKeys,
  setPersistBroker,
  getPersistBroker,
  loadStoredAlert,
  updateStoredAlert,
  deleteStoredAlert,
  loadLayouts,
  loadLayout,
  saveLayout,
  deleteLayout,
  loadDefaultLayoutId,
  loadActiveLayoutId,
  saveActiveLayoutId,
  hasExplicitScratchSelection,
  sessionGet,
  sessionSet,
  loadScratch,
  saveScratch,
  clearScratch,
  cloneWorkspace,
  pickActiveTabId,
  loadAutosave,
  saveAutosave,
  mergeTabInto,
  canMergeTabs,
  unmergeScopes,
  loadSnapshotMeta,
  type ChartTab,
  type LayoutKind,
  type Workspace,
  type ChartSnapshot,
} from "./lib/persist";
import LayoutManager from "./LayoutManager";
import { requestSymbolSearch } from "./lib/signals";
import { loadSettings, saveSettings, chartColors, type Settings } from "./theme";
import { browserTimezone } from "./chart/chartPainters";
import TabBar from "./TabBar";
import Tooltip from "./components/Tooltip";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import { isSynthetic } from "./lib/syntheticRegistry";
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

// Max effective opacity for the chart-pane background wash in DARK theme. The bg
// colors/moods are light washes; capping their opacity in dark lets them lift the
// dark background toward the color instead of replacing it (see the theme effect).
const DARK_CHART_BG_CAP = 0.15;

const DEFAULT_SYMBOL: Instrument = {
  epic: "US100",
  name: "US Tech 100",
  status: null,
  pricePrecision: 2,
};
const DEFAULT_PERIOD: Period =
  PERIODS.find((p) => p.resolution === "HOUR") ?? PERIODS[0];

// Which chart tab is active is remembered PER BROWSER TAB (sessionStorage, so it
// survives a reload but isn't shared with sibling tabs) — see the activeId state.
const ACTIVE_TAB_SESSION_KEY = "auto-trader.activeTabId";

// The first instrument a brand-new broker workspace opens on (each broker is an
// isolated instance with a FRESH START — no carry-over). Epics are broker-specific,
// so a per-broker default; pricePrecision is just a render seed (the chart fetches
// real market meta on mount). A synchronous map (not a network call) so the empty
// workspace renders instantly — see resolveStartup / the broker-switch handler.
const DEFAULT_SYMBOL_BY_BROKER: Record<string, Instrument> = {
  capital: DEFAULT_SYMBOL,
  "ig-demo": { epic: "CS.D.EURUSD.CFD.IP", name: "EUR/USD", status: null, pricePrecision: 5 },
  "ig-live": { epic: "CS.D.EURUSD.CFD.IP", name: "EUR/USD", status: null, pricePrecision: 5 },
};
function defaultInstrument(broker: string): Instrument {
  return DEFAULT_SYMBOL_BY_BROKER[broker] ?? DEFAULT_SYMBOL;
}

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now().toString(36)}-${tabSeq}`;
}
let cellSeq = 0;
function newCellId(): string {
  cellSeq += 1;
  return `cell-${Date.now().toString(36)}-${cellSeq}`;
}

// Build a one-cell tab. The first cell reuses the tab's primary scope (`tab.<id>`)
// so it lines up with the pre-cells / migrated key namespace.
// Effective per-tab sync flags. The "lock charts" master override doesn't mutate
// the four underlying toggles — it derives over them — so unlocking restores their
// prior state for free. Locked = interval/crosshair/date-range forced on (full
// mirror) and symbol forced off (each cell keeps its own instrument). Every place
// that consumes a sync flag reads through these instead of the raw field.
const effectiveSyncSymbol = (t: ChartTab) => !t.locked && !!t.syncSymbol;
const effectiveSyncInterval = (t: ChartTab) => !!t.locked || !!t.syncInterval;
const effectiveSyncCrosshair = (t: ChartTab) => !!t.locked || !!t.syncCrosshair;
const effectiveSyncTime = (t: ChartTab) => !!t.locked || !!t.syncTime;

function makeTab(symbol: Instrument, period: Period): ChartTab {
  const id = newTabId();
  const cid = newCellId();
  return {
    id,
    layout: "1",
    activeCellId: cid,
    cells: [{ id: cid, symbol, period, scope: primaryCellScope(id) }],
  };
}

// A fresh single-tab workspace on `broker`'s default instrument — what a brand-new
// broker (no saved workspace) lands on, so the user sees a usable chart instead of a
// blank screen. Synchronous (no network) for an instant switch.
function defaultWorkspace(broker: string): Workspace {
  const t = makeTab(defaultInstrument(broker), DEFAULT_PERIOD);
  return { tabs: [t], activeTabId: t.id };
}

// Resolve which workspace this device shows on launch. Precedence:
//   1. this device's last-open layout (activeLayoutId), if it still exists
//   2. the synced default layout, if set
//   3. the unsaved scratch workspace, if the user had one
//   4. a BRAND-NEW broker (no layouts, no scratch) -> a fresh default-symbol tab
//   5. otherwise blank (has layouts but none selected — pick one from the manager)
// Returns the workspace plus the active layout id (null = scratch/blank). Reads the
// ACTIVE broker's keys (persistBroker), so each broker resolves its own workspace.
function resolveStartup(): { ws: Workspace; activeLayoutId: string | null } {
  const blank: Workspace = { tabs: [], activeTabId: "" };
  const layouts = loadLayouts();
  const known = new Set(layouts.map((l) => l.id));

  const activeId = loadActiveLayoutId();
  if (activeId && known.has(activeId)) {
    return { ws: loadLayout(activeId) ?? blank, activeLayoutId: activeId };
  }
  // THIS TAB explicitly chose scratch (session tombstone): the synced default
  // layout must not override that choice — skip rule 2 and fall through to the
  // scratch rules. Without this gate a scratch tab would be yanked onto the
  // default layout on every reload or sibling defaultLayoutId push.
  if (!hasExplicitScratchSelection()) {
    const defId = loadDefaultLayoutId();
    if (defId && known.has(defId)) {
      return { ws: loadLayout(defId) ?? blank, activeLayoutId: defId };
    }
  }
  const scratch = loadScratch();
  if (scratch && scratch.tabs.length > 0) {
    return { ws: scratch, activeLayoutId: null };
  }
  // Nothing saved for this broker at all → seed a default-symbol workspace so a
  // first-time broker lands on a usable chart (not a blank screen). If the broker
  // HAS layouts but none is selected, keep blank — the user picks one.
  if (layouts.length === 0) {
    return { ws: defaultWorkspace(getPersistBroker()), activeLayoutId: null };
  }
  return { ws: blank, activeLayoutId: null };
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
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
  // Mirror confirmLineEdits onto a signal so the chart (no settings prop) can read it.
  useEffect(() => {
    confirmLineEditsSignal.set(settings.trading.confirmLineEdits);
  }, [settings.trading.confirmLineEdits]);
  // Toolbar gear + chart context menu request the Settings modal via a signal.
  useEffect(() => settingsRequest.subscribe(() => setShowSettings(true)), []);
  // The toolbar Backtest button opens the docked config panel via a signal.
  // Open-state is device-local so the panel reopens after a reload if it was
  // open (loadBacktestOpen), showing the persisted config/results without re-running.
  const [showBacktestCfg, setShowBacktestCfg] = useState(loadBacktestOpen);
  const openBacktestCfg = (open: boolean) => {
    setShowBacktestCfg(open);
    saveBacktestOpen(open);
  };
  useEffect(() => backtestSettingsRequest.subscribe(() => openBacktestCfg(true)), []);
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
  // Remember the active tab for this browser tab so a reload restores it.
  useEffect(() => {
    if (activeId) sessionStorage.setItem(ACTIVE_TAB_SESSION_KEY, activeId);
  }, [activeId]);
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
  // the structure-signature effect below when anything structural changes.
  const [pendingUndo, setPendingUndo] = useState<{
    prevTabs: ChartTab[];
    prevActiveId: string;
    pairs: Array<{ from: string; to: string }>;
    label: string;
    sigAfter: string;
    targetId: string; // the merged tab — the snackbar anchors under its chip
  } | null>(null);

  // Active broker / trading account (registry key "{broker}:{env}"). Drives BOTH
  // the chart data feed (epics are broker-specific) and order/position routing.
  // PER BROWSER TAB: sessionStorage is this tab's selection (each app tab can sit
  // on a different broker); the bare localStorage key is only the last-used seed
  // a brand-new tab opens on. The list of selectable accounts comes from GET
  // /api/brokers.
  const [accounts, setAccounts] = useState<BrokerAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<TradeAccount>(
    () =>
      sessionGet("activeAccount") ??
      localStorage.getItem("activeAccount") ??
      DEFAULT_ACCOUNT,
  );
  const brokerId = brokerOf(activeAccount);

  // Remember the last-used account PER broker, so switching brokers in the tab-bar
  // selector returns to the env you were last on for that broker (not always paper).
  // Device-local; a plain {broker: "{broker}:{env}"} map. Updated on every active-
  // account change (effect below); read by selectBroker.
  const lastAccountByBroker = useRef<Record<string, TradeAccount>>(null!);
  if (lastAccountByBroker.current === null) {
    lastAccountByBroker.current = loadLastAccountByBroker();
  }

  // Switch the active BROKER (tab-bar selector). Picks the account to land on within
  // that broker: the last one used there (if still registered), else its paper
  // account, else its first registered account. brokerId is derived from the account,
  // so this is the single lever that drives the per-broker workspace swap.
  const selectBroker = (broker: string) => {
    if (broker === brokerId) return;
    const ofBroker = accounts.filter((a) => a.broker === broker);
    const remembered = lastAccountByBroker.current[broker];
    const next =
      (remembered && ofBroker.some((a) => a.key === remembered) && remembered) ||
      ofBroker.find((a) => a.env === "paper")?.key ||
      ofBroker[0]?.key ||
      `${broker}:paper`;
    // Switching broker swaps the WHOLE workspace (the broker-switch effect reseeds
    // from the incoming broker's saved state), which discards in-memory edits that
    // autosave-off mode deliberately left unsaved. `isDirty` is true ONLY in that
    // case (the persist effect sets it nowhere else), so confirm before discarding
    // — a silent drop of unsaved named-layout work was the bug. Cancel = stay put
    // (the user can ⌘S first); autosave-on / scratch never reach here (not dirty).
    if (isDirty) {
      requestConfirm({
        message: "You have unsaved changes to this layout. Switch broker and discard them?",
        onConfirm: () => setActiveAccount(next),
      });
    } else {
      setActiveAccount(next);
    }
  };

  // Load the selectable accounts once. If the persisted active account is no longer
  // registered (e.g. config changed), fall back to the first available.
  useEffect(() => {
    let alive = true;
    // Seed from the last-good cache so the selector is populated immediately and
    // survives a transient backend hiccup — a fresh fetch then refreshes it. This
    // is why one broker being down (which can make the live fetch time out behind
    // saturated connections) no longer leaves the account list empty.
    const cached = cachedBrokers();
    if (cached) setAccounts(cached.exec);
    void fetchBrokers()
      .then((info) => {
        if (!alive) return;
        setAccounts(info.exec);
        if (info.exec.length && !info.exec.some((a) => a.key === activeAccount)) {
          setActiveAccount(info.exec[0].key);
        }
      })
      .catch(() => {
        /* keep the cached/default accounts; the backend may be momentarily down */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active account and point the shared trades poll at it, so the
  // positions/orders dock follows the selection.
  useEffect(() => {
    sessionSet("activeAccount", activeAccount); // this tab's truth (guarded write)
    localStorage.setItem("activeAccount", activeAccount); // seed for future tabs
    // Always point the trades feed at the current account, INCLUDING a data-only
    // source: setTradesAccount clears the prior broker's trades synchronously, so
    // switching to Dukascopy can't leave a stale (and interactable) position lingering
    // on the chart. Its positions/orders fetch for dukascopy:data 404/422s and is
    // caught, leaving the feed empty (the dock shows a "history only" note).
    setTradesAccount(activeAccount);
    // Remember this as the broker's last-used account (read when the tab-bar selector
    // switches back to this broker). Re-read the map from disk first: sibling tabs
    // write this shared device-local map too, and every write is flushed immediately,
    // so disk is never behind — only this tab's own entry comes from memory.
    lastAccountByBroker.current = {
      ...loadLastAccountByBroker(),
      [brokerId]: activeAccount,
    };
    saveLastAccountByBroker(lastAccountByBroker.current);
  }, [activeAccount, brokerId]);

  // Real per-account balance/currency for the dock's stats strip — a LIVE account
  // shows its true figures instead of the global paper balance. Only real-money
  // accounts have a summary (paper → null → dock keeps its paper math). Like the
  // trades feed, real accounts get no server push, so poll (paused when hidden);
  // paper clears it. Refetches on every account switch.
  const [accountSummary, setAccountSummary] = useState<AccountSummary | null>(null);
  useEffect(() => {
    if (!isRealMoneyAccount(activeAccount)) {
      setAccountSummary(null);
      return;
    }
    let alive = true;
    const load = () => {
      if (document.hidden) return; // pause when the tab is hidden
      fetchAccountSummary(activeAccount)
        .then((s) => alive && setAccountSummary(s))
        .catch(() => {/* keep last-known figures on a transient error */});
    };
    load();
    const timer = setInterval(load, 6_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeAccount]);

  // Backend-wins startup hydration. hydrateFromBackend() pulls the snapshot,
  // overwrites localStorage where the backend differs, and (crucially) gates
  // write-mirroring at the module level until it resolves — so the mount-time
  // saves below and every cell's mount-time save can't push stale local state
  // over newer backend data before we've pulled it.
  //
  // When it reports a change, re-resolve the workspace AND bump hydrateEpoch. The
  // epoch is mixed into the ChartGrid key so the active grid remounts even when
  // the tab/cell ids are identical (a cross-device drawing/indicator edit changes
  // a per-cell key but not the tab array — without a forced remount the cell
  // would keep showing stale overlays, since they only rehydrate on mount).
  const [hydrateEpoch, setHydrateEpoch] = useState(0);
  // Re-read the active workspace from localStorage and force a grid remount. Shared
  // by the startup hydrate and live cross-tab pushes. LayoutManager re-reads too.
  const reseedFromLocal = () => {
    // Someone else (another device/browser tab, a broker or layout switch)
    // just rewrote the workspace we snapshotted — a pending merge-undo would
    // restore a stale state and silently clobber their edit, so drop it even
    // when the tab STRUCTURE happens to match (the sig effect can't see
    // symbol/TF-only remote changes).
    setPendingUndo(null);
    const r = resolveStartup();
    // Skip the remount if the resolved workspace already matches what's on screen
    // (avoids an unnecessary grid remount on the common no-change startup).
    // Compare TABS ONLY — the active tab is per-instance (see pickActiveTabId), so a
    // sibling's selection must never register as a view change here.
    const same =
      r.activeLayoutId === activeLayoutIdRef.current &&
      JSON.stringify(r.ws.tabs) === JSON.stringify(workspaceRef.current.tabs);
    setTabs(r.ws.tabs);
    setActiveId((prev) => pickActiveTabId(prev, r.ws));
    setActiveLayoutId(r.activeLayoutId);
    setLayoutRev((n) => n + 1);
    if (!same) setHydrateEpoch((n) => n + 1);
    // Settings ride the same backend sync: re-read so a synced theme/timezone/alert
    // default from hydration or another device applies without a reload. Skip if
    // unchanged so we don't trip the save() effect into a redundant re-mirror.
    syncSettingsFromLocal();
  };

  // Broker switch: each DATA-BROKER is an isolated platform instance with its own
  // workspace. Switching brokers swaps the WHOLE workspace to that broker's last
  // state — no symbol remapping, no stale epics. (Env-only changes, e.g. paper↔real
  // on the same broker, share the chart workspace and are ignored here.)
  //
  // Ordering is the correctness crux (see persistBroker's single-writer invariant in
  // persist.ts): the OUTGOING broker's workspace is already saved under ITS namespace
  // — the autosave effect ran under the old persistBroker on every prior render — so
  // we just FLIP the namespace, then reload the incoming broker's saved workspace (or
  // a fresh default for a first-time broker) and remount the grid onto its charts.
  // The alert engine follows via its own setBrokerId/setTabs effects below.
  const prevBrokerRef = useRef(brokerId);
  useEffect(() => {
    const prev = prevBrokerRef.current;
    if (prev === brokerId) return; // initial mount or env-only change
    prevBrokerRef.current = brokerId;
    setPersistBroker(brokerId);
    reseedFromLocal(); // resolves the new broker's workspace + forces a remount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerId]);

  // Live cross-device push. A change to a key OUTSIDE the active workspace (a
  // sibling editing another layout) must NOT remount this view — only refresh the
  // LayoutManager index. We can't cheaply know which key changed (persist applies
  // it to localStorage before calling back), so we compare the resolved workspace:
  // remount only when our visible tabs actually changed.
  const onBackendPush = (key: string) => {
    const r = resolveStartup();
    const sameView =
      r.activeLayoutId === activeLayoutIdRef.current &&
      JSON.stringify(r.ws.tabs) === JSON.stringify(workspaceRef.current.tabs);
    // A per-cell CONTENT change (an alert, drawing, or indicator on a cell we're ALSO
    // showing) never alters the tabs array, so the sameView check below treats it as
    // "not our view" and skips it — leaving our on-chart overlays stale until our next
    // persist() stomps the other tab's edit back to storage (cross-tab data loss: the
    // reported alerts/drawings vanishing when the app is open in two tabs). Route those
    // keys explicitly so the mounted cells re-sync to storage:
    //  - alerts are global-per-epic and reconcile IN PLACE off the alerts signal
    //    (every mounted same-epic cell); no remount needed.
    //  - drawings/indicators/avwap are per-cell-scope and have no in-place reconcile,
    //    so remount the grid (rehydrate re-reads storage) when the changed key belongs
    //    to a cell that's currently on screen.
    if (parseAlertsStateKey(key)) bumpAlerts();
    const visibleScopes =
      workspaceRef.current.tabs
        .find((t) => t.id === workspaceRef.current.activeTabId)
        ?.cells.map((c) => c.scope) ?? [];
    const isVisibleCellContent = visibleScopes.some((s) => key.startsWith(`${PREFIX}.${s}.`));
    if (!sameView) {
      reseedFromLocal(); // also syncs settings
      return;
    }
    setLayoutRev((n) => n + 1); // index/default may have changed; view didn't
    // The push may have been a settings change (which never touches the view).
    syncSettingsFromLocal();
    // A drawing/indicator edit from another tab on a visible cell: force a remount so
    // it rehydrates from the just-updated storage (alerts already reconciled above).
    if (isVisibleCellContent) setHydrateEpoch((n) => n + 1);
  };
  // Pull settings from (just-updated) localStorage into React state, but only if
  // they actually changed — re-setting an identical object would re-run the save()
  // effect and re-mirror, and could clobber an in-flight local edit with a stale read.
  const syncSettingsFromLocal = () => {
    const next = loadSettings();
    if (JSON.stringify(next) !== JSON.stringify(settingsRef.current)) setSettings(next);
  };
  // Refs so the WS callback (registered once) sees the latest active view.
  const workspaceRef = useRef<Workspace>({ tabs, activeTabId: activeId });
  const activeLayoutIdRef = useRef<string | null>(activeLayoutId);
  const settingsRef = useRef<Settings>(settings);
  useEffect(() => {
    workspaceRef.current = { tabs, activeTabId: activeId };
    activeLayoutIdRef.current = activeLayoutId;
    settingsRef.current = settings;
  });
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    hydrateFromBackend().then(() => {
      if (cancelled) return;
      // Per-broker isolation rollout: the workspace is now ISOLATED PER BROKER and
      // this is a FRESH START (each broker begins blank). Drop the abandoned old
      // GLOBAL workspace roots once — AFTER hydrate so the deletes reach the backend
      // (else the next hydrate re-seeds them). Idempotent (sentinel-gated); preserves
      // global preferences and every per-broker `auto-trader.b.*` key.
      pruneLegacyGlobalWorkspace();
      // The working tab set now lives in the layout body / scratch; drop the
      // abandoned per-broker `.tabs` roots (localStorage + backend).
      pruneLegacyTabsKeys();
      // ALWAYS reconcile to the resolved workspace — not only when hydrate reports a
      // change. The useState initializers ran before hydration (so a fresh device
      // with a synced workspace rendered its default); resolving again here applies
      // it. Idempotent when nothing changed, and robust to StrictMode's double-mount
      // (where the 2nd hydrate sees localStorage already written and reports no
      // change, yet React state from the cancelled 1st mount must still be set).
      reseedFromLocal();
      // Subscribe AFTER hydration so we don't apply live pushes onto a not-yet-
      // reconciled localStorage. Remote edits (other tabs/devices) re-seed + remount
      // only when they touch THIS view; our own edits are filtered by origin.
      unsubscribe = subscribeToBackendUpdates(onBackendPush);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve the active tab / focused cell — BOTH may be undefined when no tabs are
  // open (blank workspace). Downstream rendering guards on `active`.
  const active: ChartTab | undefined =
    tabs.find((t) => t.id === activeId) ?? tabs[0];
  const focusedCell =
    active?.cells.find((c) => c.id === active.activeCellId) ?? active?.cells[0];
  const symbol = focusedCell?.symbol;
  const period = focusedCell?.period;

  // Live chart instances + controllers, keyed by cell id. A ready/focus change
  // bumps a counter so the derived `focused` recomputes (the map itself is a ref).
  const readyRef = useRef(new Map<string, { chart: Chart; controller: ChartController }>());
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
  };

  // Focus (or open) a chart showing `epic` and return its focused cell. Search
  // order for an existing cell: the active tab first (its focused cell, then its
  // other cells), then every other tab — so a chart already on screen is reused
  // before we touch tabs the user can't see. Nothing open for the epic → spin up a
  // fresh tab. We only know the epic and a precision guess; the chart fetches its
  // own market meta on mount, so a minimal instrument is enough to render. Shared
  // by alert navigation and the trading dock's whole-book rows (clicking a position
  // re-scopes the order ticket + chart lines to its symbol).
  const jumpToEpic = (epic: string, precisionGuess = 2): { cellId: string } => {
    const ordered = active ? [active, ...tabs.filter((t) => t.id !== active.id)] : tabs;
    for (const t of ordered) {
      const lead = t.cells.find((c) => c.id === t.activeCellId);
      const cells = lead ? [lead, ...t.cells.filter((c) => c.id !== lead.id)] : t.cells;
      const hit = cells.find((c) => c.symbol.epic === epic);
      if (hit) {
        // Focus that cell so the chrome (and the panel's "current chart" scope)
        // follow it, and bring its tab to the front.
        setTabs((ts) => ts.map((tt) => (tt.id === t.id ? { ...tt, activeCellId: hit.id } : tt)));
        setActiveId(t.id);
        return { cellId: hit.id };
      }
    }
    const t = makeTab(
      { epic, name: epic, status: null, pricePrecision: precisionGuess },
      DEFAULT_PERIOD,
    );
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    return { cellId: t.cells[0].id };
  };

  // Open (or reuse) the chart for an alert and select its line. The select is
  // deferred via pendingSelectRef (see resolvePendingSelect) — resolvePendingSelect
  // is idempotent and guarded, so calling it now resolves an already-mounted cell
  // and harmlessly no-ops for a freshly-opened tab (the alertsChanged/ready path
  // resolves that later).
  const openAlert = (epic: string, target: AlertNavTarget, precisionGuess: number) => {
    const { cellId } = jumpToEpic(epic, precisionGuess);
    pendingSelectRef.current = { epic, cellId, ...target };
    resolvePendingSelect();
  };
  // Market open/closed status (+ next-open time) keyed by EPIC, for the tab
  // closed badge. Polled at the App level (below) for every tab's lead epic, not
  // just the active tab's — only the active tab mounts a ChartGrid/ChartCore, so
  // sourcing the badge from per-cell ChartCore state left background tabs stale
  // (a moon stuck on after a market reopened) or unbadged. Keying by epic also
  // bounds the map to distinct lead symbols and lets us prune it to the tabs that
  // currently exist.
  const [epicClosed, setEpicClosed] = useState<
    Record<string, { closed: boolean; nextOpen: string | null }>
  >({});

  // The distinct lead epics across all tabs (the lead cell is the focused-or-first
  // one, matching how TabBar picks the chip). Joined into a stable string so the
  // poll effect below only re-subscribes when the SET of lead epics changes, not
  // on every unrelated tab edit.
  const leadEpicsKey = useMemo(() => {
    const epics = new Set<string>();
    for (const t of tabs) {
      const lead = t.cells.find((c) => c.id === t.activeCellId) ?? t.cells[0];
      if (lead && !isSynthetic(lead.symbol.epic)) epics.add(lead.symbol.epic);
    }
    // JSON (not a delimiter-joined string) so the key round-trips cleanly back to
    // an array regardless of what characters an epic contains — a comma in an epic
    // would corrupt a comma-joined key.
    return JSON.stringify([...epics].sort());
  }, [tabs]);

  // Open/closed badge for every tab's lead epic, so background tabs (whose
  // ChartCore isn't mounted) still show a closed crescent. Event-driven, NOT
  // polled: fetch each epic once when the tab set / broker changes, then for a
  // CLOSED epic schedule a single re-check exactly at `nextOpen` (rescheduling
  // itself). An open background tab that later closes shows stale until it's
  // activated — at which point the active chart's ChartCore corrects it live from
  // the stream. This trades a little background-badge latency for zero polling.
  useEffect(() => {
    const epics: string[] = leadEpicsKey ? JSON.parse(leadEpicsKey) : [];
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const toEntry = (meta: Awaited<ReturnType<typeof fetchMarketMeta>>) => ({
      closed: meta.closed === true,
      nextOpen: meta.closed === true ? meta.nextOpen : null,
    });

    // Re-check a closed epic exactly when it should reopen — an event, not a poll.
    const scheduleReopen = (epic: string, meta: Awaited<ReturnType<typeof fetchMarketMeta>>) => {
      if (meta.closed !== true || !meta.nextOpen) return;
      const ms = Math.min(Math.max(1000, Date.parse(meta.nextOpen) - Date.now()), 2_000_000_000);
      timers.push(
        setTimeout(async () => {
          const m = await fetchMarketMeta(epic, brokerId).catch(() => null);
          if (cancelled || !m) return;
          setEpicClosed((prev) => ({ ...prev, [epic]: toEntry(m) }));
          scheduleReopen(epic, m);
        }, ms),
      );
    };

    void (async () => {
      const entries = await Promise.all(
        epics.map(async (epic) => [epic, await fetchMarketMeta(epic, brokerId)] as const),
      );
      if (cancelled) return;
      // Replace wholesale (not merge) so epics no longer present are dropped.
      setEpicClosed(Object.fromEntries(entries.map(([e, m]) => [e, toEntry(m)])));
      for (const [epic, meta] of entries) scheduleReopen(epic, meta);
    })();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [leadEpicsKey, brokerId]);

  // Pointer-down in a cell focuses it (routes the chrome to that cell).
  const onCellFocus = (cellId: string) => {
    if (!active || cellId === active.activeCellId) return;
    setTabs((ts) =>
      ts.map((t) => (t.id === active.id ? { ...t, activeCellId: cellId } : t)),
    );
  };

  const [panelOpen, setPanelOpen] = useState(alertsPanelOpen.value);
  useEffect(() => alertsPanelOpen.subscribe(setPanelOpen), []);
  const [tradeOpen, setTradeOpen] = useState(tradePanelOpen.value);
  useEffect(() => tradePanelOpen.subscribe(setTradeOpen), []);
  const [snapGalleryOpen, setSnapGalleryOpen] = useState(snapshotsGalleryOpen.value);
  useEffect(() => snapshotsGalleryOpen.subscribe(setSnapGalleryOpen), []);
  // Unlocking a snapshot view clears the cell controller's readOnly flag;
  // re-render so focusedReadOnly recomputes (toolbar swap, DrawSidebar, gallery
  // save button).
  const [, bumpSnapViewTick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => snapshotViewChanged.subscribe(() => bumpSnapViewTick()), []);
  // Closing the trading panel exits edit mode AND drops the trade selection (the
  // chart pills + row highlight clear). Done here — a state transition — rather than
  // in OrderTicket's unmount cleanup, which StrictMode fires spuriously on mount.
  useEffect(() => {
    if (!tradeOpen) setTradeSelected(null);
  }, [tradeOpen]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    // Chart-pane background override: set the `--chart-bg` var (consumed by
    // .chart-cell) when a custom color is chosen, else clear it so the cell falls
    // back to the theme's `--bg`. Opacity composites the color OVER the theme
    // background (not toward transparent) so it stays opaque — otherwise a low
    // opacity would reveal the grey grid behind the pane. So opacity 0 = the theme
    // background, opacity 1 = the full picked color, a clean dim/wash-out knob.
    //
    // The picked colors (and every bg "mood" preset) are light washes tuned for the
    // light theme. In DARK theme a full-opacity light wash would replace the dark
    // background and leave the chart glaringly light. So cap the effective opacity in
    // dark (Math.min, never scaling up) — the wash then only lifts the dark bg toward
    // the color instead of replacing it, dimming toward the active theme. Light is
    // untouched, so moods look exactly as picked there; a user's own low opacity is
    // never dimmed twice.
    if (settings.chartBg) {
      const op = settings.chartBgOpacity ?? 1;
      const effOpacity = settings.theme === "dark" ? Math.min(op, DARK_CHART_BG_CAP) : op;
      const bg = compositeOverHex(
        settings.chartBg,
        chartColors[settings.theme].bg,
        effOpacity,
      );
      document.documentElement.style.setProperty("--chart-bg", bg);
    } else {
      document.documentElement.style.removeProperty("--chart-bg");
    }
    // Don't re-mirror a change that came FROM a remote sync. persist writes the
    // pushed value to localStorage before calling syncSettingsFromLocal, so if our
    // state already equals localStorage this update is that sync echo — re-saving it
    // would push it back out and two tabs holding different settings (e.g. priceSide
    // mid vs bid) ping-pong forever via /ws/state, thrashing the live feed. A genuine
    // local edit differs from localStorage until this save writes it.
    if (JSON.stringify(settings) === JSON.stringify(loadSettings())) return;
    saveSettings(settings);
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

  // Keep the alert feeds on the same data broker as the charts — epics are
  // broker-specific, so a feed must stream from the active broker. setBrokerId
  // no-ops when unchanged.
  //
  // ORDER MATTERS: this effect MUST precede the setTabs effect below. setTabs arms
  // feeds via `loadAlerts(epic, this.brokerId)`, and setBrokerId only reopens
  // ALREADY-OPEN feeds (none on mount) — so if setTabs ran first on mount, it would
  // arm with the stale default broker and a non-default broker's alerts would never
  // get a feed. Setting the broker first means the initial setTabs reads the right
  // store. Do NOT reorder these two effects.
  useEffect(() => {
    alertEngine.setBrokerId(brokerId);
  }, [brokerId]);
  // Drive the background alert engine — the single firing authority across ALL
  // cells of ALL tabs. Re-sync whenever the tab set changes OR an alert is added/
  // removed/fired (alertsChanged), so it opens/closes one live feed per distinct
  // epic that has alerts. Lives here (outside the remounted ChartCore cells) so its
  // arming state is continuous. Tolerates an empty tab set (no armed feeds).
  useEffect(() => {
    alertEngine.setTabs(tabs);
    const unsub = alertsChanged.subscribe(() => alertEngine.setTabs(tabs));
    return unsub;
  }, [tabs]);
  // Keep the alert feeds on the same bid/mid/ask side as the charts, so an alert
  // fires on the price the user sees. setPriceSide no-ops when unchanged.
  useEffect(() => {
    alertEngine.setPriceSide(settings.priceSide);
  }, [settings.priceSide]);
  // Keep activeId valid (heal to first tab) and persist this device's active layout.
  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);
  useEffect(() => {
    saveActiveLayoutId(activeLayoutId); // device-local, not mirrored
  }, [activeLayoutId]);

  // Update the focused cell's instrument / interval. With symbol-sync on, the
  // change broadcasts to every cell in the tab (TradingView's "link" control).
  const setSymbol = (s: Instrument) => {
    if (!active || !focusedCell) return;
    // Lock keeps each cell's own symbol (effectiveSyncSymbol forces sync OFF), so
    // only the focused cell changes symbol even when syncSymbol was on underneath.
    const broadcast = effectiveSyncSymbol(active);
    setTabs((ts) =>
      ts.map((t) =>
        t.id !== active.id
          ? t
          : {
              ...t,
              cells: t.cells.map((c) =>
                broadcast || c.id === focusedCell.id ? { ...c, symbol: s } : c,
              ),
            },
      ),
    );
  };
  // Switch a SPECIFIC cell's interval. The quick-range bar uses this (it knows the
  // cell that owns it) so a keyboard-activated preset still targets the right cell
  // even when no pointer-down moved focus there first. Lock/interval-sync forces
  // the TF onto every cell — that's what keeps same-timestamp candles aligned.
  const setCellPeriod = (cellId: string, p: Period) => {
    if (!active) return;
    const broadcast = effectiveSyncInterval(active);
    setTabs((ts) =>
      ts.map((t) =>
        t.id !== active.id
          ? t
          : {
              ...t,
              cells: t.cells.map((c) =>
                broadcast || c.id === cellId ? { ...c, period: p } : c,
              ),
            },
      ),
    );
  };

  const setPeriod = (p: Period) => {
    if (!active || !focusedCell) return;
    setCellPeriod(focusedCell.id, p);
  };

  // Change the active tab's layout: add cells (cloning the focused cell's symbol/
  // period) or trim extras (purging their per-cell storage; the primary cell is
  // never purged). Keeps activeCellId valid.
  const setLayout = (layout: LayoutKind) => {
    if (!active) return;
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== active.id) return t;
        const want = LAYOUT_CELLS[layout];
        let cells = t.cells.slice();
        if (cells.length < want) {
          const base = cells.find((c) => c.id === t.activeCellId) ?? cells[0];
          while (cells.length < want) {
            const cid = newCellId();
            cells.push({
              id: cid,
              symbol: base.symbol,
              period: base.period,
              scope: cellScope(t.id, cid),
            });
          }
        } else if (cells.length > want) {
          for (const c of cells.slice(want)) {
            if (c.scope !== primaryCellScope(t.id)) purgeScope(c.scope);
          }
          cells = cells.slice(0, want);
        }
        const activeCellId = cells.some((c) => c.id === t.activeCellId)
          ? t.activeCellId
          : cells[0].id;
        return { ...t, layout, cells, activeCellId, sizes: layout === t.layout ? t.sizes : undefined };
      }),
    );
  };

  // Commit new cell-size fractions after a border drag (ChartGrid onSizes).
  const setCellSizes = (sizes: { cols: number[]; rows: number[] }) => {
    if (!active) return;
    setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, sizes } : t)));
  };

  // Toggle a per-tab sync link (symbol, interval, or crosshair). Enabling symbol or
  // interval sync applies IMMEDIATELY — every cell adopts the focused cell's symbol /
  // timeframe right away (TradingView behaviour), not just on the next change.
  // Crosshair sync is live, so there's nothing to back-fill.
  const toggleSync = (kind: "symbol" | "interval" | "crosshair" | "time") => {
    if (!active || !focusedCell) return;
    // Date-range link: enabling snaps the siblings to the focused cell's current
    // window once (read it now and broadcast); from then on the focused cell live-
    // broadcasts on every scroll/zoom (see ChartCore). The cells share only the
    // flag, so siblings always apply what's published — no per-cell back-fill here.
    if (kind === "time") {
      const turningOn = !active.syncTime;
      if (turningOn) {
        const src = readyRef.current.get(focusedCell.id);
        // A focused cell panned into right-edge whitespace reports an extrapolated
        // window, so siblings snap to the same view, whitespace included.
        const r = src ? readVisibleRange(src.chart) : null;
        if (r) rangeSync.publish(active.id, { sourceCellId: focusedCell.id, ...r });
      }
      setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, syncTime: turningOn } : t)));
      return;
    }
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== active.id) return t;
        if (kind === "crosshair") return { ...t, syncCrosshair: !t.syncCrosshair };
        if (kind === "symbol") {
          const on = !t.syncSymbol;
          return {
            ...t,
            syncSymbol: on,
            cells: on
              ? t.cells.map((c) => ({ ...c, symbol: focusedCell.symbol }))
              : t.cells,
          };
        }
        const on = !t.syncInterval;
        return {
          ...t,
          syncInterval: on,
          cells: on
            ? t.cells.map((c) => ({ ...c, period: focusedCell.period }))
            : t.cells,
        };
      }),
    );
  };

  // Master "lock charts" toggle. Lock is a derived override (see effective* helpers),
  // so the four underlying flags aren't touched — unlock just returns to whatever
  // they were. Turning ON applies once, from the focused cell as the initial master:
  // every cell adopts its TF (so same-timestamp candles line up), and its current
  // window is broadcast on the date-range channel so siblings snap to it (from then
  // on the cell under the cursor live-broadcasts every scroll/zoom).
  const toggleLock = () => {
    if (!active || !focusedCell) return;
    const turningOn = !active.locked;
    const tabId = active.id;
    const masterId = focusedCell.id;
    const broadcastMasterWindow = () => {
      const src = readyRef.current.get(masterId);
      const r = src ? readVisibleRange(src.chart) : null;
      // Carry the exact-mode anchor so siblings mirror the master's window pixel-for-
      // pixel (lock forces them onto its interval) — same payload as ChartCore's onRange.
      // Honour any sticky align anchor (defaults to right edge): the deferred re-broadcast
      // below can land AFTER the user has hovered a candle, and without this it would
      // snap siblings back to the right edge, transiently undoing that alignment.
      if (r) {
        const exact = readExactAnchor(src!.chart, getAlignAnchor(tabId));
        rangeSync.publish(tabId, { sourceCellId: masterId, ...r, ...exact });
      }
    };
    if (turningOn) {
      // Snap siblings to the master's window now (covers cells already on the
      // master's TF). Cells whose TF actually changes refetch history and reset to
      // the latest bars (applyNewData in ChartCore), which wipes this snap — so
      // re-broadcast after that reload settles. The master's own TF never changes,
      // so its window is stable to read on the deferred pass. Belt-and-braces: a
      // sibling that still misses the snap self-heals on the first pan/zoom.
      broadcastMasterWindow();
      setTimeout(broadcastMasterWindow, 350);
    } else {
      // Turning lock off: drop the sticky (hover-driven) align anchor so the next lock
      // session starts fresh at the right edge rather than a stale hovered timestamp.
      clearAlignAnchor(tabId);
    }
    setTabs((ts) =>
      ts.map((t) =>
        t.id !== tabId
          ? t
          : {
              ...t,
              locked: turningOn,
              cells: turningOn
                ? t.cells.map((c) => ({ ...c, period: focusedCell.period }))
                : t.cells,
            },
      ),
    );
  };

  // New tab starts on the default chart, becomes active, then immediately opens
  // symbol search (TradingView-style "new tab" UX).
  const addTab = () => {
    const t = makeTab(DEFAULT_SYMBOL, DEFAULT_PERIOD);
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    requestSymbolSearch();
  };

  // Detach a cell into its own NEW one-cell tab: same symbol/interval, and a full
  // copy of the cell's scope content (drawings/indicators/config) into the new
  // tab's primary scope. Alerts are global per instrument — nothing to copy.
  // target "move" (the default click) also REMOVES the source cell — the layout
  // downgrades exactly like closeCell, but without a confirm since the content
  // lives on in the new tab (a single-cell tab falls back to copy: it can't be
  // left empty, though the UI only shows the handle on multi-cell layouts).
  // "tab" leaves the source untouched (opens a copy); "window" is the copy
  // variant that opens the app in a new browser tab focused on the new tab
  // (?tab=<id> — see the startup handling). "move"/"tab" switch this window to
  // the new tab; "window" leaves this window alone.
  const detachCell = (cellId: string, target: "move" | "tab" | "window") => {
    if (!active) return;
    const src = active.cells.find((c) => c.id === cellId);
    if (!src) return;
    const id = newTabId();
    const cid = `${id}-c0`;
    const scope = primaryCellScope(id);
    const copiedOk = copyScopeContent(src.scope, scope);
    const t: ChartTab = {
      id,
      layout: "1",
      activeCellId: cid,
      cells: [{ id: cid, symbol: src.symbol, period: src.period, scope }],
    };
    let nextTabs = [...tabs, t];
    if (target === "move" && active.cells.length > 1) {
      // Same removal rules as closeCell: purge the source scope unless it's the
      // tab's primary one, downgrade the layout kind to the remaining count,
      // reset track sizes (grid shape changed), re-home activeCellId.
      // Only burn the original once the copy fully landed — on storage quota the
      // copy silently drops keys, so keeping the source turns permanent data
      // loss into a mere orphaned-scope leak (mirrors mergeTabInto).
      if (copiedOk && src.scope !== primaryCellScope(active.id)) purgeScope(src.scope);
      nextTabs = nextTabs.map((tt) => {
        if (tt.id !== active.id) return tt;
        const cells = tt.cells.filter((c) => c.id !== cellId);
        const activeCellId = cells.some((c) => c.id === tt.activeCellId)
          ? tt.activeCellId
          : cells[0].id;
        return { ...tt, layout: KIND_FOR_COUNT[cells.length], cells, activeCellId, sizes: undefined };
      });
    }
    // "move" PURGED the source cell's persisted content, so the matching
    // tab-list change must be durable NOW — same rule as mergeTabs: leaving it
    // to the deferred autosave effect (or autosave-off never committing) opens
    // a data-loss window where a reload resurrects the source cell with its
    // drawings/indicators already gone. "window" needs the sync save too: the
    // new browser tab resolves its workspace from storage inside this click
    // gesture (popup-blocker friendliness, autosave-off).
    if (target !== "tab") {
      const ws: Workspace = { tabs: nextTabs, activeTabId: "" };
      if (activeLayoutId && layoutName != null) {
        saveLayout(activeLayoutId, layoutName, ws);
        setIsDirty(false);
      } else {
        saveScratch(ws);
      }
    }
    setTabs(nextTabs);
    if (target !== "window") {
      setActiveId(id);
    } else {
      window.open(`${location.pathname}?tab=${encodeURIComponent(id)}`, "_blank");
    }
  };

  // Restore a saved snapshot into a fresh one-cell tab. Unlike detachCell this never
  // touches an existing tab/scope, so it can rely on the autosave effect (no sync
  // save needed) — same shape as addTab. writeSnapshotToScope must run BEFORE the
  // new tab is added to state: the cell mounts and reads its scope on the very next
  // render, so the blobs (drawings/indicators/AVWAP anchors) have to already be there.
  const restoreSnapshot = (s: ChartSnapshot) => {
    const id = newTabId();
    const cid = `${id}-c0`;
    const scope = primaryCellScope(id);
    writeSnapshotToScope(s, scope);
    const t: ChartTab = {
      id,
      layout: "1",
      activeCellId: cid,
      cells: [{ id: cid, symbol: s.symbol, period: s.period, scope }],
    };
    setTabs([...tabs, t]);
    setActiveId(id);
    snapshotsGalleryOpen.set(false);
  };

  // Gallery "Save current chart": snapshot the focused cell without leaving the
  // modal; the gallery refreshes itself so the new card on top is the feedback.
  const saveCurrentSnapshot = async (): Promise<ChartSnapshot | null> => {
    if (!focused || !focusedCell) return null;
    return saveSnapshotOfChart(
      focused.chart,
      focusedCell.scope,
      focusedCell.symbol,
      focusedCell.period,
    );
  };

  // Close ONE cell of a multi-cell layout (✕ corner button). Confirms first —
  // the cell's drawings/indicators are purged — then removes the cell and
  // downgrades the layout kind to the remaining count (2×2 → three columns →
  // two columns → single). Survivor order is preserved; sizes reset because
  // the grid shape changed. maximizedCellId clears via the existing
  // layout-change effect (the kind always changes here).
  const closeCell = (cellId: string) => {
    if (!active) return;
    const cell = active.cells.find((c) => c.id === cellId);
    if (!cell || active.cells.length < 2) return;
    requestConfirm({
      title: "Close chart",
      message: "Close this chart? Its drawings and indicators will be removed.",
      confirmLabel: "Close",
      onConfirm: () => {
        if (cell.scope !== primaryCellScope(active.id)) purgeScope(cell.scope);
        setTabs((ts) =>
          ts.map((t) => {
            if (t.id !== active.id) return t;
            const cells = t.cells.filter((c) => c.id !== cellId);
            if (cells.length === t.cells.length || cells.length === 0) return t;
            const activeCellId = cells.some((c) => c.id === t.activeCellId)
              ? t.activeCellId
              : cells[0].id;
            return { ...t, layout: KIND_FOR_COUNT[cells.length], cells, activeCellId, sizes: undefined };
          }),
        );
      },
    });
  };

  // Swap two cells' positions in the active tab (border ↔/↕ buttons). Cells
  // move whole — symbol, period, scope (drawings/alerts) travel with them —
  // so nothing is purged or copied. Layout kind and track sizes are untouched
  // (fractions belong to the grid tracks, not the cells).
  const swapCells = (idA: string, idB: string) => {
    if (!active) return;
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== active.id) return t;
        const i = t.cells.findIndex((c) => c.id === idA);
        const j = t.cells.findIndex((c) => c.id === idB);
        if (i < 0 || j < 0 || i === j) return t;
        const cells = t.cells.slice();
        [cells[i], cells[j]] = [cells[j], cells[i]];
        return { ...t, cells };
      }),
    );
  };

  // Merge whole tabs into `targetId` — the inverse of detachCell. Each source
  // tab's cells move across (content re-scoped by mergeTabInto), the source
  // tabs close, and the merged tab gains crosshair sync. `position` places the
  // incoming cells (drag-onto-chart's left/top half passes "before"). The
  // target becomes the active tab in every gesture.
  // Structural fingerprint: tab ids + layout kinds + cell ids. Symbol/TF
  // changes don't alter it (an undo offer must survive them); close/add/
  // detach/layout changes and workspace/broker switches do.
  // Sorted so pure tab REORDER doesn't change the signature — reordering is
  // not structural and must not kill a still-valid undo offer.
  const structureSig = (ts: ChartTab[]) =>
    ts
      .map((t) => `${t.id}:${t.layout}:${t.cells.map((c) => c.id).join(",")}`)
      .sort()
      .join("|");

  useEffect(() => {
    if (pendingUndo && structureSig(tabs) !== pendingUndo.sigAfter) setPendingUndo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  const mergeTabs = (
    targetId: string,
    sourceIds: string[],
    position: "before" | "after" = "after",
  ) => {
    const prevTabs = tabs;
    const prevActiveId = activeId;
    // Label = the TARGET's pre-merge lead chart (after the merge its
    // activeCellId points at the merged-in cell, which would mislabel).
    const dst = tabs.find((t) => t.id === targetId);
    const lead = dst ? (dst.cells.find((c) => c.id === dst.activeCellId) ?? dst.cells[0]) : null;
    const pairs: Array<{ from: string; to: string }> = [];
    let next = tabs;
    for (const srcId of sourceIds) {
      const res = mergeTabInto(next, srcId, targetId, position);
      if (!res) continue; // over-cap sources are UI-disabled; skip defensively
      next = res.tabs;
      pairs.push(...res.moved);
      clearAlignAnchor(srcId); // same leak-guard closeTab applies
    }
    if (next === tabs) return;
    // Merging PURGED the source tabs' persisted content (mergeTabInto), so the
    // matching tab-list change must be durable NOW. Leaving it to the deferred
    // autosave effect opens a data-loss window: a reload before it commits (or
    // autosave-off never committing) resurrects the source tab from the stale
    // body with its drawings/indicators already gone. Same deliberate
    // autosave-off trade-off as detachCell's window path: the merge gesture
    // commits the workspace synchronously.
    const ws: Workspace = { tabs: next, activeTabId: "" };
    if (activeLayoutId && layoutName != null) {
      saveLayout(activeLayoutId, layoutName, ws);
      setIsDirty(false);
    } else {
      saveScratch(ws);
    }
    setTabs(next);
    setActiveId(targetId);
    setPendingUndo({
      prevTabs,
      prevActiveId,
      pairs,
      label: lead ? `Merged into ${lead.symbol.name} · ${lead.period.label}` : "Tabs merged",
      sigAfter: structureSig(next),
      targetId,
    });
  };

  // Full inverse of the last merge: content moves back to the old scopes
  // (carrying post-merge edits), the snapshot tab array is restored, and the
  // workspace is persisted with the same durable rule the merge used.
  const undoMerge = () => {
    const u = pendingUndo;
    if (!u) return;
    setPendingUndo(null); // before setTabs — the sig effect must not race it
    unmergeScopes(u.pairs);
    const ws: Workspace = { tabs: u.prevTabs, activeTabId: "" };
    if (activeLayoutId && layoutName != null) {
      saveLayout(activeLayoutId, layoutName, ws);
      setIsDirty(false);
    } else {
      saveScratch(ws);
    }
    setTabs(u.prevTabs);
    setActiveId(u.prevActiveId);
  };

  // Reorder tabs by drag-and-drop: move the tab at `from` to destination slot
  // `to` (in original-array indexing; `to === length` means past the last tab).
  const reorderTab = (from: number, to: number) => {
    setTabs((ts) => {
      if (from === to || from < 0 || to < 0 || from >= ts.length || to > ts.length)
        return ts;
      const next = [...ts];
      const [moved] = next.splice(from, 1);
      // After removing `from`, indices to its right shift down by one, so a
      // rightward move must drop at `to - 1` to land at the intended slot.
      // Leftward moves are unaffected.
      const insertAt = from < to ? to - 1 : to;
      next.splice(insertAt, 0, moved);
      return next;
    });
  };

  // Close a tab; if it was active, fall back to a neighbour. Closing the LAST tab
  // now leaves a blank workspace (no charts) — the layout can hold zero tabs. Purge
  // the closed tab's namespaced layout keys (covers all its cells via the primary
  // prefix). NOTE: this purges per-cell content even for a saved layout's tab — the
  // user explicitly closed it; the layout body simply records one fewer tab.
  const closeTab = (id: string) => {
    purgeTabScope(id);
    clearAlignAnchor(id); // drop this tab's sticky lock anchor so the map doesn't leak
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === activeId) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? "");
      return next;
    });
  };

  // --- named-layout lifecycle (LayoutManager callbacks) ----------------------

  // Switch this device to layout `id`. Persists the current workspace first (the
  // auto-save effect already mirrors it, but switching changes activeLayoutId
  // synchronously, so snapshot now), then loads the target and remounts the grid.
  const switchLayout = (id: string) => {
    if (id === activeLayoutId) return;
    const target = loadLayout(id);
    if (!target) return;
    setTabs(target.tabs);
    setActiveId(pickActiveTabId("", target));
    setActiveLayoutId(id);
    setHydrateEpoch((n) => n + 1);
    setLayoutRev((n) => n + 1);
  };

  // "Save" (⌘S) — update the active named layout in place. When autosave is on this
  // is redundant (the effect already persists); when autosave is off this is the only
  // thing that commits edits and clears the dirty flag.
  const saveActiveLayout = () => {
    if (!activeLayoutId || layoutName == null) return;
    saveLayout(activeLayoutId, layoutName, { tabs, activeTabId: "" });
    setIsDirty(false);
    setLayoutRev((n) => n + 1);
  };

  // "Save as…" — clone the current workspace under FRESH tab/cell ids (copying each
  // cell's scope content so the new layout is independent), register it, switch to
  // it, and drop the scratch (the workspace is now named). See cloneWorkspace.
  const saveLayoutAs = (name: string) => {
    const id = `layout-${newTabId()}`;
    const cloned = cloneWorkspace(
      { tabs, activeTabId: active?.id ?? "" },
      newTabId,
      newCellId,
    );
    // Persist with "" (active tab is per-instance, never synced), but keep THIS
    // instance on the cloned-and-remapped active tab so "Save as…" doesn't jump.
    saveLayout(id, name, { ...cloned, activeTabId: "" });
    clearScratch();
    setTabs(cloned.tabs);
    setActiveId(pickActiveTabId(cloned.activeTabId, cloned));
    setActiveLayoutId(id);
    setHydrateEpoch((n) => n + 1);
    setLayoutRev((n) => n + 1);
  };

  // Delete a layout. If it's the one on screen, fall back to another layout (or a
  // blank scratch). deleteLayout purges its tabs' scopes + index entry + default.
  const removeLayout = (id: string) => {
    deleteLayout(id);
    if (id === activeLayoutId) {
      const remaining = loadLayouts();
      if (remaining.length > 0) {
        switchLayout(remaining[0].id);
      } else {
        setTabs([]);
        setActiveId("");
        setActiveLayoutId(null);
        setHydrateEpoch((n) => n + 1);
      }
    }
    setLayoutRev((n) => n + 1);
  };

  const toggleAutosave = () => {
    const next = !autosave;
    saveAutosave(next);
    setAutosaveState(next);
    if (next) {
      // Turning autosave back on: immediately persist any pending dirty edits.
      if (activeLayoutId && layoutName != null) {
        saveLayout(activeLayoutId, layoutName, { tabs, activeTabId: "" });
        setIsDirty(false);
      }
    }
  };

  // ⌘S / Ctrl+S: save the active named layout (same as the menu "Save" action).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveActiveLayout();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLayoutId, layoutName, tabs, active?.id]);

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

  // Whether the FOCUSED cell is a read-only snapshot view. The controller's
  // readOnly flag is the sentinel (seeded at cell mount, cleared by Unlock, which
  // also bumps snapshotViewChanged so this re-renders); for the brief window
  // before the cell's controller registers, fall back to the scope's stored
  // snapshotMeta so a restoring tab never flashes the full editing chrome.
  const focusedReadOnly = focusedController
    ? focusedController.readOnly.value
    : focusedCell != null && loadSnapshotMeta(focusedCell.scope) != null;

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
        onSelect={setActiveId}
        onAdd={addTab}
        onClose={closeTab}
        onReorder={reorderTab}
        canMerge={(s, d) => canMergeTabs(tabs, s, d)}
        onMerge={mergeTabs}
        onDragActive={setDragTabId}
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
                locked={!!active.locked}
                onToggleSync={toggleSync}
                onToggleLock={toggleLock}
              />
            )}
            <AppearanceMenu settings={settings} onChange={setSettings} />
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
            <BrokerSelector
              accounts={accounts}
              activeBroker={brokerId}
              onChange={selectBroker}
            />
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
            <DrawSidebar controller={focusedController} />
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
        </main>
        {/* Panel is toggled by the toolbar bell; closed = chart uses full width. */}
        {panelOpen && symbol && !isSynthetic(symbol.epic) && (
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
        {tradeOpen && symbol && !isSynthetic(symbol.epic) && !isDataOnlyBroker(brokerId) && (
          <aside className="trade-sidebar">
            <OrderTicket
              epic={symbol.epic}
              account={activeAccount}
              precision={symbol.pricePrecision ?? 2}
              instrumentType={symbol.type}
              trading={settings.trading}
              accountSummary={accountSummary}
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
        {showLive && symbol && period && !isDataOnlyBroker(brokerId) && (
          <LiveTradingPanel
            epic={symbol.epic}
            resolution={period.resolution}
            brokerId={brokerId}
            accounts={accounts}
            defaultAccount={activeAccount}
            onClose={() => livePanelOpen.set(false)}
          />
        )}
      </div>
      {/* Trading dock (paper): the whole open book — positions + resting orders
          across ALL symbols — docked full-width under the chart, TV-style. ALWAYS
          shown (the book is global, independent of the order ticket) but
          collapsible to its header bar. Double-clicking a row focuses that symbol's
          chart and opens its edit ticket in the (revealed) sidebar. */}
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

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {alertReq && symbol && (
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

      {alertEdit &&
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
          chart={focused.chart}
          scope={focusedCell.scope}
          epic={symbol.epic}
          brokerId={brokerId}
          chartResolution={period.resolution}
          paneId={indSettings.paneId}
          name={indSettings.name}
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

      {snapGalleryOpen && (
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

      {saveDefaultReq && (
        <SaveDefaultTemplateModal
          req={saveDefaultReq}
          onClose={() => saveDefaultTemplateRequest.set(null)}
        />
      )}

      {/* Hover popover for a backtest aggregate marker (higher-timeframe view).
          Self-driven by backtestClusterHoverSignal; renders nothing when idle. */}
      <BacktestClusterPopover />
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

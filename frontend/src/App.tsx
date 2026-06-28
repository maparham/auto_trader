import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Chart } from "klinecharts";
import ChartGrid from "./ChartGrid";
import Toolbar from "./Toolbar";
import LayoutPicker from "./LayoutPicker";
import { rangeSync, readVisibleRange, readExactAnchor, getAlignAnchor, clearAlignAnchor } from "./lib/chartSync";
import ThemeToggle from "./ThemeToggle";
import SettingsModal from "./Settings";
import AlertModal from "./AlertModal";
import IndicatorSettings from "./IndicatorSettings";
import DrawingSettings from "./DrawingSettings";
import AlertsSidebar, { type AlertNavTarget, type VisibleCell } from "./AlertsSidebar";
import ConfirmDialog from "./ConfirmDialog";
import OrderTicket from "./OrderTicket";
import PositionsPanel from "./PositionsPanel";
import { registerCustomIndicators } from "./lib/customIndicators";
import { registerBacktestIndicators } from "./lib/backtest";
import { registerCustomOverlays } from "./lib/customOverlays";
import { registerPositionLine } from "./lib/positionLines";
import type { ChartController } from "./lib/chartController";
import {
  alertModalRequest,
  alertEditRequest,
  alertGlobalEditRequest,
  confirmRequest,
  requestConfirm,
  indicatorSettingsRequest,
  drawingSettingsRequest,
  alertsPanelOpen,
  tradePanelOpen,
  alertsChanged,
  bumpAlerts,
  settingsRequest,
} from "./lib/signals";
import { alertEngine } from "./lib/alertEngine";
import {
  PERIODS,
  fetchMarketMeta,
  searchInstruments,
  type Instrument,
  type Period,
} from "./lib/feed";
import {
  fetchBrokers,
  cachedBrokers,
  setTradesAccount,
  DEFAULT_ACCOUNT,
  type BrokerAccount,
  type TradeAccount,
} from "./lib/trading";
import {
  hydrateFromBackend,
  subscribeToBackendUpdates,
  purgeTabScope,
  purgeScope,
  primaryCellScope,
  cellScope,
  LAYOUT_CELLS,
  migrateToNamedLayouts,
  migrateAlertsToGlobal,
  loadStoredAlert,
  updateStoredAlert,
  deleteStoredAlert,
  moveAlerts,
  loadLayouts,
  loadLayout,
  saveLayout,
  deleteLayout,
  loadDefaultLayoutId,
  loadActiveLayoutId,
  saveActiveLayoutId,
  loadScratch,
  saveScratch,
  clearScratch,
  cloneWorkspace,
  loadAutosave,
  saveAutosave,
  type ChartTab,
  type LayoutKind,
  type Workspace,
} from "./lib/persist";
import LayoutManager from "./LayoutManager";
import { requestSymbolSearch } from "./lib/signals";
import { loadSettings, saveSettings, type Settings } from "./theme";
import TabBar from "./TabBar";
import "./App.css";

// Register VWAP / AVWAP and the backtest EQUITY indicator once, before any chart
// mounts, so they're available to the chart and the indicator menu.
registerCustomIndicators();
registerBacktestIndicators();
registerCustomOverlays();
registerPositionLine();

const DEFAULT_SYMBOL: Instrument = {
  epic: "US100",
  name: "US Tech 100",
  status: null,
  pricePrecision: 2,
};
const DEFAULT_PERIOD: Period =
  PERIODS.find((p) => p.resolution === "HOUR") ?? PERIODS[0];

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

// Resolve which workspace this device shows on launch. Precedence:
//   1. this device's last-open layout (activeLayoutId), if it still exists
//   2. the synced default layout, if set
//   3. the unsaved scratch workspace, if the user had one
//   4. nothing — blank (no tabs) until the user opens/creates a layout
// Returns the workspace plus the active layout id (null = scratch/blank).
function resolveStartup(): { ws: Workspace; activeLayoutId: string | null } {
  const blank: Workspace = { tabs: [], activeTabId: "" };
  const known = new Set(loadLayouts().map((l) => l.id));

  const activeId = loadActiveLayoutId();
  if (activeId && known.has(activeId)) {
    return { ws: loadLayout(activeId) ?? blank, activeLayoutId: activeId };
  }
  const defId = loadDefaultLayoutId();
  if (defId && known.has(defId)) {
    return { ws: loadLayout(defId) ?? blank, activeLayoutId: defId };
  }
  const scratch = loadScratch();
  if (scratch && scratch.tabs.length > 0) {
    return { ws: scratch, activeLayoutId: null };
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
  // Toolbar gear + chart context menu request the Settings modal via a signal.
  useEffect(() => settingsRequest.subscribe(() => setShowSettings(true)), []);
  const [alertReq, setAlertReq] = useState(alertModalRequest.value);
  useEffect(() => alertModalRequest.subscribe(setAlertReq), []);
  const [alertEdit, setAlertEdit] = useState(alertEditRequest.value);
  useEffect(() => alertEditRequest.subscribe(setAlertEdit), []);
  const [alertGlobalEdit, setAlertGlobalEdit] = useState(alertGlobalEditRequest.value);
  useEffect(() => alertGlobalEditRequest.subscribe(setAlertGlobalEdit), []);
  const [confirm, setConfirm] = useState(confirmRequest.value);
  useEffect(() => confirmRequest.subscribe(setConfirm), []);
  const [indSettings, setIndSettings] = useState(indicatorSettingsRequest.value);
  useEffect(() => indicatorSettingsRequest.subscribe(setIndSettings), []);
  const [drawSettings, setDrawSettings] = useState(drawingSettingsRequest.value);
  useEffect(() => drawingSettingsRequest.subscribe(setDrawSettings), []);

  // The workspace = the current set of tabs + which tab is active. It belongs to a
  // NAMED layout (activeLayoutId) or to the device-local unsaved scratch (null).
  // `tabs` MAY be empty (blank launch with no default) — every consumer below is
  // written to tolerate zero tabs and an undefined active/focusedCell.
  const [tabs, setTabs] = useState<ChartTab[]>(() => resolveStartup().ws.tabs);
  const [activeId, setActiveId] = useState<string>(
    () => resolveStartup().ws.activeTabId,
  );
  // The named layout this device currently shows (null = scratch). Device-local.
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(
    () => resolveStartup().activeLayoutId,
  );
  // Bumped after any layout mutation so LayoutManager re-reads the persisted index.
  const [layoutRev, setLayoutRev] = useState(0);
  // Autosave: when off, edits accumulate as dirty until the user manually saves.
  const [autosave, setAutosaveState] = useState<boolean>(loadAutosave);
  const [isDirty, setIsDirty] = useState(false);

  // Active broker / trading account (registry key "{broker}:{env}"). Drives BOTH
  // the chart data feed (epics are broker-specific) and order/position routing.
  // Device-local; the list of selectable accounts comes from GET /api/brokers.
  const [accounts, setAccounts] = useState<BrokerAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<TradeAccount>(
    () => localStorage.getItem("activeAccount") ?? DEFAULT_ACCOUNT,
  );
  const brokerId = activeAccount.split(":")[0];

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
    localStorage.setItem("activeAccount", activeAccount);
    setTradesAccount(activeAccount);
  }, [activeAccount]);

  // When the BROKER changes (not just the env), every open cell's symbol must be
  // re-resolved against the new broker: epics aren't portable across brokers. We
  // re-search each unique epic by ticker and swap to a confident match; an epic
  // with no match is left as-is, so its chart simply blanks (no candles) until the
  // user picks a symbol from the now broker-scoped search modal. Per-epic alerts
  // are carried to the re-resolved epic (they fire in the background). NOTE: the
  // remaining per-epic state — drawings, symbol templates, avwap anchors — still
  // assumes the active broker; revisit at broker #2.
  const prevBrokerRef = useRef(brokerId);
  useEffect(() => {
    const prev = prevBrokerRef.current;
    prevBrokerRef.current = brokerId;
    if (prev === brokerId) return; // initial mount or env-only change
    let cancelled = false;
    (async () => {
      // The original symbols (by epic), keeping the full Instrument: we search the
      // new broker by the human ticker/name (more portable across brokers than the
      // broker-specific epic id) and match a hit back against that same name.
      const originals = new Map<string, Instrument>();
      for (const t of tabs) for (const c of t.cells) originals.set(c.symbol.epic, c.symbol);
      const resolved = new Map<string, Instrument>();
      await Promise.all(
        [...originals].map(async ([epic, sym]) => {
          const hits = await searchInstruments(sym.name || epic, brokerId);
          const match =
            hits.find((h) => h.epic === epic) ??
            (sym.name
              ? hits.find((h) => h.name?.toLowerCase() === sym.name!.toLowerCase())
              : undefined);
          if (match) resolved.set(epic, match);
        }),
      );
      if (cancelled || resolved.size === 0) return;
      // Alerts are stored per-epic and fire in the background, so when a symbol
      // re-resolves to a DIFFERENT epic, carry its alerts to the new key — otherwise
      // they'd be orphaned under the old epic (the alert engine drops that feed once
      // no open cell references it). Drawings/templates/anchors stay per-epic and are
      // left for broker #2 (their cross-broker semantics aren't settled yet).
      let alertsMoved = false;
      for (const [oldEpic, sym] of resolved) {
        if (sym.epic !== oldEpic) alertsMoved = moveAlerts(oldEpic, sym.epic) || alertsMoved;
      }
      setTabs((prevTabs) =>
        prevTabs.map((t) => ({
          ...t,
          cells: t.cells.map((c) =>
            resolved.has(c.symbol.epic)
              ? { ...c, symbol: resolved.get(c.symbol.epic)! }
              : c,
          ),
        })),
      );
      if (alertsMoved) bumpAlerts();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokerId]);

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
    const r = resolveStartup();
    // Skip the remount if the resolved workspace already matches what's on screen
    // (avoids an unnecessary grid remount on the common no-change startup).
    const same =
      r.activeLayoutId === activeLayoutIdRef.current &&
      JSON.stringify(r.ws) === JSON.stringify(workspaceRef.current);
    setTabs(r.ws.tabs);
    setActiveId(r.ws.activeTabId);
    setActiveLayoutId(r.activeLayoutId);
    setLayoutRev((n) => n + 1);
    if (!same) setHydrateEpoch((n) => n + 1);
    // Settings ride the same backend sync: re-read so a synced theme/timezone/alert
    // default from hydration or another device applies without a reload. Skip if
    // unchanged so we don't trip the save() effect into a redundant re-mirror.
    syncSettingsFromLocal();
  };
  // Live cross-device push. A change to a key OUTSIDE the active workspace (a
  // sibling editing another layout) must NOT remount this view — only refresh the
  // LayoutManager index. We can't cheaply know which key changed (persist applies
  // it to localStorage before calling back), so we compare the resolved workspace:
  // remount only when our visible tabs actually changed.
  const onBackendPush = () => {
    const r = resolveStartup();
    const sameView =
      r.activeLayoutId === activeLayoutIdRef.current &&
      JSON.stringify(r.ws) === JSON.stringify(workspaceRef.current);
    if (sameView) {
      setLayoutRev((n) => n + 1); // index/default may have changed; view didn't
      // The push may have been a settings change (which never touches the view).
      syncSettingsFromLocal();
    } else {
      reseedFromLocal(); // also syncs settings
    }
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
      // Migrate AFTER hydration: only now does mirrorEnabled allow the migrated
      // layout to reach the backend, and only now is `tabs` the backend-synced
      // copy (so two upgrading devices derive the same layout id and converge).
      migrateToNamedLayouts();
      // Collapse legacy per-tab alert keys into the global per-epic form. AFTER
      // hydrate so the deletes of the orphaned scoped keys reach the backend (else
      // the next hydrate re-seeds them). Idempotent once migrated.
      const alertsMigrated = migrateAlertsToGlobal();
      // ALWAYS reconcile to the resolved workspace — not only when hydrate reports a
      // change. The useState initializers ran before hydration (so a fresh device
      // with a synced default rendered blank); resolving again here applies it. It's
      // idempotent when nothing changed, and robust to StrictMode's double-mount
      // (where the 2nd hydrate sees localStorage already written and reports no
      // change, yet React state from the cancelled 1st mount must still be set).
      reseedFromLocal();
      // The alert migration rewrote per-epic keys without changing the tab array, so
      // reseedFromLocal's workspace-diff won't have remounted the grid. Force it so
      // the already-mounted cells rehydrate against the populated global keys.
      if (alertsMigrated) setHydrateEpoch((n) => n + 1);
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
      if (lead) epics.add(lead.symbol.epic);
    }
    // JSON (not a delimiter-joined string) so the key round-trips cleanly back to
    // an array regardless of what characters an epic contains — a comma in an epic
    // would corrupt a comma-joined key.
    return JSON.stringify([...epics].sort());
  }, [tabs]);

  // Poll open/closed status for every tab's lead epic, so the closed badge stays
  // live on background tabs too (their ChartCore isn't mounted). 60s cadence, in
  // step with ChartCore's own poll, to stay clear of the /session 429 storm that
  // shared-broker polling can trigger. Prunes epicClosed to the current epics so
  // entries for closed tabs don't leak.
  useEffect(() => {
    const epics: string[] = leadEpicsKey ? JSON.parse(leadEpicsKey) : [];
    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        epics.map(async (epic) => {
          const meta = await fetchMarketMeta(epic, brokerId);
          // null `closed` (failed lookup) is treated as open, never badging a live
          // market closed on a transient error.
          return [
            epic,
            { closed: meta.closed === true, nextOpen: meta.closed === true ? meta.nextOpen : null },
          ] as const;
        }),
      );
      if (cancelled) return;
      // Replace wholesale (not merge) so epics no longer present are dropped.
      setEpicClosed(Object.fromEntries(entries));
    };
    void poll();
    const id = setInterval(() => void poll(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
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

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
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
    const ws: Workspace = { tabs, activeTabId: active?.id ?? "" };
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
  }, [tabs, active?.id, activeLayoutId, layoutName, autosave]);

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
  // Keep the alert feeds on the same data broker as the charts — epics are
  // broker-specific, so a feed must stream from the active broker. setBrokerId
  // no-ops when unchanged.
  useEffect(() => {
    alertEngine.setBrokerId(brokerId);
  }, [brokerId]);
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
  const setPeriod = (p: Period) => {
    if (!active || !focusedCell) return;
    // Lock forces interval sync on, so the master cell's TF propagates to every
    // cell — that's what keeps same-timestamp candles vertically aligned.
    const broadcast = effectiveSyncInterval(active);
    setTabs((ts) =>
      ts.map((t) =>
        t.id !== active.id
          ? t
          : {
              ...t,
              cells: t.cells.map((c) =>
                broadcast || c.id === focusedCell.id ? { ...c, period: p } : c,
              ),
            },
      ),
    );
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
        return { ...t, layout, cells, activeCellId };
      }),
    );
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
        // Plain date-range link (lock off): no extent clamp — if the master sits in
        // whitespace past its last bar, don't snap siblings; they self-heal on scroll.
        const r = src ? readVisibleRange(src.chart, false) : null;
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
    setActiveId(target.activeTabId);
    setActiveLayoutId(id);
    setHydrateEpoch((n) => n + 1);
    setLayoutRev((n) => n + 1);
  };

  // "Save" (⌘S) — update the active named layout in place. When autosave is on this
  // is redundant (the effect already persists); when autosave is off this is the only
  // thing that commits edits and clears the dirty flag.
  const saveActiveLayout = () => {
    if (!activeLayoutId || layoutName == null) return;
    saveLayout(activeLayoutId, layoutName, { tabs, activeTabId: active?.id ?? "" });
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
    saveLayout(id, name, cloned);
    clearScratch();
    setTabs(cloned.tabs);
    setActiveId(cloned.activeTabId);
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
        saveLayout(activeLayoutId, layoutName, { tabs, activeTabId: active?.id ?? "" });
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

  // Esc leaves maximized view (matches the fullscreen idiom). Only bound while
  // maximized so it doesn't swallow Esc elsewhere.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMaximized(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [maximized]);

  const focusedController = focused?.controller ?? null;

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
          workspace-level controls (named layouts, split picker, theme) ride at
          the right of this bar — they act on the tab/workspace, not on a single
          chart, so they don't belong in the per-chart toolbar below. Hidden in
          maximized view; Backtest lives in the toolbar so it survives that. */}
      {!maximized && (
      <TabBar
        tabs={tabs}
        activeId={active?.id ?? ""}
        closedEpics={epicClosed}
        onSelect={setActiveId}
        onAdd={addTab}
        onClose={closeTab}
        onReorder={reorderTab}
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
            <ThemeToggle
              theme={settings.theme}
              onToggle={() =>
                setSettings((s) => ({
                  ...s,
                  theme: s.theme === "dark" ? "light" : "dark",
                }))
              }
            />
            <button
              className="tabbar-action icon-only gear"
              onClick={() => setShowSettings(true)}
              title="Settings"
            >
              ⚙
            </button>
          </>
        }
      />
      )}
      <Toolbar
        controller={focusedController}
        symbol={symbol}
        period={period}
        onSymbol={setSymbol}
        onPeriod={setPeriod}
        brokerId={brokerId}
        accounts={accounts}
        activeAccount={activeAccount}
        onAccountChange={setActiveAccount}
        maximized={maximized}
        onToggleMaximize={() => setMaximized((m) => !m)}
      />
      <div className={`workspace${dockMaximized ? " dock-hidden" : ""}`}>
        <main className="chart">
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
        </main>
        {/* Panel is toggled by the toolbar bell; closed = chart uses full width. */}
        {panelOpen && symbol && (
          <AlertsSidebar
            controller={focusedController}
            epic={symbol.epic}
            precision={symbol.pricePrecision ?? 2}
            tabs={tabs}
            visibleCells={visibleCells}
            onOpenAlert={openAlert}
          />
        )}
        {/* Order ticket (paper): compose a new order for the focused symbol. The
            open book lives in the bottom dock, not here. Toggled by the toolbar's
            trade button. */}
        {tradeOpen && symbol && (
          <aside className="trade-sidebar">
            <OrderTicket
              epic={symbol.epic}
              account={activeAccount}
              precision={symbol.pricePrecision ?? 2}
              instrumentType={symbol.type}
              trading={settings.trading}
            />
          </aside>
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
          focusedEpic={symbol?.epic}
          precisionFor={precisionForEpic}
          trading={settings.trading}
          confirmLineEdits={settings.trading.confirmLineEdits}
          onJumpToEpic={jumpToEpic}
          onOpenTradePanel={() => tradePanelOpen.set(true)}
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
          const a = loadStoredAlert(alertGlobalEdit.epic, alertGlobalEdit.savedId);
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
                updateStoredAlert(ep, savedId, round(level), cfg);
                bumpAlerts();
                alertGlobalEditRequest.set(null);
              }}
              onDelete={() => {
                requestConfirm({
                  message: `Delete this alert on ${ep}?`,
                  onConfirm: () => {
                    deleteStoredAlert(ep, savedId);
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

      {/* Confirmation dialog — rendered LAST so it stacks above any modal that opened
          it (e.g. the alert edit modal's delete button). */}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={confirm.onConfirm}
          onClose={() => confirmRequest.set(null)}
        />
      )}
    </div>
  );
}

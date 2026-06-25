import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Chart } from "klinecharts";
import ChartGrid from "./ChartGrid";
import Toolbar from "./Toolbar";
import BacktestButton from "./BacktestButton";
import LayoutPicker from "./LayoutPicker";
import ThemeToggle from "./ThemeToggle";
import SettingsModal from "./Settings";
import AlertModal from "./AlertModal";
import IndicatorSettings from "./IndicatorSettings";
import DrawingSettings from "./DrawingSettings";
import AlertsSidebar from "./AlertsSidebar";
import { registerCustomIndicators } from "./lib/customIndicators";
import { registerBacktestIndicators } from "./lib/backtest";
import { registerCustomOverlays } from "./lib/customOverlays";
import type { ChartController } from "./lib/chartController";
import {
  alertModalRequest,
  alertEditRequest,
  indicatorSettingsRequest,
  drawingSettingsRequest,
  alertsPanelOpen,
  alertsChanged,
  settingsRequest,
} from "./lib/signals";
import { alertEngine } from "./lib/alertEngine";
import { PERIODS, fetchMarketMeta, type Instrument, type Period } from "./lib/feed";
import {
  hydrateFromBackend,
  subscribeToBackendUpdates,
  purgeTabScope,
  purgeScope,
  primaryCellScope,
  cellScope,
  LAYOUT_CELLS,
  migrateToNamedLayouts,
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
  // Toolbar gear + chart context menu request the Settings modal via a signal.
  useEffect(() => settingsRequest.subscribe(() => setShowSettings(true)), []);
  const [alertReq, setAlertReq] = useState(alertModalRequest.value);
  useEffect(() => alertModalRequest.subscribe(setAlertReq), []);
  const [alertEdit, setAlertEdit] = useState(alertEditRequest.value);
  useEffect(() => alertEditRequest.subscribe(setAlertEdit), []);
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
      // ALWAYS reconcile to the resolved workspace — not only when hydrate reports a
      // change. The useState initializers ran before hydration (so a fresh device
      // with a synced default rendered blank); resolving again here applies it. It's
      // idempotent when nothing changed, and robust to StrictMode's double-mount
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
  const [, bumpReady] = useReducer((n: number) => n + 1, 0);
  const focused = focusedCell ? readyRef.current.get(focusedCell.id) ?? null : null;

  const onCellReady = (cellId: string, chart: Chart, controller: ChartController) => {
    readyRef.current.set(cellId, { chart, controller });
    bumpReady();
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
    return [...epics].sort().join(",");
  }, [tabs]);

  // Poll open/closed status for every tab's lead epic, so the closed badge stays
  // live on background tabs too (their ChartCore isn't mounted). 60s cadence, in
  // step with ChartCore's own poll, to stay clear of the /session 429 storm that
  // shared-broker polling can trigger. Prunes epicClosed to the current epics so
  // entries for closed tabs don't leak.
  useEffect(() => {
    const epics = leadEpicsKey ? leadEpicsKey.split(",") : [];
    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        epics.map(async (epic) => {
          const meta = await fetchMarketMeta(epic);
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
  }, [leadEpicsKey]);

  // Pointer-down in a cell focuses it (routes the chrome to that cell).
  const onCellFocus = (cellId: string) => {
    if (!active || cellId === active.activeCellId) return;
    setTabs((ts) =>
      ts.map((t) => (t.id === active.id ? { ...t, activeCellId: cellId } : t)),
    );
  };

  const [panelOpen, setPanelOpen] = useState(alertsPanelOpen.value);
  useEffect(() => alertsPanelOpen.subscribe(setPanelOpen), []);

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
    setTabs((ts) =>
      ts.map((t) =>
        t.id !== active.id
          ? t
          : {
              ...t,
              cells: t.cells.map((c) =>
                t.syncSymbol || c.id === focusedCell.id ? { ...c, symbol: s } : c,
              ),
            },
      ),
    );
  };
  const setPeriod = (p: Period) => {
    if (!active || !focusedCell) return;
    setTabs((ts) =>
      ts.map((t) =>
        t.id !== active.id
          ? t
          : {
              ...t,
              cells: t.cells.map((c) =>
                t.syncInterval || c.id === focusedCell.id ? { ...c, period: p } : c,
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
  const toggleSync = (kind: "symbol" | "interval" | "crosshair") => {
    if (!active || !focusedCell) return;
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

  const focusedController = focused?.controller ?? null;

  return (
    <div className="app">
      {/* TradingView-style chart tabs: topmost strip, above the toolbar. The
          workspace-level controls (Backtest, named layouts, split picker, theme)
          ride at the right of this bar — they act on the tab/workspace, not on a
          single chart, so they don't belong in the per-chart toolbar below. */}
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
            <BacktestButton
              controller={focusedController}
              period={period}
              epic={symbol?.epic}
            />
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
                onToggleSync={toggleSync}
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
      <Toolbar
        controller={focusedController}
        symbol={symbol}
        period={period}
        onSymbol={setSymbol}
        onPeriod={setPeriod}
      />
      <div className="workspace">
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
              theme={settings.theme}
              timezone={settings.timezone}
              clock={settings.clock}
              dateFormat={settings.dateFormat}
              priceSide={settings.priceSide}
              bidAsk={settings.bidAsk}
              bidAskStyle={settings.bidAskStyle}
              crosshair={settings.crosshair}
              syncCrosshair={!!active.syncCrosshair}
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
          />
        )}
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
                focusedController?.overlays.remove(alertEdit.id);
                alertEditRequest.set(null);
              }}
              onClose={() => alertEditRequest.set(null)}
            />
          );
        })()}

      {indSettings && focused && focusedCell && symbol && period && (
        <IndicatorSettings
          chart={focused.chart}
          scope={focusedCell.scope}
          epic={symbol.epic}
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
    </div>
  );
}

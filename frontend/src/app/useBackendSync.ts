// Backend sync for the workspace: the startup hydrate (and the one-time
// cleanups that must follow it), live pushes from other tabs and devices, the
// broker switch that swaps the whole workspace, and hydrateEpoch, the key
// that forces the chart grid to remount when stored content changed.
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { backtestPanelActionForReplay, isChartReplaying, rehydrateBacktest } from "../lib/backtest";
import { bumpAlerts } from "../lib/signals";
import {
  hydrateFromBackend,
  subscribeToBackendUpdates,
  PREFIX,
  matchBacktestKey,
  matchSweepPointerKey,
  pruneLegacyGlobalWorkspace,
  pruneStaleBacktests,
  pruneLegacyTabsKeys,
  setPersistBroker,
  hydrateAlerts,
  pickActiveTabId,
  migrateIndicatorConfigStashes,
  type ChartTab,
  type Workspace,
} from "../lib/persist";
import { clearHistoryForKey } from "../lib/history";
import { loadSettings, type Settings } from "../theme";
import { resolveStartup } from "./workspace";
import type { ReadyCells, Ref } from "./types";

export function useBackendSync({
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
}: {
  brokerId: string;
  tabs: ChartTab[];
  activeId: string;
  activeLayoutId: string | null;
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  setTabs: Dispatch<SetStateAction<ChartTab[]>>;
  setActiveId: Dispatch<SetStateAction<string>>;
  setActiveLayoutId: Dispatch<SetStateAction<string | null>>;
  setLayoutRev: Dispatch<SetStateAction<number>>;
  setPendingUndo: (u: null) => void;
  readyRef: Ref<ReadyCells>;
}) {
  // Backend-wins startup hydration. hydrateFromBackend() pulls the snapshot,
  // overwrites localStorage where the backend differs, and (crucially) gates
  // write-mirroring at the module level until it resolves — so App's mount-time
  // saves and every cell's mount-time save can't push stale local state
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
  // Alerts follow on their own: they're backend rows keyed by broker, and the
  // cache hydrateAlerts() filled holds every broker's set.
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
    // Another tab/device edited this key: undoing over their change would silently
    // revert it. Clear the owning cell's history (matches pendingUndo.sigAfter's
    // philosophy for the tab-merge undo).
    clearHistoryForKey(key);
    // A per-cell CONTENT change (an alert, drawing, or indicator on a cell we're ALSO
    // showing) never alters the tabs array, so the sameView check below treats it as
    // "not our view" and skips it — leaving our on-chart overlays stale until our next
    // persist() stomps the other tab's edit back to storage (cross-tab data loss: the
    // reported alerts/drawings vanishing when the app is open in two tabs). Route those
    // keys explicitly so the mounted cells re-sync to storage:
    //  - alerts are NOT here any more: they're backend state and their
    //    `__alerts__:` pushes are consumed by alertsApi (persist/core routes them
    //    before this callback ever runs), which re-hydrates and bumps the alerts
    //    signal so every mounted same-epic cell reconciles in place.
    //  - backtest results / sweep pointers have their own in-place handling — the
    //    two early returns below, BEFORE the resolveStartup + tabs-stringify work
    //    those paths would only throw away (neither key can carry a layout or
    //    settings change).
    //  - drawings/indicators/avwap are per-cell-scope and have no in-place reconcile,
    //    so remount the grid (rehydrate re-reads storage) when the changed key belongs
    //    to a cell that's currently on screen.
    const activeTab = workspaceRef.current.tabs.find(
      (t) => t.id === workspaceRef.current.activeTabId,
    );
    const visibleScopes = activeTab?.cells.map((c) => c.scope) ?? [];
    // A backtest result written by another tab on a cell we're showing: backtest
    // artifacts have a proper in-place restore (rehydrateBacktest), so use it on
    // that one cell instead of the whole-grid remount below. The remount disposes
    // every chart (a visible reload + seconds of bar refetch), blanks the shared
    // results panel until rehydrate, and its own mount-time writes echo back to
    // the tab that RAN the backtest and remount it too — the post-run flicker.
    // A cell showing a different epic (or not yet mounted) skips the redraw: the
    // stored result is already updated and rehydrates on its next mount/switch.
    const bt = matchBacktestKey(key, visibleScopes);
    if (bt) {
      const cell = activeTab?.cells.find((c) => c.scope === bt.scope);
      const ready = cell ? readyRef.current.get(cell.id) : undefined;
      if (cell && ready && cell.symbol.epic === bt.epic) {
        // ...unless that cell is REPLAYING. A backtest finishing in another tab
        // (or on another device) would otherwise publish the whole saved run
        // onto the shared panel mid-session — every trade the strategy is about
        // to take with its P&L, the run's final net P&L, and `period` as a real
        // calendar range straight through a masked session — and clobber the
        // progressive reveal's slice while it was at it. `stalePanelOwner: false`
        // is the honest input here: nothing has been torn down on this path, so
        // anything this chart owns is the reveal's own live slice and must stay.
        // The reveal re-reads the saved result on its next redraw, so a run that
        // lands mid-session is picked up rather than lost.
        const action = backtestPanelActionForReplay({
          replaying: isChartReplaying(ready.chart),
          stalePanelOwner: false,
        });
        if (action === "rehydrate") {
          rehydrateBacktest(ready.chart, bt.scope, bt.epic, cell.period.resolution);
        }
      }
      return;
    }
    // A sweep archive pointer written by another tab on a cell we're showing: its
    // only consumers live in BacktestSettingsModal, which sits OUTSIDE the
    // hydrateEpoch-keyed grid subtree — a remount disposes every chart yet still
    // doesn't refresh the modal, so it's pure cost. The pointer is already in
    // localStorage; the modal reads it on its next restore (cell/epic switch or
    // section reopen), exactly as it would have after the remount.
    if (matchSweepPointerKey(key, visibleScopes)) return;
    const r = resolveStartup();
    const sameView =
      r.activeLayoutId === activeLayoutIdRef.current &&
      JSON.stringify(r.ws.tabs) === JSON.stringify(workspaceRef.current.tabs);
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
    hydrateFromBackend().then(async () => {
      if (cancelled) return;
      // Alerts are backend-owned and have NO localStorage fallback, so the
      // in-memory cache every read goes through is empty until this resolves.
      // Awaited here (alongside the workspace hydrate, before the first chart
      // render below) so the sidebar and the cells' rehydrate see the real list.
      await hydrateAlerts();
      bumpAlerts(); // the sidebar/all-symbols list was rendered off an empty cache
      if (cancelled) return; // the await re-opens the StrictMode double-mount window
      // Per-broker isolation rollout: the workspace is now ISOLATED PER BROKER and
      // this is a FRESH START (each broker begins blank). Drop the abandoned old
      // GLOBAL workspace roots once — AFTER hydrate so the deletes reach the backend
      // (else the next hydrate re-seeds them). Idempotent (sentinel-gated); preserves
      // global preferences and every per-broker `auto-trader.b.*` key.
      pruneLegacyGlobalWorkspace();
      // The working tab set now lives in the layout body / scratch; drop the
      // abandoned per-broker `.tabs` roots (localStorage + backend).
      pruneLegacyTabsKeys();
      // One-time cleanup of the computed MTF stashes older builds persisted
      // alongside each indicator's settings. The coordinator recomputes them
      // anyway, and a stash written before the detector's shape changed is what
      // froze charts in Sept 2026 (a throw in the trendlines draw loop stops the
      // pane repainting). After hydrate so the rewrites reach the backend
      // instead of being re-seeded by it.
      migrateIndicatorConfigStashes();
      // Expire stale backtest results. Safe here (unlike a liveness-based prune)
      // because expiry is by timestamp: a cell mounting alongside this can only
      // write a FRESH result, which by definition isn't stale. Runs after hydrate
      // so the deletes reach the backend instead of being re-seeded by it.
      pruneStaleBacktests();
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
  return { hydrateEpoch, setHydrateEpoch };
}

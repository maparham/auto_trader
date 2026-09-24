// Tab-level workspace edits: opening tabs, detaching a cell into its own tab,
// restoring and saving snapshots, closing and swapping cells, merging tabs
// (with the one-shot undo), reordering and closing tabs. Gestures that purge
// stored content commit the workspace synchronously.
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { flushPendingAutoSaves } from "../lib/templateAutosave";
import { clearAlignAnchor } from "../lib/chartSync";
import { isDemoMode } from "../lib/demoMode";
import { writeSnapshotToScope } from "../lib/snapshots";
import { saveSnapshotOfChart } from "../lib/snapshotSave";
import { toast } from "../lib/notify";
import { isChartReplaying } from "../lib/backtest";
import { requestConfirm, snapshotsGalleryOpen, requestSymbolSearch } from "../lib/signals";
import type { Instrument } from "../lib/feed";
import {
  purgeTabScope,
  purgeScope,
  primaryCellScope,
  copyScopeContent,
  KIND_FOR_COUNT,
  saveLayout,
  saveScratch,
  mergeTabInto,
  unmergeScopes,
  pushRecentSymbol,
  type ChartTab,
  type Workspace,
  type ChartSnapshot,
  type ChartCell,
} from "../lib/persist";
import { DEFAULT_SYMBOL, DEFAULT_PERIOD, newTabId, makeTab } from "./workspace";
import type { PendingUndo, FocusedCell } from "./types";

export function useTabActions({
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
}: {
  active: ChartTab | undefined;
  focused: FocusedCell;
  focusedCell: ChartCell | undefined;
  tabs: ChartTab[];
  activeId: string;
  setTabs: Dispatch<SetStateAction<ChartTab[]>>;
  setActiveId: Dispatch<SetStateAction<string>>;
  activeLayoutId: string | null;
  layoutName: string | undefined;
  setIsDirty: Dispatch<SetStateAction<boolean>>;
  pendingUndo: PendingUndo | null;
  setPendingUndo: Dispatch<SetStateAction<PendingUndo | null>>;
  openTab: (symbol: Instrument) => ChartTab;
}) {
  // New tab starts on the default chart, becomes active, then immediately opens
  // symbol search (TradingView-style "new tab" UX).
  const addTab = () => {
    openTab(DEFAULT_SYMBOL);
    requestSymbolSearch();
  };

  // Demo fallback: with nothing published (or a payload holding no tabs) a
  // signed-out visitor would land on the blank "No charts open" state. Open one
  // default chart instead, without the symbol-search popup addTab triggers.
  useEffect(() => {
    if (!isDemoMode()) return;
    setTabs((ts) => {
      if (ts.length) return ts;
      const t = makeTab(DEFAULT_SYMBOL, DEFAULT_PERIOD);
      setActiveId(t.id);
      return [t];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab-bar search catalogue fallback picked a symbol no open tab holds: open
  // it directly in a new tab (no symbol-search modal detour) on the default
  // interval, and record it as recently opened like any other pick.
  const openSymbolTab = (s: Instrument) => {
    pushRecentSymbol(s.epic);
    openTab(s);
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
      if (copiedOk && src.scope !== primaryCellScope(active.id)) {
        flushPendingAutoSaves(); // land ≤800ms-pending template autosaves pre-purge
        purgeScope(src.scope);
      }
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
    // A snapshot of a replaying chart stores the REAL epoch range of the hidden
    // slice, and restoring it prints those dates on a cell that is not replaying.
    // saveSnapshotOfChart refuses anyway; this is the half that can say why.
    if (isChartReplaying(focused.chart)) {
      toast("Chart replay is running: exit the session to snapshot this chart.");
      return null;
    }
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
        flushPendingAutoSaves(); // land ≤800ms-pending template autosaves pre-purge
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
    flushPendingAutoSaves(); // mergeTabInto purges the source scopes — land ≤800ms-pending template autosaves first
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
    // Land any pending (≤800ms debounce) template autosaves before the purge
    // wipes the scope storage they'd capture from — else those last edits die
    // with the timer (cancelAutoSave in ChartCore's cleanup only drops it).
    flushPendingAutoSaves();
    purgeTabScope(id);
    clearAlignAnchor(id); // drop this tab's sticky lock anchor so the map doesn't leak
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === activeId) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? "");
      return next;
    });
  };
  return { addTab, openSymbolTab, detachCell, restoreSnapshot, saveCurrentSnapshot, closeCell, swapCells, mergeTabs, undoMerge, reorderTab, closeTab };
}

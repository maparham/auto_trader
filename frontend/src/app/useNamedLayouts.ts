// The named-layout lifecycle behind LayoutManager: switch, save (and the
// Cmd/Ctrl+S shortcut), save as, import, delete, and the autosave toggle.
import { useEffect, type Dispatch, type SetStateAction } from "react";
import {
  loadLayouts,
  loadLayout,
  saveLayout,
  deleteLayout,
  clearScratch,
  cloneWorkspace,
  importLayout,
  pickActiveTabId,
  saveAutosave,
  type ChartTab,
} from "../lib/persist";
import { newTabId, newCellId } from "./workspace";

export function useNamedLayouts({
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
}: {
  tabs: ChartTab[];
  active: ChartTab | undefined;
  activeLayoutId: string | null;
  layoutName: string | undefined;
  autosave: boolean;
  setTabs: Dispatch<SetStateAction<ChartTab[]>>;
  setActiveId: Dispatch<SetStateAction<string>>;
  setActiveLayoutId: Dispatch<SetStateAction<string | null>>;
  setHydrateEpoch: Dispatch<SetStateAction<number>>;
  setLayoutRev: Dispatch<SetStateAction<number>>;
  setIsDirty: Dispatch<SetStateAction<boolean>>;
  setAutosaveState: Dispatch<SetStateAction<boolean>>;
}) {
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

  // Import a layout-export file (LayoutManager parses it): register it under
  // fresh tab/cell ids and switch this device to it. False = not a valid export.
  const importLayoutFromFile = (data: unknown): boolean => {
    const res = importLayout(data, newTabId, newCellId);
    if (!res) return false;
    switchLayout(res.id);
    return true;
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
  return { switchLayout, saveActiveLayout, saveLayoutAs, importLayoutFromFile, removeLayout, toggleAutosave };
}

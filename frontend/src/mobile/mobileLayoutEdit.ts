// The only writer of the saved layout from the mobile shell (spec:
// 2026-09-28-mobile-tab-overview-design.md). Each edit loads the layout body,
// applies one change and saves it, so a desktop tab showing the same layout
// picks it up through its backend push handler.
//
// Closing differs from desktop's closeTab on purpose: the tab's scope content
// (drawings, indicators) is purged only after the undo window, so Undo brings
// the tab back intact.
import type { Instrument, Period } from "../lib/feed";
import {
  saveLayout,
  loadLayout,
  loadLayouts,
  saveDefaultLayoutId,
  purgeTabScope,
  type ChartTab,
} from "../lib/persist";
import { makeTab, newTabId } from "../app/workspace";
import { mirroredWorkspace, bumpMobileWorkspace } from "./mobileWorkspace";

export const UNDO_MS = 4500;

function editLayout(id: string, fn: (tabs: ChartTab[]) => ChartTab[]): boolean {
  const ws = loadLayout(id);
  const name = loadLayouts().find((l) => l.id === id)?.name;
  if (!ws || name == null) return false;
  const tabs = fn(ws.tabs);
  if (tabs === ws.tabs) return false;
  const ok = saveLayout(id, name, { ...ws, tabs });
  bumpMobileWorkspace();
  return ok;
}

function editShown(fn: (tabs: ChartTab[]) => ChartTab[]): boolean {
  const m = mirroredWorkspace();
  return m ? editLayout(m.id, fn) : false;
}

export function addMobileTab(symbol: Instrument, period: Period): ChartTab {
  const tab = makeTab(symbol, period);
  if (mirroredWorkspace()) {
    editShown((ts) => [...ts, tab]);
  } else {
    // Nothing saved yet: the edit needs a layout to land in.
    const id = `layout-${newTabId()}`;
    saveLayout(id, "Mobile", { tabs: [tab], activeTabId: "" });
    saveDefaultLayoutId(id);
    bumpMobileWorkspace();
  }
  return tab;
}

export function setMobileTabOrder(ids: string[]): void {
  editShown((ts) => {
    const byId = new Map(ts.map((t) => [t.id, t]));
    const listed = ids.flatMap((id) => byId.get(id) ?? []);
    const seen = new Set(listed);
    const next = [...listed, ...ts.filter((t) => !seen.has(t))];
    return next.every((t, i) => t === ts[i]) ? ts : next;
  });
}

export function setMobileTabSymbol(tabId: string, symbol: Instrument): void {
  editShown((ts) => {
    const i = ts.findIndex((t) => t.id === tabId);
    if (i < 0 || ts[i].cells.length !== 1) return ts;
    const next = [...ts];
    next[i] = { ...ts[i], cells: [{ ...ts[i].cells[0], symbol }] };
    return next;
  });
}

// True when `tabId` still shows up in some saved layout's body. A concurrent
// desktop write can revert a mobile close (re-add the tab, or restore an
// older body that never dropped it) inside the undo window; purging the
// tab's scope out from under it would orphan the still-live cell.
function tabInAnySavedLayout(tabId: string): boolean {
  return loadLayouts().some((l) => !!loadLayout(l.id)?.tabs.some((t) => t.id === tabId));
}

// `onExpire` runs when the undo window closes without an undo, so the caller
// can take down an Undo control that would otherwise outlive it (a toast's own
// countdown pauses while the page is hidden; this timer does not).
export function closeMobileTab(tabId: string, onExpire?: () => void): (() => void) | null {
  const m = mirroredWorkspace();
  if (!m) return null;
  const idx = m.ws.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0 || m.ws.tabs.length === 1) return null;
  const tab = m.ws.tabs[idx];
  editLayout(m.id, (ts) => ts.filter((t) => t.id !== tabId));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const armPurge = () => {
    timer = setTimeout(() => {
      timer = null;
      if (!tabInAnySavedLayout(tabId)) purgeTabScope(tabId);
      onExpire?.();
    }, UNDO_MS);
  };
  armPurge();
  return () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    // Back into the layout it came from, even if the phone switched since.
    const restored = editLayout(m.id, (ts) => {
      const next = [...ts];
      next.splice(Math.min(idx, next.length), 0, tab);
      return next;
    });
    // The layout is gone (deleted, or the broker family switched under it):
    // the tab never made it back into a saved layout, so re-arm the purge
    // rather than leaving its scope orphaned forever.
    if (!restored) armPurge();
  };
}

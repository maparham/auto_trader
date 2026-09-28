// Mirror of the desktop workspace for the mobile shell: which saved layout the
// chart strip shows, flattened to an ordered cell list. Mobile edits to that
// layout go through mobileLayoutEdit.ts, the only writer.
//
// Only SAVED layouts are mirrorable: the unsaved scratch workspace and the
// per-tab activeLayoutId are deliberately device-local (see persist/workspace.ts
// "Sync split"). Which layout the phone shows is device-local too: the phone's
// own pick, else the default-marked layout, else the first saved layout.
import { Signal } from "../lib/signals";
import {
  PREFIX,
  load,
  saveLocal,
  loadLayouts,
  loadLayout,
  loadDefaultLayoutId,
  type LayoutMeta,
  type Workspace,
  type ChartCell,
} from "../lib/persist";

export const MOBILE_LAYOUT_KEY = `${PREFIX}.mobileLayoutId`;

export interface MirroredWorkspace {
  id: string;
  name: string;
  ws: Workspace;
}

export function mirroredWorkspace(): MirroredWorkspace | null {
  const layouts = loadLayouts();
  if (!layouts.length) return null;
  const pick = load<string | null>(MOBILE_LAYOUT_KEY, null);
  const defId = loadDefaultLayoutId();
  const meta =
    layouts.find((l) => l.id === pick) ?? layouts.find((l) => l.id === defId) ?? layouts[0];
  const ws = loadLayout(meta.id);
  return ws ? { id: meta.id, name: meta.name, ws } : null;
}

export function mobileLayoutList(): LayoutMeta[] {
  return loadLayouts();
}

export function setMobileLayout(id: string): void {
  saveLocal(MOBILE_LAYOUT_KEY, id);
  bumpMobileWorkspace();
}

// Which cell of a split tab the phone last showed, so reopening the tab from
// the overview lands where the user left it. In memory only: a fresh load
// starts every tab on its first cell.
export const lastCellByTab = new Map<string, number>();

export interface FlatCell {
  tabIndex: number;
  cell: ChartCell;
}

export function flattenCells(ws: Workspace): FlatCell[] {
  return ws.tabs.flatMap((tab, tabIndex) => tab.cells.map((cell) => ({ tabIndex, cell })));
}

// A backend push whose key affects the mirrored layout set: the layouts index
// ("…layouts"), a layout body ("…layout.<id>"), or the default marker.
export function isWorkspaceKey(key: string): boolean {
  return /\.(layouts|layout\.[^.]+|defaultLayoutId)$/.test(key);
}

// Bumped when a backend push changes any workspace key (MobileApp's
// subscribeToBackendUpdates handler); the chart strip re-reads on change.
export const mobileWorkspaceVersion = new Signal(0);
export function bumpMobileWorkspace(): void {
  mobileWorkspaceVersion.set(mobileWorkspaceVersion.value + 1);
}

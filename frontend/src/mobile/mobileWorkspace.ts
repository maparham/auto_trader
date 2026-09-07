// Read-only mirror of the desktop workspace for the mobile shell: which saved
// layout to show as the chart strip, flattened to an ordered cell list.
//
// Only SAVED layouts are mirrorable — the unsaved scratch workspace and the
// per-tab activeLayoutId are deliberately device-local (see persist/workspace.ts
// "Sync split"), so they never reach another device. We therefore mirror the
// default-marked layout when one exists, else the first saved layout.
import { Signal } from "../lib/signals";
import {
  loadLayouts,
  loadLayout,
  loadDefaultLayoutId,
  type Workspace,
  type ChartCell,
} from "../lib/persist";

export interface MirroredWorkspace {
  name: string;
  ws: Workspace;
}

export function mirroredWorkspace(): MirroredWorkspace | null {
  const layouts = loadLayouts();
  if (!layouts.length) return null;
  const defId = loadDefaultLayoutId();
  const meta = layouts.find((l) => l.id === defId) ?? layouts[0];
  const ws = loadLayout(meta.id);
  return ws ? { name: meta.name, ws } : null;
}

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

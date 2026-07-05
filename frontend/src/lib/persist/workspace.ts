// Chart tabs + cells (multi-chart layouts), tab merging, and named workspace
// layouts (save/apply/rename/delete + default/active/scratch/autosave).

import type { Instrument, Period } from "../feed";
import {
  root,
  familyRoot,
  brokerRoot,
  familyMembers,
  load,
  save,
  saveLocal,
  removeLocal,
  removeKeyEverywhere,
  primaryCellScope,
  cellScope,
  copyScopeContent,
  purgeScope,
  purgeTabScope,
} from "./core";

// --- chart tabs + cells (multi-chart layouts) --------------------------------

// TradingView-style split layouts. A tab is one layout holding 1..N cells; each
// cell is an independent chart view (instrument + interval + its own layout state
// addressed by `scope`). `2h` = side-by-side, `2v` = stacked, `4` = 2x2, etc.
export type LayoutKind = "1" | "2h" | "2v" | "3" | "4";

// Number of cells each layout shows (drives add/trim when the layout changes).
export const LAYOUT_CELLS: Record<LayoutKind, number> = {
  "1": 1,
  "2h": 2,
  "2v": 2,
  "3": 3,
  "4": 4,
};

export interface ChartCell {
  id: string;
  symbol: Instrument;
  period: Period;
  scope: string; // opaque per-cell storage prefix (see ns())
}

export interface ChartTab {
  id: string;
  layout: LayoutKind;
  cells: ChartCell[];
  activeCellId: string;
  // Per-tab sync toggles (TradingView "link" controls). When on, a change in the
  // focused cell broadcasts to the tab's other cells.
  syncSymbol?: boolean;
  syncInterval?: boolean;
  syncCrosshair?: boolean;
  // When on, scrolling/zooming the time axis in the focused chart matches the same
  // wall-clock window on the tab's other cells (cross-interval; mapped by timestamp).
  syncTime?: boolean;
  // Master "lock charts" override. When on, every interaction with the cell under
  // the cursor (TF change, pan, zoom, crosshair) mirrors to the tab's other cells
  // as if the cursor were on each of them — each cell keeps its own symbol. It's a
  // derived override of the four flags above (interval/crosshair/time forced on,
  // symbol forced off) so unlocking restores their prior state for free; the flags
  // themselves are never mutated. See the effective* helpers in App.tsx.
  locked?: boolean;
  // Per-tab cell-size fractions (column widths / row heights, each summing to 1)
  // set by dragging the borders between cells. Absent = equal split. Reset when
  // the layout kind changes.
  sizes?: { cols: number[]; rows: number[] };
}

// Pre-cells persisted tab shape (one chart per tab). Kept only to migrate.
interface ChartTabV1 {
  id: string;
  symbol: Instrument;
  period: Period;
}

// Per-broker workspace roots (see root() — addresses the ACTIVE broker).
const tabsKey = () => root("tabs");

// Convert a persisted v1 tab (one chart) into the cell-based shape: a single
// primary cell carrying the tab's old symbol/period and the byte-identical scope.
function migrateTabV1(t: ChartTabV1): ChartTab {
  const cellId = `${t.id}-c0`;
  return {
    id: t.id,
    layout: "1",
    cells: [
      { id: cellId, symbol: t.symbol, period: t.period, scope: primaryCellScope(t.id) },
    ],
    activeCellId: cellId,
  };
}

// Migrate any v1 entries (no `cells`) so old users keep their work. Shared by
// loadTabs (legacy bare-tabs key) and loadLayout/loadScratch (layout bodies).
function migrateTabs(list: Array<ChartTab | ChartTabV1>): ChartTab[] {
  return list.map((t) =>
    "cells" in t && Array.isArray((t as ChartTab).cells)
      ? (t as ChartTab)
      : migrateTabV1(t as ChartTabV1),
  );
}

export function loadTabs(): ChartTab[] | null {
  const list = load<Array<ChartTab | ChartTabV1> | null>(tabsKey(), null);
  if (!Array.isArray(list) || list.length === 0) return null;
  return migrateTabs(list);
}
export function saveTabs(tabs: ChartTab[]): void {
  save(tabsKey(), tabs);
}

// --- merge tabs (inverse of cell detach) --------------------------------------

// Layout kind implied by a cell count — merging re-derives the shape and drops
// any custom sizes (the standard rule when the layout kind changes).
export const KIND_FOR_COUNT: Record<number, LayoutKind> = { 1: "1", 2: "2h", 3: "3", 4: "4" };

export function canMergeTabs(tabs: ChartTab[], sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return false;
  const src = tabs.find((t) => t.id === sourceId);
  const dst = tabs.find((t) => t.id === targetId);
  return !!src && !!dst && src.cells.length + dst.cells.length <= 4;
}

// Merge the whole source tab into the target: every source cell moves across
// and the source tab disappears from the returned array. Cells are RE-SCOPED
// under the target tab id (content copied via copyScopeContent, source prefix
// purged) — keeping the foreign scope would break the invariant closeTab /
// deleteLayout rely on (purging a tab's content by its own prefix reaches all
// of its cells). `position` places the incoming cells relative to the target's
// existing ones. Returns null when the merge is invalid or would exceed 4 cells.
export function mergeTabInto(
  tabs: ChartTab[],
  sourceId: string,
  targetId: string,
  position: "before" | "after" = "after",
): { tabs: ChartTab[]; moved: Array<{ from: string; to: string }> } | null {
  if (!canMergeTabs(tabs, sourceId, targetId)) return null;
  const src = tabs.find((t) => t.id === sourceId)!;
  const dst = tabs.find((t) => t.id === targetId)!;
  // A locked target mirrors every interaction across its cells on ONE shared
  // timeframe (toggleLock harmonizes periods when engaging). The lock carries
  // over to the merged tab via the spread below, so incoming cells must adopt
  // the target's timeframe or the merged tab would claim a lock its cells
  // visibly violate.
  const lockPeriod = dst.locked ? dst.cells[0]?.period : undefined;
  const movedScopes: Array<{ from: string; to: string }> = [];
  let copiesOk = true;
  const moved: ChartCell[] = src.cells.map((c) => {
    const scope = cellScope(targetId, c.id);
    copiesOk = copyScopeContent(c.scope, scope) && copiesOk;
    movedScopes.push({ from: c.scope, to: scope });
    return lockPeriod ? { ...c, scope, period: lockPeriod } : { ...c, scope };
  });
  // Only burn the originals when EVERY copy landed. On storage quota the copy
  // silently drops keys — keeping the source content turns permanent data
  // loss into a mere orphaned-scope leak, and undo can still restore the
  // untouched originals.
  if (copiesOk) purgeTabScope(sourceId);
  const cells = position === "before" ? [...moved, ...dst.cells] : [...dst.cells, ...moved];
  const { sizes: _sizes, ...dstRest } = dst;
  const merged: ChartTab = {
    ...dstRest,
    cells,
    layout: KIND_FOR_COUNT[cells.length],
    // The merged-in chart is what the user just pulled over — focus it, and
    // link the cells (the point of viewing tabs together): interval, crosshair
    // and date range all sync. Symbol sync stays off — merged tabs usually
    // intentionally show different instruments.
    activeCellId: src.activeCellId,
    syncInterval: true,
    syncCrosshair: true,
    syncTime: true,
    syncSymbol: false,
  };
  return {
    tabs: tabs.filter((t) => t.id !== sourceId).map((t) => (t.id === targetId ? merged : t)),
    moved: movedScopes,
  };
}

// Inverse of the scope moves a merge performed: content travels BACK to the
// old scopes (carrying any edits made since the merge) and the merged-in
// scopes are purged. Restoring the tab array itself is the caller's job — it
// holds the pre-merge snapshot (mergeTabInto never mutates its input).
export function unmergeScopes(pairs: Array<{ from: string; to: string }>): void {
  for (const { from, to } of pairs) {
    // Only purge the merged-in scope once the content fully travelled back — on
    // storage quota the copy silently drops keys, so keeping the source turns
    // permanent data loss into a mere orphaned-scope leak (mirrors mergeTabInto).
    if (copyScopeContent(to, from)) purgeScope(to);
  }
}

// --- named workspace layouts -------------------------------------------------
//
// A LAYOUT is a named snapshot of the ENTIRE workspace: every tab (each tab a
// multi-cell split), plus which tab was active. TradingView's "Layouts" — open
// any device and apply your default; save the current arrangement under a name.
//
// Sync split (deliberate, see saveLocal above):
//   - the layout INDEX (`layouts`), each layout's body (`layout.<id>`) and the
//     DEFAULT (`defaultLayoutId`) are MIRRORED → they appear on every device.
//   - the ACTIVE layout (`activeLayoutId`) and the unsaved SCRATCH workspace are
//     DEVICE-LOCAL → each browser/tab can have a different layout open.
//
// Per-cell content (drawings/indicators/alerts/avwap/indicatorConfig) is NOT
// re-namespaced per layout: it's already addressed by each cell's globally-unique
// `scope` (`tab.<tabId>[.cell.<cellId>]`), and a layout's tabs carry those scopes.
// The ONE rule that keeps layouts independent: cloning a layout ("Save as…") must
// generate fresh tab/cell ids AND copy each cell's scope content to the new scopes
// (see cloneWorkspace) — otherwise two layouts alias the same drawings.

// Per-broker named-layout roots. The MIRRORED ones (index/body/default) sync across
// devices; the DEVICE-LOCAL ones (activeLayoutId/scratch/autosave) don't (see
// isDeviceLocalKey + saveLocal). All address the ACTIVE broker via root().
// layoutsKey/layoutKey are namespaced by broker FAMILY (see layoutFamily above) so
// the saved-layout library is shared between e.g. capital and capital-live.
const layoutsKey = () => familyRoot("layouts");
const defaultLayoutKey = () => root("defaultLayoutId");
const activeLayoutKey = () => root("activeLayoutId"); // device-local
const scratchKey = () => root("scratch"); // device-local
const autosaveKey = () => root("autosave"); // device-local
const layoutKey = (id: string) => familyRoot(`layout.${id}`);

export interface LayoutMeta {
  id: string;
  name: string;
}
// The persisted body of one layout: the workspace it captures.
export interface Workspace {
  tabs: ChartTab[];
  // The active tab is intentionally NOT a synced concept — it's per-instance and
  // lives in React state (see App.tsx). The persisted value is only a seed for the
  // very first render after load; live selection is never written back. We keep the
  // field so older bodies (which DID carry a real id) still seed gracefully.
  activeTabId: string;
}

// Which tab should be active given the workspace `ws` and the instance's CURRENT
// in-memory selection `prevId`. The active tab is per-instance, so we KEEP the
// instance's own selection whenever that tab still exists in `ws` (this is what
// stops a sibling browser tab's selection from hijacking ours on a backend push).
// Only when `prevId` is gone (e.g. broker switch, layout switch, tab closed) do we
// fall back to the body's seed, then the first tab.
export function pickActiveTabId(prevId: string, ws: Workspace): string {
  if (prevId && ws.tabs.some((t) => t.id === prevId)) return prevId;
  if (ws.activeTabId && ws.tabs.some((t) => t.id === ws.activeTabId))
    return ws.activeTabId;
  return ws.tabs[0]?.id ?? "";
}

export function loadLayouts(): LayoutMeta[] {
  return load<LayoutMeta[]>(layoutsKey(), []);
}
export function loadLayout(id: string): Workspace | null {
  const w = load<Workspace | null>(layoutKey(id), null);
  if (!w || !Array.isArray(w.tabs)) return null;
  // Run any v1 tabs in the body through the same migration loadTabs() applies.
  return { tabs: migrateTabs(w.tabs), activeTabId: w.activeTabId };
}

// Create or update-in-place the layout `id` (keeps tab/cell ids → scopes, so the
// existing per-cell content stays addressed). Used by both "Save" (existing id)
// and the index bookkeeping for a freshly-created layout.
export function saveLayout(id: string, name: string, ws: Workspace): void {
  save(layoutKey(id), ws);
  const list = loadLayouts();
  const idx = list.findIndex((l) => l.id === id);
  if (idx >= 0) list[idx] = { id, name };
  else list.push({ id, name });
  save(layoutsKey(), list);
}

export function renameLayout(id: string, name: string): void {
  const list = loadLayouts();
  const idx = list.findIndex((l) => l.id === id);
  if (idx < 0) return;
  list[idx] = { id, name };
  save(layoutsKey(), list);
}

// Delete a layout: drop its index entry, its body, every cell scope it owned, and
// clear the default if it pointed here. (activeLayoutId is healed by the caller.)
//
// The layout body/index are family-shared (layoutFamily), but defaultLayoutId is
// per-feed — so a shared layout can be someone's default under a SIBLING feed even
// though it's being deleted from the current one. Clear it there too, or that
// feed's default silently and permanently points at a layout that no longer exists.
export function deleteLayout(id: string): void {
  const ws = loadLayout(id);
  const list = loadLayouts().filter((l) => l.id !== id);
  save(layoutsKey(), list);
  removeKeyEverywhere(layoutKey(id));
  if (ws) for (const t of ws.tabs) purgeTabScope(t.id);
  for (const broker of familyMembers()) {
    const key = brokerRoot(broker, "defaultLayoutId");
    if (load<string | null>(key, null) === id) removeKeyEverywhere(key);
  }
}

export function loadDefaultLayoutId(): string | null {
  return load<string | null>(defaultLayoutKey(), null);
}
export function saveDefaultLayoutId(id: string | null): void {
  if (id == null) {
    removeKeyEverywhere(defaultLayoutKey());
  } else {
    save(defaultLayoutKey(), id);
  }
}

// Device-local: which layout this browser/tab currently shows. null = scratch.
export function loadActiveLayoutId(): string | null {
  return load<string | null>(activeLayoutKey(), null);
}
export function saveActiveLayoutId(id: string | null): void {
  if (id == null) removeLocal(activeLayoutKey());
  else saveLocal(activeLayoutKey(), id);
}

// Device-local: the unsaved workspace shown before the user names a layout.
export function loadScratch(): Workspace | null {
  const w = load<Workspace | null>(scratchKey(), null);
  if (!w || !Array.isArray(w.tabs)) return null;
  return { tabs: migrateTabs(w.tabs), activeTabId: w.activeTabId };
}
export function saveScratch(ws: Workspace): void {
  saveLocal(scratchKey(), ws);
}
export function clearScratch(): void {
  removeLocal(scratchKey());
}

// Device-local: whether autosave is enabled (default true, matching TV).
export function loadAutosave(): boolean {
  return load<boolean>(autosaveKey(), true);
}
export function saveAutosave(enabled: boolean): void {
  saveLocal(autosaveKey(), enabled);
}

// Deep-copy a workspace under FRESH tab/cell ids, copying each cell's scope
// content (drawings/indicators/alerts/avwap/indicatorConfig) to the new scopes so
// the copy is fully independent of the source. Returns the new workspace plus the
// scope remap (unused by callers today, handy for tests/debug). `mintTabId` /
// `mintCellId` are injected so the caller owns id generation (App.tsx's seq).
export function cloneWorkspace(
  src: Workspace,
  mintTabId: () => string,
  mintCellId: () => string,
): Workspace {
  const tabs: ChartTab[] = src.tabs.map((t) => {
    const newTabId = mintTabId();
    let activeCellId = "";
    const cells: ChartCell[] = t.cells.map((c, i) => {
      const newCellId = i === 0 ? null : mintCellId();
      // The primary cell reuses the tab's primary scope (mirrors makeTab/migrate).
      const id = newCellId ?? `${newTabId}-c0`;
      const scope =
        i === 0 ? primaryCellScope(newTabId) : cellScope(newTabId, id);
      copyScopeContent(c.scope, scope);
      if (c.id === t.activeCellId || activeCellId === "") activeCellId = id;
      return { id, symbol: c.symbol, period: c.period, scope };
    });
    return {
      id: newTabId,
      layout: t.layout,
      cells,
      activeCellId: cells.some((c) => c.id === activeCellId)
        ? activeCellId
        : cells[0].id,
      syncSymbol: t.syncSymbol,
      syncInterval: t.syncInterval,
      syncCrosshair: t.syncCrosshair,
      syncTime: t.syncTime,
      locked: t.locked,
      sizes: t.sizes,
    };
  });
  const srcActiveIdx = src.tabs.findIndex((t) => t.id === src.activeTabId);
  return {
    tabs,
    activeTabId: tabs[srcActiveIdx >= 0 ? srcActiveIdx : 0]?.id ?? "",
  };
}

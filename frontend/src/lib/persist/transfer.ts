// Export/import one named layout as a self-contained JSON document: the
// workspace body (tabs/cells/splits/sync flags/sizes) plus every cell scope's
// stored content (drawings, indicators, indicatorConfig, alerts, avwap — the
// same key set cloneWorkspace/copyScopeContent treat as a cell's content).
// Import re-mints every tab/cell id so the payload can never collide with ids
// already living in this browser (or with a second import of the same file).

import { PREFIX, save, primaryCellScope, cellScope } from "./core";
import {
  loadLayout,
  loadLayouts,
  saveLayout,
  type ChartCell,
  type ChartTab,
  type Workspace,
} from "./workspace";

export interface LayoutExportV1 {
  format: "auto-trader.layout";
  version: 1;
  name: string;
  exportedAt: string;
  workspace: Workspace;
  // scope -> suffix -> raw stored JSON string (exactly the localStorage bytes).
  scopes: Record<string, Record<string, string>>;
}

// Collect every `${PREFIX}.<scope>.<suffix>` key as { suffix: raw }. A primary
// scope (`tab.<id>`) prefix-matches its nested cell scopes (`tab.<id>.cell.*`),
// so nested keys are EXCLUDED here — each cell contributes its own scope entry
// (the same rule copyScopeContent applies).
function readScopeContent(scope: string): Record<string, string> {
  const head = `${PREFIX}.${scope}.`;
  const nested = `${head}cell.`;
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(head) || k.startsWith(nested)) continue;
    const v = localStorage.getItem(k);
    if (v != null) out[k.slice(head.length)] = v;
  }
  return out;
}

export function exportLayout(id: string): LayoutExportV1 | null {
  const ws = loadLayout(id);
  if (!ws) return null;
  const name = loadLayouts().find((l) => l.id === id)?.name ?? "Layout";
  const scopes: Record<string, Record<string, string>> = {};
  for (const t of ws.tabs)
    for (const c of t.cells) scopes[c.scope] = readScopeContent(c.scope);
  return {
    format: "auto-trader.layout",
    version: 1,
    name,
    exportedAt: new Date().toISOString(),
    workspace: { tabs: ws.tabs, activeTabId: "" },
    scopes,
  };
}

// Shape check, not a full schema: enough to reject the wrong file and to make
// the remap below safe to run. Anything deeper (unknown drawing types etc.)
// degrades the same way it does for stale localStorage: consumers ignore it.
function isValidExport(data: unknown): data is LayoutExportV1 {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Partial<LayoutExportV1>;
  return (
    d.format === "auto-trader.layout" &&
    d.version === 1 &&
    typeof d.name === "string" &&
    typeof d.scopes === "object" &&
    d.scopes !== null &&
    typeof d.workspace === "object" &&
    d.workspace !== null &&
    Array.isArray(d.workspace.tabs) &&
    d.workspace.tabs.every(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        Array.isArray((t as ChartTab).cells) &&
        (t as ChartTab).cells.every(
          (c) => typeof c === "object" && c !== null && typeof c.scope === "string",
        ),
    )
  );
}

// First free name: `name`, then `name (imported)`, then `name (imported N)`.
function freeName(name: string): string {
  const taken = new Set(loadLayouts().map((l) => l.name));
  if (!taken.has(name)) return name;
  if (!taken.has(`${name} (imported)`)) return `${name} (imported)`;
  for (let n = 2; ; n++)
    if (!taken.has(`${name} (imported ${n})`)) return `${name} (imported ${n})`;
}

// Import a parsed export document as a NEW named layout under fresh tab/cell
// ids (same remap rule as cloneWorkspace: cell0 rides the tab's primary scope,
// the rest get their own nested scopes). Scope content is written through
// save() so it mirrors to the backend like any local edit. Returns the new
// layout's id + (possibly de-collided) name, or null for a malformed payload.
export function importLayout(
  data: unknown,
  mintTabId: () => string,
  mintCellId: () => string,
): { id: string; name: string } | null {
  if (!isValidExport(data)) return null;
  const tabs: ChartTab[] = data.workspace.tabs.map((t) => {
    const newTabId = mintTabId();
    let activeCellId = "";
    const cells: ChartCell[] = t.cells.map((c, i) => {
      const id = i === 0 ? `${newTabId}-c0` : mintCellId();
      const scope = i === 0 ? primaryCellScope(newTabId) : cellScope(newTabId, id);
      for (const [suffix, raw] of Object.entries(data.scopes[c.scope] ?? {})) {
        try {
          save(`${PREFIX}.${scope}.${suffix}`, JSON.parse(raw));
        } catch {
          /* one corrupt value shouldn't sink the whole import */
        }
      }
      if (c.id === t.activeCellId || activeCellId === "") activeCellId = id;
      return { id, symbol: c.symbol, period: c.period, scope };
    });
    return {
      id: newTabId,
      layout: t.layout,
      cells,
      activeCellId,
      syncSymbol: t.syncSymbol,
      syncInterval: t.syncInterval,
      syncCrosshair: t.syncCrosshair,
      syncTime: t.syncTime,
      locked: t.locked,
      sizes: t.sizes,
    };
  });
  const id = `layout-${mintTabId()}`;
  const name = freeName(data.name);
  saveLayout(id, name, { tabs, activeTabId: "" });
  return { id, name };
}

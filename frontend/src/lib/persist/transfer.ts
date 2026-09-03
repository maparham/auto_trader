// Export/import one named layout as a self-contained JSON document: the
// workspace body (tabs/cells/splits/sync flags/sizes) plus every cell scope's
// stored content (drawings, indicators, indicatorConfig, alerts, avwap — the
// same key set cloneWorkspace/copyScopeContent treat as a cell's content).
// Import re-mints every tab/cell id so the payload can never collide with ids
// already living in this browser (or with a second import of the same file).

import { PREFIX, save, purgeTabScope } from "./core";
import {
  loadLayout,
  loadLayouts,
  remapTabs,
  saveLayout,
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
// the remap below safe to run. Cells MUST carry a symbol and period object and
// every tab MUST have at least one cell — the app renders those unguarded (a
// symbol-less cell crashes App.tsx's precision lookup on every reload, and a
// zero-cell tab breaks "Save as…"), so unlike unknown drawing types they can't
// be left for consumers to ignore. Anything deeper degrades the same way it
// does for stale localStorage.
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
        (t as ChartTab).cells.length > 0 &&
        (t as ChartTab).cells.every(
          (c) =>
            typeof c === "object" &&
            c !== null &&
            typeof c.scope === "string" &&
            typeof c.symbol === "object" &&
            c.symbol !== null &&
            typeof c.period === "object" &&
            c.period !== null,
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
// layout's id + (possibly de-collided) name, or null for a malformed payload
// OR when any write was dropped (storage quota) — a partial import is rolled
// back (scopes purged, nothing indexed) rather than reported as success.
export function importLayout(
  data: unknown,
  mintTabId: () => string,
  mintCellId: () => string,
): { id: string; name: string } | null {
  if (!isValidExport(data)) return null;
  let wroteOk = true;
  const tabs = remapTabs(data.workspace.tabs, mintTabId, mintCellId, (c, scope) => {
    for (const [suffix, raw] of Object.entries(data.scopes[c.scope] ?? {})) {
      try {
        wroteOk = save(`${PREFIX}.${scope}.${suffix}`, JSON.parse(raw)) && wroteOk;
      } catch {
        /* one corrupt value shouldn't sink the whole import */
      }
    }
  });
  const id = `layout-${mintTabId()}`;
  const name = freeName(data.name);
  if (!wroteOk || !saveLayout(id, name, { tabs, activeTabId: "" })) {
    // Quota hit somewhere: undo the scope content already written (the tab's
    // primary scope prefix-matches its nested cell scopes) and report failure.
    for (const t of tabs) purgeTabScope(t.id);
    return null;
  }
  return { id, name };
}

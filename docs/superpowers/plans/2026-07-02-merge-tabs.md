# Merge Tabs (inverse of cell detach) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge whole chart tabs into one multi-cell layout — cells move (content re-scoped), the source tab closes, crosshair sync turns on — via three gestures: tab context menu, drag chip onto the chart, drop chip on another chip's center.

**Architecture:** One core function `mergeTabInto` in `frontend/src/lib/persist.ts` (re-scopes moved cells under the target tab via the existing `copyScopeContent`, purges the source prefix, re-derives the layout kind). App.tsx exposes a `mergeTabs` handler; TabBar grows a context menu + a `MergeTabsMenu` checklist popover + a center drop zone; ChartGrid grows a drag-over merge overlay.

**Tech Stack:** React 19 + TypeScript (Vite), vitest for unit tests, Playwright for e2e. Spec: `docs/superpowers/specs/2026-07-02-merge-tabs-design.md`.

## Global Constraints

- Work directly on `main` — no feature branch. Do NOT kill the user's running dev servers.
- Layout cap: a tab holds at most **4** cells (`LAYOUT_CELLS` in persist.ts). Merges that would exceed it are disabled in the UI, never error at runtime.
- Scope invariant: every cell's `scope` must start with `tab.<owningTabId>` — `closeTab` (App.tsx:1057) and `deleteLayout` (persist.ts:663) purge by that prefix. Merged-in cells are therefore RE-SCOPED, not moved verbatim.
- Layout kind is re-derived from cell count on merge: 2→`"2h"`, 3→`"3"`, 4→`"4"`; custom `sizes` reset (same rule as any layout-kind change).
- After a merge: target tab's `activeCellId` = the source tab's former `activeCellId`; `syncCrosshair` = true; `syncSymbol`/`syncInterval` untouched.
- No backward-compat/migration code. Plain UI copy ("Merge into this tab…", "Would exceed 4 charts"). No drop shadows on new UI (inset accent rings via `outline`); light theme is canonical.
- All frontend commands run from `frontend/`: unit `npx vitest run src/lib/persist.test.ts`, e2e `npx playwright test e2e/merge-tabs.spec.ts` (playwright.config starts the dev server on :5173 itself).

---

### Task 1: `mergeTabInto` + `canMergeTabs` in persist.ts

**Files:**
- Modify: `frontend/src/lib/persist.ts` (add after `saveTabs`, ~line 566)
- Test: `frontend/src/lib/persist.test.ts`

**Interfaces:**
- Consumes: existing `cellScope`, `primaryCellScope`, `copyScopeContent`, `purgeTabScope`, `ChartTab`, `ChartCell`, `LayoutKind` (all already in persist.ts).
- Produces: `canMergeTabs(tabs: ChartTab[], sourceId: string, targetId: string): boolean` and `mergeTabInto(tabs: ChartTab[], sourceId: string, targetId: string, position?: "before" | "after"): ChartTab[] | null` (null = invalid/over-cap; otherwise a new tabs array with the source removed and the target replaced by the merged tab).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/persist.test.ts` (extend the existing `from "./persist"` import list with `mergeTabInto, canMergeTabs, cellScope, primaryCellScope, saveDrawings, loadDrawings` and `type ChartTab` — keep whatever it already imports):

```ts
describe("mergeTabInto (merge whole tabs — inverse of detach)", () => {
  const cell = (tabId: string, n: number) => ({
    id: `${tabId}-c${n}`,
    symbol: { epic: "US100", name: "US100" } as never,
    period: { resolution: "HOUR", label: "1H" } as never,
    // Cell 0 is the primary (tab-prefix scope), later cells are nested — same
    // shape real tabs have.
    scope: n === 0 ? primaryCellScope(tabId) : cellScope(tabId, `${tabId}-c${n}`),
  });
  const tab = (id: string, nCells: number): ChartTab => ({
    id,
    layout: (["1", "2h", "3", "4"] as const)[nCells - 1],
    cells: Array.from({ length: nCells }, (_, i) => cell(id, i)),
    activeCellId: `${id}-c0`,
    sizes: { cols: [0.3, 0.7], rows: [1] },
  });

  it("moves all source cells re-scoped under the target and purges the source prefix", () => {
    saveDrawings(primaryCellScope("s"), "US100", [
      { name: "horizontalStraightLine", points: [{ value: 1 }] },
    ]);
    const out = mergeTabInto([tab("s", 1), tab("d", 1)], "s", "d")!;
    expect(out.map((t) => t.id)).toEqual(["d"]);
    expect(out[0].cells.map((c) => c.id)).toEqual(["d-c0", "s-c0"]);
    expect(out[0].cells[1].scope).toBe(cellScope("d", "s-c0"));
    // Content followed the cell; the old scope is purged.
    expect(loadDrawings(cellScope("d", "s-c0"), "US100")).toHaveLength(1);
    expect(loadDrawings(primaryCellScope("s"), "US100")).toHaveLength(0);
  });

  it("re-derives layout, resets sizes, focuses the merged-in lead, enables crosshair sync", () => {
    const out = mergeTabInto([tab("s", 2), tab("d", 2)], "s", "d")!;
    expect(out[0].layout).toBe("4");
    expect(out[0].sizes).toBeUndefined();
    expect(out[0].activeCellId).toBe("s-c0");
    expect(out[0].syncCrosshair).toBe(true);
  });

  it("position 'before' puts the incoming cells first", () => {
    const out = mergeTabInto([tab("s", 1), tab("d", 1)], "s", "d", "before")!;
    expect(out[0].cells.map((c) => c.id)).toEqual(["s-c0", "d-c0"]);
  });

  it("refuses over-cap and self merges", () => {
    expect(canMergeTabs([tab("s", 3), tab("d", 2)], "s", "d")).toBe(false);
    expect(mergeTabInto([tab("s", 3), tab("d", 2)], "s", "d")).toBeNull();
    expect(canMergeTabs([tab("s", 1), tab("d", 1)], "s", "s")).toBe(false);
    expect(canMergeTabs([tab("s", 1)], "s", "missing")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts`
Expected: FAIL — `mergeTabInto` / `canMergeTabs` are not exported.

- [ ] **Step 3: Implement in persist.ts**

Add right after `saveTabs` (~line 566):

```ts
// --- merge tabs (inverse of cell detach) --------------------------------------

// Layout kind implied by a cell count — merging re-derives the shape and drops
// any custom sizes (the standard rule when the layout kind changes).
const KIND_FOR_COUNT: Record<number, LayoutKind> = { 1: "1", 2: "2h", 3: "3", 4: "4" };

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
): ChartTab[] | null {
  if (!canMergeTabs(tabs, sourceId, targetId)) return null;
  const src = tabs.find((t) => t.id === sourceId)!;
  const dst = tabs.find((t) => t.id === targetId)!;
  const moved: ChartCell[] = src.cells.map((c) => {
    const scope = cellScope(targetId, c.id);
    copyScopeContent(c.scope, scope);
    return { ...c, scope };
  });
  purgeTabScope(sourceId);
  const cells = position === "before" ? [...moved, ...dst.cells] : [...dst.cells, ...moved];
  const { sizes: _sizes, ...dstRest } = dst;
  const merged: ChartTab = {
    ...dstRest,
    cells,
    layout: KIND_FOR_COUNT[cells.length],
    // The merged-in chart is what the user just pulled over — focus it, and
    // link the cells' crosshairs (the point of viewing tabs together).
    activeCellId: src.activeCellId,
    syncCrosshair: true,
  };
  return tabs.filter((t) => t.id !== sourceId).map((t) => (t.id === targetId ? merged : t));
}
```

Note: `cellScope`, `copyScopeContent`, `purgeTabScope`, `ChartCell` are all defined earlier in the same file — no imports needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts`
Expected: PASS (all suites, including pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/persist.ts frontend/src/lib/persist.test.ts
git commit -m "feat(tabs): mergeTabInto — move a tab's cells into another tab (inverse of detach)"
```

---

### Task 2: Context-menu gesture — TabBar menu + MergeTabsMenu checklist

**Files:**
- Create: `frontend/src/MergeTabsMenu.tsx`
- Modify: `frontend/src/TabBar.tsx`
- Modify: `frontend/src/App.tsx` (handler ~after `detachCell` line 1033; TabBar render ~line 1230)
- Modify: `frontend/src/App.css` (after the `.ctxmenu` block, ~line 588)
- Test: `frontend/e2e/merge-tabs.spec.ts` (create)

**Interfaces:**
- Consumes: `mergeTabInto`, `canMergeTabs` from Task 1; existing `ContextMenu` component; `clearAlignAnchor` (already imported in App.tsx from `./lib/chartSync`).
- Produces: App handler `mergeTabs(targetId: string, sourceIds: string[], position?: "before" | "after"): void`; TabBar props `canMerge: (sourceId: string, targetId: string) => boolean` and `onMerge: (targetId: string, sourceIds: string[]) => void` (Tasks 3–4 reuse both); component `MergeTabsMenu({ x, y, tabs, targetId, onMerge, onClose })`.

- [ ] **Step 1: App.tsx — add the `mergeTabs` handler**

Add `mergeTabInto, canMergeTabs` to the existing `./lib/persist` import. Insert after `detachCell` (below line 1033):

```ts
  // Merge whole tabs into `targetId` — the inverse of detachCell. Each source
  // tab's cells move across (content re-scoped by mergeTabInto), the source
  // tabs close, and the merged tab gains crosshair sync. `position` places the
  // incoming cells (drag-onto-chart's left/top half passes "before"). The
  // target becomes the active tab in every gesture.
  const mergeTabs = (
    targetId: string,
    sourceIds: string[],
    position: "before" | "after" = "after",
  ) => {
    let next = tabs;
    for (const srcId of sourceIds) {
      const merged = mergeTabInto(next, srcId, targetId, position);
      if (!merged) continue; // over-cap sources are UI-disabled; skip defensively
      next = merged;
      clearAlignAnchor(srcId); // same leak-guard closeTab applies
    }
    if (next === tabs) return;
    setTabs(next);
    setActiveId(targetId);
  };
```

Then pass the new props where TabBar renders (~line 1230):

```tsx
        canMerge={(s, d) => canMergeTabs(tabs, s, d)}
        onMerge={mergeTabs}
```

- [ ] **Step 2: Create MergeTabsMenu.tsx**

```tsx
// Checklist popover behind the tab context-menu's "Merge into this tab…": lists
// every OTHER tab; ticked tabs merge into the target in tab-bar order. Rows
// whose cells would push the merged tab past 4 are disabled, live — ticking a
// row updates which of the rest still fit. Closes on outside-click / Escape
// (same idiom as ContextMenu).

import { useEffect, useRef, useState } from "react";
import type { ChartTab } from "./lib/persist";
import SymbolIcon from "./SymbolIcon";

interface Props {
  x: number;
  y: number;
  tabs: ChartTab[];
  targetId: string;
  onMerge: (sourceIds: string[]) => void;
  onClose: () => void;
}

export default function MergeTabsMenu({ x, y, tabs, targetId, onMerge, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const target = tabs.find((t) => t.id === targetId);
  if (!target) return null;
  const others = tabs.filter((t) => t.id !== targetId);
  const total =
    target.cells.length +
    others.filter((t) => picked.has(t.id)).reduce((n, t) => n + t.cells.length, 0);

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  return (
    <div
      ref={ref}
      className="ctxmenu merge-menu"
      style={{ left: Math.min(x, window.innerWidth - 260), top: y }}
    >
      <div className="merge-menu-title">Merge into this tab</div>
      {others.map((t) => {
        const lead = t.cells.find((c) => c.id === t.activeCellId) ?? t.cells[0];
        const on = picked.has(t.id);
        const fits = on || total + t.cells.length <= 4;
        return (
          <button
            key={t.id}
            className={`ctx-item merge-row${on ? " on" : ""}`}
            disabled={!fits}
            title={fits ? undefined : "Would exceed 4 charts"}
            onClick={() => toggle(t.id)}
          >
            <span className="ctx-item-label">
              <input type="checkbox" checked={on} readOnly tabIndex={-1} />
              <SymbolIcon epic={lead.symbol.epic} type={lead.symbol.type} className="tab-icon" />
              {lead.symbol.name} · {lead.period.label}
              {t.cells.length > 1 && <span className="tab-count">{t.cells.length}</span>}
            </span>
          </button>
        );
      })}
      <button
        className="ctx-item merge-confirm"
        disabled={picked.size === 0}
        onClick={() => {
          // Merge in tab-bar order, not tick order — predictable cell layout.
          onMerge(others.filter((t) => picked.has(t.id)).map((t) => t.id));
          onClose();
        }}
      >
        Merge
      </button>
    </div>
  );
}
```

Check `Instrument`'s field for `SymbolIcon`'s `type` prop against TabBar.tsx line 135 (`lead.symbol.type`) — copy that usage exactly.

- [ ] **Step 3: TabBar.tsx — context menu + popover wiring**

Add imports and props:

```tsx
import ContextMenu from "./ContextMenu";
import MergeTabsMenu from "./MergeTabsMenu";
```

Extend `Props`:

```ts
  // Merge gestures (see App.mergeTabs). canMerge gates UI affordances by the
  // 4-cell cap; onMerge performs the merge (sources merge in the given order).
  canMerge: (sourceId: string, targetId: string) => boolean;
  onMerge: (targetId: string, sourceIds: string[]) => void;
```

Add state inside the component:

```ts
  // Right-click menu on a chip and the follow-up merge checklist, anchored
  // where the user clicked.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [mergePick, setMergePick] = useState<{ x: number; y: number; tabId: string } | null>(null);
```

On the tab chip `<div>` (next to the existing handlers):

```tsx
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
          }}
```

Before the closing `</div>` of `.tab-bar` (after the trailing block):

```tsx
      {ctxMenu && tabs.length > 1 && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            {
              label: "Merge into this tab…",
              onClick: () => setMergePick(ctxMenu),
            },
          ]}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {mergePick && (
        <MergeTabsMenu
          x={mergePick.x}
          y={mergePick.y}
          tabs={tabs}
          targetId={mergePick.tabId}
          onMerge={(sourceIds) => onMerge(mergePick.tabId, sourceIds)}
          onClose={() => setMergePick(null)}
        />
      )}
```

(When only one tab exists, right-click shows nothing — a one-item disabled menu is noise.)

- [ ] **Step 4: CSS**

Append to `frontend/src/App.css` after the `.ctxmenu` rules (~line 588):

```css
/* Merge-tabs checklist (tab-chip context menu → "Merge into this tab…"). */
.merge-menu { min-width: 220px; }
.merge-menu-title { padding: 5px 10px 7px; font-size: 12px; color: var(--text-faint); }
.merge-menu .merge-row .ctx-item-label { display: flex; align-items: center; gap: 8px; }
.merge-menu .merge-row input[type="checkbox"] { pointer-events: none; margin: 0; }
.merge-menu .merge-confirm { justify-content: center; margin-top: 4px; font-weight: 600; }
```

- [ ] **Step 5: Write the e2e test**

Create `frontend/e2e/merge-tabs.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";
import { stubStateApi } from "./helpers";

// Two one-cell tabs in the device-local scratch workspace (per-broker key —
// same seeding approach as detach-cell.spec.ts), plus a drawing on t2's
// primary scope so the test can assert content moves with the merged cell.
async function seedTwoTabs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("__seeded")) return;
    localStorage.clear();
    const period = { resolution: "HOUR", label: "1H" };
    const tab = (id: string, epic: string) => ({
      id,
      layout: "1",
      activeCellId: `${id}-c0`,
      cells: [
        {
          id: `${id}-c0`,
          symbol: { epic, name: epic, status: null, pricePrecision: 2 },
          period,
          scope: `tab.${id}`,
        },
      ],
    });
    const ws = { tabs: [tab("t1", "US100"), tab("t2", "OIL_CRUDE")], activeTabId: "t1" };
    localStorage.setItem("auto-trader.b.capital.scratch", JSON.stringify(ws));
    localStorage.setItem(
      "auto-trader.tab.t2.drawings.OIL_CRUDE",
      JSON.stringify([{ name: "horizontalStraightLine", points: [{ value: 70 }] }]),
    );
    sessionStorage.setItem("__seeded", "1");
  });
}

test("context-menu merge collapses t2 into t1 with content, focus and crosshair sync", async ({ page }) => {
  await seedTwoTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".tab-bar .tab").first().click({ button: "right" });
  await page.locator(".ctxmenu .ctx-item", { hasText: "Merge into this tab" }).click();
  await page.locator(".merge-menu .merge-row", { hasText: "OIL_CRUDE" }).click();
  await page.locator(".merge-menu .merge-confirm").click();

  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  // Persisted shape: one 2h tab, crosshair-synced, focused on the merged-in
  // cell; t2's drawing re-scoped under t1 and the old scope purged. Poll — the
  // scratch autosave effect commits asynchronously.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ws = JSON.parse(localStorage.getItem("auto-trader.b.capital.scratch") || "null");
        const t = ws?.tabs?.[0];
        return {
          tabCount: ws?.tabs?.length,
          layout: t?.layout,
          sync: t?.syncCrosshair,
          active: t?.activeCellId,
          moved: localStorage.getItem("auto-trader.tab.t1.cell.t2-c0.drawings.OIL_CRUDE") != null,
          purged: localStorage.getItem("auto-trader.tab.t2.drawings.OIL_CRUDE") == null,
        };
      }),
    )
    .toEqual({ tabCount: 1, layout: "2h", sync: true, active: "t2-c0", moved: true, purged: true });

  // Round-trip: detach still splits a merged-in cell back out into its own tab.
  await page.locator(".chart-cell").nth(1).hover();
  await page.locator(".chart-cell").nth(1).locator(".chart-cell-detach").click();
  await expect(page.locator(".tab-bar .tab")).toHaveCount(2);
});
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx playwright test e2e/merge-tabs.spec.ts` (config auto-starts Vite)
Expected: PASS. Also run `npx vitest run` and `npx tsc -b` — both clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/MergeTabsMenu.tsx frontend/src/TabBar.tsx frontend/src/App.tsx frontend/src/App.css frontend/e2e/merge-tabs.spec.ts
git commit -m "feat(tabs): merge tabs via chip context menu — checklist picker, move semantics, crosshair sync on"
```

---

### Task 3: Drop a chip on another chip's center to merge

**Files:**
- Modify: `frontend/src/TabBar.tsx` (drag-zone logic, lines ~59-133)
- Modify: `frontend/src/App.css` (near `.tab.drop-before`, ~line 276)
- Test: `frontend/e2e/merge-tabs.spec.ts` (append)

**Interfaces:**
- Consumes: TabBar's `canMerge` / `onMerge` props from Task 2; existing `dragIdx`/`overIdx`/`overSide` drag state.
- Produces: no new external interfaces — TabBar-internal gesture.

- [ ] **Step 1: Widen the zone type and hover logic**

In TabBar, change the `overSide` state to three zones and compute the zone from the cursor's horizontal fraction — the middle ~40% means merge (only when the dragged tab can merge into this one; otherwise the halves rule as before):

```ts
  type DropZone = "before" | "after" | "merge";
  const [overSide, setOverSide] = useState<DropZone>("before");
```

Replace the body of the chip's `onDragOver`:

```tsx
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const r = e.currentTarget.getBoundingClientRect();
            const frac = (e.clientX - r.left) / r.width;
            // Middle ~40% of the chip = merge drop (when allowed); the outer
            // edges keep meaning reorder, so the gestures don't fight.
            const mergeOk =
              dragIdx !== null && dragIdx !== i && canMerge(tabs[dragIdx].id, t.id);
            const side: DropZone =
              mergeOk && frac >= 0.3 && frac <= 0.7
                ? "merge"
                : frac < 0.5
                  ? "before"
                  : "after";
            if (overIdx !== i) setOverIdx(i);
            if (overSide !== side) setOverSide(side);
          }}
```

Update `onDrop`:

```tsx
          onDrop={(e) => {
            e.preventDefault();
            if (dragIdx !== null) {
              if (overSide === "merge" && dragIdx !== i) {
                onMerge(t.id, [tabs[dragIdx].id]);
              } else {
                const to = overSide === "after" ? i + 1 : i;
                if (to !== dragIdx) onReorder(dragIdx, to);
              }
            }
            endDrag();
          }}
```

And the chip's className ternary gains the merge class:

```ts
            overIdx === i && dragIdx !== i
              ? overSide === "merge"
                ? "drop-merge"
                : overSide === "after"
                  ? "drop-after"
                  : "drop-before"
              : "",
```

- [ ] **Step 2: CSS**

Next to the `.tab.drop-before` rules (~App.css line 276):

```css
/* Whole-chip highlight while hovering a merge drop (center zone of the chip). */
.tab.drop-merge { outline: 2px solid var(--accent); outline-offset: -2px; }
```

- [ ] **Step 3: e2e**

Append to `frontend/e2e/merge-tabs.spec.ts`:

```ts
test("dropping a chip on another chip's center merges the two tabs", async ({ page }) => {
  await seedTwoTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  const tabs = page.locator(".tab-bar .tab");
  const b = (await tabs.nth(0).boundingBox())!;
  // Center of the target chip = merge zone (edges still mean reorder — covered
  // by tab-reorder.spec.ts, which this must not break).
  await tabs.nth(1).dragTo(tabs.nth(0), {
    targetPosition: { x: b.width / 2, y: b.height / 2 },
  });

  await expect(tabs).toHaveCount(1);
  await expect(page.locator(".chart-cell")).toHaveCount(2);
});
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx playwright test e2e/merge-tabs.spec.ts e2e/tab-reorder.spec.ts`
Expected: PASS — merge works AND reorder (edge halves) is unbroken.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/TabBar.tsx frontend/src/App.css frontend/e2e/merge-tabs.spec.ts
git commit -m "feat(tabs): drop a tab chip on another chip's center to merge (edges still reorder)"
```

---

### Task 4: Drag a chip onto the chart to merge into the active tab

**Files:**
- Modify: `frontend/src/TabBar.tsx` (notify drag start/end)
- Modify: `frontend/src/App.tsx` (dragTabId state; ChartGrid props at the render ~line 1336)
- Modify: `frontend/src/ChartGrid.tsx` (merge-drop overlay)
- Modify: `frontend/src/App.css`
- Test: `frontend/e2e/merge-tabs.spec.ts` (append)

**Interfaces:**
- Consumes: `mergeTabs` / `canMergeTabs` (Tasks 1–2).
- Produces: TabBar prop `onDragActive: (tabId: string | null) => void`; ChartGrid props `tabDrag?: { canMerge: boolean } | null` and `onMergeDrop?: (position: "before" | "after") => void`.

- [ ] **Step 1: TabBar — surface the drag lifecycle**

Add prop:

```ts
  // A chip drag started/ended (id or null) — App shows ChartGrid's merge
  // overlay while a chip is in flight.
  onDragActive: (tabId: string | null) => void;
```

Call it in the chip's `onDragStart` (after `setDragIdx(i)`): `onDragActive(t.id);` and inside `endDrag`: `onDragActive(null);` (endDrag already runs on both drop and dragEnd).

- [ ] **Step 2: App — hold the drag state and wire ChartGrid**

```ts
  // Tab chip currently being dragged (chart-drop merge gesture), or null.
  const [dragTabId, setDragTabId] = useState<string | null>(null);
```

TabBar render gains `onDragActive={setDragTabId}`. ChartGrid render (~line 1336, next to `onDetachCell`) gains:

```tsx
              tabDrag={
                dragTabId && active && dragTabId !== active.id
                  ? { canMerge: canMergeTabs(tabs, dragTabId, active.id) }
                  : null
              }
              onMergeDrop={(pos) => {
                if (dragTabId && active) mergeTabs(active.id, [dragTabId], pos);
                setDragTabId(null);
              }}
```

- [ ] **Step 3: ChartGrid — the drop overlay**

Add to `Props`:

```ts
  // A tab chip is being dragged over the app (merge gesture): show a two-half
  // drop overlay. canMerge=false renders a "would exceed" notice instead of
  // droppable halves. Absent/null = no drag in flight.
  tabDrag?: { canMerge: boolean } | null;
  onMergeDrop?: (position: "before" | "after") => void;
```

State + render (inside the component; the `.chart-grid` root is already `position: relative`):

```tsx
  // Which overlay half the chip drag is over (highlight), or null.
  const [mergeHover, setMergeHover] = useState<"before" | "after" | null>(null);
```

Just before `{detachMenu && (`:

```tsx
      {tabDrag && (
        <div
          className="merge-drop"
          // Halves follow the grid's main axis: side-by-side layouts split
          // left/right, stacked ones top/bottom.
          style={{ flexDirection: shape.rows === 1 ? "row" : "column" }}
        >
          {tabDrag.canMerge ? (
            (["before", "after"] as const).map((pos) => (
              <div
                key={pos}
                className={`merge-drop-half${mergeHover === pos ? " over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (mergeHover !== pos) setMergeHover(pos);
                }}
                onDragLeave={() => setMergeHover((h) => (h === pos ? null : h))}
                onDrop={(e) => {
                  e.preventDefault();
                  setMergeHover(null);
                  onMergeDrop?.(pos);
                }}
              />
            ))
          ) : (
            <div className="merge-drop-blocked">Would exceed 4 charts</div>
          )}
        </div>
      )}
```

- [ ] **Step 4: CSS**

Append to App.css (after the merge-menu block from Task 2):

```css
/* Chip-onto-chart merge overlay: two droppable halves over the grid. Above the
   resize strips and corner controls, below modals. */
.merge-drop { position: absolute; inset: 0; z-index: 60; display: flex; }
.merge-drop-half { flex: 1; }
.merge-drop-half.over {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.merge-drop-blocked {
  margin: auto; padding: 6px 12px; font-size: 13px; color: var(--text-faint);
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
}
```

- [ ] **Step 5: e2e**

Append to `frontend/e2e/merge-tabs.spec.ts`:

```ts
test("dragging a chip onto the chart merges it into the active tab", async ({ page }) => {
  await seedTwoTabs(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // t1 is active; drag t2's chip onto the chart. Drop on the right half →
  // incoming cell lands after the existing one.
  const grid = page.locator(".chart-grid");
  const g = (await grid.boundingBox())!;
  await page.locator(".tab-bar .tab").nth(1).dragTo(grid, {
    targetPosition: { x: g.width * 0.75, y: g.height / 2 },
  });

  await expect(page.locator(".tab-bar .tab")).toHaveCount(1);
  await expect(page.locator(".chart-cell")).toHaveCount(2);
  // Order: existing t1 cell first (drop was "after").
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ws = JSON.parse(localStorage.getItem("auto-trader.b.capital.scratch") || "null");
        return ws?.tabs?.[0]?.cells?.map((c: { id: string }) => c.id);
      }),
    )
    .toEqual(["t1-c0", "t2-c0"]);
});
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx playwright test e2e/merge-tabs.spec.ts && npx vitest run && npx tsc -b`
Expected: all PASS / clean. If the `dragTo` never shows the overlay (dragstart→overlay race), fall back to manual `page.dispatchEvent` HTML5 drag events — but try `dragTo` first; it drives the same HTML5 handlers tab-reorder.spec.ts exercises.

- [ ] **Step 7: Full regression + commit**

Run: `cd frontend && npx playwright test`
Expected: full e2e suite PASS (notably `tab-reorder`, `detach-cell`, `split-layout`, `resize-cells`).

```bash
git add frontend/src/TabBar.tsx frontend/src/App.tsx frontend/src/ChartGrid.tsx frontend/src/App.css frontend/e2e/merge-tabs.spec.ts
git commit -m "feat(tabs): drag a tab chip onto the chart to merge into the active tab (half-zone insert order)"
```

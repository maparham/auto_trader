# Cell Detach + Draggable Cell Borders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) A detach handle on each multi-cell chart cell that opens that chart as a new one-cell tab (in-app by default; right-click menu offers "in new browser tab"). (2) Draggable borders between adjacent cells to resize them, persisted per tab.

**Architecture:** Both features ride existing machinery. Detach reuses `copyScopeContent` (currently private in `frontend/src/lib/persist.ts`) to clone the cell's drawings/indicators into a fresh one-cell tab built like `makeTab`; the browser variant persists the workspace synchronously and opens `?tab=<id>`, which startup resolves. Resize adds an optional `sizes` field (column/row fractions) to `ChartTab`, rendered as CSS grid `fr` values in `ChartGrid.tsx`, with invisible drag strips overlaid on the internal grid lines.

**Tech Stack:** React + TypeScript (Vite), klinecharts (untouched), Vitest unit tests, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-02-cell-detach-and-resize-design.md`

## Global Constraints

- Commit directly to `main` — never create a branch.
- No backward-compat/migration code: `sizes` is optional; absent = equal split. Nothing else.
- UI conventions: no drop-shadows, content-sized menus, dismiss on outside click / Escape, light theme is canonical.
- Frontend dev server is the user's (HMR) — do NOT kill or restart it. Unit tests: `cd frontend && npx vitest run src/lib/persist.test.ts`. E2E: `cd frontend && npx playwright test e2e/<file> --reporter=line`.
- All paths below are relative to the repo root `/Users/mahmoudparham/auto_trader`.

---

### Task 1: persist.ts — `sizes` field, export `copyScopeContent`, clone support

**Files:**
- Modify: `frontend/src/lib/persist.ts` (ChartTab ~line 493, cloneWorkspace ~line 728, copyScopeContent ~line 773)
- Test: `frontend/src/lib/persist.test.ts`

**Interfaces:**
- Produces: `ChartTab.sizes?: { cols: number[]; rows: number[] }`; exported `copyScopeContent(from: string, to: string): void`; `cloneWorkspace` preserves `sizes`.

- [ ] **Step 1: Write the failing tests**

Open `frontend/src/lib/persist.test.ts`, look at how existing `cloneWorkspace` tests build a `Workspace` fixture (they exist — follow the local pattern for localStorage setup/teardown), and add:

```ts
describe("cell sizes + detach support", () => {
  it("cloneWorkspace preserves the tab's sizes fractions", () => {
    let n = 0;
    const ws: Workspace = {
      tabs: [
        {
          id: "t1",
          layout: "2h",
          activeCellId: "t1-c0",
          sizes: { cols: [0.3, 0.7], rows: [1] },
          cells: [
            { id: "t1-c0", symbol: SYM, period: PERIOD, scope: "tab.t1" },
            { id: "c2", symbol: SYM, period: PERIOD, scope: "tab.t1.cell.c2" },
          ],
        },
      ],
      activeTabId: "t1",
    };
    const out = cloneWorkspace(ws, () => `nt${++n}`, () => `nc${++n}`);
    expect(out.tabs[0].sizes).toEqual({ cols: [0.3, 0.7], rows: [1] });
  });

  it("copyScopeContent is exported and copies scope keys", () => {
    localStorage.setItem("auto-trader.tab.src.drawings.EPIC", "[1]");
    copyScopeContent("tab.src", "tab.dst");
    expect(localStorage.getItem("auto-trader.tab.dst.drawings.EPIC")).toBe("[1]");
  });
});
```

(`SYM`/`PERIOD`: reuse whatever symbol/period fixtures the file already defines; if none, inline minimal literals matching the `Instrument`/`Period` types used by neighboring tests. The storage prefix is `auto-trader` — verify against the file's existing key literals and match them.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts`
Expected: FAIL — `copyScopeContent` not exported; `sizes` missing from clone output / type error.

- [ ] **Step 3: Implement**

In `frontend/src/lib/persist.ts`:

a) Add to `ChartTab` (after `locked?: boolean;`):

```ts
  // Per-tab cell-size fractions (column widths / row heights, each summing to 1)
  // set by dragging the borders between cells. Absent = equal split. Reset when
  // the layout kind changes.
  sizes?: { cols: number[]; rows: number[] };
```

b) In `cloneWorkspace`'s returned tab literal, after `locked: t.locked,` add:

```ts
      sizes: t.sizes,
```

c) Change `function copyScopeContent(` to `export function copyScopeContent(` (keep the comment; note in it that App.tsx's detach-cell also uses it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/persist.ts frontend/src/lib/persist.test.ts
git commit -m "feat(chart): ChartTab.sizes fractions + exported copyScopeContent (detach/resize groundwork)"
```

---

### Task 2: Detach handle + context menu in ChartGrid, detachCell in App

**Files:**
- Modify: `frontend/src/ChartGrid.tsx` (button block ~line 116)
- Modify: `frontend/src/App.tsx` (add `detachCell` near `addTab` ~line 967; wire prop at the `<ChartGrid>` call ~line 1246)
- Modify: `frontend/src/App.css` (detach button placement, ~line 133)
- Test: `frontend/e2e/detach-cell.spec.ts` (new)

**Interfaces:**
- Consumes: `copyScopeContent` (Task 1), existing `ContextMenu` component (`frontend/src/ContextMenu.tsx`), `makeTab`-style tab construction, `primaryCellScope` from persist.
- Produces: `ChartGrid` prop `onDetachCell: (cellId: string, target: "tab" | "window") => void`; App function `detachCell(cellId: string, target: "tab" | "window")`.

- [ ] **Step 1: Write the failing e2e test**

Create `frontend/e2e/detach-cell.spec.ts`. Reuse the split + draw + scope-count helpers pattern from `frontend/e2e/split-layout.spec.ts` (read it first — it shows how to split into two cells, wait for both charts' data, focus a cell, draw a horizontal line via the draw sidebar, and count drawings per scope in localStorage):

```ts
import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Detach: a handle next to maximize clones the cell (symbol/period + scope
// content) into a NEW one-cell tab; the original tab/cell is untouched.
test("detach handle opens the cell as a new in-app tab with its drawings", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  // Split into two columns and wait for both cells' data (copy the poll from
  // split-layout.spec.ts verbatim).
  await page.locator(".layout-menu button", { hasText: "Layout" }).click();
  await page.locator(".layout-dropdown li", { hasText: "Two columns" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);
  // ... (data-loaded poll from split-layout.spec.ts)

  // Draw a horizontal line on the SECOND cell (focus + draw-sidebar flow from
  // split-layout.spec.ts).
  // ...

  const tabCount = () => page.locator(".tab-bar .tab").count();
  const before = await tabCount();

  // Hover the second cell to reveal its corner controls, then left-click detach.
  await page.locator(".chart-cell").nth(1).hover();
  await page.locator(".chart-cell").nth(1).locator(".chart-cell-detach").click();

  // A new tab exists and is active, showing ONE cell.
  await expect(page.locator(".tab-bar .tab")).toHaveCount(before + 1);
  await expect(page.locator(".chart-cell")).toHaveCount(1);

  // The new tab's primary scope carries the copied drawing (1 drawing key).
  const dstCount = await page.evaluate(() => {
    const tabsRaw = Object.keys(localStorage).filter((k) =>
      /auto-trader\.tab\.[^.]+\.drawings\./.test(k));
    return tabsRaw.length;
  });
  expect(dstCount).toBeGreaterThanOrEqual(2); // source cell's + the copy

  // Original tab intact: switch back → still 2 cells.
  await page.locator(".tab-bar .tab").first().click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);
});

test("right-clicking the detach handle offers both destinations", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".layout-menu button", { hasText: "Layout" }).click();
  await page.locator(".layout-dropdown li", { hasText: "Two columns" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  await page.locator(".chart-cell").nth(1).hover();
  await page.locator(".chart-cell").nth(1).locator(".chart-cell-detach")
    .click({ button: "right" });
  await expect(page.locator(".ctxmenu .ctx-item", { hasText: "Open in new tab" })).toBeVisible();
  await expect(page.locator(".ctxmenu .ctx-item", { hasText: "Open in new browser tab" })).toBeVisible();
  // Escape dismisses.
  await page.keyboard.press("Escape");
  await expect(page.locator(".ctxmenu")).toHaveCount(0);
});
```

Fill the two `// ...` blocks by copying the working poll/draw code from `split-layout.spec.ts` — do not invent new selectors. Check `.tab-bar .tab` is the real tab selector (grep `frontend/e2e/tabs.spec.ts`); adjust if it differs.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx playwright test e2e/detach-cell.spec.ts --reporter=line`
Expected: FAIL — `.chart-cell-detach` not found.

- [ ] **Step 3: Implement `detachCell` in App.tsx**

Add near `addTab` (~line 967). Note `makeTab` can't be reused directly (it mints its own ids and doesn't copy scope content), so build the tab inline the same way:

```ts
  // Detach a cell into its own NEW one-cell tab: same symbol/interval, and a full
  // copy of the cell's scope content (drawings/indicators/config) into the new
  // tab's primary scope. Alerts are global per instrument — nothing to copy.
  // target "tab" switches this window to the new tab; "window" leaves this window
  // alone and opens the app in a new browser tab focused on it (?tab=<id> — see
  // the startup handling). The source tab/cell is untouched either way.
  const detachCell = (cellId: string, target: "tab" | "window") => {
    if (!active) return;
    const src = active.cells.find((c) => c.id === cellId);
    if (!src) return;
    const id = newTabId();
    const cid = `${id}-c0`;
    const scope = primaryCellScope(id);
    copyScopeContent(src.scope, scope);
    const t: ChartTab = {
      id,
      layout: "1",
      activeCellId: cid,
      cells: [{ id: cid, symbol: src.symbol, period: src.period, scope }],
    };
    const nextTabs = [...tabs, t];
    setTabs(nextTabs);
    if (target === "tab") {
      setActiveId(id);
    } else {
      // The new browser tab resolves its workspace from storage, so the updated
      // tab list must be persisted NOW (synchronously, inside the click gesture —
      // both for popup-blocker friendliness and so the autosave effect's timing
      // doesn't matter, including autosave-off).
      const ws: Workspace = { tabs: nextTabs, activeTabId: "" };
      if (activeLayoutId && layoutName != null) saveLayout(activeLayoutId, layoutName, ws);
      else saveScratch(ws);
      window.open(`${location.pathname}?tab=${encodeURIComponent(id)}`, "_blank");
    }
  };
```

`layoutName` is defined at ~line 726 — it's below this insertion point today, so either place `detachCell` after it or recompute locally with `loadLayouts().find(...)`. Import `copyScopeContent` in the existing persist import block (`primaryCellScope`, `saveLayout`, `saveScratch`, `Workspace` type are already imported or trivially added — check the import list at the top).

Wire the prop at the `<ChartGrid>` call site (~line 1275):

```tsx
              onDetachCell={detachCell}
```

- [ ] **Step 4: Implement the handle + menu in ChartGrid.tsx**

Add to imports:

```tsx
import { useState } from "react";
import ContextMenu from "./ContextMenu";
```

Add to `Props`:

```ts
  // Detach a cell to a new tab ("tab" = in-app, "window" = new browser tab).
  onDetachCell: (cellId: string, target: "tab" | "window") => void;
```

Inside the component add menu state:

```tsx
  // Right-click menu on a detach handle: which cell + where to anchor it.
  const [detachMenu, setDetachMenu] = useState<{ x: number; y: number; cellId: string } | null>(null);
```

Next to the maximize button (inside the same `cells.length > 1 &&` block, BEFORE it so it renders to its left), add:

```tsx
            <button
              type="button"
              className="chart-cell-maximize chart-cell-detach"
              title="Open in new tab (right-click for options)"
              aria-label="Open in new tab"
              onClick={(e) => {
                e.stopPropagation();
                onDetachCell(cell.id, "tab");
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDetachMenu({ x: e.clientX, y: e.clientY, cellId: cell.id });
              }}
            >
              {/* open-in-new: box with an arrow pointing out the top-right */}
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 3H3v10h10V9" />
                <path d="M9 3h4v4" />
                <path d="M13 3L7.5 8.5" />
              </svg>
            </button>
```

At the end of the grid container (after the cells `.map`), render the menu:

```tsx
      {detachMenu && (
        <ContextMenu
          x={detachMenu.x}
          y={detachMenu.y}
          items={[
            { label: "Open in new tab", onClick: () => onDetachCell(detachMenu.cellId, "tab") },
            { label: "Open in new browser tab", onClick: () => onDetachCell(detachMenu.cellId, "window") },
          ]}
          onClose={() => setDetachMenu(null)}
        />
      )}
```

In `frontend/src/App.css`, after the `.chart-cell-maximize:hover` rule (~line 133), add:

```css
/* Detach ("open in new tab") control: shares the maximize button's look, sits
   to its left. Revealed on cell hover via the shared .chart-cell-maximize rule. */
.chart-cell-detach {
  right: 34px;
}
```

(`.chart-cell-detach` also carries `.chart-cell-maximize`, so hover-reveal and styling come for free; only the horizontal offset differs. While a cell is maximized, `cells.length > 1` still holds — the detach button stays available, which is fine.)

- [ ] **Step 5: Run the e2e tests**

Run: `cd frontend && npx playwright test e2e/detach-cell.spec.ts --reporter=line`
Expected: both tests PASS.

- [ ] **Step 6: Run the full existing e2e suite for regressions in split/maximize behavior**

Run: `cd frontend && npx playwright test e2e/split-layout.spec.ts e2e/tabs.spec.ts --reporter=line`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/ChartGrid.tsx frontend/src/App.tsx frontend/src/App.css frontend/e2e/detach-cell.spec.ts
git commit -m "feat(chart): detach handle — open a cell as a new tab (right-click: browser tab)"
```

---

### Task 3: `?tab=` startup activation

**Files:**
- Modify: `frontend/src/App.tsx` (activeId initializer ~line 282)
- Test: `frontend/e2e/detach-cell.spec.ts` (extend)

**Interfaces:**
- Consumes: `startup.ws.tabs` (the resolved workspace).
- Produces: URL `?tab=<tabId>` selects that tab on launch, then is stripped.

- [ ] **Step 1: Write the failing e2e test**

Append to `frontend/e2e/detach-cell.spec.ts`. `seedTwoChartTabs` in `e2e/helpers.ts` seeds two tabs — read its signature first to learn the seeded tab ids (grep its usage in `e2e/tabs.spec.ts` for the pattern):

```ts
test("?tab= startup param activates that tab and is stripped from the URL", async ({ page }) => {
  await seedTwoChartTabs(page /* , per helper signature */);
  await stubStateApi(page);
  await page.goto("/?tab=t2"); // second seeded tab id — match the helper's ids
  await page.locator(".tab-bar").waitFor();
  // Second tab is the active one.
  await expect(page.locator(".tab-bar .tab").nth(1)).toHaveClass(/active/);
  // Param stripped.
  expect(new URL(page.url()).searchParams.get("tab")).toBeNull();
});
```

Verify the active-tab class name against `e2e/tabs.spec.ts` (it asserts tab activation somewhere — reuse its selector).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx playwright test e2e/detach-cell.spec.ts --reporter=line -g "startup param"`
Expected: FAIL — first tab active, or param still present.

- [ ] **Step 3: Implement**

In `frontend/src/App.tsx`, replace the `activeId` initializer (line 282):

```ts
  const [activeId, setActiveId] = useState<string>(() => {
    // Deep-link from "detach to browser tab": ?tab=<id> selects that tab on
    // launch (if it exists in the resolved workspace), then is stripped so a
    // reload behaves normally. Device-local activation only — never persisted.
    const want = new URLSearchParams(location.search).get("tab");
    if (want) {
      history.replaceState(null, "", location.pathname);
      if (startup.ws.tabs.some((t) => t.id === want)) return want;
    }
    return startup.ws.activeTabId;
  });
```

- [ ] **Step 4: Run the e2e test to verify it passes**

Run: `cd frontend && npx playwright test e2e/detach-cell.spec.ts --reporter=line`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/e2e/detach-cell.spec.ts
git commit -m "feat(chart): ?tab= startup param — detach-to-browser-tab lands on the detached chart"
```

---

### Task 4: Resizable cells — sizes-driven grid + drag strips

**Files:**
- Modify: `frontend/src/ChartGrid.tsx` (grid templates + strips)
- Modify: `frontend/src/App.tsx` (`setCellSizes` callback; `setLayout` resets sizes)
- Modify: `frontend/src/App.css` (strip styles; `.chart-grid` position)
- Test: `frontend/e2e/resize-cells.spec.ts` (new)

**Interfaces:**
- Consumes: `ChartTab.sizes` (Task 1).
- Produces: `ChartGrid` props `sizes?: { cols: number[]; rows: number[] }` and `onSizes: (sizes: { cols: number[]; rows: number[] }) => void`; App function `setCellSizes(sizes)`.

- [ ] **Step 1: Write the failing e2e test**

Create `frontend/e2e/resize-cells.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Drag the border between two side-by-side cells: widths change, persist
// across reload, and reset when the layout kind changes.
test("dragging the cell border resizes and persists", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".layout-menu button", { hasText: "Layout" }).click();
  await page.locator(".layout-dropdown li", { hasText: "Two columns" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  const w = async (i: number) =>
    (await page.locator(".chart-cell").nth(i).boundingBox())!.width;
  const before0 = await w(0);

  // Drag the vertical strip 120px to the right.
  const strip = page.locator(".cell-resize-strip.cols");
  await expect(strip).toHaveCount(1);
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  const after0 = await w(0);
  expect(after0).toBeGreaterThan(before0 + 80);

  // Persists across reload.
  await page.reload();
  await page.locator(".tab-bar").waitFor();
  await expect(page.locator(".chart-cell")).toHaveCount(2);
  expect(await w(0)).toBeGreaterThan(before0 + 80);

  // Changing the layout kind resets to equal split.
  await page.locator(".layout-menu button", { hasText: "Layout" }).click();
  await page.locator(".layout-dropdown li", { hasText: "Two rows" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);
  const h0 = (await page.locator(".chart-cell").nth(0).boundingBox())!.height;
  const h1 = (await page.locator(".chart-cell").nth(1).boundingBox())!.height;
  expect(Math.abs(h0 - h1)).toBeLessThan(4);
});
```

("Two rows" — verify the actual dropdown label in `frontend/src/LayoutPicker.tsx`; use its real text.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx playwright test e2e/resize-cells.spec.ts --reporter=line`
Expected: FAIL — `.cell-resize-strip` not found.

- [ ] **Step 3: Implement grid-shape + fractions in ChartGrid.tsx**

Replace the `GRID` constant with a shape table + fraction-derived templates:

```tsx
// Grid shape (column x row counts) per layout kind. Templates are derived from
// per-tab size fractions (equal split when none saved).
const SHAPE: Record<LayoutKind, { cols: number; rows: number }> = {
  "1": { cols: 1, rows: 1 },
  "2h": { cols: 2, rows: 1 },
  "2v": { cols: 1, rows: 2 },
  "3": { cols: 3, rows: 1 },
  "4": { cols: 2, rows: 2 },
};

// Saved fractions if they match this layout's shape, else an equal split.
function fracs(saved: number[] | undefined, count: number): number[] {
  if (saved && saved.length === count && saved.every((f) => f > 0)) return saved;
  return Array(count).fill(1 / count);
}
const template = (f: number[]) => f.map((v) => `${v}fr`).join(" ");
```

Add props:

```ts
  // Per-tab cell-size fractions (see ChartTab.sizes). Undefined = equal split.
  sizes?: { cols: number[]; rows: number[] };
  // Commit new fractions after a border drag.
  onSizes: (sizes: { cols: number[]; rows: number[] }) => void;
```

In the component body, replace the `baseGrid`/`grid` computation:

```tsx
  const shape = SHAPE[layout] ?? SHAPE["1"];
  // Live fractions during a border drag (uncommitted); null when not dragging.
  // Committing to the tab on every mousemove would spam the layout autosave
  // (localStorage + backend mirror), so the drag renders from local state and
  // onSizes fires once on release.
  const [dragSizes, setDragSizes] = useState<{ cols: number[]; rows: number[] } | null>(null);
  const eff = dragSizes ?? sizes;
  const colFracs = fracs(eff?.cols, shape.cols);
  const rowFracs = fracs(eff?.rows, shape.rows);
  const grid = validMaximizedCellId
    ? { columns: "1fr", rows: "1fr" }
    : { columns: template(colFracs), rows: template(rowFracs) };
```

(`validMaximizedCellId` computation stays as is, just moves above this block if needed.)

- [ ] **Step 4: Implement the drag strips in ChartGrid.tsx**

Below the component (same file), add the strip renderer and handlers. Strips live inside the `.chart-grid` container (which becomes `position: relative` in CSS):

```tsx
// One invisible drag strip on an internal grid line. `axis` picks columns vs
// rows; `line` is the 1-based grid-line index (between fracs[line-1] and
// fracs[line]). Drag updates a local copy of the fractions (parent renders
// them live via dragSizes) and commits once on release.
function ResizeStrip({
  axis,
  line,
  colFracs,
  rowFracs,
  onLive,
  onCommit,
}: {
  axis: "cols" | "rows";
  line: number;
  colFracs: number[];
  rowFracs: number[];
  onLive: (s: { cols: number[]; rows: number[] }) => void;
  onCommit: (s: { cols: number[]; rows: number[] }) => void;
}) {
  const MIN = 0.15; // no cell below 15% of the grid
  const f = axis === "cols" ? colFracs : rowFracs;
  // Strip center sits at the cumulative fraction of the preceding tracks.
  const at = f.slice(0, line).reduce((a, b) => a + b, 0) * 100;
  const pos: React.CSSProperties =
    axis === "cols"
      ? { left: `calc(${at}% - 4px)`, top: 0, bottom: 0, width: 8, cursor: "col-resize" }
      : { top: `calc(${at}% - 4px)`, left: 0, right: 0, height: 8, cursor: "row-resize" };
  return (
    <div
      className={`cell-resize-strip ${axis}`}
      style={pos}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const rect = el.parentElement!.getBoundingClientRect();
        const total = axis === "cols" ? rect.width : rect.height;
        const start = axis === "cols" ? e.clientX : e.clientY;
        const f0 = [...f];
        let latest: { cols: number[]; rows: number[] } | null = null;
        const apply = (ev: PointerEvent) => {
          const d = ((axis === "cols" ? ev.clientX : ev.clientY) - start) / total;
          const next = [...f0];
          // Clamp so BOTH neighbors stay >= MIN.
          const dd = Math.max(MIN - f0[line - 1], Math.min(f0[line] - MIN, d));
          next[line - 1] = f0[line - 1] + dd;
          next[line] = f0[line] - dd;
          latest = axis === "cols"
            ? { cols: next, rows: rowFracs }
            : { cols: colFracs, rows: next };
          onLive(latest);
        };
        const up = () => {
          el.removeEventListener("pointermove", apply);
          el.removeEventListener("pointerup", up);
          if (latest) onCommit(latest);
        };
        el.addEventListener("pointermove", apply);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}
```

In `ChartGrid`'s JSX, after the cells `.map` (inside the grid div), render the internal-line strips:

```tsx
      {/* Border-drag strips on internal grid lines (hidden while maximized). */}
      {!validMaximizedCellId &&
        Array.from({ length: shape.cols - 1 }, (_, i) => (
          <ResizeStrip
            key={`c${i + 1}`}
            axis="cols"
            line={i + 1}
            colFracs={colFracs}
            rowFracs={rowFracs}
            onLive={setDragSizes}
            onCommit={(s) => {
              setDragSizes(null);
              onSizes(s);
            }}
          />
        ))}
      {!validMaximizedCellId &&
        Array.from({ length: shape.rows - 1 }, (_, i) => (
          <ResizeStrip
            key={`r${i + 1}`}
            axis="rows"
            line={i + 1}
            colFracs={colFracs}
            rowFracs={rowFracs}
            onLive={setDragSizes}
            onCommit={(s) => {
              setDragSizes(null);
              onSizes(s);
            }}
          />
        ))}
```

In `frontend/src/App.css`:

```css
/* .chart-grid gains position:relative so the resize strips anchor to it. */
```
— extend the existing `.chart-grid` rule (line ~87) to:

```css
.chart-grid { gap: 1px; background: var(--border); position: relative; }

/* Invisible ~8px grab strips over the 1px cell borders. Above the corner
   controls' z-25 so the border is always grabbable. */
.cell-resize-strip {
  position: absolute;
  z-index: 30;
  background: transparent;
  touch-action: none;
}
.cell-resize-strip:hover { background: var(--accent); opacity: 0.25; }
```

- [ ] **Step 5: Wire App.tsx**

Add next to `setLayout`:

```ts
  // Commit new cell-size fractions after a border drag (ChartGrid onSizes).
  const setCellSizes = (sizes: { cols: number[]; rows: number[] }) => {
    if (!active) return;
    setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, sizes } : t)));
  };
```

In `setLayout`'s returned tab literal (~line 859), reset sizes when the kind changes:

```ts
        return { ...t, layout, cells, activeCellId, sizes: layout === t.layout ? t.sizes : undefined };
```

At the `<ChartGrid>` call site add:

```tsx
              sizes={active.sizes}
              onSizes={setCellSizes}
```

- [ ] **Step 6: Run the e2e test**

Run: `cd frontend && npx playwright test e2e/resize-cells.spec.ts --reporter=line`
Expected: PASS.

- [ ] **Step 7: Regression pass on grid-dependent suites**

Run: `cd frontend && npx playwright test e2e/split-layout.spec.ts e2e/detach-cell.spec.ts e2e/tab-drawings.spec.ts --reporter=line`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/ChartGrid.tsx frontend/src/App.tsx frontend/src/App.css frontend/e2e/resize-cells.spec.ts
git commit -m "feat(chart): draggable cell borders — per-tab size fractions, persisted in layouts"
```

---

### Task 5: Full-suite verification + visual check

**Files:** none new.

- [ ] **Step 1: Unit tests**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 2: Full e2e suite**

Run: `cd frontend && npx playwright test --reporter=line`
Expected: PASS (any pre-existing failure must be shown to be pre-existing via `git stash` re-run before ignoring).

- [ ] **Step 3: Visual check in the running app (light theme)**

Using claude-in-chrome (set a document.title on the automation tab; close the tab when done): open the dev app, split a tab, hover a cell → detach button appears left of maximize with the open-in-new glyph; drag a border → smooth live resize; right-click detach → menu. Screenshot for the user.

- [ ] **Step 4: Commit any test-only fixups**

```bash
git add -A && git commit -m "test(chart): detach/resize e2e fixups"
```
(Skip if nothing changed.)

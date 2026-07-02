# Cell Close & Cell Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close one cell of a multi-cell layout via an ✕ corner button (with confirm + layout downgrade), and swap adjacent cells via a two-way-arrow button on their shared border.

**Architecture:** Both features are pure-frontend edits to the existing multi-chart grid. App.tsx gains two handlers (`closeCell`, `swapCells`) that update the active tab's `cells` array through `setTabs`; ChartGrid.tsx renders the new buttons and calls them via two new props. Layout persistence rides the existing tab autosave — no storage changes.

**Tech Stack:** React + TypeScript (Vite), Playwright e2e (the project's test layer for chart UI; there are no unit tests for App/ChartGrid).

**Spec:** `docs/superpowers/specs/2026-07-02-cell-close-and-swap-design.md`

## Global Constraints

- Layout kinds are fixed: `"1" | "2h" | "2v" | "3" | "4"` (`frontend/src/lib/persist.ts:475`). Downgrade mapping on close reuses persist.ts's existing `KIND_FOR_COUNT` (`{1:"1", 2:"2h", 3:"3", 4:"4"}`, line ~572) — export it, do not duplicate it.
- Project style: no drop-shadows; plain, direct UI copy; dismiss-on-outside-click (ConfirmDialog already does this).
- Commit directly to `main` (1-person team; no feature branches).
- e2e specs must call `stubStateApi(page)` (see `frontend/e2e/helpers.ts`) so tests don't hit the real backend state API.
- Dev server: do NOT kill/restart the user's running HMR dev server; Playwright's config manages its own server.

---

### Task 1: Close a cell (✕ corner button + confirm + layout downgrade)

**Files:**
- Modify: `frontend/src/lib/persist.ts` (~line 572 — export `KIND_FOR_COUNT`)
- Modify: `frontend/src/App.tsx` (new `closeCell` next to `detachCell` at ~line 1009; import `KIND_FOR_COUNT`; wire prop at ~line 1365)
- Modify: `frontend/src/ChartGrid.tsx` (new `onCloseCell` prop + ✕ button in the corner controls)
- Test: `frontend/e2e/close-cell.spec.ts` (new)

**Interfaces:**
- Consumes: `requestConfirm(req: ConfirmRequest)` from `lib/signals.ts`; `purgeScope(scope)`, `primaryCellScope(tabId)`, `KIND_FOR_COUNT` from `lib/persist.ts`; ChartGrid's existing `buttonRight(cellId, slot)` offset helper.
- Produces: `closeCell(cellId: string): void` in App; `onCloseCell: (cellId: string) => void` prop on ChartGrid; `.chart-cell-close` button class (used by Task 1's e2e test only — Task 2 does not depend on this task).

- [ ] **Step 1: Write the failing e2e test**

Create `frontend/e2e/close-cell.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Closing one cell of a 2×2: the ✕ corner button asks for confirmation; cancel
// keeps all four cells, confirm removes exactly that cell and downgrades the
// layout kind to three columns ("3"), preserving the order of the survivors.
test("close button removes a cell and downgrades the layout", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".layout-menu button").click();
  await page.locator(".layout-dropdown li", { hasText: "Grid (2×2)" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(4);

  // Active tab state (cell ids + layout kind) from persisted storage — same
  // read pattern as split-layout.spec.ts.
  const tabState = () =>
    page.evaluate(() => {
      const __lid = JSON.parse(localStorage.getItem("auto-trader.activeLayoutId") || "null");
      // seedSingleChartDefault always seeds activeLayoutId="L0", so the named-
      // layout body is the single source here (same read as split-layout.spec).
      const __body = JSON.parse(localStorage.getItem(`auto-trader.layout.${__lid}`) || "null");
      const tabs = __body?.tabs ?? [];
      const active = __body?.activeTabId ?? "";
      const t = tabs.find((tt: { id: string }) => tt.id === active);
      return { ids: t.cells.map((c: { id: string }) => c.id) as string[], layout: t.layout as string };
    });
  const before = await tabState();
  expect(before.ids).toHaveLength(4);

  // Corner controls reveal on cell hover. Close cell #1 (top-right of the 2×2).
  const closeBtn = (i: number) =>
    page.locator(".chart-cell").nth(i).locator(".chart-cell-close");
  await page.locator(".chart-cell").nth(1).hover();
  await closeBtn(1).click();

  // Cancel: nothing changes.
  await page.locator(".confirm-modal button.ghost").click();
  await expect(page.locator(".chart-cell")).toHaveCount(4);

  // Confirm: the cell is gone, layout downgrades to three columns, order kept.
  await page.locator(".chart-cell").nth(1).hover();
  await closeBtn(1).click();
  await page.locator(".confirm-modal button.confirm-danger").click();
  await expect(page.locator(".chart-cell")).toHaveCount(3);
  await expect.poll(async () => (await tabState()).layout).toBe("3");
  const after = await tabState();
  expect(after.ids).toEqual([before.ids[0], before.ids[2], before.ids[3]]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx playwright test e2e/close-cell.spec.ts`
Expected: FAIL — `.chart-cell-close` resolves to 0 elements (button doesn't exist yet).

- [ ] **Step 3: Export `KIND_FOR_COUNT` from persist.ts**

In `frontend/src/lib/persist.ts` (~line 572), change:

```ts
const KIND_FOR_COUNT: Record<number, LayoutKind> = { 1: "1", 2: "2h", 3: "3", 4: "4" };
```

to:

```ts
export const KIND_FOR_COUNT: Record<number, LayoutKind> = { 1: "1", 2: "2h", 3: "3", 4: "4" };
```

- [ ] **Step 4: Add `closeCell` to App.tsx and wire the prop**

Add `KIND_FOR_COUNT` to the existing `lib/persist` import block in `frontend/src/App.tsx` (the one at ~lines 74–78 that already imports `purgeScope`, `primaryCellScope`, `LAYOUT_CELLS`).

Insert the handler right after `detachCell` (which ends ~line 1037):

```ts
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
```

(Note: `purgeScope` runs OUTSIDE the `setTabs` updater — updaters can be invoked twice under StrictMode and shouldn't carry side effects, unlike the pre-existing pattern in `setLayout`.)

Wire it where ChartGrid is rendered (~line 1365, next to `onDetachCell={detachCell}`):

```tsx
              onCloseCell={closeCell}
```

- [ ] **Step 5: Add the ✕ button to ChartGrid.tsx**

In `frontend/src/ChartGrid.tsx`:

Add to `interface Props` (after `onDetachCell`):

```ts
  // Close a cell (removes it from the layout; App confirms + downgrades the kind).
  onCloseCell: (cellId: string) => void;
```

Add `onCloseCell,` to the destructured props (after `onDetachCell,`).

Inside the cell render, after the maximize `<button>` block (ends ~line 267), add a third corner button at slot 2 (left of Detach and Maximize):

```tsx
          {cells.length > 1 && (
            <button
              type="button"
              className="chart-cell-maximize chart-cell-close"
              style={{ right: buttonRight(cell.id, 2) }}
              title="Close chart"
              aria-label="Close chart"
              onClick={(e) => {
                e.stopPropagation();
                onCloseCell(cell.id);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8" />
                <path d="M12 4l-8 8" />
              </svg>
            </button>
          )}
```

No CSS changes: it reuses `.chart-cell-maximize` (position/hover-reveal), and the inline `right` offset comes from `buttonRight`, same as the other two buttons.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npx playwright test e2e/close-cell.spec.ts`
Expected: PASS

- [ ] **Step 7: Sanity-check neighbors + lint**

Run: `cd frontend && npx playwright test e2e/split-layout.spec.ts e2e/resize-cells.spec.ts e2e/detach-cell.spec.ts && npm run lint`
Expected: all PASS (the new button must not shift the existing corner-control offsets or break the layout specs).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/persist.ts frontend/src/App.tsx frontend/src/ChartGrid.tsx frontend/e2e/close-cell.spec.ts
git commit -m "feat(layout): close a cell from a multi-cell layout (✕ corner button, confirm, layout downgrade)"
```

---

### Task 2: Swap adjacent cells (border two-way-arrow buttons)

**Files:**
- Modify: `frontend/src/App.tsx` (new `swapCells` handler; wire prop)
- Modify: `frontend/src/ChartGrid.tsx` (new `onSwapCells` prop + swap buttons rendered next to the ResizeStrips)
- Modify: `frontend/src/App.css` (`.cell-swap` styles, next to `.cell-resize-strip` at ~line 147)
- Test: `frontend/e2e/swap-cells.spec.ts` (new)

**Interfaces:**
- Consumes: ChartGrid's existing `shape` (`{cols, rows}`), `colFracs`/`rowFracs`, `validMaximizedCellId`; cells are laid out row-major by CSS grid auto-placement, so the cell at (row `r`, col `c`) is `cells[r * shape.cols + c]`.
- Produces: `swapCells(idA: string, idB: string): void` in App; `onSwapCells: (idA: string, idB: string) => void` prop on ChartGrid; `.cell-swap.cols` / `.cell-swap.rows` button classes.

- [ ] **Step 1: Write the failing e2e test**

Create `frontend/e2e/swap-cells.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Two-columns layout: the ↔ button on the shared border swaps the two cells'
// positions (identity travels with the cell — the persisted cells array order
// flips, nothing is purged), and the resize strip on that border still drags.
test("border swap button exchanges adjacent cells", async ({ page }) => {
  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();

  await page.locator(".layout-menu button").click();
  await page.locator(".layout-dropdown li", { hasText: "Two columns" }).click();
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  const cellIds = () =>
    page.evaluate(() => {
      const __lid = JSON.parse(localStorage.getItem("auto-trader.activeLayoutId") || "null");
      const __body = JSON.parse(localStorage.getItem(`auto-trader.layout.${__lid}`) || "null");
      const tabs = __body?.tabs ?? [];
      const active = __body?.activeTabId ?? "";
      return tabs
        .find((t: { id: string }) => t.id === active)
        .cells.map((c: { id: string }) => c.id) as string[];
    });
  const before = await cellIds();
  expect(before).toHaveLength(2);

  // One ↔ button on the single vertical border. It reveals on hover but is
  // clickable regardless (opacity doesn't gate actionability).
  const swap = page.locator(".cell-swap.cols");
  await expect(swap).toHaveCount(1);
  await swap.click();

  await expect.poll(cellIds).toEqual([before[1], before[0]]);
  await expect(page.locator(".chart-cell")).toHaveCount(2);

  // A second click swaps back.
  await swap.click();
  await expect.poll(cellIds).toEqual(before);

  // The resize strip underneath still drags (swap button must not eat it).
  const w0 = (await page.locator(".chart-cell").first().boundingBox())!.width;
  const strip = page.locator(".cell-resize-strip.cols");
  const box = (await strip.boundingBox())!;
  // Grab the strip AWAY from its center (the swap button covers the center).
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 40, { steps: 5 });
  await page.mouse.up();
  expect((await page.locator(".chart-cell").first().boundingBox())!.width).toBeGreaterThan(w0 + 80);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx playwright test e2e/swap-cells.spec.ts`
Expected: FAIL — `.cell-swap.cols` resolves to 0 elements.

- [ ] **Step 3: Add `swapCells` to App.tsx and wire the prop**

Insert right after the `closeCell` handler from Task 1:

```ts
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
```

Wire it where ChartGrid is rendered (next to `onCloseCell={closeCell}`):

```tsx
              onSwapCells={swapCells}
```

- [ ] **Step 4: Render swap buttons in ChartGrid.tsx**

Add to `interface Props` (after `onCloseCell`):

```ts
  // Swap two adjacent cells' positions (border ↔/↕ buttons).
  onSwapCells: (idA: string, idB: string) => void;
```

Add `onSwapCells,` to the destructured props.

After the two ResizeStrip blocks (the `Array.from({ length: shape.rows - 1 }, ...)` one ends ~line 333), add — IMPORTANT: after the strips in JSX order, so the CSS sibling reveal (`.cell-resize-strip:hover ~ .cell-swap`) can match:

```tsx
      {/* Border swap buttons: one per adjacent cell pair, centered on the
          shared border SEGMENT (per row for vertical borders, per column for
          horizontal ones — a 2×2 gets four). Clicking swaps the two cells;
          identity travels with the cell, layout kind and track sizes stay put.
          Cells are placed row-major, so (row r, col c) = cells[r*cols + c].
          Hidden while a cell is maximized, same as the strips. Rendered AFTER
          the strips so the sibling-hover reveal in App.css matches. */}
      {!validMaximizedCellId &&
        Array.from({ length: shape.rows }, (_, r) =>
          Array.from({ length: shape.cols - 1 }, (_, i) => {
            const c = i + 1;
            const a = cells[r * shape.cols + c - 1];
            const b = cells[r * shape.cols + c];
            if (!a || !b) return null;
            const left = colFracs.slice(0, c).reduce((s, v) => s + v, 0) * 100;
            const top =
              (rowFracs.slice(0, r).reduce((s, v) => s + v, 0) + rowFracs[r] / 2) * 100;
            return (
              <button
                key={`swap-c${c}-r${r}`}
                type="button"
                className="cell-swap cols"
                style={{ left: `calc(${left}% - 12px)`, top: `calc(${top}% - 12px)` }}
                title="Swap charts"
                aria-label="Swap charts"
                onClick={(e) => {
                  e.stopPropagation();
                  onSwapCells(a.id, b.id);
                }}
              >
                {/* ↔ two-way arrow */}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8h10" />
                  <path d="M6 5L3 8l3 3" />
                  <path d="M10 5l3 3-3 3" />
                </svg>
              </button>
            );
          }),
        )}
      {!validMaximizedCellId &&
        Array.from({ length: shape.rows - 1 }, (_, i) =>
          Array.from({ length: shape.cols }, (_, c) => {
            const r = i + 1;
            const a = cells[(r - 1) * shape.cols + c];
            const b = cells[r * shape.cols + c];
            if (!a || !b) return null;
            const top = rowFracs.slice(0, r).reduce((s, v) => s + v, 0) * 100;
            const left =
              (colFracs.slice(0, c).reduce((s, v) => s + v, 0) + colFracs[c] / 2) * 100;
            return (
              <button
                key={`swap-r${r}-c${c}`}
                type="button"
                className="cell-swap rows"
                style={{ left: `calc(${left}% - 12px)`, top: `calc(${top}% - 12px)` }}
                title="Swap charts"
                aria-label="Swap charts"
                onClick={(e) => {
                  e.stopPropagation();
                  onSwapCells(a.id, b.id);
                }}
              >
                {/* ↕ two-way arrow */}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v10" />
                  <path d="M5 6l3-3 3 3" />
                  <path d="M5 10l3 3 3-3" />
                </svg>
              </button>
            );
          }),
        )}
```

- [ ] **Step 5: Add `.cell-swap` CSS**

In `frontend/src/App.css`, right after the `.cell-resize-strip:hover` rule (~line 153):

```css
/* Swap button centered on the border segment between two adjacent cells.
   Hidden until the pointer reaches the border zone: hovering the grab strip
   reveals the buttons on that border, and the button keeps itself visible
   under its own hover (it sits ABOVE the strip — z 31 vs 30 — so the click
   lands on the swap; the rest of the strip still drags). No drop-shadow. */
.cell-swap {
  position: absolute;
  z-index: 31;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.1s ease, color 0.1s ease, background 0.1s ease;
}
.cell-resize-strip:hover ~ .cell-swap,
.cell-swap:hover {
  opacity: 1;
}
.cell-swap:hover {
  color: var(--text);
  background: var(--surface-2);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npx playwright test e2e/swap-cells.spec.ts`
Expected: PASS

- [ ] **Step 7: Sanity-check neighbors + lint**

Run: `cd frontend && npx playwright test e2e/resize-cells.spec.ts e2e/split-layout.spec.ts e2e/close-cell.spec.ts && npm run lint`
Expected: all PASS (resize strips must still drag with the buttons overlaid).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/App.tsx frontend/src/ChartGrid.tsx frontend/src/App.css frontend/e2e/swap-cells.spec.ts
git commit -m "feat(layout): swap adjacent cells via border ↔/↕ buttons"
```

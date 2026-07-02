# Reorder Bottom (Sub-) Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user reorder the chart's bottom sub-panes (Volume, RSI, MACD, …) via the legend's "more" menu, on-hover ↑/↓ arrow buttons, and drag, with the new order persisting per cell.

**Architecture:** klinecharts 9.8.12 has no pane-move API, so a reorder is done by tearing down the affected panes and recreating them in the new order via the existing `applyIndicator` path. The persisted per-cell indicator instance list (already replayed in order by `hydrateIndicators`) is the saved order, so reordering rewrites that list. Pure ordering math is factored into `src/lib/paneOrder.ts` (unit-tested); the live chart mutation is `reorderSubPanes` in `src/lib/indicators.ts`; all three triggers (menu items, ↑/↓ arrows, drag handle) live in `ChartCore.tsx`/`ChartLegend.tsx` and share the single `reorderPaneByName` handler.

**Tech Stack:** React + TypeScript, klinecharts 9.8.12 / @klinecharts/pro, Vitest (unit), Playwright (e2e).

## Global Constraints

- Work on `main` — do NOT create a feature branch.
- No backward-compat / migration code. No new persistence keys — reuse the existing per-cell `indicators` list (`loadIndicators`/`saveIndicators`).
- The candle pane (`candle_pane`) and internal panes (`INTERNAL_INDICATORS` = the backtest `EQUITY_INDICATOR`) are never reorderable and never valid drop targets.
- A pane is the unit of movement; a pane holding multiple indicators moves as a whole.
- Follow existing patterns; light comments matching the density of the file being edited. Plain, direct copy in UI strings.

---

### Task 1: Pure pane-ordering helpers

**Files:**
- Create: `frontend/src/lib/paneOrder.ts`
- Test: `frontend/src/lib/paneOrder.test.ts`

**Interfaces:**
- Produces:
  - `arrayMove<T>(arr: T[], from: number, to: number): T[]`
  - `planPaneReorder(paneIds: string[], movingPaneId: string, targetIndex: number): { desired: string[]; divIndex: number } | null`
  - `reorderInstanceList(current: IndicatorInstance[], newSubOrderIds: string[]): IndicatorInstance[]`
  - `IndicatorInstance` is imported from `./persist`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/paneOrder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { arrayMove, planPaneReorder, reorderInstanceList } from "./paneOrder";
import type { IndicatorInstance } from "./persist";

describe("arrayMove", () => {
  it("moves an element down", () => {
    expect(arrayMove(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
  it("moves an element up", () => {
    expect(arrayMove(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
  it("returns a copy, does not mutate", () => {
    const src = ["a", "b"];
    const out = arrayMove(src, 0, 1);
    expect(src).toEqual(["a", "b"]);
    expect(out).toEqual(["b", "a"]);
  });
});

describe("planPaneReorder", () => {
  it("plans a move-down and reports the first divergence index", () => {
    const plan = planPaneReorder(["p1", "p2", "p3"], "p1", 2);
    expect(plan).toEqual({ desired: ["p2", "p3", "p1"], divIndex: 0 });
  });
  it("plans a move-down by one (tail starts at the smaller index)", () => {
    const plan = planPaneReorder(["p1", "p2", "p3"], "p2", 2);
    expect(plan).toEqual({ desired: ["p1", "p3", "p2"], divIndex: 1 });
  });
  it("clamps the target into range", () => {
    const plan = planPaneReorder(["p1", "p2", "p3"], "p3", 99);
    expect(plan).toBeNull(); // already last → clamped to same slot → no-op
  });
  it("returns null when the pane is unknown", () => {
    expect(planPaneReorder(["p1", "p2"], "nope", 0)).toBeNull();
  });
  it("returns null on a no-op (target === current)", () => {
    expect(planPaneReorder(["p1", "p2", "p3"], "p2", 1)).toBeNull();
  });
});

describe("reorderInstanceList", () => {
  const inst = (id: string): IndicatorInstance => ({ id, type: id.replace(/#.*/, "") });
  it("reorders sub-pane ids in place, leaving other entries fixed", () => {
    // EMA is a candle-pane overlay (not in the sub-order); VOL/RSI/MACD are sub-panes.
    const current = [inst("VOL"), inst("EMA"), inst("RSI"), inst("MACD")];
    const out = reorderInstanceList(current, ["RSI", "MACD", "VOL"]);
    expect(out.map((i) => i.id)).toEqual(["RSI", "EMA", "MACD", "VOL"]);
  });
  it("keeps the list unchanged when the sub-order matches", () => {
    const current = [inst("VOL"), inst("RSI")];
    const out = reorderInstanceList(current, ["VOL", "RSI"]);
    expect(out.map((i) => i.id)).toEqual(["VOL", "RSI"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/paneOrder.test.ts`
Expected: FAIL — `Cannot find module './paneOrder'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/paneOrder.ts`:

```ts
// Pure ordering math for reordering the chart's bottom sub-panes. Kept side-effect
// free (no klinecharts, no storage) so it is unit-testable; the live-chart mutation
// that consumes it is reorderSubPanes in ./indicators.
import type { IndicatorInstance } from "./persist";

// Move arr[from] to index `to`, returning a NEW array (never mutates the input).
export function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const out = arr.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

// Given the current top-to-bottom order of reorderable pane ids, move `movingPaneId`
// to `targetIndex` (clamped into range). Returns the desired order plus `divIndex` —
// the first index at which desired differs from current, so the caller only rebuilds
// panes from there down. Returns null when the pane is unknown or the move is a no-op.
export function planPaneReorder(
  paneIds: string[],
  movingPaneId: string,
  targetIndex: number,
): { desired: string[]; divIndex: number } | null {
  const from = paneIds.indexOf(movingPaneId);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(paneIds.length - 1, targetIndex));
  if (to === from) return null;
  const desired = arrayMove(paneIds, from, to);
  let divIndex = 0;
  while (divIndex < paneIds.length && paneIds[divIndex] === desired[divIndex]) divIndex++;
  return { desired, divIndex };
}

// Rewrite the persisted instance list so the sub-pane instances appear in
// `newSubOrderIds` order, while every non-sub-pane entry (candle-pane overlays like
// EMA) stays in its original slot. This keeps hydrate replaying sub-panes in the new
// order without disturbing overlays.
export function reorderInstanceList(
  current: IndicatorInstance[],
  newSubOrderIds: string[],
): IndicatorInstance[] {
  const subSet = new Set(newSubOrderIds);
  const byId = new Map(current.map((i) => [i.id, i]));
  let k = 0;
  return current.map((inst) =>
    subSet.has(inst.id) ? byId.get(newSubOrderIds[k++]) ?? inst : inst,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/paneOrder.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/paneOrder.ts frontend/src/lib/paneOrder.test.ts
git commit -m "feat(chart): pure pane-ordering helpers for sub-pane reorder"
```

---

### Task 2: Reorder engine + legend "Move up/down" menu actions

**Files:**
- Modify: `frontend/src/lib/indicators.ts` (extend `applyIndicator`; add `reorderSubPanes`, `subPaneOrder`)
- Modify: `frontend/src/lib/menuIcons.tsx` (add `moveUp` / `moveDown` icons)
- Modify: `frontend/src/ChartCore.tsx` (`reorderPaneByName` handler; add menu items in `indicatorMenuItems`)
- Test: `frontend/e2e/pane-reorder.spec.ts` (menu path + persistence)

**Interfaces:**
- Consumes: `planPaneReorder`, `reorderInstanceList` from `./paneOrder` (Task 1); `applyIndicator`, `IndicatorInstance`.
- Produces:
  - `subPaneOrder(chart: Chart): string[]` — reorderable pane ids, top→bottom.
  - `reorderSubPanes(chart, scope, epic, current, movingPaneId, targetIndex): IndicatorInstance[] | null` — mutates the live chart and returns the new full instance list (or null on no-op).
  - `applyIndicator` gains `opts.height?: number` and `opts.paneId?: string`.

- [ ] **Step 1: Write the failing e2e test**

Create `frontend/e2e/pane-reorder.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";
import { seedSingleChartDefault } from "./helpers";

// The user-defined sub-pane order must be changeable via the legend "more" menu and
// must survive a reload. Backend stubbed empty so hydrate doesn't overwrite storage.

type IndMap = Map<string, Map<string, { name: string }>>;

// The top-to-bottom order of sub-pane indicator names (skip the candle pane).
async function subPaneNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const c = (window as unknown as { __chart?: { getIndicatorByPaneId: () => IndMap } }).__chart;
    if (!c) return [];
    const out: string[] = [];
    for (const [paneId, inds] of c.getIndicatorByPaneId())
      if (paneId !== "candle_pane") for (const ind of inds.values()) out.push(ind.name);
    return out;
  });
}

async function waitForData(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const c = (window as unknown as { __chart?: { getDataList(): unknown[] } }).__chart;
        return c ? c.getDataList().length : 0;
      }),
    { timeout: 20000 })
    .toBeGreaterThan(0);
}

function indicatorMenu(page: Page) {
  const indBtn = page.locator(".menu button", { hasText: "Indicators" });
  const dropdown = page.locator(".menu .dropdown");
  return {
    add: async (code: string) => {
      if (!(await dropdown.isVisible())) await indBtn.click();
      await dropdown.locator("input").fill(code);
      await dropdown
        .locator("li.ind-row", { hasText: new RegExp(`\\(${code}\\)$|^${code}$`) })
        .first()
        .click();
      if (await dropdown.isVisible()) await indBtn.click();
    },
  };
}

// Open the "more" (⋯) menu for the sub-pane legend row whose text starts with `name`.
async function openMoreMenu(page: Page, name: string) {
  const row = page.locator(".sub-pane-legend .cl-row", { hasText: name }).first();
  await row.hover();
  await row.locator("button.cl-icon-svg", { hasText: "" }).last().click();
}

test("reorder sub-panes via the more-menu and persist across reload", async ({ page }) => {
  await page.route("**/api/state", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/state/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await seedSingleChartDefault(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForData(page);

  const m = indicatorMenu(page);
  await m.add("VOL");
  await m.add("RSI");
  await m.add("MACD");

  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "RSI", "MACD"]);

  // Move RSI down one → VOL, MACD, RSI
  await openMoreMenu(page, "RSI");
  await page.locator(".ctxmenu .ctx-item", { hasText: "Move down" }).click();
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "MACD", "RSI"]);

  // Reload → order persists
  await page.reload();
  await page.locator(".tab-bar").waitFor();
  await waitForData(page);
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "MACD", "RSI"]);
});
```

> Note: the context menu renders as `.ctxmenu` with each item a `button.ctx-item` (see `ContextMenu.tsx`), opened from `ChartCore.tsx`'s `<ContextMenu>` usage (~line 4173). The last `button.cl-icon-svg` in a legend row is the ⋯ ("more") button.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx playwright test e2e/pane-reorder.spec.ts`
Expected: FAIL — no "Move down" item in the menu yet (order stays `VOL, RSI, MACD`).

- [ ] **Step 3: Extend `applyIndicator` to accept height + target pane**

In `frontend/src/lib/indicators.ts`, change the `opts` param of `applyIndicator` (around line 176) to add two fields:

```ts
  opts?: {
    rehydrate?: boolean;
    config?: SavedIndicatorConfig; // explicit snapshot (Paste) instead of storage
    // Reorder support: stack this instance into an existing pane (2nd+ indicator of a
    // moved multi-indicator pane), and/or open a fresh sub-pane at a preserved height.
    paneId?: string;
    height?: number;
  },
```

Then replace the `createIndicator` call (lines 216-227) with a version that honors those options:

```ts
  const stack = isOverlay || !!opts?.paneId;
  const paneOptions = opts?.paneId
    ? { id: opts.paneId } // stack into the just-recreated pane of a moved group
    : isOverlay
      ? { id: "candle_pane" }
      : { height: opts?.height ?? SUBPANE_HEIGHT, gap: { top: 0.08, bottom: 0.08 } };
  const paneId = chart.createIndicator(value, stack, paneOptions);
```

- [ ] **Step 4: Add `subPaneOrder` + `reorderSubPanes` to `indicators.ts`**

At the top of `frontend/src/lib/indicators.ts`, add to the klinecharts import and a backtest import:

```ts
import { registerIndicator, getSupportedIndicators, DomPosition } from "klinecharts";
```
```ts
import { EQUITY_INDICATOR } from "./backtest";
import { planPaneReorder, reorderInstanceList } from "./paneOrder";
```

Add near the other module constants (after `SUBPANE_HEIGHT`):

```ts
// Panes the reorder feature must never touch: the candle pane is handled by paneId,
// and the backtest equity curve is app-owned (same set the legend excludes).
const INTERNAL_INDICATORS = new Set<string>([EQUITY_INDICATOR]);

// A reorderable sub-pane captured before teardown: its id, current height, and the
// ordered indicator instances it holds (usually one; a multi-indicator pane moves whole).
interface PaneSnapshot {
  paneId: string;
  height: number;
  insts: IndicatorInstance[];
}

// Enumerate the reorderable bottom panes top-to-bottom (skip candle_pane and panes
// holding only internal indicators), capturing each pane's height + instances.
function reorderablePanes(chart: Chart): PaneSnapshot[] {
  const all = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  const out: PaneSnapshot[] = [];
  for (const [paneId, inds] of all ?? []) {
    if (paneId === "candle_pane") continue;
    const insts: IndicatorInstance[] = [];
    for (const ind of inds.values()) {
      if (!ind?.name || INTERNAL_INDICATORS.has(ind.name)) continue;
      insts.push({ id: ind.name, type: indTypeOf(ind) });
    }
    if (!insts.length) continue; // internal-only pane (e.g. equity) — not reorderable
    const height = Math.round(chart.getSize(paneId, DomPosition.Main)?.height ?? SUBPANE_HEIGHT);
    out.push({ paneId, height, insts });
  }
  return out;
}

// The reorderable sub-pane ids, top-to-bottom. Used by the UI to compute a pane's
// current position (for Move up/down enablement and the drag drop-slot).
export function subPaneOrder(chart: Chart): string[] {
  return reorderablePanes(chart).map((p) => p.paneId);
}

// Reorder the bottom sub-panes so `movingPaneId` lands at `targetIndex`. klinecharts
// has no pane-move API, so we tear down the panes from the first divergence point down
// and recreate them (via applyIndicator, rehydrating each instance's saved config and
// preserving its pane height) in the new order — they re-append below the untouched
// head panes. Returns the new full instance list for the caller to persist, or null on
// a no-op. NOTE: the equity pane, if present, is left in place and may end up above the
// reordered user panes; acceptable for the transient backtest pane.
export function reorderSubPanes(
  chart: Chart,
  scope: string,
  epic: string,
  current: IndicatorInstance[],
  movingPaneId: string,
  targetIndex: number,
): IndicatorInstance[] | null {
  const panes = reorderablePanes(chart);
  const plan = planPaneReorder(panes.map((p) => p.paneId), movingPaneId, targetIndex);
  if (!plan) return null;
  const { desired, divIndex } = plan;
  const byId = new Map(panes.map((p) => [p.paneId, p]));

  // Tear down every reorderable pane from the divergence point down (current order).
  for (const p of panes.slice(divIndex))
    for (const inst of p.insts) chart.removeIndicator(p.paneId, inst.id);

  // Recreate them in desired order; each opens a fresh pane appended at the bottom.
  for (const paneId of desired.slice(divIndex)) {
    const snap = byId.get(paneId);
    if (!snap) continue;
    let newPaneId: string | null = null;
    snap.insts.forEach((inst, i) => {
      const pid = applyIndicator(chart, scope, epic, inst, {
        rehydrate: true,
        ...(i === 0 ? { height: snap.height } : { paneId: newPaneId ?? undefined }),
      });
      if (i === 0) newPaneId = pid;
    });
  }

  const newSubOrderIds = desired.flatMap((pid) => byId.get(pid)?.insts.map((x) => x.id) ?? []);
  return reorderInstanceList(current, newSubOrderIds);
}
```

- [ ] **Step 5: Add `moveUp` / `moveDown` icons**

In `frontend/src/lib/menuIcons.tsx`, add two entries to the `MenuIcons` object (alongside `bringFront`/`sendBack`):

```ts
  moveUp: svg(
    <>
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </>,
  ),
  moveDown: svg(
    <>
      <path d="M12 5v14" />
      <path d="M5 12l7 7 7-7" />
    </>,
  ),
```

(`moveUp` is an up arrow: a vertical line plus an up-chevron; `moveDown` is the mirror.)

- [ ] **Step 6: Add the `reorderPaneByName` handler + menu items in `ChartCore.tsx`**

In `frontend/src/ChartCore.tsx`, add these imports to the existing `./lib/indicators` import block (near line 86-89):

```ts
  reorderSubPanes,
  subPaneOrder,
```

Add the handler just above `indicatorMenuItems` (before line 3928):

```ts
  // Move a sub-pane to a new slot: rebuild panes, persist the new order, and re-resolve
  // the current selection's paneId (recreate mints new paneIds). No-op for candle_pane.
  const reorderPaneByName = useCallback(
    (name: string, targetIndex: number) => {
      const c = chartRef.current;
      if (!c) return;
      const paneId = paneIdOf(name);
      if (paneId === "candle_pane") return;
      const next = reorderSubPanes(
        c,
        scope,
        epicRef.current,
        controller.indicators.value,
        paneId,
        targetIndex,
      );
      if (!next) return;
      controller.indicators.set(next);
      saveIndicators(scope, next);
      const sel = selectedIndicator.value;
      if (sel) selectedIndicator.set({ paneId: paneIdOf(sel.name), name: sel.name });
      redrawRef.current();
    },
    [paneIdOf, scope, controller, selectedIndicator],
  );
```

In `indicatorMenuItems` (line 3928), after computing `visible`, build optional move items and splice them into the returned array:

```ts
      const order = paneId === "candle_pane" ? [] : subPaneOrder(chartRef.current!);
      const idx = order.indexOf(paneId);
      const moveItems: MenuItem[] =
        idx < 0 || order.length < 2
          ? []
          : [
              ...(idx > 0
                ? [{ label: "Move up", icon: MenuIcons.moveUp, onClick: () => reorderPaneByName(name, idx - 1) }]
                : []),
              ...(idx < order.length - 1
                ? [{ label: "Move down", icon: MenuIcons.moveDown, onClick: () => reorderPaneByName(name, idx + 1) }]
                : []),
            ];
      return [
        {
          label: "Settings",
          icon: MenuIcons.settings,
          onClick: () => indicatorSettingsRequest.set({ paneId, name }),
        },
        { label: "Copy", icon: MenuIcons.copy, onClick: () => copyIndicator(paneId, name) },
        {
          label: visible ? "Hide" : "Show",
          icon: visible ? MenuIcons.hide : MenuIcons.show,
          onClick: () => toggleVisibleOn(paneId, name),
        },
        ...moveItems,
        { label: "Remove", icon: MenuIcons.remove, danger: true, onClick: () => removeOn(paneId, name) },
      ];
```

Add `reorderPaneByName` to the `indicatorMenuItems` `useCallback` dependency array:

```ts
    [copyIndicator, toggleVisibleOn, removeOn, reorderPaneByName],
```

- [ ] **Step 7: Type-check and run the e2e**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

Run: `cd frontend && npx playwright test e2e/pane-reorder.spec.ts`
Expected: PASS — RSI moves below MACD via the menu and the order survives reload.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/indicators.ts frontend/src/lib/menuIcons.tsx frontend/src/ChartCore.tsx frontend/e2e/pane-reorder.spec.ts
git commit -m "feat(chart): reorder sub-panes via the legend more-menu (Move up/down)"
```

---

### Task 3: Drag-to-reorder + ↑/↓ arrow buttons on the sub-pane legend

**Files:**
- Modify: `frontend/src/ChartLegend.tsx` (drag handle + ↑/↓ arrow buttons on the sub-pane card; `onStartReorder` and `onMove` props threaded through `SubPaneLegend` → `IndicatorRow`)
- Modify: `frontend/src/ChartCore.tsx` (`startPaneReorderDrag` drag session; `paneDropTop` state + drop-indicator div; pass `onStartReorder`+`onMove` to `<ChartLegend>`)
- Modify: `frontend/src/ChartLegend.css` (or the file that styles `.sub-pane-legend`; add `.sp-drag-handle` + `.pane-drop-indicator`)
- Test: `frontend/e2e/pane-reorder.spec.ts` (add an arrow-button case and a drag case)

**Interfaces:**
- Consumes: `subPaneOrder` (Task 2), `reorderPaneByName` (Task 2).
- Produces:
  - Per sub-pane row: on-hover `↑`/`↓` buttons (`.cl-icon.cl-icon-svg`) that move the pane, omitted at the top/bottom ends. They call `onMove(name, targetIndex)` where `onMove === reorderPaneByName`.
  - Per sub-pane card: a `.sp-drag-handle` grip button; a `.pane-drop-indicator` line rendered by ChartCore during a drag.
- Both triggers reuse `reorderPaneByName` from Task 2 — no new engine.

> First: confirm the stylesheet that styles `.sub-pane-legend` / `.chart-legend`. Run `cd frontend && grep -rl "sub-pane-legend" src` — edit that CSS file in the CSS step below.

> Icon convention: the legend's eye/gear/trash are Material-Symbols font glyphs (`ICON_EYE` = `""` etc.), but the ⋯ "more" button uses an **inline SVG** in a `.cl-icon.cl-icon-svg` button because the font subset lacks `more_horiz`. Use inline SVG chevrons for the ↑/↓ arrows too (same `.cl-icon.cl-icon-svg` class), so we don't depend on the font subset. They reveal on hover via the existing `.cl-icons` CSS.

- [ ] **Step 1: Write the failing e2e cases (arrow + drag)**

Append both tests to `frontend/e2e/pane-reorder.spec.ts`. Add this helper near the top of the file (next to `openMoreMenu`):

```ts
// Click the ↑ or ↓ arrow on the sub-pane legend row whose text starts with `name`.
async function clickArrow(page: Page, name: string, dir: "up" | "down") {
  const row = page.locator(".sub-pane-legend .cl-row", { hasText: name }).first();
  await row.hover();
  await row.locator(`button.sp-move-${dir}`).click();
}
```

```ts
test("reorder sub-panes with the ↑/↓ arrow buttons", async ({ page }) => {
  await page.route("**/api/state", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/state/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await seedSingleChartDefault(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForData(page);

  const m = indicatorMenu(page);
  await m.add("VOL");
  await m.add("RSI");
  await m.add("MACD");
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "RSI", "MACD"]);

  // MACD up one → VOL, MACD, RSI
  await clickArrow(page, "MACD", "up");
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "MACD", "RSI"]);

  // The top pane has no ↑ arrow; the bottom pane has no ↓ arrow.
  const volRow = page.locator(".sub-pane-legend .cl-row", { hasText: "VOL" }).first();
  await volRow.hover();
  await expect(volRow.locator("button.sp-move-up")).toHaveCount(0);
  const rsiRow = page.locator(".sub-pane-legend .cl-row", { hasText: "RSI" }).first();
  await rsiRow.hover();
  await expect(rsiRow.locator("button.sp-move-down")).toHaveCount(0);
});

test("reorder sub-panes by dragging the legend handle", async ({ page }) => {
  await page.route("**/api/state", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/state/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await seedSingleChartDefault(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await waitForData(page);

  const m = indicatorMenu(page);
  await m.add("VOL");
  await m.add("RSI");
  await expect.poll(() => subPaneNames(page)).toEqual(["VOL", "RSI"]);

  // Drag VOL's handle down past RSI's pane → RSI, VOL
  const volHandle = page
    .locator(".sub-pane-legend", { hasText: "VOL" })
    .locator(".sp-drag-handle");
  const rsiCard = page.locator(".sub-pane-legend", { hasText: "RSI" });
  const from = await volHandle.boundingBox();
  const to = await rsiCard.boundingBox();
  if (!from || !to) throw new Error("missing boxes");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height + 20, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => subPaneNames(page)).toEqual(["RSI", "VOL"]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx playwright test e2e/pane-reorder.spec.ts -g "arrow|dragging"`
Expected: FAIL — `button.sp-move-up`/`button.sp-move-down` and `.sp-drag-handle` don't exist yet.

- [ ] **Step 3: Add the ↑/↓ arrow buttons + drag handle in `ChartLegend.tsx`**

**(a) Arrow icon constants.** Near the other `ICON_*` constants (around line 137-140), add two inline-SVG chevrons:

```tsx
const ICON_ARROW_UP = (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path d="M12 19V6M6 12l6-6 6 6" />
  </svg>
);
const ICON_ARROW_DOWN = (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path d="M12 5v13M6 12l6 6 6-6" />
  </svg>
);
```

**(b) `IndicatorRow` gains optional move handlers.** Add to its props type (after `onOpenMenu`):

```ts
  // Sub-pane reorder arrows. Present only for sub-pane rows; undefined for candle-pane
  // rows (no arrows) and omitted individually at the top/bottom ends.
  onMoveUp?: () => void;
  onMoveDown?: () => void;
```

Add `onMoveUp` and `onMoveDown` to the destructured params. Then render the two buttons as the FIRST children inside the `.cl-icons` span (before the eye button):

```tsx
      <span
        className={`cl-icons${row.visible ? "" : " cl-icons-hidden-eye"}`}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {onMoveUp && (
          <button
            className="cl-icon cl-icon-svg sp-move-up"
            title="Move up"
            onClick={(e) => {
              e.stopPropagation();
              onMoveUp();
            }}
          >
            {ICON_ARROW_UP}
          </button>
        )}
        {onMoveDown && (
          <button
            className="cl-icon cl-icon-svg sp-move-down"
            title="Move down"
            onClick={(e) => {
              e.stopPropagation();
              onMoveDown();
            }}
          >
            {ICON_ARROW_DOWN}
          </button>
        )}
        {/* existing eye / gear / trash / ⋯ buttons follow unchanged */}
```

Leave the existing eye/gear/trash/⋯ buttons exactly as they are, right after these two.

**(c) `SubPaneLegend` gains `index`, `count`, `onMove`, `onStartReorder`.** Add to its props type:

```ts
  index: number; // this pane's position within the reorderable sub-pane list
  count: number; // total reorderable sub-panes
  onMove: (name: string, targetIndex: number) => void;
  onStartReorder: (paneId: string, name: string, clientY: number) => void;
```

Add those four to the destructured params. Render the drag handle as the first child of the card and pass move handlers to each row (arrows omitted at the ends via the `index` guards):

```tsx
  return (
    <div className="chart-legend sub-pane-legend" style={{ top: data.top }}>
      <button
        className="sp-drag-handle"
        title="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onStartReorder(data.paneId, data.rows[0]?.name ?? "", e.clientY);
        }}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
          <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
          <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
        </svg>
      </button>
      {data.rows.map((row) => (
        <IndicatorRow
          key={row.name}
          row={row}
          selected={selectedName === row.name}
          highlighted={highlightedName === row.name}
          figureValuesRef={figureValuesRef}
          setRowHover={setRowHover}
          onSelectRow={onSelectRow}
          onToggleVisible={onToggleVisible}
          onOpenSettings={onOpenSettings}
          onRemove={onRemove}
          onOpenMenu={onOpenMenu}
          onMoveUp={index > 0 ? () => onMove(row.name, index - 1) : undefined}
          onMoveDown={index < count - 1 ? () => onMove(row.name, index + 1) : undefined}
        />
      ))}
    </div>
  );
```

> The reorderable order equals the `subPanes` array order — `buildSubPaneLegends` already skips `candle_pane` and internal panes — so a card's array index IS its reorderable index and `subPanes.length` is the count.

**(d) Thread `onMove` + `onStartReorder` through `<ChartLegend>`.** Add both to `Props` (near line 111):

```ts
  onMove: (name: string, targetIndex: number) => void;
  onStartReorder: (paneId: string, name: string, clientY: number) => void;
```

Add both to the `<ChartLegend>` destructured props, and pass `index`/`count`/`onMove`/`onStartReorder` when mapping the sub-pane cards (line 361-375):

```tsx
    {subPanes.map((sp, i) => (
      <SubPaneLegend
        key={sp.paneId}
        data={sp}
        index={i}
        count={subPanes.length}
        selectedName={selectedName}
        highlightedName={highlightedName}
        figureValuesRef={figureValuesRef}
        setRowHover={setRowHover}
        onSelectRow={onSelectRow}
        onToggleVisible={onToggleVisible}
        onOpenSettings={onOpenSettings}
        onRemove={onRemove}
        onOpenMenu={onOpenMenu}
        onMove={onMove}
        onStartReorder={onStartReorder}
      />
    ))}
```

The candle-pane `rows.map((row) => <IndicatorRow ... />)` (line 331) stays unchanged — it passes no `onMoveUp`/`onMoveDown`, so candle rows show no arrows.

- [ ] **Step 4: Implement the drag session + wire `onMove` in `ChartCore.tsx`**

Add state near the other legend state (search for `subPaneLegends` around line 817):

```ts
  const [paneDropTop, setPaneDropTop] = useState<number | null>(null);
```

Add the drag handler after `reorderPaneByName` (Task 2):

```ts
  // Drag a sub-pane by its legend handle: track the pointer against each reorderable
  // pane's vertical band, show a drop-indicator line, and on release move the pane to
  // the hovered slot. Rebuild happens via reorderPaneByName (shared with the menu).
  const startPaneReorderDrag = useCallback(
    (paneId: string, name: string, _clientY: number) => {
      const c = chartRef.current;
      const wrap = wrapRef.current;
      if (!c || !wrap) return;
      const order = subPaneOrder(c);
      if (order.length < 2 || order.indexOf(paneId) < 0) return;
      const rootTop = wrap.getBoundingClientRect().top;
      const bounds = order.map((pid) => {
        const s = c.getSize(pid, DomPosition.Main);
        const top = s?.top ?? 0;
        return { top, bottom: top + (s?.height ?? 0) };
      });
      const from = order.indexOf(paneId);
      let target = from;
      const move = (ev: PointerEvent) => {
        const y = ev.clientY - rootTop;
        let t = 0;
        for (const b of bounds) {
          if ((b.top + b.bottom) / 2 < y) t++;
          else break;
        }
        target = Math.max(0, Math.min(order.length - 1, t));
        const last = bounds[bounds.length - 1];
        setPaneDropTop(target >= bounds.length ? last.bottom : bounds[target].top);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setPaneDropTop(null);
        if (target !== from) reorderPaneByName(name, target);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [reorderPaneByName],
  );
```

Pass both props to `<ChartLegend>` (find the `<ChartLegend` usage, it has `onOpenMenu={onLegendOpenMenu}` around line 4139) by adding:

```tsx
        onMove={reorderPaneByName}
        onStartReorder={startPaneReorderDrag}
```

(`reorderPaneByName` is the Task 2 handler; its signature `(name, targetIndex) => void` already matches `onMove`.)

Render the drop indicator. Near the other absolutely-positioned chart chrome inside the outer `chart-wrap` div (e.g. just after `<div ref={containerRef} .../>` around line 4010-4014), add:

```tsx
      {paneDropTop != null && (
        <div className="pane-drop-indicator" style={{ top: paneDropTop }} />
      )}
```

- [ ] **Step 5: Add CSS for the handle + drop indicator**

In the stylesheet that styles `.sub-pane-legend` (from the grep above), add:

```css
.sp-drag-handle {
  display: inline-flex;
  align-items: center;
  padding: 0 2px;
  margin-right: 2px;
  border: none;
  background: none;
  color: var(--legend-muted, #9598a1);
  cursor: grab;
  opacity: 0;
}
.sub-pane-legend:hover .sp-drag-handle { opacity: 1; }
.sp-drag-handle:active { cursor: grabbing; }

.pane-drop-indicator {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--tv-accent, #2962ff);
  pointer-events: none;
  z-index: 20;
}
```

> If `.sub-pane-legend` uses a fixed color for muted text, match the file's existing variable/hex instead of the fallbacks above.

- [ ] **Step 6: Type-check and run the full spec**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

Run: `cd frontend && npx playwright test e2e/pane-reorder.spec.ts`
Expected: PASS — both the menu case and the drag case are green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/ChartLegend.tsx frontend/src/ChartCore.tsx frontend/src/ChartLegend.css frontend/e2e/pane-reorder.spec.ts
git commit -m "feat(chart): reorder sub-panes via legend ↑/↓ arrows + drag handle"
```

> Adjust the CSS path in `git add` to whichever stylesheet you edited.

---

## Final verification

- [ ] Run the unit suite: `cd frontend && npx vitest run` — all green.
- [ ] Run the reorder e2e: `cd frontend && npx playwright test e2e/pane-reorder.spec.ts` — all green.
- [ ] Type-check: `cd frontend && npx tsc -b` — clean.
- [ ] Manual smoke (optional, do not kill the user's dev server): with VOL+RSI+MACD added, reorder via menu and via drag; reload and confirm order persists; confirm overlays on the candle pane are unaffected.

## Notes / accepted corner cases

- **Multi-indicator sub-pane:** currently every sub-pane holds exactly one indicator (each `createIndicator` mints its own pane). `reorderSubPanes` still handles a multi-indicator pane as a unit (recreating the 2nd+ via `opts.paneId`), so it is future-proof.
- **Equity/internal pane:** filtered out of the reorderable set and never a drop target; if present it may end up above the reordered user panes after a move. Acceptable for the transient backtest pane; out of scope to preserve its interleaving.
- **Pane heights:** preserved by capturing `getSize().height` before teardown and passing it to `applyIndicator`.
- **Selection:** re-resolved to the recreated pane by name after a reorder.

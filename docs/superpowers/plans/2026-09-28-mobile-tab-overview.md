# Mobile Tab Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pull-down overview on mobile that shows every tab of the mirrored layout as wrapped chips, and lets mobile add, close (with undo), reorder and re-symbol tabs, writing the shared saved layout.

**Architecture:** One writer module (`mobile/mobileLayoutEdit.ts`) loads the chosen layout body, applies one change and calls `saveLayout`, then bumps `mobileWorkspaceVersion`. Desktop picks the change up through its existing backend push path. The UI is a panel component (`MobileTabOverview.tsx`) driven by a small gesture hook (`useHoldDrag.ts`), opened from a grab bar under the existing strip.

**Tech Stack:** React 19 + TypeScript, vitest + @testing-library/react (jsdom), plain CSS in `mobile/mobile.css`.

**Spec:** `docs/superpowers/specs/2026-09-28-mobile-tab-overview-design.md`

## Global Constraints

- UI copy never uses "—" or "--"; split the sentence instead.
- No native `title=` attributes; the `Tooltip` component is the only tooltip (none are needed here).
- Persistent "active" states use a muted fill (`color-mix(in srgb, var(--text) 10%, transparent)`), never solid accent blue.
- Run only the affected test files (`npx vitest run <files>` from `frontend/`), never the whole suite.
- `npx tsc -b` (from `frontend/`) is the typecheck; eslint must stay at zero. Ask the user before running tsc or eslint (high CPU on their laptop); batch them into one ask at the end.
- Stage files by explicit path; never `git stash`, `git clean` or `git restore` (other sessions share the worktree). Commit on the current branch.
- The device-local layout choice must never mirror to the backend.

## Review Focus

1. A backend push (desktop edit) lands while a chip is lifted or dragging: the drag must finish without a crash, keyed by tab id, and an id that vanished is ignored. Test in Task 5.
2. Undo after the user switched layout in between: the tab must return to the layout it was closed from, not the one now shown. Test in Task 2.
3. Closing the tab the phone is currently showing: the chart must move to the neighbour tab, never keep showing a purged scope. Test in Task 5.
4. Reorder while the search filter hides some tabs: hidden tabs keep their slots. Test in Task 5.
5. The chosen mobile layout gets deleted on desktop: mobile falls back to default, then first. Test in Task 1.

---

### Task 1: Device-local layout choice on mobile

**Files:**
- Modify: `frontend/src/mobile/mobileWorkspace.ts`
- Modify: `frontend/src/lib/persist/core.ts:145` (add the key to `DEVICE_LOCAL_FLAT_KEYS`)
- Create: `frontend/src/mobile/mobileWorkspace.test.ts`

**Interfaces:**
- Produces:
  - `MirroredWorkspace` gains `id: string`.
  - `MOBILE_LAYOUT_KEY: string` (= `` `${PREFIX}.mobileLayoutId` ``).
  - `setMobileLayout(id: string): void` saves locally and bumps `mobileWorkspaceVersion`.
  - `mobileLayoutList(): LayoutMeta[]` (the saved layout index).
  - `lastCellByTab: Map<string, number>`, an in-memory record of the cell index last shown on mobile per tab id.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/mobile/mobileWorkspace.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";
import { saveLayout, saveDefaultLayoutId, isDeviceLocalKey, type Workspace } from "../lib/persist";
import {
  mirroredWorkspace,
  setMobileLayout,
  mobileLayoutList,
  mobileWorkspaceVersion,
  MOBILE_LAYOUT_KEY,
} from "./mobileWorkspace";

installMemStorage();
const ws = (epic: string): Workspace =>
  ({
    tabs: [{ id: `t-${epic}`, layout: "1", activeCellId: "c", cells: [{ id: "c", symbol: { epic, name: epic }, period: { resolution: "HOUR", label: "1H" }, scope: `tab.t-${epic}` }] }],
    activeTabId: "",
  }) as unknown as Workspace;

describe("mobile layout choice", () => {
  beforeEach(() => {
    localStorage.clear();
    saveLayout("a", "Main", ws("US100"));
    saveLayout("b", "Swing", ws("GOLD"));
  });

  it("defaults to the desktop default layout, else the first", () => {
    expect(mirroredWorkspace()?.id).toBe("a");
    saveDefaultLayoutId("b");
    expect(mirroredWorkspace()?.id).toBe("b");
  });

  it("a mobile pick wins over the default, and bumps the version", () => {
    saveDefaultLayoutId("a");
    const v = mobileWorkspaceVersion.value;
    setMobileLayout("b");
    expect(mirroredWorkspace()).toMatchObject({ id: "b", name: "Swing" });
    expect(mobileWorkspaceVersion.value).toBe(v + 1);
  });

  it("falls back when the picked layout was deleted", () => {
    setMobileLayout("gone");
    expect(mirroredWorkspace()?.id).toBe("a");
  });

  it("the pick is device-local, never mirrored", () => {
    expect(isDeviceLocalKey(MOBILE_LAYOUT_KEY)).toBe(true);
  });

  it("lists the saved layouts", () => {
    expect(mobileLayoutList().map((l) => l.name)).toEqual(["Main", "Swing"]);
  });
});
```

If `isDeviceLocalKey` is not exported from `lib/persist/core.ts`, export it (it is the function at `core.ts:~180` that reads `DEVICE_LOCAL_FLAT_KEYS`).

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run src/mobile/mobileWorkspace.test.ts`
Expected: FAIL, `setMobileLayout` is not exported.

- [ ] **Step 3: Implement**

In `lib/persist/core.ts`, add `` `${PREFIX}.mobileLayoutId`, `` to the `DEVICE_LOCAL_FLAT_KEYS` set.

Rewrite the top of `mobile/mobileWorkspace.ts`:

```ts
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
```

Keep `FlatCell`, `flattenCells`, `isWorkspaceKey`, `mobileWorkspaceVersion` and `bumpMobileWorkspace` as they are. `bumpMobileWorkspace` is a function declaration, so `setMobileLayout` can call it from above.

In `MobileChartStrip.tsx`, fix the header comment ("Read-only" is no longer true: say "Tapping a chip shows that cell's chart"), and inside `open(f)` add `lastCellByTab.set(mirror.ws.tabs[f.tabIndex].id, mirror.ws.tabs[f.tabIndex].cells.indexOf(f.cell));` and import `lastCellByTab`.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/mobile/mobileWorkspace.test.ts src/mobile/MobileChartStrip.test.tsx src/lib/persist/core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/mobile/mobileWorkspace.ts frontend/src/mobile/mobileWorkspace.test.ts frontend/src/mobile/MobileChartStrip.tsx frontend/src/lib/persist/core.ts
git commit -m "feat(mobile): device-local choice of which layout the phone shows"
```

---

### Task 2: Layout writer for mobile

**Files:**
- Create: `frontend/src/mobile/mobileLayoutEdit.ts`
- Create: `frontend/src/mobile/mobileLayoutEdit.test.ts`

**Interfaces:**
- Consumes: `mirroredWorkspace()`, `bumpMobileWorkspace()` (Task 1), `makeTab`, `newTabId` from `app/workspace.ts`, `saveLayout`, `loadLayout`, `loadLayouts`, `saveDefaultLayoutId`, `purgeTabScope` from `lib/persist`.
- Produces:
  - `UNDO_MS = 4500`
  - `addMobileTab(symbol: Instrument, period: Period): ChartTab`
  - `closeMobileTab(tabId: string): (() => void) | null` (returns the undo function; null when the tab is missing or is the last one)
  - `setMobileTabOrder(ids: string[]): void` (tabs listed in `ids` take that order; ids not in the layout are ignored; tabs missing from `ids` keep their relative order after the listed ones)
  - `setMobileTabSymbol(tabId: string, symbol: Instrument): void` (single-cell tabs only; no-op otherwise)

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/mobile/mobileLayoutEdit.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";
import {
  saveLayout,
  loadLayout,
  loadLayouts,
  loadDefaultLayoutId,
  PREFIX,
  type Workspace,
} from "../lib/persist";
import { setMobileLayout, mobileWorkspaceVersion } from "./mobileWorkspace";
import {
  addMobileTab,
  closeMobileTab,
  setMobileTabOrder,
  setMobileTabSymbol,
  UNDO_MS,
} from "./mobileLayoutEdit";

installMemStorage();
const P = { resolution: "HOUR", label: "1H" } as const;
const tab = (id: string, ...epics: string[]) => ({
  id,
  layout: epics.length > 1 ? "2h" : "1",
  activeCellId: `${id}-c0`,
  cells: epics.map((epic, i) => ({ id: `${id}-c${i}`, symbol: { epic, name: epic }, period: P, scope: i ? `tab.${id}.cell.${id}-c${i}` : `tab.${id}` })),
});
const ws = (...tabs: unknown[]) => ({ tabs, activeTabId: "" }) as unknown as Workspace;
const epics = (id = "a") => loadLayout(id)!.tabs.map((t) => t.cells[0].symbol.epic);

describe("mobileLayoutEdit", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    saveLayout("a", "Main", ws(tab("t1", "US100"), tab("t2", "GOLD"), tab("t3", "EURUSD", "GBPUSD")));
  });
  afterEach(() => vi.useRealTimers());

  it("adds a one-chart tab at the end and bumps the version", () => {
    const v = mobileWorkspaceVersion.value;
    const t = addMobileTab({ epic: "NVDA", name: "NVDA", status: null, pricePrecision: 2 }, P);
    expect(epics()).toEqual(["US100", "GOLD", "EURUSD", "NVDA"]);
    expect(t.cells[0].scope).toBe(`tab.${t.id}`);
    expect(mobileWorkspaceVersion.value).toBeGreaterThan(v);
  });

  it("with no saved layout, adds into a new default layout named Mobile", () => {
    localStorage.clear();
    addMobileTab({ epic: "NVDA", name: "NVDA", status: null, pricePrecision: 2 }, P);
    const [meta] = loadLayouts();
    expect(meta.name).toBe("Mobile");
    expect(loadDefaultLayoutId()).toBe(meta.id);
    expect(loadLayout(meta.id)!.tabs).toHaveLength(1);
  });

  it("sets the tab order, ignoring unknown ids and keeping unlisted tabs after", () => {
    setMobileTabOrder(["t3", "gone", "t1"]);
    expect(epics()).toEqual(["EURUSD", "US100", "GOLD"]);
  });

  it("an unchanged order writes nothing", () => {
    const v = mobileWorkspaceVersion.value;
    setMobileTabOrder(["t1", "t2", "t3"]);
    expect(mobileWorkspaceVersion.value).toBe(v);
  });

  it("changes the symbol of a single-chart tab, keeping its scope", () => {
    setMobileTabSymbol("t2", { epic: "SILVER", name: "SILVER", status: null, pricePrecision: 2 });
    const c = loadLayout("a")!.tabs[1].cells[0];
    expect(c.symbol.epic).toBe("SILVER");
    expect(c.scope).toBe("tab.t2");
    setMobileTabSymbol("t3", { epic: "X", name: "X", status: null, pricePrecision: 2 });
    expect(loadLayout("a")!.tabs[2].cells[0].symbol.epic).toBe("EURUSD");
  });

  it("refuses to close the last tab or a missing one", () => {
    saveLayout("a", "Main", ws(tab("t1", "US100")));
    expect(closeMobileTab("t1")).toBeNull();
    expect(closeMobileTab("nope")).toBeNull();
  });

  it("close removes the tab now and purges its scope only after UNDO_MS", () => {
    localStorage.setItem(`${PREFIX}.tab.t2.drawings`, "[1]");
    closeMobileTab("t2");
    expect(epics()).toEqual(["US100", "EURUSD"]);
    expect(localStorage.getItem(`${PREFIX}.tab.t2.drawings`)).toBe("[1]");
    vi.advanceTimersByTime(UNDO_MS);
    expect(localStorage.getItem(`${PREFIX}.tab.t2.drawings`)).toBeNull();
  });

  it("undo restores the tab at its old index with its content", () => {
    localStorage.setItem(`${PREFIX}.tab.t2.drawings`, "[1]");
    const undo = closeMobileTab("t2")!;
    undo();
    vi.advanceTimersByTime(UNDO_MS);
    expect(epics()).toEqual(["US100", "GOLD", "EURUSD"]);
    expect(localStorage.getItem(`${PREFIX}.tab.t2.drawings`)).toBe("[1]");
  });

  it("undo lands in the layout the tab came from, even after a layout switch", () => {
    saveLayout("b", "Swing", ws(tab("s1", "DE40")));
    const undo = closeMobileTab("t2")!;
    setMobileLayout("b");
    undo();
    expect(epics("a")).toEqual(["US100", "GOLD", "EURUSD"]);
    expect(epics("b")).toEqual(["DE40"]);
  });

  it("a second undo call does nothing", () => {
    const undo = closeMobileTab("t2")!;
    undo();
    undo();
    expect(epics()).toEqual(["US100", "GOLD", "EURUSD"]);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run src/mobile/mobileLayoutEdit.test.ts`
Expected: FAIL, cannot resolve `./mobileLayoutEdit`.

- [ ] **Step 3: Implement**

```ts
// frontend/src/mobile/mobileLayoutEdit.ts
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

export function closeMobileTab(tabId: string): (() => void) | null {
  const m = mirroredWorkspace();
  if (!m) return null;
  const idx = m.ws.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0 || m.ws.tabs.length === 1) return null;
  const tab = m.ws.tabs[idx];
  editLayout(m.id, (ts) => ts.filter((t) => t.id !== tabId));
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    purgeTabScope(tabId);
  }, UNDO_MS);
  return () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    // Back into the layout it came from, even if the phone switched since.
    editLayout(m.id, (ts) => {
      const next = [...ts];
      next.splice(Math.min(idx, next.length), 0, tab);
      return next;
    });
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/mobile/mobileLayoutEdit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/mobile/mobileLayoutEdit.ts frontend/src/mobile/mobileLayoutEdit.test.ts
git commit -m "feat(mobile): layout writer for adding, closing, reordering and re-symbolling tabs"
```

---

### Task 3: Route a symbol-search pick to a callback

The overview's "+" and "Change symbol" both need the existing mobile symbol search, but the pick must go to the overview, not switch the chart.

**Files:**
- Modify: `frontend/src/mobile/mobileChartState.ts` (add the signal)
- Modify: `frontend/src/mobile/MobileModals.tsx:252-262`
- Test: `frontend/src/mobile/MobileModals.test.tsx` (add cases)

**Interfaces:**
- Produces: `symbolPickTarget: Signal<((s: Instrument) => void) | null>` and `requestSymbolPick(fn: (s: Instrument) => void): void` in `mobileChartState.ts`. One-shot: the modal clears it on pick and on close.

- [ ] **Step 1: Write the failing test**

Read the top of `MobileModals.test.tsx` first and reuse its render helper and its `SymbolSearchModal` mock (if it mocks the modal, drive the mock's `onPick`/`onClose`; if not, pick through the real modal's list). Add:

```tsx
describe("symbol pick routing", () => {
  it("a pending pick target gets the symbol instead of the chart", async () => {
    const got: string[] = [];
    mobileSymbol.set(null);
    act(() => requestSymbolPick((s) => got.push(s.epic)));
    // pick "NVDA" through the modal (mock onPick or real list click, per this file's setup)
    await pickSymbol("NVDA");
    expect(got).toEqual(["NVDA"]);
    expect(mobileSymbol.value).toBeNull();
    expect(symbolPickTarget.value).toBeNull();
  });

  it("closing the modal drops the pending target", async () => {
    act(() => requestSymbolPick(() => {}));
    await closeSymbolSearch();
    expect(symbolPickTarget.value).toBeNull();
  });
});
```

`pickSymbol` and `closeSymbolSearch` are small helpers written against this file's existing modal setup.

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run src/mobile/MobileModals.test.tsx`
Expected: FAIL, `requestSymbolPick` is not exported.

- [ ] **Step 3: Implement**

In `mobileChartState.ts`, below `mobileChartScope`:

```ts
// One-shot redirect for the next symbol-search pick: the tab overview's "+"
// and "Change symbol" reuse the shell's symbol search, but the pick belongs
// to them rather than to the chart. MobileModals clears it on pick and close.
export const symbolPickTarget = new Signal<((s: Instrument) => void) | null>(null);
export function requestSymbolPick(fn: (s: Instrument) => void): void {
  symbolPickTarget.set(fn);
  requestSymbolSearch();
}
```

In `MobileModals.tsx`, import `symbolPickTarget` and change the modal:

```tsx
          onPick={(s: Instrument) => {
            const target = symbolPickTarget.value;
            symbolPickTarget.set(null);
            if (target) target(s);
            else setMobileSymbol(s, brokerId);
            setSymModalOpen(false);
          }}
          onClose={() => {
            symbolPickTarget.set(null);
            setSymModalOpen(false);
          }}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/mobile/MobileModals.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/mobile/mobileChartState.ts frontend/src/mobile/MobileModals.tsx frontend/src/mobile/MobileModals.test.tsx
git commit -m "feat(mobile): let a caller take the next symbol-search pick"
```

---

### Task 4: Hold-and-drag gesture hook

**Files:**
- Create: `frontend/src/mobile/useHoldDrag.ts`
- Create: `frontend/src/mobile/useHoldDrag.test.tsx`

**Interfaces:**
- Produces:

```ts
export const HOLD_MS = 350;
export const SLOP_PX = 8;
export interface HoldDragHandlers {
  onTap(id: string): void;
  onHold(id: string): void;              // held, released without moving
  onOver(id: string, overId: string): void; // dragging over another item
  onDrop(id: string): void;              // drag finished
}
export function useHoldDrag(h: HoldDragHandlers): {
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  liftedId: string | null;   // held (before or during a drag)
  draggingId: string | null; // moved after the hold
};
```

Items mark themselves with `data-drag-id={id}`; the hook finds the item under the finger with `document.elementFromPoint(x, y)?.closest("[data-drag-id]")`.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/mobile/useHoldDrag.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import { useHoldDrag, HOLD_MS } from "./useHoldDrag";

function List(props: { h: Parameters<typeof useHoldDrag>[0] }) {
  const { onPointerDown, draggingId } = useHoldDrag(props.h);
  return (
    <div>
      {["a", "b"].map((id) => (
        <div key={id} data-drag-id={id} data-testid={id} data-dragging={draggingId === id}
             onPointerDown={(e) => onPointerDown(e, id)} />
      ))}
    </div>
  );
}

describe("useHoldDrag", () => {
  let h: { onTap: ReturnType<typeof vi.fn>; onHold: ReturnType<typeof vi.fn>; onOver: ReturnType<typeof vi.fn>; onDrop: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.useFakeTimers();
    h = { onTap: vi.fn(), onHold: vi.fn(), onOver: vi.fn(), onDrop: vi.fn() };
  });
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  const down = (el: HTMLElement, x = 0, y = 0) => fireEvent.pointerDown(el, { clientX: x, clientY: y, pointerId: 1 });
  const move = (x: number, y: number) => fireEvent.pointerMove(window, { clientX: x, clientY: y, pointerId: 1 });
  const up = () => fireEvent.pointerUp(window, { pointerId: 1 });

  it("a quick release is a tap", () => {
    const { getByTestId } = render(<List h={h} />);
    down(getByTestId("a")); up();
    expect(h.onTap).toHaveBeenCalledWith("a");
    expect(h.onHold).not.toHaveBeenCalled();
  });

  it("hold then release without moving is a hold", () => {
    const { getByTestId } = render(<List h={h} />);
    down(getByTestId("a"));
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    up();
    expect(h.onHold).toHaveBeenCalledWith("a");
    expect(h.onTap).not.toHaveBeenCalled();
  });

  it("moving past the slop before the hold cancels everything (a scroll)", () => {
    const { getByTestId } = render(<List h={h} />);
    down(getByTestId("a"));
    move(0, 20);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    up();
    expect(h.onTap).not.toHaveBeenCalled();
    expect(h.onHold).not.toHaveBeenCalled();
  });

  it("hold then drag reports the item under the finger and drops", () => {
    const { getByTestId } = render(<List h={h} />);
    document.elementFromPoint = vi.fn(() => getByTestId("b"));
    down(getByTestId("a"));
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    move(0, 30);
    expect(getByTestId("a").dataset.dragging).toBe("true");
    expect(h.onOver).toHaveBeenCalledWith("a", "b");
    up();
    expect(h.onDrop).toHaveBeenCalledWith("a");
    expect(h.onHold).not.toHaveBeenCalled();
  });

  it("pointercancel ends the gesture with no callbacks", () => {
    const { getByTestId } = render(<List h={h} />);
    down(getByTestId("a"));
    fireEvent.pointerCancel(window, { pointerId: 1 });
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(h.onTap).not.toHaveBeenCalled();
    expect(h.onHold).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run src/mobile/useHoldDrag.test.tsx`
Expected: FAIL, cannot resolve `./useHoldDrag`.

- [ ] **Step 3: Implement**

```ts
// frontend/src/mobile/useHoldDrag.ts
// Touch gesture for the tab overview: a quick tap selects, holding lifts the
// item, then dragging reorders and releasing without moving opens its menu.
// Moving past SLOP_PX before the hold fires hands the gesture to native
// scrolling, so the overview still scrolls under a finger that lands on a chip.
import { useEffect, useRef, useState } from "react";

export const HOLD_MS = 350;
export const SLOP_PX = 8;

export interface HoldDragHandlers {
  onTap(id: string): void;
  onHold(id: string): void;
  onOver(id: string, overId: string): void;
  onDrop(id: string): void;
}

// Once an item is lifted, page scrolling must not steal the drag.
let touchLock = false;
if (typeof document !== "undefined") {
  document.addEventListener("touchmove", (e) => { if (touchLock) e.preventDefault(); }, { passive: false });
}

export function useHoldDrag(h: HoldDragHandlers) {
  const hRef = useRef(h);
  hRef.current = h;
  const [liftedId, setLiftedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button > 0) return;
    cleanupRef.current?.();
    const sx = e.clientX;
    const sy = e.clientY;
    let lifted = false;
    let dragging = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      lifted = true;
      touchLock = true;
      setLiftedId(id);
    }, HOLD_MS);

    const move = (ev: PointerEvent) => {
      const dist = Math.hypot(ev.clientX - sx, ev.clientY - sy);
      if (!lifted) {
        if (dist > SLOP_PX) { cancelled = true; clearTimeout(timer); }
        return;
      }
      if (!dragging) {
        if (dist < 4) return;
        dragging = true;
        setDraggingId(id);
      }
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-drag-id]");
      const overId = over?.dataset.dragId;
      if (overId && overId !== id) hRef.current.onOver(id, overId);
    };
    const finish = (fire: boolean) => {
      clearTimeout(timer);
      touchLock = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      cleanupRef.current = null;
      setLiftedId(null);
      setDraggingId(null);
      if (!fire) return;
      if (dragging) hRef.current.onDrop(id);
      else if (lifted) hRef.current.onHold(id);
      else if (!cancelled) hRef.current.onTap(id);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    cleanupRef.current = () => finish(false);
  };

  return { onPointerDown, liftedId, draggingId };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/mobile/useHoldDrag.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/mobile/useHoldDrag.ts frontend/src/mobile/useHoldDrag.test.tsx
git commit -m "feat(mobile): hold, drag and tap gesture hook for the tab overview"
```

---

### Task 5: The tab overview panel

**Files:**
- Create: `frontend/src/mobile/MobileTabOverview.tsx`
- Create: `frontend/src/mobile/MobileTabOverview.test.tsx`
- Modify: `frontend/src/mobile/mobile.css` (append after the `.m-chart-strip-*` rules, ~line 381)

**Interfaces:**
- Consumes: `mirroredWorkspace`, `mobileLayoutList`, `setMobileLayout`, `mobileWorkspaceVersion`, `lastCellByTab` (Task 1); `addMobileTab`, `closeMobileTab`, `setMobileTabOrder`, `setMobileTabSymbol`, `UNDO_MS` (Task 2); `requestSymbolPick`, `setMobileSymbol`, `mobilePeriod`, `mobileChartScope` (Task 3 and existing); `useHoldDrag` (Task 4); `toast` from `lib/notify`; `DEFAULT_PERIOD` from `app/workspace`.
- Produces: `export default function MobileTabOverview(props: { open: boolean; onClose(): void })`, plus `openTab(tab: ChartTab, cellIndex: number): void` exported for reuse.

Behaviour to build (from the spec):
- Header: layout `<select>` (aria-label "Layout", id `m-tab-ov-layout`), search input (aria-label "Find tab", placeholder "Find tab", id `m-tab-ov-find`), "+" button (aria-label "New tab"). Under it a count line: "11 tabs", or "3 of 11 tabs" while filtering.
- Chips: one `<button>` per visible tab with `data-drag-id={tab.id}`, label `"{epic} {period.label}"` of the first cell, plus `<span className="m-tab-ov-more">+N</span>` for split tabs. The chip of the tab now shown (its cell scope matches `mobileChartScope`) gets `.active` and is scrolled into view on open.
- Filter: case-insensitive match on any cell's epic or name. Empty result shows "No tab has that symbol. Tap + to open it in a new tab."
- Tap: `openTab(tab, lastCellByTab.get(tab.id) ?? 0)` then `onClose()`.
- Hold: opens an in-panel menu with "Change symbol" (single-chart tabs only), "Close tab" (disabled when it is the only tab), "Cancel".
- Drag: `onOver(id, overId)` reorders a local preview order (visible ids only); `onDrop` commits with `setMobileTabOrder(fullOrder)`, where visible tabs refill the slots they held in the full list so hidden tabs keep their places. Ids that no longer exist in the layout are skipped.
- "+": `requestSymbolPick(s => { const t = addMobileTab(s, mobilePeriod.value ?? DEFAULT_PERIOD); openTab(t, 0); onClose(); })`.
- Close: `const undo = closeMobileTab(id)`; if the phone shows that tab, first `openTab` the neighbour (next, else previous). Then `toast("Tab closed. Tap to undo", { onClick: undo, duration: UNDO_MS })`.
- Change symbol: `requestSymbolPick(s => { setMobileTabSymbol(id, s); if shown, setMobileSymbol(s, undefined, tab.cells[0].scope) })`.
- Bottom grip: a `<button className="m-tab-ov-grip" aria-label="Hide tabs">` that calls `onClose` on tap. Dragging it up is wired in Task 6.
- The panel always renders (so it can animate) and gets `.open` from the prop; `aria-hidden={!open}`.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/mobile/MobileTabOverview.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemStorage } from "../lib/testMemStorage";
import { saveLayout, loadLayout, type Workspace } from "../lib/persist";
import MobileTabOverview from "./MobileTabOverview";
import { mobileSymbol, mobilePeriod, mobileChartScope, symbolPickTarget } from "./mobileChartState";
import { bumpMobileWorkspace } from "./mobileWorkspace";
import { HOLD_MS } from "./useHoldDrag";

const toast = vi.fn();
vi.mock("../lib/notify", () => ({ toast: (...a: unknown[]) => toast(...a) }));

installMemStorage();
afterEach(cleanup);
const P = { resolution: "HOUR", label: "1H" };
const tab = (id: string, ...epics: string[]) => ({
  id, layout: "1", activeCellId: `${id}-c0`,
  cells: epics.map((epic, i) => ({ id: `${id}-c${i}`, symbol: { epic, name: epic }, period: P, scope: i ? `tab.${id}.cell.${id}-c${i}` : `tab.${id}` })),
});
const seed = () => saveLayout("a", "Main", { tabs: [tab("t1", "US100"), tab("t2", "GOLD"), tab("t3", "EURUSD", "GBPUSD", "USDJPY")], activeTabId: "" } as unknown as Workspace);
const order = () => loadLayout("a")!.tabs.map((t) => t.id);

describe("MobileTabOverview", () => {
  beforeEach(() => {
    localStorage.clear();
    toast.mockReset();
    mobileSymbol.set(null); mobilePeriod.set(null); mobileChartScope.set(null); symbolPickTarget.set(null);
    seed();
  });

  it("renders one chip per tab with a +N count for split tabs", () => {
    render(<MobileTabOverview open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "US100 1H" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "EURUSD 1H +2" })).toBeTruthy();
    expect(screen.getByText("3 tabs")).toBeTruthy();
  });

  it("marks the tab now shown as active", () => {
    mobileChartScope.set({ epic: "GOLD", scope: "tab.t2" });
    render(<MobileTabOverview open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "GOLD 1H" }).classList.contains("active")).toBe(true);
  });

  it("tap opens the tab's chart and closes the overview", async () => {
    const onClose = vi.fn();
    render(<MobileTabOverview open onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "GOLD 1H" }));
    expect(mobileChartScope.value).toEqual({ epic: "GOLD", scope: "tab.t2" });
    expect(onClose).toHaveBeenCalled();
  });

  it("the filter narrows the chips and shows the empty state", async () => {
    render(<MobileTabOverview open onClose={() => {}} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Find tab" }), "gbp");
    expect(screen.getByRole("button", { name: "EURUSD 1H +2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "GOLD 1H" })).toBeNull();
    expect(screen.getByText("1 of 3 tabs")).toBeTruthy();
    await userEvent.clear(screen.getByRole("searchbox", { name: "Find tab" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find tab" }), "zzz");
    expect(screen.getByText(/No tab has that symbol/)).toBeTruthy();
  });

  it("+ routes through symbol search and opens the new tab", async () => {
    mobilePeriod.set({ resolution: "HOUR_4", label: "4H" } as never);
    render(<MobileTabOverview open onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "New tab" }));
    act(() => symbolPickTarget.value!({ epic: "NVDA", name: "NVDA", status: null, pricePrecision: 2 }));
    const tabs = loadLayout("a")!.tabs;
    expect(tabs).toHaveLength(4);
    expect(tabs[3].cells[0].period.label).toBe("4H");
    expect(mobileSymbol.value?.epic).toBe("NVDA");
  });

  describe("hold gestures", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const hold = (el: HTMLElement) => {
      fireEvent.pointerDown(el, { clientX: 0, clientY: 0, pointerId: 1 });
      act(() => { vi.advanceTimersByTime(HOLD_MS); });
    };

    it("closing the shown tab moves the chart to its neighbour and offers undo", () => {
      mobileChartScope.set({ epic: "GOLD", scope: "tab.t2" });
      render(<MobileTabOverview open onClose={() => {}} />);
      hold(screen.getByRole("button", { name: "GOLD 1H" }));
      fireEvent.pointerUp(window, { pointerId: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
      expect(order()).toEqual(["t1", "t3"]);
      expect(mobileChartScope.value?.scope).toBe("tab.t3");
      const [msg, opts] = toast.mock.calls[0] as [string, { onClick(): void }];
      expect(msg).toBe("Tab closed. Tap to undo");
      act(() => opts.onClick());
      expect(order()).toEqual(["t1", "t2", "t3"]);
    });

    it("Change symbol is offered only for single-chart tabs", () => {
      render(<MobileTabOverview open onClose={() => {}} />);
      hold(screen.getByRole("button", { name: "EURUSD 1H +2" }));
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(screen.queryByRole("button", { name: "Change symbol" })).toBeNull();
    });

    it("drag reorders and keeps tabs hidden by the filter in their slots", () => {
      render(<MobileTabOverview open onClose={() => {}} />);
      fireEvent.change(screen.getByRole("searchbox", { name: "Find tab" }), { target: { value: "u" } });
      // visible: US100 (t1), EURUSD (t3); hidden: GOLD (t2)
      const t3 = screen.getByRole("button", { name: "EURUSD 1H +2" });
      document.elementFromPoint = vi.fn(() => screen.getByRole("button", { name: "US100 1H" }));
      hold(t3);
      fireEvent.pointerMove(window, { clientX: 0, clientY: 40, pointerId: 1 });
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(order()).toEqual(["t3", "t2", "t1"]);
    });

    it("a backend push mid-drag that removes the dragged tab is ignored", () => {
      render(<MobileTabOverview open onClose={() => {}} />);
      document.elementFromPoint = vi.fn(() => screen.getByRole("button", { name: "US100 1H" }));
      hold(screen.getByRole("button", { name: "GOLD 1H" }));
      fireEvent.pointerMove(window, { clientX: 0, clientY: 40, pointerId: 1 });
      saveLayout("a", "Main", { tabs: [tab("t1", "US100"), tab("t3", "EURUSD")], activeTabId: "" } as unknown as Workspace);
      act(() => bumpMobileWorkspace());
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(order()).toEqual(["t1", "t3"]);
    });
  });
});
```

The filter-reorder expectation: visible order becomes [t3, t1]; the visible slots in the full list are indexes 0 and 2, so t3 fills slot 0, t2 stays at 1, t1 fills slot 2.

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run src/mobile/MobileTabOverview.test.tsx`
Expected: FAIL, cannot resolve `./MobileTabOverview`.

- [ ] **Step 3: Implement the component**

```tsx
// frontend/src/mobile/MobileTabOverview.tsx
// Pull-down overview of every tab in the mirrored layout (spec:
// 2026-09-28-mobile-tab-overview-design.md). Wrapped chips like the desktop
// tab bar: tap opens a tab, hold opens its menu, hold then drag reorders.
// Every edit goes through mobileLayoutEdit.ts.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChartTab } from "../lib/persist";
import { toast } from "../lib/notify";
import { DEFAULT_PERIOD } from "../app/workspace";
import {
  mirroredWorkspace,
  mobileLayoutList,
  setMobileLayout,
  mobileWorkspaceVersion,
  lastCellByTab,
} from "./mobileWorkspace";
import {
  addMobileTab,
  closeMobileTab,
  setMobileTabOrder,
  setMobileTabSymbol,
  UNDO_MS,
} from "./mobileLayoutEdit";
import {
  mobileChartScope,
  mobilePeriod,
  requestSymbolPick,
  setMobileSymbol,
} from "./mobileChartState";
import { useHoldDrag } from "./useHoldDrag";

export function openTab(tab: ChartTab, cellIndex: number): void {
  const i = Math.min(Math.max(cellIndex, 0), tab.cells.length - 1);
  const cell = tab.cells[i];
  lastCellByTab.set(tab.id, i);
  setMobileSymbol(cell.symbol, undefined, cell.scope);
  mobilePeriod.set(cell.period);
}

const shows = (tab: ChartTab, scope: string | undefined) =>
  !!scope && tab.cells.some((c) => c.scope === scope);

export default function MobileTabOverview({ open, onClose }: { open: boolean; onClose(): void }) {
  useSyncExternalStore(
    (fn) => mobileWorkspaceVersion.subscribe(fn),
    () => mobileWorkspaceVersion.value,
  );
  const scope = useSyncExternalStore(
    (fn) => mobileChartScope.subscribe(fn),
    () => mobileChartScope.value,
  )?.scope;
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const mirror = mirroredWorkspace();
  const all = mirror?.ws.tabs ?? [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const q = query.trim().toUpperCase();
  const visible = all.filter(
    (t) => !q || t.cells.some((c) => c.symbol.epic.toUpperCase().includes(q) || (c.symbol.name ?? "").toUpperCase().includes(q)),
  );
  const shown = (preview ?? visible.map((t) => t.id)).map((id) => byId.get(id)).filter((t): t is ChartTab => !!t);

  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(".m-tab-ov-chip.active");
    if (el && bodyRef.current) bodyRef.current.scrollTop = Math.max(0, el.offsetTop - 10);
  }, [open]);

  const drag = useHoldDrag({
    onTap(id) {
      const t = byId.get(id);
      if (!t) return;
      openTab(t, lastCellByTab.get(id) ?? 0);
      onClose();
    },
    onHold(id) {
      setMenuId(id);
    },
    onOver(id, overId) {
      setPreview((cur) => {
        const ids = cur ?? visible.map((t) => t.id);
        const from = ids.indexOf(id);
        const to = ids.indexOf(overId);
        if (from < 0 || to < 0) return cur;
        const next = [...ids];
        next.splice(from, 1);
        next.splice(to, 0, id);
        return next;
      });
    },
    onDrop(id) {
      const ids = (preview ?? []).filter((x) => byId.has(x));
      setPreview(null);
      if (!byId.has(id) || !ids.length) return;
      // Visible tabs refill the slots they held in the full list; hidden tabs
      // keep theirs.
      const visibleSet = new Set(ids);
      const queue = [...ids];
      setMobileTabOrder(all.map((t) => (visibleSet.has(t.id) ? queue.shift()! : t.id)));
    },
  });

  const addTab = () =>
    requestSymbolPick((s) => {
      const t = addMobileTab(s, mobilePeriod.value ?? DEFAULT_PERIOD);
      setQuery("");
      openTab(t, 0);
      onClose();
    });

  const closeTab = (t: ChartTab) => {
    setMenuId(null);
    if (shows(t, scope)) {
      const i = all.indexOf(t);
      const neighbour = all[i + 1] ?? all[i - 1];
      if (neighbour) openTab(neighbour, 0);
    }
    const undo = closeMobileTab(t.id);
    if (undo) toast("Tab closed. Tap to undo", { onClick: undo, duration: UNDO_MS });
  };

  const changeSymbol = (t: ChartTab) => {
    setMenuId(null);
    requestSymbolPick((s) => {
      setMobileTabSymbol(t.id, s);
      if (shows(t, scope)) setMobileSymbol(s, undefined, t.cells[0].scope);
    });
  };

  const menuTab = menuId ? byId.get(menuId) : undefined;

  return (
    <div className={"m-tab-ov" + (open ? " open" : "")} aria-hidden={!open}>
      <div className="m-tab-ov-head">
        <select
          id="m-tab-ov-layout"
          aria-label="Layout"
          value={mirror?.id ?? ""}
          onChange={(e) => { setQuery(""); setMobileLayout(e.target.value); }}
        >
          {mobileLayoutList().map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <input
          id="m-tab-ov-find"
          type="search"
          aria-label="Find tab"
          placeholder="Find tab"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="m-tab-ov-add" aria-label="New tab" onClick={addTab}>+</button>
      </div>
      <div className="m-tab-ov-count">
        {q ? `${visible.length} of ${all.length} tabs` : `${all.length} tabs`}
      </div>
      <div className="m-tab-ov-body" ref={bodyRef}>
        {shown.length ? (
          <div className="m-tab-ov-chips">
            {shown.map((t) => {
              const c = t.cells[0];
              return (
                <button
                  key={t.id}
                  data-drag-id={t.id}
                  className={
                    "m-tab-ov-chip" +
                    (shows(t, scope) ? " active" : "") +
                    (drag.liftedId === t.id ? " lifted" : "") +
                    (drag.draggingId === t.id ? " dragging" : "")
                  }
                  onPointerDown={(e) => drag.onPointerDown(e, t.id)}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  {c.symbol.epic} {c.period.label}
                  {t.cells.length > 1 && <span className="m-tab-ov-more"> +{t.cells.length - 1}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="m-tab-ov-empty">No tab has that symbol. Tap + to open it in a new tab.</div>
        )}
      </div>
      <button className="m-tab-ov-grip" aria-label="Hide tabs" onClick={onClose}><i /></button>
      {menuTab && (
        <div className="m-tab-ov-scrim" onClick={(e) => { if (e.target === e.currentTarget) setMenuId(null); }}>
          <div className="m-tab-ov-menu" role="menu">
            {menuTab.cells.length === 1 && (
              <button role="menuitem" onClick={() => changeSymbol(menuTab)}>Change symbol</button>
            )}
            <button role="menuitem" className="danger" disabled={all.length === 1} onClick={() => closeTab(menuTab)}>
              Close tab
            </button>
            <button role="menuitem" onClick={() => setMenuId(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

Note on the tap path: a chip is a `<button>`, and `userEvent.click` fires pointerdown then pointerup, so `onTap` runs through the hook. Do not also add an `onClick` to the chip, or a tap fires twice.

Note on accessible names: the "+N" span is inside the button, so the name reads "EURUSD 1H +2", which the tests rely on.

- [ ] **Step 4: Add the styles**

Append to `mobile/mobile.css` after the `.m-chart-strip-empty` rule:

```css
/* Tab overview: pulled down from under the chart strip, covering the chart
   body. Wrapped chips mirror the desktop tab bar. */
.m-tab-ov { position: absolute; inset: 0; z-index: 20; display: flex; flex-direction: column; background: var(--bg); transform: translateY(-100%); transition: transform .24s cubic-bezier(.2,.8,.2,1); }
.m-tab-ov.open { transform: translateY(0); }
@media (prefers-reduced-motion: reduce) { .m-tab-ov { transition: none; } }
.m-tab-ov-head { display: flex; align-items: center; gap: 6px; padding: 8px; }
.m-tab-ov-head select, .m-tab-ov-head input { min-width: 0; font: inherit; font-size: 14px; color: var(--text); background: none; border: 1px solid var(--border); border-radius: 12px; padding: 4px 10px; }
.m-tab-ov-head select { flex: 0 1 auto; max-width: 110px; }
.m-tab-ov-head input { flex: 1; }
.m-tab-ov-add { flex: 0 0 auto; width: 30px; height: 28px; border: 1px solid var(--border); border-radius: 12px; background: none; color: var(--text); font-size: 18px; line-height: 1; }
.m-tab-ov-count { padding: 0 10px 6px; font-size: 11px; color: var(--text-faint); letter-spacing: .04em; text-transform: uppercase; }
.m-tab-ov-body { position: relative; flex: 1; min-height: 0; overflow-y: auto; padding: 2px 8px 12px; touch-action: pan-y; }
.m-tab-ov-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.m-tab-ov-chip { border: 1px solid var(--border); background: none; color: var(--text-dim); border-radius: 12px; padding: 6px 12px; font-size: 13px; white-space: nowrap; touch-action: pan-y; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.m-tab-ov-chip.active { color: var(--text); background: color-mix(in srgb, var(--text) 10%, transparent); }
.m-tab-ov-chip.lifted { transform: scale(1.05); transition: transform .12s; }
.m-tab-ov-chip.dragging { opacity: .6; }
.m-tab-ov-more { color: var(--text-faint); font-size: 11px; }
.m-tab-ov-empty { padding: 16px 4px; font-size: 13px; color: var(--text-faint); }
.m-tab-ov-grip { flex: 0 0 22px; display: flex; align-items: center; justify-content: center; border: 0; border-top: 1px solid var(--border); background: none; touch-action: none; }
.m-tab-ov-grip i, .m-chart-strip-pull i { width: 36px; height: 4px; border-radius: 2px; background: var(--text-faint); }
.m-tab-ov-scrim { position: absolute; inset: 0; display: flex; align-items: flex-end; background: color-mix(in srgb, #000 35%, transparent); }
.m-tab-ov-menu { width: 100%; display: grid; gap: 6px; padding: 12px; background: var(--bg); border-top: 1px solid var(--border); border-radius: 14px 14px 0 0; }
.m-tab-ov-menu button { text-align: left; padding: 10px 12px; font: inherit; color: var(--text); background: none; border: 1px solid var(--border); border-radius: 10px; }
.m-tab-ov-menu button.danger { color: var(--down, #ef5350); }
.m-tab-ov-menu button:disabled { opacity: .4; }
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run src/mobile/MobileTabOverview.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/mobile/MobileTabOverview.tsx frontend/src/mobile/MobileTabOverview.test.tsx frontend/src/mobile/mobile.css
git commit -m "feat(mobile): tab overview with wrapped chips, menu, undo and reorder"
```

---

### Task 6: Pull-down grab bar and mounting

**Files:**
- Modify: `frontend/src/mobile/MobileChartStrip.tsx` (render the grab bar under the chips)
- Modify: `frontend/src/mobile/MobileChartView.tsx:158-160` (own the open state, mount the overview inside `.m-chart-body`)
- Create: `frontend/src/mobile/usePullPanel.ts`
- Test: `frontend/src/mobile/MobileChartStrip.test.tsx` (add cases)

**Interfaces:**
- Consumes: `MobileTabOverview` (Task 5).
- Produces:
  - `MobileChartStrip` takes `{ onPull?(dy: number): void; onPullEnd?(dy: number): void }`. Its grab bar is a `<button className="m-chart-strip-pull" aria-label="Show all tabs">`.
  - `usePullPanel(): { open: boolean; setOpen(v: boolean): void; dragOffset: number | null; onPull(dy: number): void; onPullEnd(dy: number): void }`. `dragOffset` is the live px pulled (null when not dragging). `onPullEnd` opens when `dy > 60` or on a tap (`|dy| < 4` toggles).
- The strip keeps rendering its bar even with one chart, but not with zero (no layout), where "+" in the overview is the only entry point; with no layout the bar still renders so the user can reach "+".

- [ ] **Step 1: Write the failing tests**

Add to `MobileChartStrip.test.tsx`:

```tsx
  describe("grab bar", () => {
    it("reports a drag distance and its end", () => {
      saveLayout("l1", "main", ws([
        { id: "t1", layout: "1", cells: [cell("c1", "US100", "tab.t1")], activeCellId: "c1" },
      ]));
      const onPull = vi.fn();
      const onPullEnd = vi.fn();
      render(<MobileChartStrip onPull={onPull} onPullEnd={onPullEnd} />);
      const bar = screen.getByRole("button", { name: "Show all tabs" });
      bar.setPointerCapture = vi.fn();
      fireEvent.pointerDown(bar, { clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(bar, { clientY: 180, pointerId: 1 });
      fireEvent.pointerUp(bar, { clientY: 180, pointerId: 1 });
      expect(onPull).toHaveBeenLastCalledWith(80);
      expect(onPullEnd).toHaveBeenCalledWith(80);
    });

    it("shows the bar even with no saved layout, so + stays reachable", () => {
      render(<MobileChartStrip onPull={() => {}} onPullEnd={() => {}} />);
      expect(screen.getByRole("button", { name: "Show all tabs" })).toBeTruthy();
    });
  });
```

Add `vi` and `fireEvent` to that file's imports. Update the existing "renders nothing without a saved layout" test: with no layout the component now renders only the grab bar, so assert `screen.queryAllByRole("tab").length === 0` plus no chips, instead of `container.firstChild` being null.

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run src/mobile/MobileChartStrip.test.tsx`
Expected: FAIL, no "Show all tabs" button.

- [ ] **Step 3: Implement**

`usePullPanel.ts`:

```ts
// frontend/src/mobile/usePullPanel.ts
// Open state for the tab overview plus the live pull distance, so the panel
// follows the finger while the strip's grab bar (or the panel's grip) drags.
import { useState } from "react";

export const OPEN_PX = 60;
const TAP_PX = 4;

export function usePullPanel() {
  const [open, setOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  return {
    open,
    setOpen,
    dragOffset,
    onPull: (dy: number) => setDragOffset(dy),
    onPullEnd: (dy: number) => {
      setDragOffset(null);
      if (Math.abs(dy) < TAP_PX) setOpen((o) => !o);
      else if (dy > OPEN_PX) setOpen(true);
      else if (dy < -OPEN_PX) setOpen(false);
    },
  };
}
```

In `MobileChartStrip.tsx`: accept `{ onPull, onPullEnd }` props. Replace the early `return null`s with rendering just the bar when there is no layout or no cell. Wrap the existing strip `div` and the bar in a fragment:

```tsx
  const bar = (
    <button
      className="m-chart-strip-pull"
      aria-label="Show all tabs"
      onPointerDown={(e) => {
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const sy = e.clientY;
        let dy = 0;
        const move = (ev: PointerEvent) => { dy = ev.clientY - sy; onPull?.(dy); };
        const end = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", end);
          el.removeEventListener("pointercancel", end);
          onPullEnd?.(dy);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", end);
        el.addEventListener("pointercancel", end);
      }}
    >
      <i />
    </button>
  );
```

Keyboard: the button's own Enter/Space fires `click`, so add `onClick={(e) => { if (e.detail === 0) onPullEnd?.(0); }}` (detail 0 = keyboard activation) so it toggles without double-firing after a pointer tap.

Add to `mobile.css`:

```css
.m-chart-strip-pull { display: flex; align-items: center; justify-content: center; width: 100%; height: 16px; padding: 0; border: 0; border-bottom: 1px solid var(--border); background: none; touch-action: none; }
```

and drop the `border-bottom` from `.m-chart-strip` (the bar now carries the rule under the strip).

In `MobileChartView.tsx`:

```tsx
  const pull = usePullPanel();
  ...
      {!viewMode.chromeHidden && <MobileChartStrip onPull={pull.onPull} onPullEnd={pull.onPullEnd} />}
      <div className="m-chart-body">
        {!viewMode.chromeHidden && (
          <div
            className="m-tab-ov-host"
            style={pull.dragOffset != null ? { ["--pull" as string]: `${pull.dragOffset}px` } : undefined}
          >
            <MobileTabOverview open={pull.open} onClose={() => pull.setOpen(false)} />
          </div>
        )}
        ...existing children
```

and in CSS, let the live pull drive the panel while dragging:

```css
.m-tab-ov-host { position: absolute; inset: 0; z-index: 20; pointer-events: none; overflow: hidden; }
.m-tab-ov-host > .m-tab-ov { pointer-events: auto; }
.m-tab-ov-host[style*="--pull"] > .m-tab-ov { transition: none; transform: translateY(min(0px, calc(-100% + max(0px, var(--pull))))); }
.m-tab-ov-host[style*="--pull"] > .m-tab-ov.open { transform: translateY(min(0px, var(--pull))); }
```

Also let the panel's grip drag up to close: give `MobileTabOverview` optional `onPull`/`onPullEnd` props and attach the same pointer handler shape as the strip's bar to `.m-tab-ov-grip` (keep its `onClick={onClose}` only for `e.detail === 0`). Pass `pull.onPull`/`pull.onPullEnd` from `MobileChartView`. Change `.m-tab-ov` in CSS from `position: absolute; inset: 0; z-index: 20` to `position: absolute; inset: 0` (the host now carries the stacking).

Hide the overview when the chart tab is left: in `MobileChartView`, `useEffect(() => () => pull.setOpen(false), [])` is not needed since the view unmounts; nothing to do.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/mobile/MobileChartStrip.test.tsx src/mobile/MobileTabOverview.test.tsx src/mobile/MobileChartView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint (ask the user first, one batch)**

Run: `cd frontend && npx tsc -b && npx eslint src/mobile src/lib/persist/core.ts`
Expected: no errors.

- [ ] **Step 6: Manual check on a phone-sized viewport**

Using the running dev server (http://localhost:5173) on a real phone, or desktop Chrome device mode on a throwaway layout (never through the Playwright MCP, which drives the user's live workspace):
1. Drag the bar under the strip down: the panel follows, opens past ~60 px, snaps back below that.
2. Scroll a long chip list with a finger that lands on a chip: it scrolls, no lift.
3. Hold a chip, drag it: order changes live; a desktop tab on the same layout updates after release.
4. Hold and release: menu. Close tab, then tap the toast: the tab and its drawings come back.
5. "+": symbol search opens; the pick becomes a new last tab on the current timeframe.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/mobile/MobileChartStrip.tsx frontend/src/mobile/MobileChartStrip.test.tsx frontend/src/mobile/MobileChartView.tsx frontend/src/mobile/usePullPanel.ts frontend/src/mobile/MobileTabOverview.tsx frontend/src/mobile/mobile.css
git commit -m "feat(mobile): pull the tab overview down from under the chart strip"
```

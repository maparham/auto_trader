# Per-cell Chart Undo/Redo (Ctrl+Z) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl/Cmd+Z undo and Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y redo for the focused chart cell's drawings, indicators, and AVWAP anchors.

**Architecture:** History records `(storage key, before, after)` deltas at the persistence choke points in `lib/persist/artifacts.ts`. Deltas landing within 800 ms group into one step (so a drag, or a remove that writes two keys, is one undo). Undo writes `before` back through `save()` (mirror + broadcast stay correct), then an applier refreshes the live chart in place — never a grid remount.

**Tech Stack:** React + TypeScript frontend, klinecharts, vitest (node env + `installMemStorage()`).

**Spec:** `docs/superpowers/specs/2026-08-15-chart-undo-design.md`

## Global Constraints

- All test commands run from `frontend/`: `npx vitest run src/<path>`.
- The frontend test baseline has 5-7 known failures on main (several order-sensitive). Never "fix" them; judge success only by the tests named in each task.
- New storage writes MUST go through `save()` / the typed `saveX` wrappers — raw `localStorage.setItem` is reverted by backend hydration.
- No em dashes in any user-visible copy (there is none planned; keep it that way).
- This checkout may be shared with concurrent Claude sessions: `git add` specific paths only, never `git add -A`.

---

### Task 1: HistoryManager core (`lib/history.ts`)

**Files:**
- Create: `frontend/src/lib/history.ts`
- Test: `frontend/src/lib/history.test.ts`

**Interfaces:**
- Consumes: `load`, `save`, `removeKeyEverywhere`, `PREFIX` from `frontend/src/lib/persist/core.ts` (`save<T>(key, value): boolean`, `removeKeyEverywhere(key): void`, `PREFIX === "auto-trader"`).
- Produces (used by Tasks 2, 4, 5):
  - `class HistoryManager { constructor(scope: string); setApplier(fn: ((suffixes: string[]) => void) | null): void; push(key: string, before: unknown, after: unknown, now?: number): void; undo(): boolean; redo(): boolean; clear(): void; get canUndo(): boolean; get canRedo(): boolean }`
  - `registerHistory(scope: string, mgr: HistoryManager): void`
  - `unregisterHistory(scope: string, mgr: HistoryManager): void`
  - `historyCapture(scope: string, key: string, after: unknown, now?: number): void`
  - `clearHistoryForKey(key: string): void`
  - `withHistorySuppressed<T>(fn: () => T): T`
  - `partitionHistorySuffixes(suffixes: string[], epic: string): { drawings: boolean; indicators: boolean; avwapIds: string[] }`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/lib/history.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();
const {
  HistoryManager,
  registerHistory,
  unregisterHistory,
  historyCapture,
  clearHistoryForKey,
  withHistorySuppressed,
  partitionHistorySuffixes,
} = await import("./history");

const SCOPE = "tab.T.cell.c";
const KEY = `auto-trader.${SCOPE}.drawings.US100`;
const KEY2 = `auto-trader.${SCOPE}.indicators`;

let mgr: InstanceType<typeof HistoryManager>;
beforeEach(() => {
  localStorage.clear();
  mgr = new HistoryManager(SCOPE);
  registerHistory(SCOPE, mgr);
});

describe("push / undo / redo", () => {
  it("undo restores `before` through save() and redo restores `after`", () => {
    localStorage.setItem(KEY, JSON.stringify(["a"]));
    mgr.push(KEY, ["a"], ["a", "b"], 1000);
    localStorage.setItem(KEY, JSON.stringify(["a", "b"]));
    expect(mgr.undo()).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a"]);
    expect(mgr.redo()).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a", "b"]);
  });

  it("undo of a create (before === undefined) removes the key", () => {
    mgr.push(KEY, undefined, ["a"], 1000);
    localStorage.setItem(KEY, JSON.stringify(["a"]));
    expect(mgr.undo()).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("undo with an empty stack returns false", () => {
    expect(mgr.undo()).toBe(false);
    expect(mgr.redo()).toBe(false);
  });

  it("a new push clears the redo stack", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.undo();
    mgr.push(KEY, ["a"], ["c"], 99999);
    expect(mgr.canRedo).toBe(false);
  });
});

describe("grouping and coalescing", () => {
  it("same-key pushes within 800ms coalesce (keep first before, last after)", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.push(KEY, ["b"], ["c"], 1500);
    mgr.undo();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a"]);
    expect(mgr.canUndo).toBe(false); // one step, not two
  });

  it("different-key pushes within 800ms group into ONE step", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.push(KEY2, [{ id: "RSI", type: "RSI" }], [], 1200);
    expect(mgr.undo()).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a"]);
    expect(JSON.parse(localStorage.getItem(KEY2)!)).toEqual([{ id: "RSI", type: "RSI" }]);
    expect(mgr.canUndo).toBe(false);
  });

  it("pushes beyond 800ms start a new step", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.push(KEY, ["b"], ["c"], 2000);
    mgr.undo();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["b"]);
    expect(mgr.canUndo).toBe(true);
  });

  it("a push after undo/redo never merges into the surviving top step", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.push(KEY, ["b"], ["c"], 2000);
    mgr.undo(); // pops the 2000 step; top is now the 1000 step
    mgr.push(KEY, ["b"], ["d"], 2100); // close in time, must NOT merge
    mgr.undo();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["b"]);
    expect(mgr.canUndo).toBe(true);
  });

  it("no-op pushes (before deep-equals after) are discarded", () => {
    mgr.push(KEY, ["a"], ["a"], 1000);
    expect(mgr.canUndo).toBe(false);
  });

  it("caps the undo stack at 100 steps, dropping the oldest", () => {
    for (let i = 0; i < 105; i++) mgr.push(KEY, [i], [i + 1], i * 10000);
    let n = 0;
    while (mgr.undo()) n++;
    expect(n).toBe(100);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([5]);
  });
});

describe("registry, capture, suppression", () => {
  it("historyCapture reads `before` from storage and records on the scope's manager", () => {
    localStorage.setItem(KEY, JSON.stringify(["a"]));
    historyCapture(SCOPE, KEY, ["a", "b"], 1000);
    localStorage.setItem(KEY, JSON.stringify(["a", "b"]));
    expect(mgr.undo()).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a"]);
  });

  it("capture for an unregistered scope is a no-op", () => {
    historyCapture("tab.other", "auto-trader.tab.other.indicators", ["x"], 1000);
    // nothing throws, nothing recorded anywhere
    expect(mgr.canUndo).toBe(false);
  });

  it("withHistorySuppressed drops captures", () => {
    withHistorySuppressed(() => historyCapture(SCOPE, KEY, ["a"], 1000));
    expect(mgr.canUndo).toBe(false);
  });

  it("clearHistoryForKey clears the owning scope's stacks (prefix match, no scope bleed)", () => {
    mgr.push(KEY, ["a"], ["b"], 1000);
    clearHistoryForKey("auto-trader.tab.T.cell.OTHER.drawings.US100");
    expect(mgr.canUndo).toBe(true); // different scope untouched
    clearHistoryForKey(KEY);
    expect(mgr.canUndo).toBe(false);
    expect(mgr.canRedo).toBe(false);
  });

  it("unregisterHistory only removes the registered instance", () => {
    const other = new HistoryManager(SCOPE);
    unregisterHistory(SCOPE, other); // not the registered one: no-op
    historyCapture(SCOPE, KEY, ["z"], 1000);
    expect(mgr.canUndo).toBe(true);
    unregisterHistory(SCOPE, mgr);
    historyCapture(SCOPE, KEY, ["zz"], 5000);
    expect(mgr.canUndo).toBe(true); // no NEW capture landed (still just the one step)
    expect(mgr.canRedo).toBe(false);
  });
});

describe("applier", () => {
  it("undo notifies the applier with the touched key suffixes", () => {
    const seen: string[][] = [];
    mgr.setApplier((s) => seen.push(s));
    mgr.push(KEY, ["a"], ["b"], 1000);
    mgr.push(KEY2, ["x"], ["y"], 1100);
    mgr.undo();
    expect(seen).toEqual([["drawings.US100", "indicators"]]);
  });
});

describe("partitionHistorySuffixes", () => {
  it("classifies suffixes for the current epic", () => {
    expect(
      partitionHistorySuffixes(
        ["drawings.US100", "indicators", "indicatorConfig", "avwap.US100.AVWAP", "avwap.DE40.x"],
        "US100",
      ),
    ).toEqual({ drawings: true, indicators: true, avwapIds: ["AVWAP"] });
    expect(partitionHistorySuffixes(["drawings.DE40"], "US100")).toEqual({
      drawings: false,
      indicators: false,
      avwapIds: [],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/history.test.ts`
Expected: FAIL — module `./history` not found.

- [ ] **Step 3: Implement `lib/history.ts`**

```ts
// Per-cell undo/redo for chart content (drawings, indicators, AVWAP anchors).
//
// History records (storage key, before, after) deltas at the persistence choke
// points in lib/persist/artifacts.ts. Deltas landing within GROUP_MS group into
// one step, so a drag gesture (repeated persists of one key) and a composite
// action (indicator remove writes `indicators` + `indicatorConfig`) each undo
// as a single Ctrl+Z. Undo re-enters storage through save()/removeKeyEverywhere
// so the backend mirror and cross-tab broadcast stay correct; writing
// localStorage directly here would be reverted by hydrateFromBackend.
import { save, removeKeyEverywhere, PREFIX } from "./persist/core";

interface HistoryDelta {
  key: string; // full storage key: `${PREFIX}.${scope}.${suffix}`
  before: unknown; // undefined = key absent before the write
  after: unknown;
}
interface HistoryStep {
  deltas: HistoryDelta[];
  // Last capture time. 0 marks the step CLOSED to further merging (set when a
  // step crosses the stacks): "draw, undo, draw again fast" must not merge the
  // new gesture into the pre-undo step.
  lastAt: number;
}

const GROUP_MS = 800;
const CAP = 100;

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- suppression -------------------------------------------------------------
// Guards programmatic writes that must not be undoable: undo/redo application
// itself and strategy-overlay auto-adds. Same idiom as withLayoutEventsSuppressed.
let suppressed = 0;
export function withHistorySuppressed<T>(fn: () => T): T {
  suppressed++;
  try {
    return fn();
  } finally {
    suppressed--;
  }
}

// --- registry ----------------------------------------------------------------
// scope -> the live cell's manager. Captures for unregistered scopes are
// no-ops, which is what keeps mount-time template auto-apply, migrations, and
// background-scope writes out of the stacks.
const registry = new Map<string, HistoryManager>();
export function registerHistory(scope: string, mgr: HistoryManager): void {
  registry.set(scope, mgr);
}
export function unregisterHistory(scope: string, mgr: HistoryManager): void {
  if (registry.get(scope) === mgr) registry.delete(scope);
}
// Remote push invalidation (App.onBackendPush): another tab/device edited this
// key, so the owning cell's history would undo over their change. Clear it.
export function clearHistoryForKey(key: string): void {
  for (const [scope, mgr] of registry) {
    if (key.startsWith(`${PREFIX}.${scope}.`)) mgr.clear();
  }
}

// Called by lib/persist/artifacts.ts immediately BEFORE save(key, after) —
// `before` is read from storage here, so call order is load-bearing.
export function historyCapture(scope: string, key: string, after: unknown, now?: number): void {
  if (suppressed) return;
  const mgr = registry.get(scope);
  if (!mgr) return;
  let before: unknown;
  try {
    const raw = localStorage.getItem(key);
    before = raw == null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    before = undefined;
  }
  mgr.push(key, before, after, now);
}

/** Classify a step's touched suffixes for the applier: which live-apply paths
 *  to run, restricted to the cell's CURRENT epic (a stale epic's key is already
 *  restored in storage and rehydrates on the next symbol switch). */
export function partitionHistorySuffixes(
  suffixes: string[],
  epic: string,
): { drawings: boolean; indicators: boolean; avwapIds: string[] } {
  const out = { drawings: false, indicators: false, avwapIds: [] as string[] };
  for (const s of suffixes) {
    if (s === `drawings.${epic}`) out.drawings = true;
    else if (s === "indicators" || s === "indicatorConfig") out.indicators = true;
    else if (s.startsWith(`avwap.${epic}.`)) out.avwapIds.push(s.slice(`avwap.${epic}.`.length));
  }
  return out;
}

export class HistoryManager {
  private undoStack: HistoryStep[] = [];
  private redoStack: HistoryStep[] = [];
  private applier: ((suffixes: string[]) => void) | null = null;

  constructor(readonly scope: string) {}

  setApplier(fn: ((suffixes: string[]) => void) | null): void {
    this.applier = fn;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  push(key: string, before: unknown, after: unknown, now: number = Date.now()): void {
    if (eq(before, after)) return;
    this.redoStack.length = 0;
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top.lastAt !== 0 && now - top.lastAt <= GROUP_MS) {
      const d = top.deltas.find((d) => d.key === key);
      if (d) d.after = after; // coalesce: keep first before, take last after
      else top.deltas.push({ key, before, after });
      top.lastAt = now;
      // A gesture that ended exactly where it started (drag out and back) is
      // not an undo step at all.
      if (top.deltas.every((d) => eq(d.before, d.after))) this.undoStack.pop();
      return;
    }
    this.undoStack.push({ deltas: [{ key, before, after }], lastAt: now });
    if (this.undoStack.length > CAP) this.undoStack.shift();
  }

  undo(): boolean {
    return this.applyTop(this.undoStack, this.redoStack, "before");
  }
  redo(): boolean {
    return this.applyTop(this.redoStack, this.undoStack, "after");
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  private applyTop(from: HistoryStep[], to: HistoryStep[], field: "before" | "after"): boolean {
    const step = from[from.length - 1];
    if (!step) return false;
    const ok = withHistorySuppressed(() => {
      let allOk = true;
      // Undo applies deltas newest-first, redo oldest-first.
      const deltas = field === "before" ? [...step.deltas].reverse() : step.deltas;
      for (const d of deltas) {
        const v = d[field];
        if (v === undefined) removeKeyEverywhere(d.key);
        else if (!save(d.key, v)) allOk = false; // quota: report failure, leave step
      }
      return allOk;
    });
    if (!ok) return false;
    from.pop();
    step.lastAt = 0; // closed: later captures never merge into a crossed step
    to.push(step);
    // Surviving top must not swallow the next gesture either (see grouping test).
    const survivor = from[from.length - 1];
    if (survivor) survivor.lastAt = 0;
    const prefix = `${PREFIX}.${this.scope}.`;
    this.applier?.(step.deltas.map((d) => d.key.slice(prefix.length)));
    return true;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/history.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/history.ts frontend/src/lib/history.test.ts
git commit -m "feat(undo): HistoryManager with grouped multi-key steps"
```

---

### Task 2: Capture hooks in the persistence layer

**Files:**
- Modify: `frontend/src/lib/persist/artifacts.ts` (functions: `saveDrawings` ~L33, `saveIndicators` ~L180, `saveIndicatorConfig` ~L372, `saveIndicatorVisible` ~L386, `patchIndicatorExtend` ~L397, `deleteIndicatorConfig` ~L410, `saveAvwapAnchor` ~L435)
- Modify: `frontend/src/lib/strategyOverlays.ts` (`syncStrategyOverlays`, write at L104)
- Test: `frontend/src/lib/historyCapture.test.ts` (new)

**Interfaces:**
- Consumes: `historyCapture`, `withHistorySuppressed`, `HistoryManager`, `registerHistory` from Task 1.
- Produces: every listed save function records history before writing. No signature changes.

- [ ] **Step 1: Write the failing integration test**

```ts
// frontend/src/lib/historyCapture.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();
const { HistoryManager, registerHistory } = await import("./history");
const {
  saveDrawings,
  loadDrawings,
  saveIndicators,
  loadIndicators,
  saveIndicatorConfig,
  loadIndicatorConfigs,
  deleteIndicatorConfig,
  saveAvwapAnchor,
  loadAvwapAnchor,
} = await import("./persist");

const SCOPE = "tab.T.cell.c";
const EPIC = "US100";

let mgr: InstanceType<typeof HistoryManager>;
beforeEach(() => {
  localStorage.clear();
  mgr = new HistoryManager(SCOPE);
  registerHistory(SCOPE, mgr);
});

it("saveDrawings captures; undo restores the previous list", () => {
  const a = [{ name: "horizontalStraightLine", points: [{ value: 1 }] }];
  saveDrawings(SCOPE, EPIC, a);
  const b = [...a, { name: "horizontalStraightLine", points: [{ value: 2 }] }];
  // beyond the 800ms group window: force two steps by faking time via push order
  // (saveDrawings uses real time; two same-key writes here coalesce into one
  // step, which is fine — undo must land back on `a`'s PREDECESSOR = absent,
  // so assert the coalesced semantics instead:)
  saveDrawings(SCOPE, EPIC, b);
  expect(mgr.undo()).toBe(true);
  expect(loadDrawings(SCOPE, EPIC)).toEqual([]); // both writes coalesced; before = absent
});

it("indicator remove (list + config) undoes as one step", () => {
  saveIndicators(SCOPE, [{ id: "RSI", type: "RSI" }]);
  saveIndicatorConfig(SCOPE, "RSI", { calcParams: [14] });
  mgr.clear(); // start measuring from the established state
  // the remove gesture: list write + config delete (same tick, one group)
  saveIndicators(SCOPE, []);
  deleteIndicatorConfig(SCOPE, "RSI");
  expect(mgr.undo()).toBe(true);
  expect(loadIndicators(SCOPE)).toEqual([{ id: "RSI", type: "RSI" }]);
  expect(loadIndicatorConfigs(SCOPE).RSI).toEqual({ calcParams: [14] });
  expect(mgr.canUndo).toBe(false);
});

it("saveAvwapAnchor captures", () => {
  saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 1_700_000_000_000);
  mgr.clear();
  saveAvwapAnchor(SCOPE, EPIC, "AVWAP", 1_800_000_000_000);
  expect(mgr.undo()).toBe(true);
  expect(loadAvwapAnchor(SCOPE, EPIC, "AVWAP")).toBe(1_700_000_000_000);
});

it("writes to an unregistered scope record nothing", () => {
  saveDrawings("tab.other", EPIC, [{ name: "x", points: [] }]);
  expect(mgr.canUndo).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/historyCapture.test.ts`
Expected: FAIL — undo() returns false (nothing captured yet).

- [ ] **Step 3: Add capture calls in `lib/persist/artifacts.ts`**

Add the import:

```ts
import { historyCapture } from "../history";
```

Then one line per function, immediately BEFORE its `save(...)` call (capture reads `before` from storage itself, so order matters). Exact placements:

```ts
export function saveDrawings(scope: string, epic: string, list: SavedOverlay[]): void {
  historyCapture(scope, drawingsKey(scope, epic), list);
  save(drawingsKey(scope, epic), list);
  emitLayoutChanged(scope);
}

export function saveIndicators(scope: string, list: IndicatorInstance[]): void {
  historyCapture(scope, indicatorsKey(scope), list);
  save(indicatorsKey(scope), list);
  emitLayoutChanged(scope);
}

// saveIndicatorConfig / saveIndicatorVisible / patchIndicatorExtend: after
// mutating `all`, before `save(indicatorCfgKey(scope), all)`:
  historyCapture(scope, indicatorCfgKey(scope), all);

// deleteIndicatorConfig: inside the `if (id in all)` block, after `delete`,
// before `save(...)`:
  historyCapture(scope, indicatorCfgKey(scope), all);

export function saveAvwapAnchor(scope: string, epic: string, id: string, anchorMs: number): void {
  historyCapture(scope, avwapKey(scope, epic, id), anchorMs);
  save(avwapKey(scope, epic, id), anchorMs);
  emitLayoutChanged(scope);
}
```

- [ ] **Step 4: Suppress the strategy-overlay auto-add**

In `frontend/src/lib/strategyOverlays.ts`, `syncStrategyOverlays` adds indicator instances and calls `saveIndicators` when a backtest run needs strategy overlays — programmatic, not a user edit, must not be undoable. Wrap the function BODY:

```ts
import { withHistorySuppressed } from "./history";

export function syncStrategyOverlays(/* existing params unchanged */) {
  return withHistorySuppressed(() => {
    // ...entire existing body unchanged...
  });
}
```

(`writeSnapshotToScope` in `lib/snapshots.ts` needs no suppression: it writes to a fresh, never-registered scope, so captures are already no-ops.)

- [ ] **Step 5: Run the new test and the existing persist/strategy suites**

Run: `cd frontend && npx vitest run src/lib/historyCapture.test.ts src/lib/persist src/lib/templates.test.ts src/lib/snapshots.test.ts`
Expected: all PASS (persist suites unaffected: capture is a no-op for their unregistered scopes).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/persist/artifacts.ts frontend/src/lib/strategyOverlays.ts frontend/src/lib/historyCapture.test.ts
git commit -m "feat(undo): capture history at the persistence choke points"
```

---

### Task 3: `syncIndicatorsFromStorage` (in-place indicator restore)

**Files:**
- Modify: `frontend/src/lib/indicators.ts` (add near `hydrateIndicators`, ~L963)
- Test: `frontend/src/lib/indicatorSync.test.ts` (new)

**Interfaces:**
- Consumes: existing `loadIndicators(scope)`, `removeIndicatorById(chart, scope, id)`, `applyIndicator(chart, scope, epic, inst, opts)`, `getIndicatorsByPane(chart)`; `IndicatorInstance {id, type}`.
- Produces (used by Task 4):
  - `diffIndicatorSync(storedIds: string[], liveIds: string[]): { remove: string[]; addOrRebuild: string[] }` — pure, exported.
  - `syncIndicatorsFromStorage(chart: Chart, controller: ChartController, scope: string, epic: string): void`

- [ ] **Step 1: Write the failing test for the pure diff**

```ts
// frontend/src/lib/indicatorSync.test.ts
import { describe, it, expect } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();
const { diffIndicatorSync } = await import("./indicators");

describe("diffIndicatorSync", () => {
  it("removes live ids missing from storage, add-or-rebuilds every stored id", () => {
    expect(diffIndicatorSync(["a", "b"], ["b", "c"])).toEqual({
      remove: ["c"],
      addOrRebuild: ["a", "b"],
    });
  });
  it("empty storage removes everything", () => {
    expect(diffIndicatorSync([], ["x"])).toEqual({ remove: ["x"], addOrRebuild: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicatorSync.test.ts`
Expected: FAIL — `diffIndicatorSync` not exported.

- [ ] **Step 3: Implement in `lib/indicators.ts`**

```ts
/** Pure half of syncIndicatorsFromStorage: which live instances to drop, and
 *  which stored instances to (re)build. Every stored id is rebuilt — restoring
 *  an instance from storage is exactly a reload of that instance, which is the
 *  one uniform path that applies configs, anchors, and companions correctly. */
export function diffIndicatorSync(
  storedIds: string[],
  liveIds: string[],
): { remove: string[]; addOrRebuild: string[] } {
  const stored = new Set(storedIds);
  return {
    remove: liveIds.filter((id) => !stored.has(id)),
    addOrRebuild: [...storedIds],
  };
}

/** Reconcile the live chart to the (just-restored) stored indicator state, in
 *  place — the undo path must never take App's setHydrateEpoch grid remount.
 *  Callers run inside withHistorySuppressed: removeIndicatorById persists a
 *  config delete, and the rebuild's own writes must not re-enter history. */
export function syncIndicatorsFromStorage(
  chart: Chart,
  controller: ChartController,
  scope: string,
  epic: string,
): void {
  const stored = loadIndicators(scope);
  const live = controller.indicators.value;
  const { remove } = diffIndicatorSync(
    stored.map((s) => s.id),
    live.map((l) => l.id),
  );
  for (const id of remove) removeIndicatorById(chart, scope, id);
  const next: IndicatorInstance[] = [];
  for (const inst of stored) {
    // Tear down any live pane for this id first (removeIndicator, NOT
    // removeIndicatorById — the restored config must survive), then rebuild
    // from storage exactly like a reload.
    const panes = getIndicatorsByPane(chart);
    for (const [paneId, inds] of panes ?? []) {
      if (inds.has(inst.id)) {
        chart.removeIndicator({ paneId, name: inst.id });
        break;
      }
    }
    if (applyIndicator(chart, scope, epic, inst, { rehydrate: true })) next.push(inst);
  }
  controller.indicators.set(next);
}
```

Add `import type { ChartController } from "./chartController";` if not present (check for an import cycle: `chartController.ts` must not import from `indicators.ts` — as of now it does not; if the type-only import still trips a lint rule, type the parameter structurally as `{ indicators: { value: IndicatorInstance[]; set(v: IndicatorInstance[]): void } }` instead).

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/indicatorSync.test.ts`
Expected: PASS. Also `npx tsc --noEmit` from `frontend/` if the repo has no faster typecheck script.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators.ts frontend/src/lib/indicatorSync.test.ts
git commit -m "feat(undo): in-place indicator reconcile from restored storage"
```

---

### Task 4: Wire ChartController + ChartCore (applier, invalidation, keyboard)

**Files:**
- Modify: `frontend/src/lib/chartController.ts` (constructor, ~L182)
- Modify: `frontend/src/ChartCore.tsx` (controller memo ~L267; wrap onKeyDown mod block ~L3660; document fallback near ~L3513)

**Interfaces:**
- Consumes: `HistoryManager`, `registerHistory`, `unregisterHistory`, `partitionHistorySuffixes`, `withHistorySuppressed` (Task 1); `syncIndicatorsFromStorage` (Task 3); existing `loadAvwapAnchor`, `overlays.rehydrate()`, `controller.coverDrawingAnchors?.()`, `chartRef`, `epicRef`.
- Produces: working Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y on the focused cell. `controller.history: HistoryManager`.

- [ ] **Step 1: ChartController owns and registers the manager**

In `lib/chartController.ts`:

```ts
import { HistoryManager, registerHistory } from "./history";

// field declaration (assigned in constructor — `scope` isn't set during field init):
readonly history: HistoryManager;

// constructor body, after readOnly is seeded:
this.history = new HistoryManager(scope);
// Snapshot cells are frozen study copies: no mutations, no history.
if (!this.readOnly.value) registerHistory(scope, this.history);
```

- [ ] **Step 2: ChartCore — unregister on unmount, applier, epic-change clear**

Near the controller memo (`ChartCore.tsx:267`):

```ts
// Unregister on unmount/remount so a stale controller never receives captures.
useEffect(() => {
  return () => unregisterHistory(scope, controller.history);
}, [controller, scope]);

// Live-apply restored storage after undo/redo. Runs inside the history
// suppression (the manager suppresses its own storage writes, but the applier's
// side-writes — removeIndicatorById's config delete — must be suppressed too).
useEffect(() => {
  controller.history.setApplier((suffixes) => {
    const chart = chartRef.current;
    if (!chart) return; // storage is restored; next rehydrate converges
    const epic = epicRef.current;
    const { drawings, indicators, avwapIds } = partitionHistorySuffixes(suffixes, epic);
    withHistorySuppressed(() => {
      if (drawings) {
        overlays.rehydrate();
        controller.coverDrawingAnchors?.();
      }
      if (indicators) syncIndicatorsFromStorage(chart, controller, scope, epic);
      for (const id of avwapIds) {
        chart.overrideIndicator({ name: id, calcParams: [loadAvwapAnchor(scope, epic, id)] });
      }
    });
  });
  return () => controller.history.setApplier(null);
}, [controller, scope, overlays]);

// Cross-epic undo is out of scope: switching the cell's symbol clears history.
useEffect(() => {
  controller.history.clear();
}, [controller, symbol.epic]);
```

Imports to add in ChartCore: `unregisterHistory`, `partitionHistorySuffixes`, `withHistorySuppressed` from `./lib/history`; `syncIndicatorsFromStorage` from `./lib/indicators`; `loadAvwapAnchor` from `./lib/persist` (already imported — check).

- [ ] **Step 3: Keyboard — wrap handler**

In the existing mod-key block (`ChartCore.tsx:3660`, after the `k === "v"` branch):

```ts
} else if (k === "z") {
  // preventDefault only when a step applied — never swallow text-field undo
  // (the block already bailed for INPUT/TEXTAREA/SELECT/contentEditable above).
  if (e.shiftKey ? controller.history.redo() : controller.history.undo()) e.preventDefault();
} else if (k === "y") {
  if (controller.history.redo()) e.preventDefault();
}
```

- [ ] **Step 4: Keyboard — document-level fallback**

Clone the Delete/Backspace fallback effect (`ChartCore.tsx:3513-3536`) directly below it, with identical guards (`focused` gate, `e.defaultPrevented`, input/contentEditable bail, `.modal-backdrop` / `.floating-modal` bail):

```ts
// Ctrl/Cmd+Z fallback at document level: same rationale as the Delete fallback
// above — the user just clicked a sidebar/toolbar button, focus left the wrap,
// and Ctrl+Z must still hit the app-focused cell. Same guards, verbatim.
useEffect(() => {
  if (!focused) return;
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k !== "z" && k !== "y") return;
    if (e.defaultPrevented) return; // wrap handler already handled it
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
    if (document.querySelector(".modal-backdrop") || t.closest?.(".floating-modal")) return;
    const redo = k === "y" || (k === "z" && e.shiftKey);
    if (redo ? controller.history.redo() : controller.history.undo()) e.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}, [focused, controller]);
```

- [ ] **Step 5: Typecheck + full lib test sweep**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/lib`
Expected: typecheck clean; lib suite green EXCEPT the 5-7 known baseline failures (compare against `git stash`-free main behavior only if a failure looks new — do not touch known-failing tests).

- [ ] **Step 6: Manual smoke test in the running app**

With the dev app open (http://localhost:5173): draw two lines → Ctrl+Z twice removes them newest-first → Ctrl+Shift+Z restores; drag a line, one Ctrl+Z returns it in one step; add an indicator, Ctrl+Z removes it; remove an indicator, ONE Ctrl+Z restores it with its params; edit an RSI length in settings, Ctrl+Z reverts it; Ctrl+Z inside the settings modal's number input does NOT touch the chart; in a split tab, Ctrl+Z only affects the focused cell; switch symbol → Ctrl+Z does nothing.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/chartController.ts frontend/src/ChartCore.tsx
git commit -m "feat(undo): Ctrl+Z/Ctrl+Shift+Z wiring per chart cell"
```

---

### Task 5: Remote-push invalidation + final sweep

**Files:**
- Modify: `frontend/src/App.tsx` (`onBackendPush`, ~L681)

**Interfaces:**
- Consumes: `clearHistoryForKey(key)` from Task 1.

- [ ] **Step 1: Add the invalidation line**

First line of `onBackendPush` (before `parseAlertsStateKey`):

```ts
// Another tab/device edited this key: undoing over their change would silently
// revert it. Clear the owning cell's history (matches pendingUndo.sigAfter's
// philosophy for the tab-merge undo).
clearHistoryForKey(key);
```

Import `clearHistoryForKey` from `./lib/history`.

- [ ] **Step 2: Typecheck + full frontend test run**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck; only the known baseline failures (5-7, order-sensitive) — every history/persist/indicator test green.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(undo): clear cell history on remote state push"
```

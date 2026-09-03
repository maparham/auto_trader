# Sync Indicators Across Layout Cells Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Sync indicators" toggle in the layout dropdown that makes every cell of a chart tab share one indicator set — add/remove/edit in any cell mirrors to all cells (TradingView-style full mirror).

**Architecture:** Storage-level mirror. Every indicator mutation in this app already persists through the per-scope writers in `lib/persist/artifacts.ts` (`saveIndicators`, `saveIndicatorConfig`, `saveIndicatorVisible`, `patchIndicatorExtend`, `deleteIndicatorConfig`, `saveAvwapAnchor`), and each of those emits `emitLayoutChanged(scope)` (`lib/persist/layoutEvents.ts`). We subscribe once in App: when a changed scope belongs to a tab with `syncIndicators` on, we copy that scope's persisted indicator state onto the tab's sibling scopes (same instance ids; AVWAP anchors re-keyed per sibling epic) and reconcile each mounted sibling chart via the existing `syncIndicatorsFromStorage` (the undo path's rebuild machinery). Mirror writes run inside `withLayoutEventsSuppressed` + `withHistorySuppressed`, so they can't loop back or pollute sibling undo/template-autosave. This supersedes the spec's per-op `replicateToSiblings` sketch — one mirror pass covers add, remove, config, visibility, styles, extendData, and anchor edits, because they all land in the same storage.

**Tech Stack:** React 18 + TypeScript, klinecharts, vitest (`npm run test:unit` in `frontend/`), localStorage-backed persist layer.

**Spec:** `docs/superpowers/specs/2026-07-07-sync-indicators-design.md` (note deviations: `maybeAutoApplyTemplate` no longer exists — templates auto-apply was replaced by the look-follows-template flow; and replication is storage-driven, not per-op).

## Global Constraints

- All frontend paths below are relative to `frontend/` unless prefixed.
- Default off: absent `syncIndicators` behaves exactly like today.
- "Lock charts" must NOT affect this flag in either direction (no `effectiveSync*` helper for it; use the raw flag).
- Same instance ids across cells is the invariant (mirroring copies the origin's `IndicatorInstance[]` verbatim).
- Per-cell view state (sub-pane collapse, legend collapse, candle hidden, indicator hide-all) is NOT mirrored — only the keys `indicators`, `indicatorConfig`, and `avwap.<epic>.<id>`.
- Drawings are NOT mirrored.
- Baseline to keep green: `cd frontend && npm run test:unit` and `npx tsc -b` (23 pre-existing tsc errors unrelated — count them before you start, don't add new ones).
- Commit after each task; work happens on a feature branch/worktree, merged to main at the end.

---

### Task 1: `syncIndicators` flag + LayoutPicker checkbox + toggle wiring

**Files:**
- Modify: `src/lib/persist/workspace.ts` (ChartTab interface ~line 49-73; layout-clone block ~line 421-434)
- Modify: `src/LayoutPicker.tsx`
- Modify: `src/App.tsx` (`toggleSync` ~line 1455; LayoutPicker JSX ~line 2122)

**Interfaces:**
- Produces: `ChartTab.syncIndicators?: boolean`; `toggleSync` accepts kind `"indicators"`. Task 3 branches on the flag and extends the `"indicators"` toggle-on branch with the seed.

- [ ] **Step 1: Add the flag to `ChartTab`**

In `src/lib/persist/workspace.ts`, after the `syncTime?: boolean;` member of `interface ChartTab` add:

```ts
  // When on, all cells of the tab share ONE indicator set: adding, removing, or
  // editing an indicator in any cell mirrors to every cell (full mirror, same
  // instance ids). Storage-level: see lib/indicatorSync.ts. Unlike the flags
  // above, "Lock charts" does NOT override it — lock is visual alignment,
  // indicator content is an independent choice.
  syncIndicators?: boolean;
```

In the same file find the named-layout clone that rebuilds tabs field-by-field (the block containing `syncSymbol: t.syncSymbol,` / `syncTime: t.syncTime,` / `locked: t.locked,` around line 428) and add `syncIndicators: t.syncIndicators,` alongside them. Do NOT add it to the `merged: ChartTab` object in `mergeTabInto` (~line 156) or to `detachCell`'s new tab in App — the spec wants the flag off on merged/detached tabs, and absent = off.

- [ ] **Step 2: LayoutPicker checkbox**

In `src/LayoutPicker.tsx`:
- Widen the props: `syncIndicators: boolean;` and `onToggleSync: (kind: "symbol" | "interval" | "crosshair" | "time" | "indicators") => void;`; destructure `syncIndicators`.
- Inside the `ls-group` div, after the "Sync date range" `<label>` (ends ~line 181), add a sibling label. It is NOT disabled by lock (place it after the `ls-group` closing `</div>` if the group is lock-greyed — it is: `ls-group${locked ? " ls-disabled" : ""}` — so put this label OUTSIDE that div, directly before `</div>` of `layout-sync`):

```tsx
            <label>
              <input
                type="checkbox"
                checked={syncIndicators}
                onChange={() => onToggleSync("indicators")}
              />
              <span className="ls-label">Sync indicators</span>
              <Tooltip content="All charts in this layout share the same indicators — adding, removing, or editing one applies everywhere.">
                <span className="ls-info">ⓘ</span>
              </Tooltip>
            </label>
```

- [ ] **Step 3: App wiring**

In `src/App.tsx`:
- At the LayoutPicker call site (~line 2122, where `syncSymbol={!!active.syncSymbol}` etc. are passed) add `syncIndicators={!!active.syncIndicators}`.
- In `toggleSync` (~line 1455) widen the parameter type to include `"indicators"` and add a branch BEFORE the final `setTabs` block:

```ts
    if (kind === "indicators") {
      const turningOn = !active.syncIndicators;
      if (turningOn) seedIndicatorSync(active, focusedCell.id); // Task 3; until then, insert a `// seed happens in Task 3` comment and just flip the flag
      setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, syncIndicators: turningOn } : t)));
      return;
    }
```

(For this task, ship it without the `seedIndicatorSync` call — flag-flip only; Task 3 adds the seed. Keep the comment.)

- [ ] **Step 4: Typecheck + tests**

Run: `cd frontend && npx tsc -b 2>&1 | tail -5` (no NEW errors vs baseline) and `npm run test:unit`.
Expected: suite green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/persist/workspace.ts frontend/src/LayoutPicker.tsx frontend/src/App.tsx
git commit -m "feat(layout): add Sync indicators flag and menu toggle (no-op yet)"
```

---

### Task 2: `lib/indicatorSync.ts` — the storage mirror

**Files:**
- Create: `src/lib/indicatorSync.ts`
- Test: `src/lib/indicatorSync.test.ts`

**Interfaces:**
- Consumes (from `./persist`): `loadIndicators(scope): IndicatorInstance[]`, `saveIndicators(scope, list)`, `loadIndicatorConfigs(scope): Record<string, SavedIndicatorConfig>`, `saveIndicatorConfig(scope, id, cfg)`, `deleteIndicatorConfig(scope, id)`, `loadAvwapAnchor(scope, epic, id): number`, `saveAvwapAnchor(scope, epic, id, anchorMs)`, `type IndicatorInstance { id: string; type: string; inset?: boolean }`.
- Consumes: `withLayoutEventsSuppressed` from `./persist/layoutEvents`, `withHistorySuppressed` from `./history`.
- Produces (used by Task 3):

```ts
export interface SyncCellRef { scope: string; epic: string; }
/** Copy origin's persisted indicator state onto sibling's scope (full replace,
 *  same instance ids; AVWAP anchors re-keyed to the sibling's epic). Returns the
 *  instance ids whose sibling-side bytes changed (instance entry, config, or
 *  anchor) — the caller feeds these to syncIndicatorsFromStorage as rebuildIds.
 *  Never emits layout events or history steps. */
export function mirrorIndicatorState(origin: SyncCellRef, sibling: SyncCellRef): string[];
```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/indicatorSync.test.ts`. The persist layer reads/writes `localStorage` (vitest env provides it — see `src/lib/templates.test.ts` for precedent, which imports persist functions directly and asserts on load* results). Test with two scopes `"o"` and `"s"`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveIndicators, loadIndicators,
  saveIndicatorConfig, loadIndicatorConfigs,
  saveAvwapAnchor, loadAvwapAnchor,
} from "./persist";
import { onLayoutChanged } from "./persist/layoutEvents";
import { mirrorIndicatorState } from "./indicatorSync";

const O = { scope: "o", epic: "US100" };
const S = { scope: "s", epic: "DE40" };

beforeEach(() => localStorage.clear());

describe("mirrorIndicatorState", () => {
  it("copies instances verbatim (same ids) and configs, replacing the sibling set", () => {
    saveIndicators(O.scope, [{ id: "EMA#a1", type: "EMA" }, { id: "RSI", type: "RSI" }]);
    saveIndicatorConfig(O.scope, "EMA#a1", { calcParams: [21] });
    saveIndicators(S.scope, [{ id: "MACD", type: "MACD" }]); // pre-existing sibling extra
    saveIndicatorConfig(S.scope, "MACD", { calcParams: [12, 26, 9] });
    const changed = mirrorIndicatorState(O, S);
    expect(loadIndicators(S.scope)).toEqual([{ id: "EMA#a1", type: "EMA" }, { id: "RSI", type: "RSI" }]);
    expect(loadIndicatorConfigs(S.scope)["EMA#a1"]).toEqual({ calcParams: [21] });
    expect(loadIndicatorConfigs(S.scope)["MACD"]).toBeUndefined(); // stale config dropped
    // MACD is in `changed` too: an id REMOVED from the set must trigger the live
    // reconcile on the sibling (syncIndicatorsFromStorage is what tears it down).
    expect(changed.sort()).toEqual(["EMA#a1", "MACD", "RSI"].sort());
  });

  it("re-keys AVWAP anchors to the sibling's epic", () => {
    saveIndicators(O.scope, [{ id: "AVWAP#x", type: "AVWAP" }]);
    saveAvwapAnchor(O.scope, O.epic, "AVWAP#x", 1700000000000);
    mirrorIndicatorState(O, S);
    expect(loadAvwapAnchor(S.scope, S.epic, "AVWAP#x")).toBe(1700000000000);
  });

  it("returns only ids whose sibling state actually changed", () => {
    saveIndicators(O.scope, [{ id: "EMA#a1", type: "EMA" }, { id: "RSI", type: "RSI" }]);
    saveIndicatorConfig(O.scope, "EMA#a1", { calcParams: [21] });
    mirrorIndicatorState(O, S); // first pass seeds everything
    saveIndicatorConfig(O.scope, "EMA#a1", { calcParams: [34] }); // origin edit
    const changed = mirrorIndicatorState(O, S);
    expect(changed).toEqual(["EMA#a1"]); // RSI untouched
  });

  it("an anchor-only change marks that id changed", () => {
    saveIndicators(O.scope, [{ id: "AVWAP#x", type: "AVWAP" }]);
    saveAvwapAnchor(O.scope, O.epic, "AVWAP#x", 1000);
    mirrorIndicatorState(O, S);
    saveAvwapAnchor(O.scope, O.epic, "AVWAP#x", 2000);
    expect(mirrorIndicatorState(O, S)).toEqual(["AVWAP#x"]);
    expect(loadAvwapAnchor(S.scope, S.epic, "AVWAP#x")).toBe(2000);
  });

  it("emits no layout events while mirroring", () => {
    saveIndicators(O.scope, [{ id: "EMA#a1", type: "EMA" }]);
    const cb = vi.fn();
    const off = onLayoutChanged(cb);
    mirrorIndicatorState(O, S);
    off();
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/indicatorSync.test.ts`
Expected: FAIL — module `./indicatorSync` not found.

- [ ] **Step 3: Implement**

Create `src/lib/indicatorSync.ts`:

```ts
// Storage-level mirror for the "Sync indicators" layout toggle: copy one cell's
// persisted indicator state (instances + configs + AVWAP anchors) onto a sibling
// cell's scope. Same instance ids across cells is the invariant that makes
// settings edits addressable everywhere; anchors re-key to the sibling's own
// epic (a timestamp transfers cleanly across symbols — each cell anchors its
// own symbol's VWAP at the same moment in time).
//
// Runs inside withLayoutEventsSuppressed (a mirror write must not look like a
// user edit: no template autosave, and no re-entry into the App-level
// layout-changed subscription that calls us) and withHistorySuppressed (a
// sibling's undo stack must not record mirrored writes — same rule as
// template apply).
import {
  loadIndicators, saveIndicators,
  loadIndicatorConfigs, saveIndicatorConfig, deleteIndicatorConfig,
  loadAvwapAnchor, saveAvwapAnchor,
} from "./persist";
import { withLayoutEventsSuppressed } from "./persist/layoutEvents";
import { withHistorySuppressed } from "./history";

export interface SyncCellRef {
  scope: string;
  epic: string;
}

export function mirrorIndicatorState(origin: SyncCellRef, sibling: SyncCellRef): string[] {
  return withHistorySuppressed(() =>
    withLayoutEventsSuppressed(() => {
      const srcList = loadIndicators(origin.scope);
      const srcCfgs = loadIndicatorConfigs(origin.scope);
      const dstListBefore = loadIndicators(sibling.scope);
      const dstCfgs = loadIndicatorConfigs(sibling.scope);
      const dstById = new Map(dstListBefore.map((i) => [i.id, i]));

      const changed = new Set<string>();

      // Instance list: full replace (the sibling's set BECOMES the origin's).
      for (const inst of srcList) {
        const prev = dstById.get(inst.id);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(inst)) changed.add(inst.id);
      }
      const srcIds = new Set(srcList.map((i) => i.id));
      // Ids leaving the set are "changed" too — the caller's live reconcile
      // (syncIndicatorsFromStorage) is what removes their panes, and it only
      // runs when something changed.
      for (const prev of dstListBefore) {
        if (!srcIds.has(prev.id)) changed.add(prev.id);
      }
      if (
        dstListBefore.length !== srcList.length ||
        dstListBefore.some((i, idx) => JSON.stringify(i) !== JSON.stringify(srcList[idx]))
      ) {
        saveIndicators(sibling.scope, srcList);
      }

      // Configs: copy per id; drop sibling configs whose id left the set.
      for (const inst of srcList) {
        const src = srcCfgs[inst.id];
        const dst = dstCfgs[inst.id];
        if (JSON.stringify(src ?? null) !== JSON.stringify(dst ?? null)) {
          changed.add(inst.id);
          if (src) saveIndicatorConfig(sibling.scope, inst.id, src);
          else deleteIndicatorConfig(sibling.scope, inst.id);
        }
      }
      for (const id of Object.keys(dstCfgs)) {
        if (!srcIds.has(id)) deleteIndicatorConfig(sibling.scope, id);
      }

      // AVWAP anchors: origin's per-epic anchor lands under the sibling's epic.
      for (const inst of srcList) {
        if (inst.type !== "AVWAP") continue;
        const a = loadAvwapAnchor(origin.scope, origin.epic, inst.id);
        if (loadAvwapAnchor(sibling.scope, sibling.epic, inst.id) !== a) {
          changed.add(inst.id);
          saveAvwapAnchor(sibling.scope, sibling.epic, inst.id, a);
        }
      }

      return [...changed];
    }),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/indicatorSync.test.ts`
Expected: PASS (all 5). Then full suite: `npm run test:unit` — green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicatorSync.ts frontend/src/lib/indicatorSync.test.ts
git commit -m "feat(indicators): storage-level mirror helper for indicator sync"
```

---

### Task 3: Live replication in App — subscription, seed, split, symbol change

**Files:**
- Modify: `src/App.tsx`
- Test: extend `src/lib/indicatorSync.test.ts` only if you extract logic; App wiring itself is verified by typecheck + the Task 4 browser check.

**Interfaces:**
- Consumes: `mirrorIndicatorState`, `SyncCellRef` (Task 2); `syncIndicatorsFromStorage(chart, controller, scope, epic, resolution, rebuildIds)` from `./lib/indicators` (already exported); `withHistorySuppressed` from `./lib/history`; `onLayoutChanged` from `./lib/persist/layoutEvents`; App's `readyRef` (`Map<string, { chart, controller }>`, ~line 900), `tabs` state, `focusedCell`.
- Produces: `seedIndicatorSync(tab, originCellId)` (referenced by Task 1's toggle branch).

- [ ] **Step 1: The replication helper + subscription**

In `src/App.tsx` (near `onCellReady`, ~line 936), add:

```ts
  // --- Sync indicators (layout toggle): storage-level mirror ------------------
  // Copy `origin`'s persisted indicator state to every other cell of `tab`, then
  // reconcile each mounted sibling chart in place. Mirror writes are event- and
  // history-suppressed, so this never re-triggers itself.
  const replicateIndicators = useCallback((tab: ChartTab, originCellId: string) => {
    const origin = tab.cells.find((c) => c.id === originCellId);
    if (!origin) return;
    for (const sib of tab.cells) {
      if (sib.id === originCellId) continue;
      const changed = mirrorIndicatorState(
        { scope: origin.scope, epic: origin.symbol.epic },
        { scope: sib.scope, epic: sib.symbol.epic },
      );
      const entry = readyRef.current.get(sib.id);
      if (entry && changed.length > 0) {
        withHistorySuppressed(() =>
          syncIndicatorsFromStorage(
            entry.chart, entry.controller, sib.scope, sib.symbol.epic,
            sib.period.resolution, new Set(changed),
          ),
        );
      }
    }
  }, []);

  // Live tabs for the subscription below (a subscription must not re-bind per render).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const replicateRef = useRef(replicateIndicators);
  replicateRef.current = replicateIndicators;

  useEffect(() => {
    // Coalesce the several writes of one gesture (applyIndicator writes config +
    // list + anchor back-to-back) into one mirror pass per origin scope.
    const pending = new Set<string>();
    let queued = false;
    const off = onLayoutChanged((changedScope) => {
      const tab = tabsRef.current.find(
        (t) => t.syncIndicators && t.cells.some((c) => c.scope === changedScope),
      );
      if (!tab) return;
      pending.add(changedScope);
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const scopes = [...pending];
        pending.clear();
        for (const scope of scopes) {
          const t = tabsRef.current.find(
            (tt) => tt.syncIndicators && tt.cells.some((c) => c.scope === scope),
          );
          const cell = t?.cells.find((c) => c.scope === scope);
          if (t && cell) replicateRef.current(t, cell.id);
        }
      });
    });
    return off;
  }, []);
```

Imports to add at the top of App.tsx: `mirrorIndicatorState` from `./lib/indicatorSync`, `syncIndicatorsFromStorage` from `./lib/indicators`, `withHistorySuppressed` from `./lib/history`, `onLayoutChanged` from `./lib/persist/layoutEvents`. (`ChartTab` is already imported.)

- [ ] **Step 2: Toggle-on seed**

Define right after `replicateIndicators`:

```ts
  // Toggle-on: the focused cell's set becomes the layout's set (destructive to
  // siblings by design — consistent with the other sync toggles acting
  // immediately; no confirmation).
  const seedIndicatorSync = replicateIndicators;
```

…and in Task 1's `toggleSync` `"indicators"` branch, replace the placeholder comment with `seedIndicatorSync(active, focusedCell.id);` (it must run BEFORE the flag flips — the seed itself doesn't read the flag, so order only matters for clarity).

- [ ] **Step 3: Seed fresh cells on layout growth**

In `setLayout` (~line 1409): the growth branch clones `base` (the focused cell) into new cells with fresh empty scopes. After the `while (cells.length < want)` loop, inside the `if (cells.length < want)` block, add:

```ts
          // Sync-indicators tabs seed the new cells' storage NOW (before the cell
          // mounts), so hydration finds the shared set and no template auto-apply
          // races it.
          if (t.syncIndicators) {
            for (const c of cells) {
              if (c.scope === base.scope) continue;
              mirrorIndicatorState(
                { scope: base.scope, epic: base.symbol.epic },
                { scope: c.scope, epic: c.symbol.epic },
              );
            }
          }
```

(Mirroring already-seeded siblings again is a cheap no-op — the diff returns empty.)

- [ ] **Step 4: Re-seed anchors after a symbol change in a synced cell**

AVWAP anchors are per-epic, so a cell switching symbol may land on an epic with no anchor written yet. In `setSymbol` (~line 1354), inside `confirmReplayLoss`'s `onConfirm` callback after the `setTabs(...)` call, add:

```ts
        // Synced tabs: the changed cell's new epic may have no AVWAP anchors yet —
        // mirror from a sibling so the curves recompute there too. Runs on the next
        // microtask so tabs state has settled; the layout-changed subscription
        // can't cover this (a symbol change writes no indicator storage).
        if (active.syncIndicators) {
          queueMicrotask(() => {
            const t = tabsRef.current.find((tt) => tt.id === active.id);
            const other = t?.cells.find((c) => c.id !== focusedCell.id);
            if (t && other) replicateRef.current(t, other.id);
          });
        }
```

- [ ] **Step 5: Typecheck + full suite**

Run: `cd frontend && npx tsc -b 2>&1 | tail -5` (no new errors) and `npm run test:unit`.
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(layout): live indicator mirroring for Sync indicators tabs"
```

---

### Task 4: Browser sanity check (agent bridge or manual)

**Files:** none (verification only).

- [ ] **Step 1: Run the app and verify live**

`cd frontend && npm run dev` (and the backend if not running: `cd backend && uvicorn auto_trader.api.app:app --port 8000` — check README for the exact command). Open http://localhost:5173, pick a 2-row layout, enable "Sync indicators" in the layout dropdown (□ menu), then verify:
1. Toggle-on replaced the second cell's indicators with the focused cell's (same set).
2. Adding an EMA in either cell makes it appear in both; editing its length in cell A updates cell B; legend ✕ in B removes it from A.
3. Add an AVWAP, click to place its anchor — the curve appears in both cells; drag the anchor — both follow.
4. Sub-pane collapse in one cell does NOT collapse the other (view state stays per-cell).
5. Toggle off → cells keep their sets and drift independently.
6. Split 2→4 cells while on → new cells come up with the shared set.

If the Agent UI Bridge is available (`http://localhost:8000/mcp`), `ui_read_state`/screenshots may help, but manual/Chrome-tool clicking through is fine.

- [ ] **Step 2: Fix anything found, re-run `npm run test:unit`, commit fixes.**

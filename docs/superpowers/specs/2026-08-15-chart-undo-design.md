# Per-cell Ctrl+Z undo for chart drawings & config

**Date:** 2026-08-15
**Status:** Approved

## Summary

Add undo/redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y) for chart-cell
content: drawings, indicators (add/remove/param edits/visibility), and AVWAP
anchors. Each chart cell keeps its own in-memory history; Ctrl+Z targets the
focused cell only. Pan/zoom, backtest config, and workspace/tab operations are
out of scope.

The mechanism is snapshot-at-the-persistence-choke-points: every undoable
mutation already funnels through a handful of typed save functions in
`frontend/src/lib/persist/artifacts.ts` with fully serialized state, so history
records `(storage key, before, after)` deltas there and undo re-enters through
the same `save()` path, keeping the backend mirror and cross-tab sync correct.

## Goals

- Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y) undo/redo the focused cell's last
  drawing/indicator/AVWAP mutation, in place, without a chart-grid remount.
- Undone state survives reload/sync exactly as if the user had made the edit
  by hand (writes go through `save()`, mirror, and broadcast).
- A drag gesture or debounced param edit is one undo step, not many.
- Never undo over another tab/device's edit.

## Non-goals

- Undo for pan/zoom (floods the stack), backtest/sweep config, workspace/tab
  operations (the existing merge-undo snackbar stays as is).
- Cross-epic undo: switching the cell's symbol clears its history.
- History UI (toolbar buttons, history panel), persistence of history across
  reloads, or "nothing to undo" toasts. Silent no-op, like TradingView.

## Architecture

### 1. History model — `frontend/src/lib/history.ts` (new)

`HistoryManager` class, one instance per chart cell, owned by
`ChartController` alongside `overlays`. In-memory, session-only.

```ts
interface HistoryEntry {
  key: string;     // full storage key, e.g. auto-trader.tab.A.cell.b.drawings.US100
  before: unknown; // JSON value before the write (undefined = key absent)
  after: unknown;  // JSON value after
  at: number;      // capture time, for coalescing
}
```

- A history **step** is a small group of per-key deltas, not a single delta:
  removing an indicator writes two keys in one gesture (`indicators` list +
  `indicatorConfig` map), and one Ctrl+Z must revert both. Undo applies a
  step's deltas newest-first; redo oldest-first.
- Two stacks (undo/redo), undo capped at 100 steps (drop oldest).
- A new capture clears the redo stack.
- **Grouping/coalescing:** a capture arriving within 800 ms of the top undo
  step's last capture merges into it — same key updates that delta's `after`
  (keep the original `before`); a new key appends a delta. This collapses
  drawing drags (which persist repeatedly mid-gesture), the settings modal's
  400 ms-debounced param edits, and multi-key gestures into one step. A step
  that crossed the stacks via undo/redo is closed to further merging.
- **No-op discard:** captures where `before` deep-equals `after` are dropped.
- Module-level `scope → HistoryManager` registry: `ChartController` registers
  on construction, unregisters on dispose. A capture for an unregistered
  scope is a no-op — template auto-apply during mount, migrations, and
  background scopes never pollute a stack.
- `withHistorySuppressed(fn)` guard (same idiom as
  `withLayoutEventsSuppressed` in `lib/persist/layoutEvents.ts`) wraps:
  undo/redo application itself (including the applier's side-writes, e.g.
  `removeIndicatorById`'s config delete) and `syncStrategyOverlays`'
  programmatic indicator adds. Snapshot restore (`writeSnapshotToScope`) and
  remote-push application need no suppression: they write to unregistered
  scopes / bypass the artifacts save functions entirely.
- Snapshot cells (`controller.readOnly`) never register.

### 2. Capture — hooks in `lib/persist/artifacts.ts`

The undoable surface is exactly these save functions: `saveDrawings`,
`saveIndicators`, `saveIndicatorConfig`, `saveIndicatorVisible`,
`patchIndicatorExtend`, `deleteIndicatorConfig`, `saveAvwapAnchor`. Each gets
one added call: before `save()`, call `historyCapture(scope, key, before,
after)`, where `before` is a `load()` of the current value (the config-map
functions already load it).

`OverlayManager.rehydrate()`'s re-persist is already guarded by its
`hydrating` counter, and any residual write is byte-identical and discarded
by the no-op check.

### 3. Undo/redo application

`undo()` pops the top entry, writes `entry.before` back through
`save(key, value)` (or `removeKeyEverywhere` when `before` is `undefined`),
pushes the entry onto the redo stack, and notifies an **applier** so the live
chart reflects the restored storage. `redo()` is symmetric with
`entry.after`. Appliers are registered by the owning subsystem and dispatched
on the key's suffix:

| Key suffix | Applier |
|---|---|
| `drawings.<epic>` | `overlays.rehydrate()` + `coverDrawingAnchors()` — the template-apply path (`lib/templates.ts:195-199`). If the entry's epic isn't the cell's current epic, storage is already correct and the live apply is skipped. |
| `indicators`, `indicatorConfig` | new `syncIndicatorsFromStorage(chart, controller, scope)` in `lib/indicators.ts`: diff live instances vs the restored list, `removeIndicatorById` the extras, `addIndicatorInstance` the missing, re-apply configs to survivors, `controller.indicators.set(...)`. In-place — never the `setHydrateEpoch` grid remount that remote pushes use today. |
| `avwap.<epic>.<id>` | re-anchor via the existing AVWAP apply path. |

### 4. Invalidation

- **Remote push:** `App.onBackendPush(key)` (App.tsx:681) clears both stacks
  of the cell whose scope owns `key`, before its existing handling. Matches
  the `pendingUndo.sigAfter` philosophy: never undo over someone else's edit.
- **Symbol change:** the cell's stacks are cleared when its epic changes.

### 5. Keyboard wiring — `ChartCore.tsx`

- Wrap-level `onKeyDown` mod-key block (next to ⌘C/⌘V, ChartCore.tsx:3660):
  `mod+z` → undo, `mod+shift+z` / `mod+y` → redo. `preventDefault()` only
  when a step was actually applied; the block already bails for
  `INPUT|TEXTAREA|SELECT` / contentEditable, so browser-native text undo is
  untouched.
- Document-level fallback for the app-focused cell, cloned from the
  Delete/Backspace fallback (ChartCore.tsx:3513-3536) with its input/modal
  guards verbatim — Ctrl+Z must work right after clicking a sidebar button.
- No conflict with ⌘S (App-level save-layout) or Alt+I (invert).

## Error handling

- Undo application is wrapped so a failed live apply (e.g. chart momentarily
  detached) still leaves storage restored; the next rehydrate converges.
- `save()` returning `false` (quota) aborts the step and leaves the entry on
  its stack.
- Entries whose epic no longer matches the cell skip the live apply but still
  restore storage.

## Testing

- `lib/history.test.ts`: capture/undo/redo ordering, coalescing window,
  no-op discard, 100-entry cap, redo-clear on capture,
  unregistered-scope no-op, suppression guard, clear-on-invalidate.
- Persist capture integration: mutate via `saveDrawings` /
  `saveIndicatorConfig` against a registered scope; assert entries recorded
  and that undo restores the exact prior storage value through `save()`.
- `syncIndicatorsFromStorage`: diff behavior (add/remove/config-reapply)
  against a mock chart.
- Keyboard: manual smoke test in the running app (the existing
  Delete-fallback has no automated test either); guards are cloned verbatim
  from it.
- Known-failing frontend baseline tests (5-7 on main) are left alone.

## Files touched

- `frontend/src/lib/history.ts` — new
- `frontend/src/lib/persist/artifacts.ts` — capture calls
- `frontend/src/lib/chartController.ts` — own + register HistoryManager
- `frontend/src/lib/indicators.ts` — `syncIndicatorsFromStorage`
- `frontend/src/ChartCore.tsx` — key handling + applier registration
- `frontend/src/App.tsx` — one line in `onBackendPush`
- tests as above

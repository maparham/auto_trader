# Alert write decoupling — targeted per-ID edits instead of full-snapshot overwrite

**Date:** 2026-07-08
**Status:** Approved (design)

## Problem

Price alerts (and, as collateral, drawings) vanish untriggered — sometimes live on
screen, sometimes on a plain timeframe switch, sometimes across tabs. Each incident
traced back to the **same write model**, not to any one code path:

`OverlayManager.persist()` serializes the cell's **entire** in-memory overlay set and
**overwrites** two shared storage keys — the per-cell drawings key and the
global-per-epic alerts key (`auto-trader.b.<broker>.alerts.<epic>`). Two consequences
follow directly from "full-snapshot overwrite":

1. **A mistimed write is catastrophic, not localized.** If `persist()` fires while the
   in-memory model is transient (mid-rebuild, mid-symbol-change, mid-drag,
   half-reconciled), it doesn't corrupt one field — it stomps the whole list to a
   partial or empty set. The codebase defends this soft spot with a stack of "don't
   persist right now" guards (`hydrating`, `hydratedEpic !== epic`, `reconciling`,
   `draggingAlert`). The 2026-07-08 timeframe-switch vanish was simply a hole in that
   fence: during `rehydrate()`'s teardown, removing an alert overlay rang the alerts
   signal, the cell's own `reconcileAlerts()` ran, and its `guarded()` `finally` cleared
   the shared `hydrating` boolean **mid-teardown** — so the remaining removals persisted
   a shrinking list (4 → 2 → 1 → 0), then the rebuild re-read the emptied key and drew
   nothing.

2. **Alerts and drawings are co-mingled in one write.** `persist()` writes BOTH keys on
   every call, so a drawing action re-writes the (unchanged) alerts key, and the alert
   spiral above wiped the drawings key too (the debug log caught `PERSIST nA=2 nD=0`
   followed by `"[]"` written to the drawings key). Drawings only ever vanished when the
   chart **also** had an alert — the alert removal is what un-guarded the write; the
   drawing was collateral.

A tactical fix already landed (making `hydrating` a depth counter so a nested guarded
block can't un-guard its caller, plus not bumping the alerts signal for programmatic
removals). That stops the current vanish for both alerts and drawings. This design
removes the **class**: it makes it structurally impossible for a redraw/rehydrate to
write the alert list at all.

## Goal

- A redraw, timeframe switch, symbol switch, or rebuild writes the alerts key **zero
  times** — because none of them is a user *intent*.
- Alert changes are **targeted edits by stable ID** against the saved list, never a
  whole-list snapshot of the chart's view.
- Decouple alert writes from drawing writes: a drawing action never touches the alerts
  key, and vice-versa.
- No storage-format change, therefore **no migration** (consistent with the project's
  no-legacy-code rule).

## Non-goals

- Drawings stay on the current whole-list save. They have one writer per cell and rich
  mutable state (points, styles, layers, visibility, lock, extendData) that is awkward
  to edit piecemeal, and they are now protected by the depth-counter guard. Revisit only
  if a drawings-specific vanish appears.
- The residual **simultaneous cross-tab edit of the same alert** race (two tabs writing
  the same instant → last-writer-wins) is not closed here. It is a microsecond human-
  unhittable race, versus today's routine-redraw wipe. The delta model is the correct
  foundation if we ever choose to close it (e.g. merge-at-write).

## Design

### Principle

Flip ownership. Today the **chart** is authoritative: whatever it holds in memory
overwrites the saved list. In the new model the **saved list** is authoritative, and the
chart is a *view* of it. Alert mutations are dispatched as small edits to the saved list;
the chart re-renders to match. A view operation (redraw/rehydrate) produces no edit, so
it cannot write.

### 1. Storage-level edit functions (`frontend/src/lib/persist/alerts.ts`)

Three by-ID intent functions, each a load → modify-one → save:

- `addStoredAlert(epic, alert, broker?)` — **new.** Append one alert; no-op if an alert
  with the same `id` already exists (idempotent, so a double-dispatch or a
  create-then-reconcile can't duplicate). Preserves the caller's `id` and `createdAt`.
- `updateStoredAlert(epic, id, level, cfg, broker?)` — **exists.** Replace one alert's
  level + config in place, keeping its `id`/`createdAt`; other rows untouched.
- `deleteStoredAlert(epic, id, broker?)` — **exists.** Remove one alert by `id`; no-op if
  absent.

All three go through the existing mirrored `save()` (localStorage + backend mirror + the
cross-tab `/ws/state` push), so peers converge exactly as they do today. Callers bump the
`alertsChanged` signal after mutating so every mounted cell and the engine reconcile.

### 2. `OverlayManager` (`frontend/src/lib/overlays.ts`) routes actions through them

Reroute each alert lifecycle action from `persist()` to the matching intent:

- create-via-chart-click (`addAlert`) → `addStoredAlert(epic, {id, level, ...cfg,
  createdAt})`, then bump.
- edit (settings modal via overlay, `updateAlert`) → `updateStoredAlert`.
- drag-end (`endAlertDrag` / `onPressedMoveEnd` for an alert) → `updateStoredAlert` with
  the dropped level.
- delete-via-chart (`onRemoved` for an alert) → `deleteStoredAlert` — **only when the
  removal is a genuine user delete**, i.e. gated on `!this.hydrating` (programmatic
  teardown/reconcile removals must not write). This is the existing gate, now dispatching
  a delete intent instead of a full persist.

**`persist()` stops touching alerts.** It builds and writes only `drawings`; the
`saveAlerts(...)` call and the alerts arm of the `entries` loop are removed. `persist()`
is now drawings-only — this is the alert/drawing write split, achieved by subtraction.

### 3. The chart is a pure view of the saved list

`reconcileAlerts()` already materializes the saved list into on-chart lines (adds alerts
present in storage but not on the chart, drops lines no longer in storage, and syncs
drifted levels/config), keyed by stable `id`. It remains the single alert draw path,
driven by the `alertsChanged` signal. `rehydrate()`'s alert arm keeps materializing from
`loadAlerts()` — that is a *render*, and it no longer has any paired write.

Because no alert write is derived from the chart's in-memory snapshot, a
rehydrate/redraw/teardown emits nothing to the alerts key. The alert-specific reason for
the write guards disappears.

**Create-then-select detail:** on create, `addAlert` writes storage and bumps; the line
is drawn by the ensuing reconcile. To keep the just-created alert selected (the user
clicked to place it), `addAlert` remembers the new `id` and selects the materialized line
in the reconcile pass (the same by-saved-id selection restoration `rehydrate()` already
does). This keeps a single draw path rather than drawing the line twice.

### 4. Background engine (`frontend/src/lib/alertEngine.ts`)

When a `once` alert fires or an alert expires, remove **that alert by ID** via
`deleteStoredAlert(epic, id, broker)` (looping if a tick removes more than one) instead of
`saveAlerts(epic, survivors, broker)`. One writer, one ID per removal, no whole-list
overwrite — so a concurrent user edit on the same epic can't be clobbered by the engine
re-writing a stale survivor list. The engine never *adds* alerts, so no add path is
needed here.

### 5. Guards: what changes, what stays

- **Removed reason:** the alerts key no longer has any snapshot write to mistime, so the
  guards no longer protect *alert data* — their alert-motivated purpose is gone.
- **Kept:** `hydrating` (depth counter) and `hydratedEpic !== epic` still gate the
  **drawings** `persist()` (drawings remain snapshot). `reconciling` re-entrancy guard
  stays — reconcile still removes/creates overlays which fire the alerts signal, and it
  must not recurse into itself. `draggingAlert` stays — a peer's bump mid-drag must not
  snap the dragged line back before the drop writes the final level.
- The already-landed depth-counter fix + its regression test remain.

### 6. Cleanup

Remove the temporary debug instrumentation added during investigation:
- `debugLog()` + the debug endpoint (`backend/.../routers/state.py`,
  `POST /api/debug/overlay-log`) and `backend/overlay_debug.jsonl`.
- All `debugLog(...)` call sites in `overlays.ts`, `persist/core.ts`, `alertEngine.ts`,
  and the mock stub in `alertEngine.test.ts`.
- The `mgrId` debug field on `OverlayManager`.

## Data flow (after)

```
user creates/moves/deletes an alert
        │
        ▼
OverlayManager  ──►  addStoredAlert / updateStoredAlert / deleteStoredAlert  (by id)
                                    │
                                    ▼
                     save()  ──►  localStorage + backend mirror + /ws/state push
                                    │
                                    ▼  bump alertsChanged
        ┌───────────────────────────┴───────────────────────────┐
        ▼                                                         ▼
every mounted cell: reconcileAlerts()                 background engine: re-read list
   (render saved list → chart lines)                  (evaluate ticks; delete fired-once by id)

redraw / timeframe switch / rehydrate  ──►  reconcileAlerts() only  ──►  NO write
```

## Testing

- **New:** `addStoredAlert` appends and is idempotent by `id` (a second add of the same
  id is a no-op; a different id appends).
- **New (the key proof):** a full `rehydrate()`/teardown of a cell holding alerts +
  drawings, with the live `alertsChanged → reconcileAlerts` wiring attached, writes the
  alerts key **zero times** (spy/count on the alerts save path). This is the strongest
  assertion that the class is dead — stronger than "the list survived."
- **Keep green:** all existing alert-identity, reconcile, drag/selection, and engine
  tests; the depth-counter regression test.

## Files touched

- `frontend/src/lib/persist/alerts.ts` — add `addStoredAlert`.
- `frontend/src/lib/overlays.ts` — reroute alert create/edit/drag/delete to intents;
  drop alerts from `persist()`; create-then-select via reconcile; remove debug.
- `frontend/src/lib/alertEngine.ts` — engine removal via `deleteStoredAlert`; remove debug.
- `frontend/src/lib/persist/core.ts` — remove `debugLog` + mirror/ws/hydrate debug hooks.
- `backend/auto_trader/api/routers/state.py` — remove debug endpoint.
- Tests: `overlays.test.ts`, `alertEngine.test.ts` (+ remove the mock's `debugLog` stub).

## Risks

- **Create-then-select via reconcile** is the one behavioral nuance (selection + avoiding
  a double-draw). Mitigation: reuse the existing by-saved-id selection restoration path;
  cover with a test that a chart-created alert ends up selected.
- **Order of operations in `onRemoved`** — the delete intent must fire only for genuine
  user deletes (`!hydrating`), matching today's gate, or a teardown would delete from
  storage. Covered by the zero-write rehydrate test.

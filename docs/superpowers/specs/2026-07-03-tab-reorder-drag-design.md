# Modern tab drag-to-reorder — design

**Date:** 2026-07-03
**Status:** approved

## Problem

Reordering chart tabs today is drag-and-drop with a 2px vertical accent line as the only drop indicator. Three pains, confirmed with the user:

1. **Hard to see where it lands** — the thin line is easy to miss.
2. **Feels dead** — tabs don't move or react during the drag; the only feedback is the source chip dimming to 40% opacity.
3. **Fiddly** — the drop position is chosen per-chip by which half of a hovered chip the cursor is in, so you have to aim at thin edge zones.

The center ~40% of a hovered chip is the **merge** zone (drag-to-merge into a split layout), which must keep working, as must dragging a tab onto the chart body (ChartGrid's merge overlay, signalled via `onDragActive`).

## Chosen approach

**Floating tab + slide-apart**, built on the existing HTML5 drag-and-drop machinery (not a pointer-events rewrite, not a library). Rejected alternatives: slide-apart-only (grabbed tab still looks dead as the native ghost) and a full pointer-events rewrite (must rebuild the drag-onto-chart merge path; high effort for marginal gain).

## Behavior

- **Pickup:** dragging a tab hides the browser's native drag snapshot; a clean copy of the chip follows the cursor — slightly enlarged with a soft shadow. The original chip turns invisible but keeps its space (a natural hole in the bar).
- **Reorder targeting:** the landing spot is the insertion gap nearest the cursor, measured across the whole bar — no aiming at chip edges. Neighboring tabs slide sideways (~150ms CSS transition) to hold the gap open; the gap flows with the cursor.
- **Merge targeting:** cursor over the middle ~40% of another chip (and `canMerge` allows it) wins over reorder — the gap closes and that chip gets the existing highlight outline. Release merges, exactly as today.
- **Merge-to-chart:** unchanged. The floating chip simply follows the cursor over the chart area; ChartGrid's overlay works as it does now.
- **Drop:** the floating chip glides into the open gap, then the real reorder applies. Esc / cancelled drag animates everything back with no change.

## Implementation

All changes in `frontend/src/TabBar.tsx` and `frontend/src/App.css`. `App`'s callbacks (`onReorder(from, to)`, `onMerge(targetId, sourceIds)`, `canMerge`, `onDragActive`) are untouched.

- **Keep HTML5 DnD events** (`dragstart`/`dragover`/`drop`/`dragend`). This preserves the merge-to-chart path and existing e2e tests.
- **Floating chip:** on `dragstart`, `setDragImage` with a transparent 1px image; render a `position: fixed`, `pointer-events: none` clone of the chip above everything and move it from the `clientX/Y` the drag events already provide. The source chip gets `visibility: hidden` (keeps layout space).
- **Gap logic:** the bar container measures all chip rects once at drag start and computes the nearest insertion index from cursor X. Merge-zone test (middle 40% + `canMerge`) is evaluated centrally and wins over reorder. Non-dragged chips get `translateX(±gapWidth)` transforms with a transition — that is the slide-apart. The `drop-before`/`drop-after` pseudo-element line CSS (App.css:310–322) is deleted; `drop-merge` outline stays.
- **Drop/cleanup:** on drop, animate the clone to the target rect, then call `onReorder`/`onMerge`, remove the clone, clear transforms. The existing `useEffect` guard for Chrome-swallowed `dragend` (source chip unmounting mid-drag) is extended to remove the clone and reset transforms. Foreign drags (not started from this bar) remain ignored.

## Testing

- Existing Playwright reorder and merge e2e tests should pass unchanged (same events, same callbacks, same drop semantics).
- Add one e2e check: during a drag-hover a neighboring chip carries a transform (gap open), the floating chip element exists, and after drop it is removed and no transforms remain.

## Out of scope

- Right-click / keyboard reorder alternatives.
- Any change to merge semantics, the 4-cell cap, or the MergeTabsMenu popover.

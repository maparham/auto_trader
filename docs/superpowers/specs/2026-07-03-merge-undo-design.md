# Merge undo snackbar — design

2026-07-03

## Problem

Merging tabs is a move with no confirmation on the drag gestures (deliberate — see the merge-tabs spec). The durable-save fix guarantees nothing is ever lost, but a mis-drop still costs a manual detach to reverse. A short-lived undo offer makes the gestures safe without adding confirmation friction.

## Decision

A TV-style snackbar shown after every successful merge, anchored just below the merged tab's chip in the tab bar (top of the app — where the merge happened; falls back to top-center if the chip can't be located): "Merged into <lead symbol> · <TF>" + accent **Undo** button + subtle ✕. Auto-dismisses after 8 seconds; the timer pauses while hovered. One snackbar per merge *operation* — a checklist merge of several tabs gets a single undo that restores all of them.

## Inverse operation

`mergeTabInto` (persist.ts) additionally returns the moved scope pairs `{from, to}[]` it already computes. App's `mergeTabs` collects, across the whole operation:

- the pre-merge `tabs` array (immutable snapshot — a reference is enough),
- the pre-merge `activeId`,
- all moved scope pairs.

Undo (`unmergeScopes(pairs)` in persist.ts + restore in App):

1. For each pair: `copyScopeContent(to → from)`, then `purgeScope(to)`. Copy-back means edits made on the merged cells during the toast window (new drawings etc.) travel back with them.
2. Restore the snapshot tabs array and the pre-merge active tab.
3. Persist the workspace synchronously (same durable rule the merge itself uses: `saveLayout` + clear dirty when a named layout is active, else `saveScratch`).

No cap/validity checks: the snapshot is a known-good prior state.

## Snackbar component

New `Snackbar.tsx`: content-sized pill, plain copy, light-theme-first, follows the existing toast visual idiom. Rendered by App only while `pendingUndo` is set; an `anchorSelector` prop positions it under the merged tab's chip (clamped to the viewport, re-placed on window resize). Buttons: **Undo** (accent) and ✕ (dismiss). The 8s timer lives in the component; hover pauses it.

## Invalidation

`pendingUndo` clears (snackbar vanishes) on:

- timer expiry or ✕,
- Undo itself,
- another merge (replaced by the new operation's undo),
- any structural tab mutation: tab close, cell close, detach, layout-kind change, tab add,
- broker switch, named-layout switch, workspace reload/backend push.

Non-structural changes (symbol, timeframe, crosshair, panning) do NOT clear it. Consequence, accepted and documented: undo restores the full pre-merge snapshot, so a TF/symbol change made inside the 8-second window is reverted by undo.

## Testing

- Unit (persist.test.ts): merge → unmerge round-trip restores tab structure byte-equal (ids, scopes, layout, sizes, sync flags, activeCellId) and content back under old scopes with new scopes purged; an edit saved under the NEW scope between merge and undo survives the trip back to the old scope.
- e2e (merge-tabs.spec.ts): context-menu merge → snackbar visible → Undo → two tabs again, t2's drawing back under its original scope, sync flags restored, workspace persisted; merge → detach → snackbar gone (structural invalidation); snackbar auto-dismiss leaves the merge in place.

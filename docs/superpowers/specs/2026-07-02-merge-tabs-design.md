# Merge tabs (inverse of cell detach) — design

2026-07-02

## Problem

Building a multi-chart layout today means picking a tab and adding blank cells one by one, then re-configuring each. Users often already have the charts they want open as separate tabs and just want to see them together in one synced view.

## Decisions (from brainstorming)

- **Move, not copy**: merging collapses the source tab into the target tab; the source tab closes. Un-merging is the existing per-cell detach button.
- **All cells come across**: if the source tab is itself a split, every one of its cells moves. Merges that would exceed the 4-cell layout cap are blocked with a clear message.
- **Interval, crosshair and date-range sync all turn on** after a merge (user decision 2026-07-02, superseding the earlier crosshair-only default); symbol sync stays off (merged tabs usually intentionally differ in symbol). Cells keep their own timeframe at merge time — interval sync applies from the next timeframe change.
- Three gestures, all sharing one core operation: tab context menu, drag tab onto the chart, drop tab onto another tab chip.

## Core operation

`mergeTab(sourceTabId, targetTabId)`:

1. Guard: `source.cells.length + target.cells.length <= 4`, else refuse with a message ("would exceed 4 charts").
2. Append the source tab's cell objects to the target's `cells`, **re-scoped** to the target tab: each moved cell gets a fresh `tab.<targetId>.cell.<cellId>` scope (`cellScope`), its content is copied there via `copyScopeContent`, and the source tab's whole scope prefix is purged (`purgeTabScope`). This preserves the invariant that `closeTab`/`deleteLayout` purge a tab's content by its own id prefix — a cell may never carry a foreign tab's scope string.
3. Re-derive `layout` from the new cell count (2 → "2h", 3 → "3", 4 → "4"). Reset custom `sizes` (same rule as any layout-kind change).
4. Set `activeCellId` to the merged-in source tab's lead cell (its former `activeCellId`).
5. Set `syncInterval = syncCrosshair = syncTime = true` on the target tab.
6. Remove the source tab from the workspace; if it was active, activate the target.

Alerts are global per epic — nothing to move. Same-epic cells in one tab are already handled by the existing full-resync reconcile.

## Gesture 1 — tab context menu

Right-click a tab chip opens a `ContextMenu` (the component cell-detach uses) with **"Merge into this tab…"**. That opens a small checklist of the *other* tabs (each labelled with the tab-tooltip text: cell names · timeframes; multi-cell tabs show their count). Tick one or more, confirm; ticked tabs merge in tab-bar order. Tabs whose cell count would push the total past 4 render disabled with "would exceed 4 charts". Live-updating: ticking tabs updates which remaining ones are disabled.

## Gesture 2 — drag tab chip onto the chart

The tab bar's existing HTML5 drag is the drag source. While a tab chip is dragged over the chart region, the chart shows a drop highlight split into two halves — left/right when the active layout is horizontally oriented, top/bottom otherwise. Dropping merges the dragged tab into the **active** tab; the drop side only decides whether the incoming cells are inserted before or after the existing cells in the `cells` array (cell order determines grid position). The grid shape remains the fixed layout kinds — this is deliberately **not** TradingView's arbitrary nested splits.

## Gesture 3 — drop tab chip onto another chip

Tab reorder already tracks before/after halves of a hovered chip. Add a **center zone** (middle ~40% of the chip width): hovering there shows a merge highlight on the whole chip instead of the insertion line; dropping there merges the dragged tab into the hovered tab. The outer edges keep meaning reorder, so the gestures don't conflict. Cap violations show the disabled/refusal state on hover (no drop).

## Un-merge

Already shipped: the per-cell detach button (left-click = clone to new tab; that remains a copy). Since a merge re-scopes moved cells under the target tab's own id (`tab.<targetId>.cell.<id>`), a merged-in cell is indistinguishable from any other cell in that tab — detach works unmodified, no foreign-scope handling needed.

## Edge cases

- Merging the last two tabs leaves a single (split) tab — fine.
- Persistence follows the same rules as tab close/reorder today (autosave or explicit save).
- Closing (or otherwise purging) any tab is always safe to do by prefix-purging its own id: merge already re-scoped every cell it holds under that id, so no tab's `purgeTabScope` can ever leave orphaned content behind or reach into another tab's scope.

## Testing

- Unit (`persist.test.ts` / App logic): cap enforcement, cells + scopes preserved verbatim, layout re-derived, sizes reset, source tab removed, focus set to merged lead, `syncInterval`/`syncCrosshair`/`syncTime` set, purge-on-close of a tab containing foreign-scoped cells removes exactly those scopes.
- e2e (`e2e/` Playwright): merge two tabs via the context menu → both charts render with their original drawings/indicators, source tab gone, all three sync toggles on; then detach one cell back out.

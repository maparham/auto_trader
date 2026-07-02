# Merge tabs (inverse of cell detach) — design

2026-07-02

## Problem

Building a multi-chart layout today means picking a tab and adding blank cells one by one, then re-configuring each. Users often already have the charts they want open as separate tabs and just want to see them together in one synced view.

## Decisions (from brainstorming)

- **Move, not copy**: merging collapses the source tab into the target tab; the source tab closes. Un-merging is the existing per-cell detach button.
- **All cells come across**: if the source tab is itself a split, every one of its cells moves. Merges that would exceed the 4-cell layout cap are blocked with a clear message.
- **Crosshair sync turns on** after a merge; symbol/interval sync toggles are left untouched (merged tabs usually intentionally differ in symbol/timeframe).
- Three gestures, all sharing one core operation: tab context menu, drag tab onto the chart, drop tab onto another tab chip.

## Core operation

`mergeTab(sourceTabId, targetTabId)`:

1. Guard: `source.cells.length + target.cells.length <= 4`, else refuse with a message ("would exceed 4 charts").
2. Append the source tab's cell objects to the target's `cells` **unchanged** — each cell already carries an opaque `scope` string, so drawings/indicators/settings move with it. No `copyScopeContent`, no `purgeScope` (the source tab's close path must NOT purge the moved cells' scopes).
3. Re-derive `layout` from the new cell count (2 → "2h", 3 → "3", 4 → "4"). Reset custom `sizes` (same rule as any layout-kind change).
4. Set `activeCellId` to the merged-in source tab's lead cell (its former `activeCellId`).
5. Set `syncCrosshair = true` on the target tab.
6. Remove the source tab from the workspace; if it was active, activate the target.

Alerts are global per epic — nothing to move. Same-epic cells in one tab are already handled by the existing full-resync reconcile.

## Gesture 1 — tab context menu

Right-click a tab chip opens a `ContextMenu` (the component cell-detach uses) with **"Merge into this tab…"**. That opens a small checklist of the *other* tabs (each labelled with the tab-tooltip text: cell names · timeframes; multi-cell tabs show their count). Tick one or more, confirm; ticked tabs merge in tab-bar order. Tabs whose cell count would push the total past 4 render disabled with "would exceed 4 charts". Live-updating: ticking tabs updates which remaining ones are disabled.

## Gesture 2 — drag tab chip onto the chart

The tab bar's existing HTML5 drag is the drag source. While a tab chip is dragged over the chart region, the chart shows a drop highlight split into two halves — left/right when the active layout is horizontally oriented, top/bottom otherwise. Dropping merges the dragged tab into the **active** tab; the drop side only decides whether the incoming cells are inserted before or after the existing cells in the `cells` array (cell order determines grid position). The grid shape remains the fixed layout kinds — this is deliberately **not** TradingView's arbitrary nested splits.

## Gesture 3 — drop tab chip onto another chip

Tab reorder already tracks before/after halves of a hovered chip. Add a **center zone** (middle ~40% of the chip width): hovering there shows a merge highlight on the whole chip instead of the insertion line; dropping there merges the dragged tab into the hovered tab. The outer edges keep meaning reorder, so the gestures don't conflict. Cap violations show the disabled/refusal state on hover (no drop).

## Un-merge

Already shipped: the per-cell detach button (left-click = clone to new tab; that remains a copy). No new work in this project beyond verifying it plays well with merged-in cells (their scopes are `tab.<otherTabId>.cell.<id>`-shaped strings — opaque, so fine).

## Edge cases

- Merging the last two tabs leaves a single (split) tab — fine.
- Persistence follows the same rules as tab close/reorder today (autosave or explicit save).
- Closing the merged tab later purges all its cells' scopes by the cells' own scope strings — `purgeTabScope`-style prefix purging by tab id must not be assumed anywhere the cells may have foreign-tab-prefixed scopes; audit purge call sites.

## Testing

- Unit (`persist.test.ts` / App logic): cap enforcement, cells + scopes preserved verbatim, layout re-derived, sizes reset, source tab removed, focus set to merged lead, `syncCrosshair` set, purge-on-close of a tab containing foreign-scoped cells removes exactly those scopes.
- e2e (`e2e/` Playwright): merge two tabs via the context menu → both charts render with their original drawings/indicators, source tab gone, crosshair sync on; then detach one cell back out.

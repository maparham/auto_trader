# Reorder bottom (sub-) panes

## Problem

The chart's bottom sub-panes (Volume, RSI, MACD, …) always appear in the order
they were added. There is no way to change that order after the fact. Users want
to reorder the bottom panes — both by dragging and via a menu — and have the new
order persist.

## Constraint

We use `@klinecharts/pro` on **klinecharts 9.8.12**, which has **no pane-move /
reorder API**. `createIndicator(value, isStack, paneOptions)` can only place a
new sub-pane at the bottom (or top via `paneOptions.position`), and
`getIndicatorByPaneId()` enumerates panes in creation order. There is no
`movePane`, no numeric pane index.

Therefore reordering is implemented by **tearing down and recreating panes in the
new order**. This is acceptable: the persisted per-cell indicator instance list
order is already what `hydrateIndicators()` replays on reload, so that list *is*
the saved pane order.

## Decisions

- **Unit of movement = the pane.** A pane holding more than one indicator moves
  as a whole (all its indicators are recreated together, preserving their
  in-pane stacking order).
- **Scope = all bottom panes**, including Volume.
- **Excluded / pinned:** the candle pane (`candle_pane`) and app-internal panes
  in `INTERNAL_INDICATORS` (e.g. the backtest equity curve). These are never
  reorderable and are never valid drop targets. They keep their klinecharts
  position.
- **Persistence = per cell.** Reorder rewrites the saved indicator list order, so
  named layouts and symbol templates (which already serialize that list) pick up
  the new order for free.
- **Two triggers:** drag-to-reorder and legend menu actions.

## Architecture

### 1. Reorder engine — `frontend/src/lib/indicators.ts`

New function:

```ts
reorderSubPanes(chart, controller, scope, movingPaneId, targetIndex): void
```

Steps:

1. Build the current ordered list of **reorderable** bottom paneIds:
   iterate `chart.getIndicatorByPaneId()`, skip `candle_pane` and any pane whose
   indicators are all in `INTERNAL_INDICATORS`.
2. Compute the desired ordered paneId list by moving `movingPaneId` to
   `targetIndex` within that list.
3. Find the first index where current ≠ desired (the divergence point).
   Everything above it is untouched.
4. For each pane from the divergence point down (in *current* order): read its
   height via `chart.getSize(paneId, DomPosition.Main).height`, capture its
   ordered indicator instances, then `removeIndicator(paneId)`.
5. Recreate those panes in *desired* order by calling the existing
   `applyIndicator()` path (reusing saved instance ids, `rehydrate: true`),
   passing the captured height so pane sizes are preserved. Multiple indicators
   in one pane are recreated onto the same fresh paneId.
6. Rewrite the persisted per-cell indicator list into the new global order
   (untouched panes + reordered tail) and update `controller.indicators` signal.

Notes:
- Recreation mints new paneIds. Any app state keyed by paneId (selection,
  legend cards, curve labels) is rebuilt from the fresh chart state the same way
  it already is after add/remove — reuse existing resync paths, don't invent new
  ones.
- Overlays stacked on `candle_pane` are never touched.

### 2. Legend menu actions — `frontend/src/ChartLegend.tsx`

Add **Move up** / **Move down** items to each sub-pane legend's gear menu.
Disabled when the pane is already first / last in the reorderable list. Each
calls `reorderSubPanes` with `targetIndex = currentIndex ∓ 1`.

### 3. Drag-to-reorder — `frontend/src/ChartLegend.tsx` + `ChartCore.tsx`

- A drag handle on the sub-pane legend card (the card is already DOM-positioned
  by `getSize(paneId).top`).
- On drag, track pointer Y against each reorderable pane's `top`/`height`
  (same `getSize` data `buildSubPaneLegends()` uses) to compute the hovered
  target slot; render a drop-indicator line between panes.
- Internal/candle panes are not valid slots — clamp the target to the
  reorderable range.
- On drop, call `reorderSubPanes(movingPaneId, targetIndex)`. A no-op drop (same
  slot) does nothing.
- Follow existing chart drag conventions (a `justDragged` guard so the drop
  doesn't also fire a click/select), consistent with trade-line/tab drag code.

### 4. Persistence — existing per-cell list

No new storage. `reorderSubPanes` rewrites the same per-cell indicator list that
`loadIndicators`/`saveIndicators` and `hydrateIndicators` already use, so:
- reload replays panes in the new order,
- named layouts and symbol templates serialize the new order automatically.

## Edge cases

- **Single reorderable pane:** menu actions disabled; drag is a no-op.
- **Pane with multiple indicators:** moved and recreated as a unit.
- **Equity/internal pane present:** filtered out of the reorderable list and
  skipped as a drop target; its position is left to klinecharts.
- **Reorder while an indicator is selected / has curve labels:** rebuilt via the
  existing post-mutation resync, same as add/remove.
- **HMR / stale controller:** guard as existing chart mutations do.

## Testing

- Playwright e2e (stub `/api/state` per existing indicator tests): add
  Volume + RSI + MACD, reorder via menu, assert pane order top-to-bottom;
  reorder via drag, assert order and drop indicator; reload and assert order
  persists; confirm equity pane stays pinned when present.
- Verify overlays on the candle pane are unaffected.

## Out of scope

- Reordering indicators *within* a pane.
- Moving a sub-pane indicator onto the candle pane (or vice versa).
- Upgrading klinecharts for a native pane-move API.

# Collapsible candle-pane legend (TV-style)

Date: 2026-07-02
Status: approved

## Goal

The candle-pane legend's indicator list can be collapsed behind a chevron, like
TradingView: collapsed, only the symbol/OHLC row (and a down-chevron chip)
remain. Per chart cell, persisted.

## Behavior

- A small chevron button renders as its own mini-row at the bottom-left of the
  candle legend, under the last indicator row.
- Expanded: chevron points up, revealed only while hovering the legend area
  (like the row action icons). Clicking collapses.
- Collapsed: all indicator rows are removed; the symbol/OHLC row stays; the
  chevron chip points down and is always visible (it's the only way back).
  Clicking expands.
- The chevron renders only when there is at least one indicator row.
- Sub-pane legend cards (Volume/MACD/RSI…) are unaffected.
- State persists per cell scope (each cell in a split layout independent),
  default expanded.

## Implementation

- `frontend/src/lib/persist.ts`: `loadLegendCollapsed(scope)` /
  `saveLegendCollapsed(scope, value)`, default `false`, modeled on the
  `scalePriceOnly` pair (`ns(scope, "legendCollapsed")`).
- `ChartCore.tsx`: `useState` seeded from `loadLegendCollapsed(scope)`;
  toggle handler saves and sets; pass `collapsed` + `onToggleCollapsed`
  props to `<ChartLegend>`.
- `ChartLegend.tsx`: when `collapsed`, skip rendering the candle indicator
  rows (conditional render — the figure-value spans unregister from
  `figureValuesRef`, which `updateValues` already tolerates). Add `collapsed`
  to the `updateValues(null)` effect deps so values repaint on expand.
  Render the chevron mini-row after the rows.
- CSS (`index.css`, existing `.cl-*` block): `.cl-collapse` chevron styled
  like the legend chips — content-sized, no shadows; hover-revealed when
  expanded, always visible when collapsed.

## Testing

- Unit: persist round-trip for the new load/save pair.
- Manual (Playwright/browser): add indicators, collapse → rows gone, chevron
  flips; expand → rows return with live values; reload → state restored;
  second cell in a split layout keeps its own state.

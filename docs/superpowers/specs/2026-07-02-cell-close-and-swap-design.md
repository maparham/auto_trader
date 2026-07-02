# Cell close & cell swap — design

Date: 2026-07-02
Status: approved

Two additions to multi-cell layouts (ChartGrid):

1. **Close a cell** — an ✕ button in the cell's corner controls removes that cell
   and downgrades the layout kind.
2. **Swap cells** — a two-way-arrow button on the border between each adjacent
   pair of cells swaps their positions.

## 1. Close a cell

### UI

- A third hover-reveal button in each cell's top-right corner controls, left of
  Maximize and Detach (slot 2 in the existing `buttonRight(cellId, slot)`
  scheme, 28px apart, offset by the measured price-axis width).
- ✕ glyph, `title="Close chart"`, `aria-label="Close chart"`.
- Rendered only when `cells.length > 1` (same condition as Maximize/Detach).

### Behavior

- Clicking ✕ raises the existing `requestConfirm` dialog:
  *"Close this chart? Its drawings and indicators will be removed."*
- On confirm, App removes that specific cell:
  - Purge the closed cell's scope via `purgeScope` — unless it is the tab's
    primary scope (`primaryCellScope(tabId)`), mirroring the guard in
    `setLayout`'s trim branch.
  - Downgrade the layout kind by remaining cell count: 4 cells → `"3"`
    (three columns), 3 → `"2h"`, 2 → `"1"`. Cell order is preserved —
    closing B in a 2×2 of A/B/C/D yields three columns A/C/D.
  - Reset `sizes` to `undefined` (grid shape changed; old fractions don't
    apply — same as `setLayout` on a layout change).
  - If the closed cell was focused/active, focus falls to the first remaining
    cell. If it was maximized, App clears `maximizedCellId` (ChartGrid's
    dangling-id clamp already covers the intermediate render frame).
- On cancel, nothing changes.

### Implementation shape

- New handler in App: `closeCell(cellId)`.
- New prop on ChartGrid: `onCloseCell(cellId)`; button placed with
  `buttonRight(cell.id, 2)`.
- No persistence changes — the tab autosave already covers cells/layout/sizes.

## 2. Swap cells

### UI

- A small circular button with a two-way arrow, centered on the border
  **segment between each adjacent pair** of cells — `↔` on vertical borders,
  `↕` on horizontal borders.
- Segments, not whole grid lines: a 2×2 has four buttons (A↔B, C↔D on the
  vertical line; A↕C, B↕D on the horizontal line). Three columns has two `↔`;
  two rows has one `↕`.
- Hidden by default; fades in when the pointer is over/near that border (the
  zone the resize strip occupies). Sits on top of the resize strip: clicking
  the button swaps, dragging elsewhere on the strip still resizes.
- Hidden entirely while a cell is maximized (no borders visible), matching the
  resize strips.

### Behavior

- One click swaps the two adjacent cells' positions in the tab's `cells`
  array. Cells move whole and keep their identity — symbol, period, scope
  (drawings/indicators), alerts, focus, maximize state all travel with the
  cell. Nothing is purged or copied.
- Layout kind and size fractions are untouched (fractions belong to grid
  tracks, not cells).
- Repeated clicks toggle the pair back and forth.

### Implementation shape

- Pure frontend. New handler in App: `swapCells(idA, idB)` — swap the two
  indices in the active tab's `cells`.
- ChartGrid renders a `SwapButton` per adjacent-pair segment alongside the
  ResizeStrips, positioned with the same cumulative-fraction math (border
  line position × segment-midpoint on the cross axis).
- Cells are keyed by `cell.id`, so React reorders DOM nodes without
  remounting ChartCore — no chart teardown, no data refetch.

## Testing (Playwright, extends the existing layout spec)

- Close: open 2×2 → click ✕ on one cell → confirm dialog appears → confirm →
  three cells in three-columns layout; the right cell was removed. Cancel path
  keeps 4 cells.
- Swap: open 2×2, note symbols per position → click a swap button → the two
  positions exchanged, drawings survived, other cells untouched → resize strip
  on that border still drags.

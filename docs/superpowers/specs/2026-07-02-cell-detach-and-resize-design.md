# Cell detach + draggable cell borders — design

Date: 2026-07-02
Status: approved

Two independent multi-chart-layout features:

1. **Detach a cell** — a handle next to each cell's maximize button opens that
   chart in a new tab (in-app by default; a right-click menu also offers a new
   browser tab). The original cell stays as it is.
2. **Resizable cells** — drag the border between adjacent cells to change
   their relative sizes.

## Feature 1: Detach cell to a new tab

### Handle

- A second small button next to the existing maximize button in each cell's
  top-right corner (`ChartGrid.tsx`), same visual style
  (`chart-cell-maximize` sibling, class `chart-cell-detach`).
- Visible only when the tab has more than one cell (same condition as
  maximize).
- Icon: "open in new" glyph (box with an arrow pointing out). Tooltip:
  "Open in new tab".

### Behavior

- **Left-click** → detach to a new **in-app** tab and switch to it.
- **Right-click** → a small context menu anchored at the handle with two
  entries:
  - "Open in new tab" (same as left-click)
  - "Open in new browser tab"
  Menu follows the app's conventions: content-sized, no shadow, dismisses on
  outside click / Escape. Left-click never shows the menu.

### Detach mechanics (both variants)

- `detachCell(tabId, cellId)` in `App.tsx`:
  1. Mint a fresh tab id; build a one-cell tab (layout `"1"`) whose primary
     cell carries the source cell's `symbol` and `period` and the tab's
     primary scope (`primaryCellScope(newTabId)`), mirroring `makeTab`.
  2. Copy the source cell's scope content (drawings, indicators, indicator
     config, anchored VWAPs) to the new primary scope via
     `copyScopeContent(from, to)` — currently private in `lib/persist.ts`;
     export it. Alerts are global per instrument, so they need no copying and
     appear in the new tab automatically.
  3. Append the tab to the workspace. The original tab, cell, and scope are
     untouched.
- **In-app variant:** `setActiveId(newTabId)` — user lands on the new tab.
- **Browser-tab variant:** do NOT switch the current window. Instead
  `window.open(`${location.pathname}?tab=<newTabId>`)`. The cloned tab exists
  in the shared workspace, so the main window also shows it in its tab bar.

### Startup `?tab=` handling

- On startup, if the URL has `?tab=<id>` and that tab exists in the resolved
  workspace, activate it, then strip the param via `history.replaceState`.
- If the tab doesn't exist (stale link), ignore the param and start normally.
- Two browser tabs sharing one workspace is already possible today (open the
  app twice); this adds no new conflict class.

## Feature 2: Draggable borders between adjacent cells

### Model

- `ChartTab` gains an optional field:
  `sizes?: { cols: number[]; rows: number[] }` — fractions (summing to 1)
  for the grid's column widths and row heights.
- Absent → equal split (current behavior); all existing tabs/layouts load
  unchanged. No migration code.
- Changing the tab's layout kind resets `sizes` to undefined.
- Lives on the tab → persists via the existing tab/scratch/named-layout
  save paths for free. `cloneWorkspace` copies it (add to the clone's tab
  literal).

### Rendering

- `ChartGrid` builds `gridTemplateColumns/Rows` from `sizes` when present
  (e.g. `[0.3, 0.7]` → `"0.3fr 0.7fr"`), otherwise the current equal
  templates.
- Layout kinds map to grid shape: `2h`/`3` = columns only, `2v` = rows only,
  `4` = 2 cols × 2 rows (one shared vertical + one shared horizontal line).

### Drag strips

- Thin overlay strips (~8px hit area, transparent; the existing 1px cell
  border remains the visual divider) positioned on each internal grid line,
  absolutely positioned over the grid container. Their positions derive from
  the current fractions.
- Cursor `col-resize` / `row-resize`; pointer-capture drag updates the
  fractions live (state in App via an `onSizes(tabId, sizes)` callback),
  clamped to a minimum of 15% per column/row.
- In the `4` quad, a strip moves the whole shared grid line
  (TradingView-style), not a single cell's edge.
- Strips hidden when a cell is maximized or the tab has one cell.
- Charts already track container size via their resize observer — no
  chart-side work.

## Testing

- Playwright e2e:
  - Detach: split a tab, draw on a cell, left-click detach → new tab active,
    chart shows same symbol/interval, drawing present; original tab
    unchanged. Right-click → menu shows both options.
  - `?tab=` startup: load app with the param → that tab is active, URL
    cleaned.
  - Resize: drag a strip in a `2h` layout → cell widths change and persist
    across reload; layout-kind change resets to equal.

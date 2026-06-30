# Per-cell maximize in multi-chart layouts

## Goal

In a multi-cell layout (2h / 2v / 3 / 4), give each cell a maximize control that
expands that cell to fill the whole chart view. The user undoes it by clicking
the same control (now a "restore" affordance) or pressing **Esc**.

This is distinct from the existing app-level `maximized` (which hides the app
chrome) and `dockMaximized` (trading dock fills the workspace). This new state
operates *within* the `ChartGrid`, on a single cell.

## Behavior

- **Mechanism — CSS-only, keep all cells mounted.** The maximized cell visually
  expands to fill the grid; sibling cells are hidden via `display:none` but stay
  mounted. No remount → live sockets, drawings, indicators, and scroll position
  are all preserved. Restoring is instant.
- **Icon visibility — on hover.** A small button in each cell's top-right corner,
  hidden by default, fades in on cell hover. While a cell is maximized its icon
  stays visible (so the user can restore). TradingView-style; keeps the chart
  clean.
- **Single cell — no icon.** The control only renders when `cells.length > 1`. A
  layout-"1" tab already fills the grid, so maximize is meaningless there.
- **Exit — Esc or icon.** Pressing Esc restores; clicking the maximized cell's
  icon restores; clicking a non-maximized cell's icon maximizes that one.

## State

`App.tsx` holds transient view state (mirrors how app-level `maximized` works —
**not** persisted to the tab, not written to `persist.ts`):

```ts
const [maximizedCellId, setMaximizedCellId] = useState<string | null>(null);
```

- **Reset on tab/layout change.** An effect keyed on `active.id` + `active.layout`
  clears `maximizedCellId` to `null`. A maximized cell that no longer exists (tab
  switched, layout trimmed) must not strand the view in a blank/hidden state.
- **Not persisted across reloads.** Purely a transient view; reload starts
  un-maximized.

## Esc + toggle (App.tsx)

Mirror the existing Esc idiom at `App.tsx:1076` (bind keydown only while active):

```ts
useEffect(() => {
  if (!maximizedCellId) return;
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMaximizedCellId(null); };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [maximizedCellId]);
```

Toggle handler passed to the grid:

```ts
const onToggleMaximizeCell = (cellId: string) =>
  setMaximizedCellId((cur) => (cur === cellId ? null : cellId));
```

## ChartGrid changes

New props: `maximizedCellId: string | null`, `onToggleMaximizeCell: (cellId: string) => void`.

- **Grid template.** When `maximizedCellId` is set, collapse the grid to a single
  area: `gridTemplateColumns: "1fr"`, `gridTemplateRows: "1fr"` (instead of the
  per-layout `GRID[layout]`).
- **Per-cell visibility.** Each cell `<div>` gets
  `style.display = maximizedCellId && cell.id !== maximizedCellId ? "none" : undefined`.
  Hidden siblings remain mounted.
- **The icon button.** Rendered inside each `.chart-cell` only when
  `cells.length > 1`. It shows an expand glyph normally and a restore glyph when
  that cell is the maximized one. `onClick` stops propagation and calls
  `onToggleMaximizeCell(cell.id)`. `title` / `aria-label` = "Maximize" /
  "Restore".

## CSS (App.css)

- `.chart-cell-maximize` — absolute, top-right corner, above the chart canvas and
  the focus ring (z-index > 20). Hidden (`opacity: 0`) by default.
- `.chart-cell:hover .chart-cell-maximize` — `opacity: 1`.
- A modifier (e.g. `.chart-cell.maximized .chart-cell-maximize`) keeps the icon
  visible while maximized.
- Plain CSS/SVG expand-arrows glyph (no emoji), matching the TV-style toolbar
  look. No drop-shadow, per project style.

## Interaction with existing features

- **Focus ring** (`.chart-cell.focused::after`, gated on `cells.length > 1`) is
  unaffected — the maximized cell is the only visible one.
- **klinecharts resize.** Charts auto-resize via their container ResizeObserver, so
  growing a cell to full-grid reflows its canvas without manual intervention.
  Verify in browser.

## Testing

Browser MCP (live), no persistence test (transient state):

1. In a 2h layout: hover each cell → icon appears; click → cell fills, sibling
   hidden; chart canvas reflows to full size.
2. Esc restores; sibling reappears with state intact (drawings/scroll preserved).
3. Icon on the maximized cell restores (toggle).
4. Repeat in a 4-quad layout (maximize a non-first cell).
5. Switch tabs / change layout while maximized → view resets to un-maximized.

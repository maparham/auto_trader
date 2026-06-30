# Per-cell Maximize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-cell maximize control to multi-chart layouts so any cell can expand to fill the chart view, restored by clicking the icon again or pressing Esc.

**Architecture:** Transient view state (`maximizedCellId`) lives in `App.tsx` alongside the existing app-level `maximized`. It is threaded into `ChartGrid`, which collapses the CSS grid to one area and hides sibling cells with `display:none` (kept mounted — no remount, all live state preserved). Each cell renders a hover-revealed maximize/restore button. CSS in `App.css`. No persistence.

**Tech Stack:** React + TypeScript (Vite), klinecharts, CSS. Browser-MCP for live verification. This project has no unit-test harness for these UI files — verification is via the browser, matching how sibling features (crosshair sync, date-range sync) were verified.

## Global Constraints

- TradingView-style, no drop-shadows, content-sized, plain copy (per project UX conventions).
- No emoji glyphs — use inline SVG, `viewBox="0 0 16 16"`, `fill="none"`, `stroke="currentColor"` (matches `LayoutPicker.tsx`).
- Commit directly to `main`; do not create a feature branch.
- Do not kill the user's running HMR dev server. Close any browser tab opened for verification when done.
- Maximize state is **transient**: not written to `persist.ts`, not restored on reload.

---

### Task 1: Thread per-cell maximize state through App → ChartGrid and render the control

**Files:**
- Modify: `frontend/src/App.tsx` (add state near line 211; add Esc effect near line 1085; add reset effect; pass two props to `<ChartGrid>` near line 1206)
- Modify: `frontend/src/ChartGrid.tsx` (new props; grid template override; per-cell `display`; maximize button)
- Modify: `frontend/src/App.css` (button styling near the `.chart-cell` block, ~line 36-51)

**Interfaces:**
- Produces (App → ChartGrid): `maximizedCellId: string | null`, `onToggleMaximizeCell: (cellId: string) => void`
- Consumes: existing `active.id`, `active.layout`, `active.cells`, `active.activeCellId`; existing `GRID` map and `cells` in `ChartGrid`.

- [ ] **Step 1: Add the state in App.tsx**

Insert directly after the `dockMaximized` state (App.tsx ~line 213):

```tsx
  // Per-cell maximize: one cell of a multi-cell layout expanded to fill the grid.
  // Transient view state (like `maximized` above) — never persisted. Siblings stay
  // mounted (hidden via CSS) so their live sockets/drawings/scroll survive restore.
  const [maximizedCellId, setMaximizedCellId] = useState<string | null>(null);
```

- [ ] **Step 2: Add the Esc + reset effects in App.tsx**

Insert immediately after the existing `maximized` Esc effect (after App.tsx:1085):

```tsx
  // Esc restores a maximized cell. Bound only while one is maximized.
  useEffect(() => {
    if (!maximizedCellId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMaximizedCellId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [maximizedCellId]);

  // A maximized cell is a transient view; switching tabs or changing the layout
  // must clear it so a now-hidden/absent cell can't strand the grid blank.
  useEffect(() => {
    setMaximizedCellId(null);
  }, [active?.id, active?.layout]);
```

- [ ] **Step 3: Pass the props to ChartGrid in App.tsx**

In the `<ChartGrid ... />` element (App.tsx ~1206-1231), add after `onPeriod={setCellPeriod}`:

```tsx
              maximizedCellId={maximizedCellId}
              onToggleMaximizeCell={(cellId) =>
                setMaximizedCellId((cur) => (cur === cellId ? null : cellId))
              }
```

- [ ] **Step 4: Extend ChartGrid props**

In `ChartGrid.tsx`, add to the `Props` interface (after `onPeriod`):

```tsx
  // Per-cell maximize: the id of the cell expanded to fill the grid, or null.
  maximizedCellId: string | null;
  // Toggle maximize for a cell (maximize if none/other, restore if it's this one).
  onToggleMaximizeCell: (cellId: string) => void;
```

Add `maximizedCellId,` and `onToggleMaximizeCell,` to the destructured params in the function signature.

- [ ] **Step 5: Override the grid template when maximized**

In `ChartGrid.tsx`, replace the `const grid = GRID[layout] ?? GRID["1"];` line and the inline `gridTemplate*` style so a maximized cell collapses the grid to one area:

```tsx
  const baseGrid = GRID[layout] ?? GRID["1"];
  // When a cell is maximized, collapse the grid to a single area; the maximized
  // cell fills it and siblings are display:none'd below.
  const grid = maximizedCellId ? { columns: "1fr", rows: "1fr" } : baseGrid;
```

(The existing `gridTemplateColumns: grid.columns` / `gridTemplateRows: grid.rows` lines now read from this.)

- [ ] **Step 6: Hide siblings and render the maximize button per cell**

In `ChartGrid.tsx`, update the cell `<div>` and add the button as a child (sibling of `<ChartCore>`):

```tsx
      {cells.map((cell) => {
        const isMax = cell.id === maximizedCellId;
        const hidden = maximizedCellId !== null && !isMax;
        return (
        <div
          key={cell.id}
          className={`chart-cell${
            cell.id === focusedCellId && cells.length > 1 ? " focused" : ""
          }${isMax ? " maximized" : ""}`}
          style={{ display: hidden ? "none" : undefined }}
        >
          {cells.length > 1 && (
            <button
              type="button"
              className="chart-cell-maximize"
              title={isMax ? "Restore" : "Maximize"}
              aria-label={isMax ? "Restore" : "Maximize"}
              onClick={(e) => {
                e.stopPropagation();
                onToggleMaximizeCell(cell.id);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                {isMax ? (
                  // restore: inward arrows
                  <>
                    <path d="M9 3v4h4" />
                    <path d="M7 13V9H3" />
                    <path d="M13 3l-4 4" />
                    <path d="M3 13l4-4" />
                  </>
                ) : (
                  // maximize: outward expand arrows
                  <>
                    <path d="M6 2H2v4" />
                    <path d="M10 14h4v-4" />
                    <path d="M2 2l5 5" />
                    <path d="M14 14l-5-5" />
                  </>
                )}
              </svg>
            </button>
          )}
          <ChartCore
            cellId={cell.id}
            tabId={tabId}
            scope={cell.scope}
            symbol={cell.symbol}
            brokerId={brokerId}
            period={cell.period}
            theme={theme}
            timezone={timezone}
            clock={clock}
            dateFormat={dateFormat}
            showWeekday={showWeekday}
            priceSide={priceSide}
            bidAsk={bidAsk}
            bidAskStyle={bidAskStyle}
            crosshair={crosshair}
            syncCrosshair={syncCrosshair && cells.length > 1}
            syncTime={syncTime && cells.length > 1}
            locked={locked && cells.length > 1}
            onReady={onReady}
            onFocus={onFocus}
            onPeriod={onPeriod}
          />
        </div>
        );
      })}
```

(This converts the existing `cells.map((cell) => ( ... ))` arrow to a block body with `return`. Keep every existing `<ChartCore>` prop exactly as-is — only the wrapper `<div>`, the new button, and the map body changed.)

- [ ] **Step 7: Add the CSS**

In `frontend/src/App.css`, add after the `.chart-cell.focused::after { ... }` block (~line 51):

```css
/* Per-cell maximize control: top-right corner, revealed on cell hover, kept
   visible while that cell is maximized. Sits above the chart canvas and the
   focus ring (z 20). No drop-shadow, per project style. */
.chart-cell-maximize {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 25;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.1s ease, color 0.1s ease, background 0.1s ease;
}
.chart-cell:hover .chart-cell-maximize,
.chart-cell.maximized .chart-cell-maximize {
  opacity: 1;
}
.chart-cell-maximize:hover {
  color: var(--text);
  background: var(--surface-2);
}
```

- [ ] **Step 8: Verify the build compiles**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc --noEmit`
Expected: no errors. (If the dev server is running, HMR will also pick up changes — do not restart it.)

- [ ] **Step 9: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/App.tsx frontend/src/ChartGrid.tsx frontend/src/App.css
git commit -m "feat(chart): per-cell maximize in multi-chart layouts"
```

---

### Task 2: Live browser verification

**Files:** none (verification only).

**Interfaces:** Consumes the running app (focused cell map via `window.__charts` already exists for debugging).

- [ ] **Step 1: Open the app and create a multi-cell layout**

Use browser MCP: open the dev app URL (check the running Vite port; default `http://localhost:5173`). Set a recognizable `document.title` on the tab. Switch the active tab to a `2h` layout (layout picker in the toolbar) so there are two cells.

- [ ] **Step 2: Verify hover-reveal + maximize**

Hover the right cell → the maximize icon fades in top-right. Click it.
Expected: the cell expands to fill the whole chart area; the sibling is hidden; the klinecharts canvas reflows to full size (no clipped/old-size canvas).

- [ ] **Step 3: Verify restore via icon and Esc, state preserved**

Before maximizing, draw a trend line on each cell and scroll one. Maximize one cell, then restore via the icon. Confirm the sibling reappears with its drawing and scroll position intact. Maximize again and press Esc — confirm it restores.

- [ ] **Step 4: Verify quad layout + reset-on-change**

Switch to the `4` layout. Maximize a non-first cell (e.g. bottom-right) → it fills the grid. While maximized, switch to the layout picker and change layout (or switch tabs) → confirm the view resets to un-maximized (no blank/stranded grid).

- [ ] **Step 5: Verify single-cell hides the control**

Switch to layout `1`. Hover the cell → confirm no maximize icon appears.

- [ ] **Step 6: Clean up**

Close the browser tab opened for verification. Report results.

---

## Self-Review

- **Spec coverage:** Mechanism (CSS-only, mounted) → Task 1 Steps 5-6. Hover visibility → Step 7 CSS. Single-cell hides icon → Step 6 `cells.length > 1` guard, verified Task 2 Step 5. Esc + toggle → Step 2 effect + Step 3/6 handlers. Reset on tab/layout change → Step 2 second effect, verified Task 2 Step 4. No persistence → state is `useState` only, never passed to persist. All spec sections covered.
- **Placeholder scan:** No TBD/TODO; all code shown in full.
- **Type consistency:** `maximizedCellId: string | null` and `onToggleMaximizeCell: (cellId: string) => void` are named identically in App.tsx props, ChartGrid `Props`, and destructure. Button uses `isMax`/`hidden` locals consistently.

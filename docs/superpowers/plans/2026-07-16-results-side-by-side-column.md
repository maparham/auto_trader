# Backtest/Sweep Results Side-by-Side Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggle that moves the backtest/sweep results out of the stacked config panel into their own resizable docked column beside it, so config and results are both full-height.

**Architecture:** `BacktestSettingsModal` already renders a right-docked `aside.bt-cfg-panel` as a `flex-shrink:0` sibling of `<main class="chart">` in the `.workspace` flex row. We add a device-local `resultsSideBySide` flag (default off). When on, the results JSX (a single lifted `resultsBody` value) renders in a new `aside.bt-results-col` placed left of the config panel — another flex sibling, so the chart shrinks automatically. When off, everything is exactly as today.

**Tech Stack:** React + TypeScript, Vitest + Testing Library, plain CSS in `App.css`, existing `lib/persist` device-local helpers.

## Global Constraints

- Default layout unchanged: `resultsSideBySide` defaults to **off** (stacked).
- Results content is **not duplicated** — one `resultsBody` value renders in either the stacked region or the column, never both.
- New persisted keys are **device-local** (added to `DEVICE_LOCAL_FLAT_KEYS`), mirroring `backtestPanelWidth`.
- No em dashes or "--" in end-user-visible strings (labels, tooltips). Code/comments/commits fine.
- Use the shared `Tooltip` component for icon-button hints, not native `title=`.
- The remount-on-flip state reset (sub-tab, sort, scroll) is accepted, not fixed here.

---

### Task 1: Persistence helpers for the side-by-side flag and column width

**Files:**
- Modify: `frontend/src/lib/persist/defaults.ts` (after `saveBacktestPanelWidth`, ~line 195)
- Modify: `frontend/src/lib/persist/core.ts:129-144` (`DEVICE_LOCAL_FLAT_KEYS`)
- Test: `frontend/src/lib/persist.test.ts`

**Interfaces:**
- Produces:
  - `BACKTEST_RESULTS_COL_DEFAULT_WIDTH: number`
  - `loadBacktestResultsSideBySide(): boolean`
  - `saveBacktestResultsSideBySide(on: boolean): void`
  - `loadBacktestResultsColWidth(): number`
  - `saveBacktestResultsColWidth(w: number): void`
  - all re-exported through the `./lib/persist` barrel (via `export * from "./persist/defaults"`).

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/lib/persist.test.ts`:

```ts
import {
  loadBacktestResultsSideBySide,
  saveBacktestResultsSideBySide,
  loadBacktestResultsColWidth,
  saveBacktestResultsColWidth,
  BACKTEST_RESULTS_COL_DEFAULT_WIDTH,
} from "./persist";

describe("backtest results side-by-side prefs", () => {
  it("defaults to stacked (off) and the default column width", () => {
    expect(loadBacktestResultsSideBySide()).toBe(false);
    expect(loadBacktestResultsColWidth()).toBe(BACKTEST_RESULTS_COL_DEFAULT_WIDTH);
  });
  it("round-trips the flag and clamps an absurd width up to the floor", () => {
    saveBacktestResultsSideBySide(true);
    expect(loadBacktestResultsSideBySide()).toBe(true);
    saveBacktestResultsColWidth(50);
    expect(loadBacktestResultsColWidth()).toBe(360);
    saveBacktestResultsColWidth(600);
    expect(loadBacktestResultsColWidth()).toBe(600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts -t "side-by-side"`
Expected: FAIL — imports `loadBacktestResultsSideBySide` etc. are undefined.

- [ ] **Step 3: Add the helpers**

In `frontend/src/lib/persist/defaults.ts`, immediately after `saveBacktestPanelWidth` (~line 195), add:

```ts
// Backtest results layout: when on, results move out of the stacked config
// panel into their own docked column beside it. Device-local view preference
// like the panel width above.
const BACKTEST_RESULTS_SIDE_BY_SIDE_KEY = `${PREFIX}.backtestResultsSideBySide`;
export function loadBacktestResultsSideBySide(): boolean {
  return load<boolean>(BACKTEST_RESULTS_SIDE_BY_SIDE_KEY, false);
}
export function saveBacktestResultsSideBySide(on: boolean): void {
  saveLocal(BACKTEST_RESULTS_SIDE_BY_SIDE_KEY, on);
}

// Width (px) of that results column, dragged via its left-edge handle.
const BACKTEST_RESULTS_COL_WIDTH_KEY = `${PREFIX}.backtestResultsColWidth`;
export const BACKTEST_RESULTS_COL_DEFAULT_WIDTH = 560;
export function loadBacktestResultsColWidth(): number {
  const w = load<number>(BACKTEST_RESULTS_COL_WIDTH_KEY, BACKTEST_RESULTS_COL_DEFAULT_WIDTH);
  return Number.isFinite(w) && w >= 360 ? w : BACKTEST_RESULTS_COL_DEFAULT_WIDTH;
}
export function saveBacktestResultsColWidth(w: number): void {
  saveLocal(BACKTEST_RESULTS_COL_WIDTH_KEY, w);
}
```

- [ ] **Step 4: Register the keys as device-local**

In `frontend/src/lib/persist/core.ts`, add two entries to the `DEVICE_LOCAL_FLAT_KEYS` set (after `` `${PREFIX}.backtestPanelWidth`, `` at line 135):

```ts
  `${PREFIX}.backtestResultsSideBySide`,
  `${PREFIX}.backtestResultsColWidth`,
```

Note: the width clamp to a 360 floor happens in the component's `clampColWidth`, not in `saveBacktestResultsColWidth` (which stores what it's given). The test above saves already-clamped values through the component contract, so re-read `loadBacktestResultsColWidth` treats `50` as below its own `>= 360` guard and returns the default. Adjust the test expectation to match: `saveBacktestResultsColWidth(50)` then `loadBacktestResultsColWidth()` returns `BACKTEST_RESULTS_COL_DEFAULT_WIDTH` (560), not 360. Update Step 1's second assertion to:

```ts
    saveBacktestResultsColWidth(50);
    expect(loadBacktestResultsColWidth()).toBe(BACKTEST_RESULTS_COL_DEFAULT_WIDTH);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/persist.test.ts -t "side-by-side"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/persist/defaults.ts frontend/src/lib/persist/core.ts frontend/src/lib/persist.test.ts
git commit -m "feat(backtest): device-local prefs for results side-by-side column"
```

---

### Task 2: Move results into a docked column when the toggle is on

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx`
  - imports (~line 96-107)
  - state block (~line 984-1099)
  - stacked results region (~line 2167-2230)
  - fragment root / config aside (~line 1345-1347, 2354-2363)
- Modify: `frontend/src/App.css` (after `.bt-cfg-panel` block, ~line 1050)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes (from Task 1): `loadBacktestResultsSideBySide`, `saveBacktestResultsSideBySide`, `loadBacktestResultsColWidth`, `saveBacktestResultsColWidth`, `BACKTEST_RESULTS_COL_DEFAULT_WIDTH`.
- Produces: DOM contract for tests — when on, results live in `aside.bt-results-col`; the in-panel `.bt-results-region` is not rendered. Toggle buttons carry `aria-label="Show results in a side column"` (stacked) and `aria-label="Dock results back into the panel"` (column).

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/BacktestSettingsModal.test.tsx`:

```tsx
describe("BacktestSettingsModal results side-by-side column", () => {
  it("moves results into a docked column and back", () => {
    renderModal();
    // Default: results are stacked inside the config panel, no column.
    expect(document.querySelector(".bt-results-region")).toBeTruthy();
    expect(document.querySelector(".bt-results-col")).toBeNull();

    // Turn on side-by-side.
    fireEvent.click(screen.getByLabelText("Show results in a side column"));
    const col = document.querySelector(".bt-results-col");
    expect(col).toBeTruthy();
    // The results content lives in the column now, not the stacked region.
    expect(document.querySelector(".bt-results-region")).toBeNull();
    expect(within(col as HTMLElement).getByText(/Run a backtest to see results/)).toBeTruthy();

    // Dock back.
    fireEvent.click(screen.getByLabelText("Dock results back into the panel"));
    expect(document.querySelector(".bt-results-col")).toBeNull();
    expect(document.querySelector(".bt-results-region")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "side-by-side column"`
Expected: FAIL — no element with label "Show results in a side column".

- [ ] **Step 3: Import the Task 1 helpers**

In `frontend/src/BacktestSettingsModal.tsx`, add to the `./lib/persist` import block (after `BACKTEST_PANEL_DEFAULT_WIDTH,` at line 100):

```ts
  loadBacktestResultsSideBySide,
  saveBacktestResultsSideBySide,
  loadBacktestResultsColWidth,
  saveBacktestResultsColWidth,
  BACKTEST_RESULTS_COL_DEFAULT_WIDTH,
```

- [ ] **Step 4: Add toggle + column-width state and the column resize handler**

In `frontend/src/BacktestSettingsModal.tsx`, immediately after the `onResizeStart` handler (after its closing `};` at line 1099), add:

```ts
  // Results layout: stacked (default) vs a docked column beside the panel.
  const [sideBySide, setSideBySide] = useState<boolean>(loadBacktestResultsSideBySide);
  const setResultsSideBySide = (on: boolean) => {
    setSideBySide(on);
    saveBacktestResultsSideBySide(on);
  };
  // Keep the chart at least ~200px even with the config panel + this column both docked.
  const clampColWidth = (w: number) =>
    Math.max(360, Math.min(w, Math.max(360, window.innerWidth - panelWidth - 200)));
  const [resultsColWidth, setResultsColWidth] = useState<number>(() =>
    clampColWidth(loadBacktestResultsColWidth()),
  );
  const onResultsColResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = resultsColWidth;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let w = startW;
    const onMove = (ev: PointerEvent) => {
      // Left edge: dragging left (negative dx) grows the column.
      w = clampColWidth(startW + (startX - ev.clientX));
      setResultsColWidth(w);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      saveBacktestResultsColWidth(w);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };
```

- [ ] **Step 5: Lift the results content into a `resultsBody` value**

The results content currently lives inline in the `.bt-results-region` (lines ~2174-2229): a `btMode === "backtest"` branch rendering `<BacktestPanel />` and a `btMode === "sweep"` branch rendering the past-sweeps picker + sweep panel. Extract it so it can render in either place.

Just before the component's `return (` (the `<>` at line 1345), add a `resultsBody` value. **Move the existing JSX verbatim** — cut the `btMode === "backtest" && <BacktestPanel />` element and the entire `btMode === "sweep" && ( ... )` block (lines ~2177-2229, everything between the `bt-results-toggle` button's closing `</button>` and the region's closing `</div>`), and paste them inside this value, dropping the `!split.collapsed &&` guard from each (the guard stays at the stacked render site):

```tsx
  // One results instance, rendered either in the stacked region or the docked
  // column. Follows the active Backtest|Sweep mode; nothing is duplicated.
  const resultsBody = (
    <>
      {btMode === "backtest" && <BacktestPanel />}
      {btMode === "sweep" && (
        <>
          {/* ...the past-sweeps picker + sweep panel block moved verbatim from
              the old bt-results-region (lines ~2180-2228)... */}
        </>
      )}
    </>
  );
```

- [ ] **Step 6: Render the stacked region only when not side-by-side**

Replace the stacked results region (the `<div className={`bt-results-region...`}>` block, lines ~2167-2230) with a version that (a) only renders when `!sideBySide`, (b) uses `resultsBody`, and (c) adds the "move to column" toggle button in its header:

```tsx
        {!sideBySide && (
          <div className={`bt-results-region${split.collapsed ? " collapsed" : ""}`} style={resultsStyle}>
            <div className="bt-results-head-row">
              <button className="bt-results-toggle" onClick={toggleResults} aria-expanded={!split.collapsed}>
                <span className={`bt-results-chevron${split.collapsed ? " collapsed" : ""}`} aria-hidden="true">
                  ▾
                </span>
                Results
              </button>
              <Tooltip content="Show results in a side column">
                <button
                  className="bt-results-layout-btn"
                  aria-label="Show results in a side column"
                  onClick={() => setResultsSideBySide(true)}
                >
                  ⇥
                </button>
              </Tooltip>
            </div>
            {!split.collapsed && resultsBody}
          </div>
        )}
```

Confirm `Tooltip` is already imported in this file; if not, add `import Tooltip from "./components/Tooltip";` near the other component imports.

- [ ] **Step 7: Render the docked column when side-by-side**

At the top of the returned fragment, before `<aside className={`bt-cfg-panel bt-mode-${btMode}`} ...>` (line 1347), add the column as the first fragment child so it sits left of the config panel in the `.workspace` flex row:

```tsx
      {sideBySide && (
        <aside className={`bt-results-col bt-mode-${btMode}`} style={{ width: resultsColWidth }}>
          <div
            className="bt-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize results column"
            onPointerDown={onResultsColResizeStart}
            onDoubleClick={() => {
              setResultsColWidth(clampColWidth(BACKTEST_RESULTS_COL_DEFAULT_WIDTH));
              saveBacktestResultsColWidth(BACKTEST_RESULTS_COL_DEFAULT_WIDTH);
            }}
          />
          <div className="bt-cfg-head">
            <span className="bt-cfg-title">Results</span>
            <Tooltip content="Dock results back into the panel">
              <button
                className="bt-results-layout-btn"
                aria-label="Dock results back into the panel"
                onClick={() => setResultsSideBySide(false)}
              >
                ⇤
              </button>
            </Tooltip>
          </div>
          <div className="bt-results-col-body">{resultsBody}</div>
        </aside>
      )}
```

- [ ] **Step 8: Add the column CSS**

In `frontend/src/App.css`, after the `.bt-cfg-panel` rule block (~line 1050), add:

```css
/* Results column: a second docked surface, left of the config panel, shown when
   the side-by-side toggle is on. Mirrors bt-cfg-panel's docking so the chart
   shrinks beside it. */
.bt-results-col {
  position: relative;
  flex-shrink: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
}
.bt-results-col-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
/* Header row that carries the stacked-region "move to column" button beside the
   collapse toggle. */
.bt-results-head-row { display: flex; align-items: center; justify-content: space-between; }
.bt-results-layout-btn {
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; margin-right: 8px;
  border: none; background: transparent; color: var(--text-dim);
  font-size: 15px; line-height: 1; cursor: pointer; border-radius: 4px;
}
.bt-results-layout-btn:hover { background: var(--hover); color: var(--text); }
```

- [ ] **Step 9: Run the new test to verify it passes**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "side-by-side column"`
Expected: PASS.

- [ ] **Step 10: Run the full modal + persist suites to confirm no regressions**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx src/lib/persist.test.ts`
Expected: PASS (existing assertions query results inside `.bt-results-region`, which is still the default).

- [ ] **Step 11: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/App.css frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(backtest): open results in a docked side-by-side column"
```

---

### Task 3: Manual verification in the running app

**Files:** none (verification only).

- [ ] **Step 1: Drive the feature end-to-end**

Use the `verify` skill (or the running dev server) to:
1. Open the backtest panel, run a backtest so results populate.
2. Click the "Show results in a side column" (⇥) button; confirm results move to a column left of the config panel and the chart narrows.
3. Drag the column's left edge to resize; double-click to reset; reload and confirm width + on-state persist.
4. Switch the footer Backtest|Sweep mode; confirm the column follows the mode.
5. Click "Dock results back" (⇤); confirm results return to the stacked region and the chart widens.
6. Confirm the accepted reset: with the column open, set a trade-table sort and Analysis sub-tab, dock back, and note sub-tab/sort reset while the result data and selected trade survive.

- [ ] **Step 2: Note any polish gaps**

If the chart floor feels too tight on a small window or the header spacing looks off, capture it as follow-up; do not expand scope here.

---

## Self-Review

**Spec coverage:**
- Toggle default off, stacked unchanged → Task 1 default + Task 2 Step 6 guard. ✓
- Results in docked column left of config, chart shrinks → Task 2 Step 7 (first fragment child) + Task 2 Step 8 CSS. ✓
- Single `resultsBody`, no duplication, follows mode → Task 2 Step 5. ✓
- Column resize handle + persisted width, reuse pattern → Task 1 + Task 2 Step 4/7. ✓
- Dock-back button + toggle button → Task 2 Steps 6-7. ✓
- Device-local persistence → Task 1 Step 4. ✓
- Collapse interaction (column always shows; docking back restores prior collapse) → column ignores `split.collapsed`; stacked keeps `toggleResults`/`split` untouched. ✓
- Remount reset accepted, documented → Global Constraints + Task 3 Step 1.6. ✓
- Tests: existing green + new column coverage → Task 2 Steps 9-10. ✓

**Placeholder scan:** The only non-literal is the "moved verbatim" sweep block in Task 2 Step 5 — deliberate, to avoid transcription errors on a 50-line move; exact source lines are cited.

**Type consistency:** helper names (`loadBacktestResultsSideBySide`, `saveBacktestResultsColWidth`, `BACKTEST_RESULTS_COL_DEFAULT_WIDTH`) match between Task 1 (produce) and Task 2 (consume). State names (`sideBySide`, `resultsColWidth`, `clampColWidth`, `onResultsColResizeStart`) are consistent across Task 2 steps.

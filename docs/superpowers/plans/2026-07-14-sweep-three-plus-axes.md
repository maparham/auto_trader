# Sweep 3+ Axes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the 2-axis sweep cap: any number of sweep axes, combo cap raised to 1000, and a heatmap that stays 2D via X/Y axis pickers whose cells show the best result over the collapsed axes.

**Architecture:** Enumeration (`enumerateCombos`, `comboCount`, chunking, mirroring) is already N-axis generic. Only two places assume 2 axes: `addAxis` in `BacktestSettingsModal.tsx` (FIFO slice to 2) and the heatmap in `SweepResults.tsx` (`axes.length <= 2` gate, hardcoded `axes[0]`/`axes[1]`, exact-match cell lookup). Task 1 removes the caps; Task 2 rebuilds the heatmap's axis selection and cell semantics; Task 3 verifies in the browser.

**Tech Stack:** React + TypeScript (frontend only, no backend changes), vitest + @testing-library/react.

Spec: `docs/superpowers/specs/2026-07-14-sweep-three-plus-axes-design.md`

## Global Constraints

- No em dashes anywhere (copy, comments, tests). Rephrase with colon/comma/period.
- Shared `Tooltip` component only, never `title=` (pre-existing `title=` sites you didn't add are not yours to fix).
- Sweep axes and results stay session-only, never persisted.
- No legacy/back-compat paths: the FIFO drop and the `<= 2` gate are removed, not flagged.
- `SWEEP_MAX_COMBOS` = 1000 exactly.
- Heatmap cell aggregate = best row by the selected color metric: highest wins, except `max_drawdown` where lowest wins. No aggregate-function toggle.
- Axis pickers store axis targets (stable strings), not indexes; a stored target absent from the current axes falls back to defaults (X = first axis, Y = second axis, skipping whichever the other picker holds). Picking in one dropdown the axis the other holds swaps them.
- With 1 or 2 axes the heatmap renders exactly as today (no pickers, identical cells).
- git add ONLY the files you touched (concurrent sessions share the tree); commit to main, never push.
- Pre-existing test/tsc failures from concurrent sessions are not yours: backtestSeries "MA Slope" label test; tsc errors in BacktestPanel/useChartPaint/ChartCore/backtest.ts and avg_win_loss_ratio fixtures.

---

### Task 1: Lift the caps (combo cap 1000, no axis-count cap)

**Files:**
- Modify: `frontend/src/lib/sweep.ts` (line ~60: `SWEEP_MAX_COMBOS`)
- Modify: `frontend/src/BacktestSettingsModal.tsx` (lines ~420-431: sweep-axes comment + `addAxis`)
- Test: `frontend/src/lib/sweep.test.ts`
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: existing `enumerateCombos`, `comboCount`, `SWEEP_MAX_COMBOS` from `frontend/src/lib/sweep.ts`.
- Produces: `SWEEP_MAX_COMBOS === 1000`; `addAxis` appends without dropping. Task 2 does not depend on this task's code, only on the ability to have 3 axes at runtime.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/lib/sweep.test.ts`, add `SWEEP_MAX_COMBOS` to the existing import from `./sweep`, then append inside the `describe("enumerateCombos", ...)` block (the file's `axis` helper already exists at the top):

```ts
  it("crosses three axes: first axis varies fastest, count multiplies", () => {
    const axes = [axis("param:a", 1, 2, 1), axis("param:b", 10, 20, 10), axis("param:c", 0, 1, 1)];
    const combos = enumerateCombos(axes);
    expect(combos).toHaveLength(8);
    expect(combos[0]).toEqual({ "param:a": 1, "param:b": 10, "param:c": 0 });
    expect(combos[7]).toEqual({ "param:a": 2, "param:b": 20, "param:c": 1 });
    expect(comboCount(axes)).toBe(8);
  });

  it("allows grids up to the 1000-combo cap", () => {
    expect(SWEEP_MAX_COMBOS).toBe(1000);
  });
```

In `frontend/src/BacktestSettingsModal.test.tsx`, find the `describe("coded mode: params, risk, and exit-rule sections", ...)` block. Add a second param to its `strategies` fixture's `params` array (after the existing `ema_fast` entry):

```ts
        { name: "ema_slow", label: "Slow EMA", type: "int" as const, default: 21, min: 5, max: 100, step: 1, options: null, help: null },
```

Then append inside that same describe block (its `renderModal`/`openStrategy` helpers are file-level):

```tsx
  it("keeps three sweep axes active at once (no oldest-axis drop)", async () => {
    mockStrategies.mockResolvedValue(strategies);
    const initial = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    renderModal(initial);
    openStrategy();
    expect(await screen.findByText("Fast EMA")).toBeTruthy();

    const params = document.querySelector(".strategy-params") as HTMLElement;
    const glyphs = params.querySelectorAll(".sp-sweep");
    fireEvent.click(glyphs[0]);   // Fast EMA axis
    fireEvent.click(glyphs[1]);   // Slow EMA axis
    fireEvent.click(document.querySelector(".bt-period-sweep-toggle")!);   // Period axis

    // All three stay on: both param glyphs and the period toggle.
    expect(params.querySelectorAll(".sp-sweep.on")).toHaveLength(2);
    expect(document.querySelector(".bt-period-sweep-toggle")!.className).toContain("on");
    // Footer multiplies three factors: two multiplication signs.
    expect(screen.getByText(/runs$/).textContent?.match(/×/g)).toHaveLength(2);
  });
```

Note on the fixture edit: existing tests in that block assert on "Fast EMA" and the params section generally; adding a second param must not break them. If one asserts an exact param count, extend its expectation rather than deleting it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/sweep.test.ts src/BacktestSettingsModal.test.tsx -t "three"`
Expected: "allows grids up to the 1000-combo cap" FAILS (cap is 200); "keeps three sweep axes" FAILS (the period toggle drops the Fast EMA axis, so only one `.sp-sweep.on` remains and the footer has one ×). The 3-axis enumerate test may already PASS (enumeration is generic); that is fine.

- [ ] **Step 3: Implement**

In `frontend/src/lib/sweep.ts`, change line 60:

```ts
export const SWEEP_MAX_COMBOS = 1000;
```

In `frontend/src/BacktestSettingsModal.tsx`, replace lines ~420-431 (the sweep-axes state comment through the `addAxis` definition):

```tsx
  // Sweep axes (Task 10): session-only, never persisted, cleared on close/apply.
  // Any number of axes; SWEEP_MAX_COMBOS alone bounds run size (footer count +
  // disabled Run enforce it). Written to sweepAxesSignal right before a run so
  // BacktestButton can branch on it.
  const [sweepAxes, setSweepAxes] = useState<SweepAxis[]>([]);
  // The axes that actually ran, materialized (period → concrete windows) at run
  // time — SweepResults labels against these, not the still-editable sweepAxes.
  const [ranAxes, setRanAxes] = useState<SweepAxis[]>([]);
  // Appends the toggled-on axis (shared by every sweep toggle).
  const addAxis = (axes: SweepAxis[], next: SweepAxis) => [...axes, next];
```

Careful: the `ranAxes` comment block shown above is today's text and stays byte-identical (including its existing em dash and arrow, which predate this feature; the no-em-dash rule covers NEW text only). Only the first comment block and the `addAxis` body/comment change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/sweep.test.ts src/BacktestSettingsModal.test.tsx`
Expected: PASS, including all pre-existing tests in both files.

Run: `cd frontend && npx tsc -b`
Expected: no NEW errors (pre-existing concurrent-session errors listed in Global Constraints are not yours).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/sweep.ts frontend/src/lib/sweep.test.ts frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(sweep): no axis-count cap, combo cap 1000"
```

---

### Task 2: Heatmap X/Y axis pickers + best-over-collapsed cells

**Files:**
- Modify: `frontend/src/SweepResults.tsx` (header comment lines 1-6; gate at ~line 132; `SweepHeatmap` at ~lines 221-336)
- Modify: `frontend/src/App.css` (one new rule next to `.sweep-heat-metric`, ~line 4251)
- Test: `frontend/src/SweepResults.test.tsx`

**Interfaces:**
- Consumes: `comboAxisText`, `SweepAxis` from `./lib/sweep` (already imported in `SweepResults.tsx`); `metricValue`, `fmtMetric`, `METRIC_COLS`, `divergingBg` (file-local, unchanged).
- Produces: `SweepHeatmap` renders for any `axes.length >= 1`; selects with `aria-label="Heatmap X axis"` and `aria-label="Heatmap Y axis"` when `axes.length > 2`. No other file consumes these; Task 3 verifies them in the browser.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/SweepResults.test.tsx` (top-of-file imports already include `fireEvent`, `render`, `screen`, `vi`; the 2-axis `rows`/`axes` fixtures exist at the top):

```tsx
// 3-axis fixture: axes A (1|2) x B (10) x C (100|200). With X=A, Y=B the C
// axis collapses: cell (A=1,B=10) matches two rows (net_pnl 50 and 80, where
// the 80 row has the WORSE drawdown 90), cell (A=2,B=10) matches one success
// and one failure.
const rows3 = [
  { combo: { "param:a": 1, "param:b": 10, "param:c": 100 },
    metrics: { net_pnl: 50, n_trades: 1, win_rate: 1, max_drawdown: 30,
               profit_factor: 2, return_pct: 0.5 }, error: null },
  { combo: { "param:a": 1, "param:b": 10, "param:c": 200 },
    metrics: { net_pnl: 80, n_trades: 2, win_rate: 1, max_drawdown: 90,
               profit_factor: 3, return_pct: 0.8 }, error: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 100 },
    metrics: { net_pnl: -20, n_trades: 1, win_rate: 0, max_drawdown: 40,
               profit_factor: null, return_pct: -0.2 }, error: null },
  { combo: { "param:a": 2, "param:b": 10, "param:c": 200 }, metrics: null, error: "boom" },
];
const axes3 = [
  { kind: "range" as const, target: "param:a", label: "A", from: 1, to: 2, step: 1 },
  { kind: "range" as const, target: "param:b", label: "B", from: 10, to: 10, step: 1 },
  { kind: "range" as const, target: "param:c", label: "C", from: 100, to: 200, step: 100 },
];

describe("SweepResults 3+ axes", () => {
  it("renders X/Y pickers for 3 axes but not for 2", () => {
    const { unmount } = render(<SweepResults rows={rows3} axes={axes3} onApply={() => {}} />);
    expect(screen.getByLabelText("Heatmap X axis")).toBeTruthy();
    expect(screen.getByLabelText("Heatmap Y axis")).toBeTruthy();
    unmount();
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    expect(screen.queryByLabelText("Heatmap X axis")).toBeNull();
  });

  it("aggregated cell shows the best row by the color metric and applies its combo", () => {
    const onApply = vi.fn();
    render(<SweepResults rows={rows3} axes={axes3} onApply={onApply} />);
    const cells = [...document.querySelectorAll(".sweep-cell")];
    expect(cells).toHaveLength(2);                       // X=A (2 ticks) x Y=B (1 tick)
    const best = cells.find((c) => c.textContent === "+80.00")!;
    expect(best).toBeTruthy();                           // best net_pnl over collapsed C
    fireEvent.click(best);
    expect(onApply).toHaveBeenCalledWith(rows3[1].combo); // full combo incl. param:c 200
  });

  it("a cell with only failed matches still renders err, a mixed cell prefers success", () => {
    render(<SweepResults rows={rows3} axes={axes3} onApply={() => {}} />);
    // Cell (A=2): one success (-20) and one failure; success wins.
    const cells = [...document.querySelectorAll(".sweep-cell")];
    expect(cells.some((c) => c.textContent === "-20.00")).toBe(true);
  });

  it("drawdown picks the minimum over the collapsed axis", () => {
    const onApply = vi.fn();
    render(<SweepResults rows={rows3} axes={axes3} onApply={onApply} />);
    fireEvent.change(screen.getByLabelText("Heatmap color metric"), { target: { value: "max_drawdown" } });
    const cells = [...document.querySelectorAll(".sweep-cell")];
    const best = cells.find((c) => c.textContent === "30.00")!;
    expect(best).toBeTruthy();                           // min drawdown, not the 90 row
    fireEvent.click(best);
    expect(onApply).toHaveBeenCalledWith(rows3[0].combo);
  });

  it("picking in X the axis Y holds swaps them", () => {
    render(<SweepResults rows={rows3} axes={axes3} onApply={() => {}} />);
    const x = screen.getByLabelText("Heatmap X axis") as HTMLSelectElement;
    const y = screen.getByLabelText("Heatmap Y axis") as HTMLSelectElement;
    expect(x.value).toBe("param:a");
    expect(y.value).toBe("param:b");
    fireEvent.change(x, { target: { value: "param:b" } });
    expect((screen.getByLabelText("Heatmap X axis") as HTMLSelectElement).value).toBe("param:b");
    expect((screen.getByLabelText("Heatmap Y axis") as HTMLSelectElement).value).toBe("param:a");
  });

  it("hover on an aggregated cell names the collapsed axis value", () => {
    render(<SweepResults rows={rows3} axes={axes3} onApply={() => {}} />);
    const best = [...document.querySelectorAll(".sweep-cell")].find((c) => c.textContent === "+80.00")!;
    fireEvent.mouseEnter(best);
    expect(document.querySelector(".sweep-heat-detail")!.textContent).toContain("C 200");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/SweepResults.test.tsx`
Expected: every new test FAILS (with 3 axes the heatmap doesn't render at all today, so `.sweep-cell` is absent and the pickers don't exist). Pre-existing tests PASS.

- [ ] **Step 3: Implement**

All edits in `frontend/src/SweepResults.tsx`.

3a. Update the file header comment (lines 1-6). Replace the phrase `plus a heatmap for exactly 2 axes (a DOM grid, diverging color scale around 0 on a selectable metric) or a single-row strip for 1 axis.` with:

```
// heatmap whenever axes exist: a DOM grid (diverging color scale around 0 on a
// selectable metric) or a single-row strip for 1 axis. With 3+ axes, X/Y
// dropdowns pick the grid axes and each cell shows the BEST matching row by
// the color metric over the collapsed axes (min for drawdown).
```

(Keep the rest of the header comment as is.)

3b. Remove the gate at ~line 132. Change:

```tsx
      {axes.length > 0 && axes.length <= 2 && (
```

to:

```tsx
      {axes.length > 0 && (
```

3c. Update the comment above `SweepHeatmap` (~line 219). Replace:

```tsx
// 2-axis grid (x = axis 0 values, y = axis 1 values) or 1-axis single-row
// strip. Cell background is the diverging scale; click applies that cell's
// combo the same as a table row click.
```

with:

```tsx
// Grid over two picked axes (defaults: first two) or 1-axis single-row strip.
// With 3+ axes the unpicked axes collapse: each cell shows the best matching
// row by the color metric (min for drawdown), and clicking applies that best
// row's full combo. Cell background is the diverging scale.
```

3d. Inside `SweepHeatmap`, replace the exact-match `find` and the hardcoded axis selection. Replace this block:

```tsx
  const find = (match: Record<string, number | string>) =>
    rows.find((r) => Object.entries(match).every(([k, v]) => r.combo[k] === v));
```

with:

```tsx
  // Direction-aware "which row is better" on the selected color metric:
  // higher wins except drawdown (lower wins); a successful row always beats
  // a failed one; among two failures the first seen is kept.
  const better = (a: SweepRow, b: SweepRow): SweepRow => {
    const av = metricValue(a, metric);
    const bv = metricValue(b, metric);
    if (bv === null) return a;
    if (av === null) return b;
    if (metric === "max_drawdown") return bv < av ? b : a;
    return bv > av ? b : a;
  };
  // A cell's row: the best row (per `better`) among all rows matching the
  // cell's x+y values. With <= 2 axes each cell matches at most one row, so
  // this degenerates to today's exact lookup.
  const find = (match: Record<string, number | string>) => {
    let best: SweepRow | undefined;
    for (const r of rows) {
      if (!Object.entries(match).every(([k, v]) => r.combo[k] === v)) continue;
      best = best ? better(best, r) : r;
    }
    return best;
  };
```

Then replace:

```tsx
  const xAxis = axes[0];
  const yAxis = axes[1];
```

with:

```tsx
  // Picked grid axes, stored by TARGET (stable across streaming re-renders);
  // a stale target (new sweep, different axes) falls back to the defaults:
  // X = first axis, Y = second, never the axis the other picker holds.
  const [xSel, setXSel] = useState<string | null>(null);
  const [ySel, setYSel] = useState<string | null>(null);
  const xAxis = axes.find((a) => a.target === xSel) ?? axes[0];
  const yAxis = axes.find((a) => a.target === ySel && a.target !== xAxis.target)
    ?? axes.find((a) => a.target !== xAxis.target);
  const collapsed = axes.filter((a) => a !== xAxis && a !== yAxis);
  // Picking in one dropdown the axis the other holds swaps them: X and Y can
  // never be the same axis.
  const pickX = (t: string) => { if (t === yAxis?.target) setYSel(xAxis.target); setXSel(t); };
  const pickY = (t: string) => { if (t === xAxis.target) setXSel(yAxis?.target ?? null); setYSel(t); };
```

(`useState` is already imported at the top of the file; `xTicks`/`yTicks` below need no change.)

3e. Add the pickers to the header row. Inside the `.sweep-heat-metric` div, immediately after the closing `</select>` of the color-metric dropdown, insert:

```tsx
        {axes.length > 2 && (
          <span className="sweep-heat-axes">
            <select aria-label="Heatmap X axis" value={xAxis.target} onChange={(e) => pickX(e.target.value)}>
              {axes.map((a) => <option key={a.target} value={a.target}>{a.label}</option>)}
            </select>
            <span>by</span>
            <select aria-label="Heatmap Y axis" value={yAxis!.target} onChange={(e) => pickY(e.target.value)}>
              {axes.map((a) => <option key={a.target} value={a.target}>{a.label}</option>)}
            </select>
          </span>
        )}
```

(`yAxis!` is safe there: with `axes.length > 2` a second axis always exists.)

3f. Prefix the hover detail with the collapsed axes' values. In the hover detail, the non-error branch currently reads:

```tsx
              ) : (
                METRIC_COLS.map((c) => (
                  <span key={c.key} className="sweep-heat-detail-stat">
                    <span className="sweep-heat-detail-lbl">{c.abbr}</span>
                    <span className="sweep-heat-detail-val">{fmtMetric(c.key, metricValue(hovered, c.key))}</span>
                  </span>
                ))
              )}
```

Replace it with:

```tsx
              ) : (
                <>
                  {collapsed.length > 0 && (
                    <span className="sweep-heat-detail-combo">
                      @ {collapsed.map((a) => `${a.label} ${comboAxisText(a, hovered.combo as Record<string, number | string>)}`).join(", ")}
                    </span>
                  )}
                  {METRIC_COLS.map((c) => (
                    <span key={c.key} className="sweep-heat-detail-stat">
                      <span className="sweep-heat-detail-lbl">{c.abbr}</span>
                      <span className="sweep-heat-detail-val">{fmtMetric(c.key, metricValue(hovered, c.key))}</span>
                    </span>
                  ))}
                </>
              )}
```

(`.sweep-heat-detail-combo` already exists in App.css; `comboAxisText` is already imported at the top of `SweepResults.tsx`.)

3g. In `frontend/src/App.css`, directly after the `.sweep-heat-metric` rule (~line 4251), add:

```css
.sweep-heat-axes { display: inline-flex; align-items: center; gap: 6px; flex: none; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/SweepResults.test.tsx`
Expected: PASS, including all pre-existing tests (the 1- and 2-axis paths must be behaviorally unchanged).

Run: `cd frontend && npx tsc -b`
Expected: no NEW errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/SweepResults.tsx frontend/src/SweepResults.test.tsx frontend/src/App.css
git commit -m "feat(sweep): heatmap X/Y axis pickers with best-over-collapsed cells"
```

---

### Task 3: Verification

**Files:**
- No planned source changes (fixes only if verification finds problems).

- [ ] **Step 1: Full frontend suite + typecheck**

Run: `cd frontend && npx vitest run && npx tsc -b`
Expected: green except failures already known to come from concurrent sessions (anything in files this feature never touched; the Global Constraints list them).

- [ ] **Step 2: Drive the app (do NOT kill the user's dev servers)**

If the shared checkout's app is broken by another session's in-progress edits, verify in an isolated worktree at HEAD: `git worktree add <scratchpad>/three-axes-verify HEAD`, symlink `frontend/node_modules`, run `VITE_API_BASE="" npx vite --port 5199 --strictPort` (the vite proxy forwards /api to :8000), and clean up (kill vite, `git worktree remove`) when done.

Checks:
1. Rules mode: sweep 3 numeric fields (e.g. two indicator lengths + stop %). All three inline editors stay visible; the footer shows three factors (a × b × c = N runs); nothing gets dropped when the third toggles on.
2. Set the ranges so the total is between 200 and 1000 (e.g. 8 × 8 × 8 = 512): Run stays ENABLED (old cap would have blocked). Run the sweep end to end; progress streams; the results table lists all combos.
3. Heatmap: X/Y pickers appear beside the color-metric dropdown, defaulting to the first two axes. Cells render; hovering an aggregated cell shows the "@ <collapsed axis> <value>" prefix in the detail strip; clicking a cell applies the best combo (config fields update to it).
4. Swap: pick in X the axis currently in Y; they exchange.
5. Change the color metric to Drawdown; cell values change (best-by-min).
6. A 2-axis sweep still renders the classic heatmap with NO pickers.
7. Push one range past the cap (> 1000 total): footer count goes over-cap styled and Run disables.

- [ ] **Step 3: Fix anything found, re-run affected tests, commit (skip if nothing found)**

```bash
git add <only-the-files-you-touched>
git commit -m "fix(sweep): findings from 3+ axes verification"
```

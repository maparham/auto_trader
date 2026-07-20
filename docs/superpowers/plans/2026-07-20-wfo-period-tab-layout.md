# Walk-forward Period tab layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the walk-forward (WFO) Period tab into a "Data window" section (always-visible From/To range picker + Timeframe + Holdout, with relative and calendar quick-fill chips) and a "Schedule" section (the existing WfoConfig), leaving normal/sweep modes untouched.

**Architecture:** The Period `<section>` in `BacktestSettingsModal.tsx` currently renders one `<Section title="Time range">` for all modes, with `WfoConfig` wedged inside and the calendar chips trailing after it. We branch on `btMode === "walkforward"`: the WFO branch renders two `<Section>`s reusing extracted sub-controls (range picker, Timeframe select, Holdout select); the non-WFO branch keeps today's markup verbatim. The From/To picker is shown unconditionally in WFO and displays the *resolved* window so rolling relative modes still render real dates.

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react. Test runner: `npm run test:unit` (from `frontend/`). Typecheck: `npm run build` runs `tsc -b`.

## Global Constraints

- No em dashes in end-user-visible strings/copy (project rule). Code/comments/commits may use them.
- WFO payload/logic is out of scope: do not touch `frontend/src/lib/wfo.ts` or `buildWalkForwardPayload`.
- Normal (`backtest`) and `sweep` modes must render the Period tab exactly as before. The full existing `BacktestSettingsModal.test.tsx` suite must stay green.
- Reuse shared components: the two new group headers use the existing `Section` component. Chips reuse existing `bt-chip` / `bt-chip-row` classes. No shadows, content-sized (house UX conventions).
- Preserve range semantics: relative fills (`1D/1W/1M/1Y`) stay rolling (`fromMs`/`toMs` unset, computed against now); calendar chips write fixed `fromMs`/`toMs`; a manual From/To edit is a fixed `custom` range.

---

### Task 1: Extract shared range sub-controls (refactor, no behavior change)

Pull the Timeframe select, Holdout select, and the From/To picker out of the inline Period JSX into local consts in the component body, then use them in the existing (unchanged) "Time range" markup. This sets up reuse for Task 2 with zero behavior change, guarded by the existing test suite.

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (Period `<section>`, ~1934-2143, plus a new const block just above the `return`)
- Test: `frontend/src/BacktestSettingsModal.test.tsx` (existing suite is the guard)

**Interfaces:**
- Consumes (all already in scope in the component body): `cfg`, `setRange`, `btMode`, `resSeconds`, `holdout`, `changeHoldoutPct`, `controller`, `pickingRange`, `resolveWindow`, `msToLocalInput`, `localInputToMs`, `PERIOD_GROUPS`.
- Produces (new consts used by both branches): `timeframeSelect: JSX.Element`, `holdoutSelect: JSX.Element`, `rangePicker: JSX.Element`, and `pickerFromMs: number | undefined`, `pickerToMs: number | undefined`.

- [ ] **Step 1: Run the existing suite to capture the green baseline**

Run: `cd frontend && npm run test:unit -- BacktestSettingsModal`
Expected: PASS (all existing period-scheduling tests green). This is the safety net for the refactor.

- [ ] **Step 2: Add the extracted consts above the component `return`**

Place this block in the component body, just before the top-level `return (` (near line 1857, after `runDisabled` is defined so all deps exist):

```tsx
// Resolved window drives the always-on From/To display in WFO mode, where the
// range can be a rolling relative mode (fromMs/toMs unset). In non-WFO custom
// mode we keep the raw value so an unpicked range shows blank inputs.
const resolvedWindow = resolveWindow(cfg, resSeconds, Date.now());
const pickerFromMs = btMode === "walkforward" ? resolvedWindow.fromMs : cfg.range.fromMs;
const pickerToMs = btMode === "walkforward" ? resolvedWindow.toMs : cfg.range.toMs;

const timeframeSelect = (
  <label className="bt-tf-inline">
    <span className="bt-tf-label">
      Timeframe
      <InfoTip text="Timeframe the backtest runs on. 'Chart' follows the active chart timeframe." />
    </span>
    <select
      className="bt-tf-select"
      value={cfg.range.resolution ?? ""}
      onChange={(e) => setRange({ resolution: e.target.value || undefined })}
    >
      <option value="">Chart</option>
      {PERIOD_GROUPS.map((group) => {
        const periods = group.periods.filter((p) => !p.liveOnly);
        if (periods.length === 0) return null;
        return (
          <optgroup key={group.label} label={group.label}>
            {periods.map((p) => (
              <option key={p.resolution} value={p.resolution}>
                {p.label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  </label>
);

const holdoutSelect = (
  <label className="bt-tf-inline bt-holdout-inline">
    <span className="bt-tf-label">
      Holdout
      <InfoTip text="Reserve the last part of the range as an out-of-sample lockbox. Normal runs and sweeps stop at the training cutoff; use Evaluate on holdout to test the reserved tail. Every look is counted, because a holdout you check often stops being out-of-sample." />
    </span>
    <select
      className="bt-tf-select"
      value={holdout?.pct ?? 0}
      onChange={(e) => {
        const v = Number(e.target.value);
        changeHoldoutPct(v === 0 ? null : v);
      }}
    >
      <option value={0}>None</option>
      <option value={10}>10%</option>
      <option value={20}>20%</option>
      <option value={30}>30%</option>
    </select>
  </label>
);

const rangePicker = (
  <div className="al-row bt-range-row">
    <label className="bt-range-field">
      <span>From</span>
      <input
        type="datetime-local"
        value={pickerFromMs ? msToLocalInput(pickerFromMs) : ""}
        onChange={(e) => setRange({ mode: "custom", fromMs: localInputToMs(e.target.value) ?? undefined })}
      />
    </label>
    <label className="bt-range-field">
      <span>To</span>
      <input
        type="datetime-local"
        value={pickerToMs ? msToLocalInput(pickerToMs) : ""}
        onChange={(e) => setRange({ mode: "custom", toMs: localInputToMs(e.target.value) ?? undefined })}
      />
    </label>
    <Tooltip
      content={
        !controller
          ? "Focus a chart to pick a range"
          : pickingRange
            ? "Picking… drag across the chart's time axis, or click a start then an end. Esc cancels."
            : "Pick the range on the chart: drag across the time axis, or click a start then an end"
      }
    >
      <button
        type="button"
        className={`bt-pick-range${pickingRange ? " on" : ""}`}
        disabled={!controller}
        aria-label="Pick range on chart"
        onClick={() => {
          if (!controller) return;
          if (controller.rangePickArmed.value) {
            controller.rangePickArmed.set(false);
          } else {
            controller.rangePickArmed.set(true);
            controller.focusChart?.();
          }
        }}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 4v8M13 4v8M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </Tooltip>
  </div>
);
```

Note: the From/To `onChange` now also sets `mode: "custom"`. In non-WFO this is a no-op (the inputs only ever render while already in custom mode); in WFO it makes a manual edit a fixed custom range per the spec.

- [ ] **Step 3: Replace the inline Timeframe/Holdout/From-To markup with the consts**

In the existing `bt-range-mode-row` (~1951-1976) replace the inline Timeframe `<label>` with `{timeframeSelect}`. Replace the inline Holdout `<label>` (~2013-2031) with `{holdoutSelect}`. Replace the whole `{cfg.range.mode === "custom" && ( <div className="al-row bt-range-row">…</div> )}` block (~2089-2143) with `{cfg.range.mode === "custom" && rangePicker}`. Leave the mode seg, Windows input, period sweep glyph, chips, and holdout note exactly as they are.

- [ ] **Step 4: Run the suite to confirm no behavior change**

Run: `cd frontend && npm run test:unit -- BacktestSettingsModal`
Expected: PASS (same tests as Step 1, still green). Also run `npm run build` and expect a clean `tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx
git commit -m "refactor(wfo-ui): extract range picker / timeframe / holdout sub-controls"
```

---

### Task 2: WFO Data window + Schedule sections

Branch the Period section on `btMode === "walkforward"`. The WFO branch renders a "Data window" `<Section>` (always-on `rangePicker` + `timeframeSelect` + `holdoutSelect`, relative chip row, calendar chip row, holdout note) and a "Schedule" `<Section>` wrapping `WfoConfig`. Remove the mode seg, Windows input, and Bars from the WFO path (they simply are not rendered there). The non-WFO branch keeps today's single "Time range" Section.

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (Period `<section>`, ~1934-2172; module-level chip constant near the other `const` tables ~155)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes from Task 1: `rangePicker`, `timeframeSelect`, `holdoutSelect`.
- Consumes existing: `Section`, `WfoConfig`, `wfoCfg`, `changeWfoCfg`, `wfoComboTotal`, `wfoDroppedAxes`, `setRange`, `cfg`, `buildRangeChips`, `chartTimezone`, `holdout`, `holdoutReserved`, `runInFlight`, `evaluateHoldout`.
- Produces: module const `WFO_RELATIVE_CHIPS: { mode: RangeMode; label: string }[]`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/BacktestSettingsModal.test.tsx`. Reuse the file's `renderModal` and `modeSeg` helpers; add a local `enterWfoMode` helper.

```tsx
function enterWfoMode() {
  fireEvent.click(within(modeSeg()).getByRole("button", { name: /Walk-fwd/ }));
}

describe("BacktestSettingsModal walk-forward Period layout", () => {
  it("shows the From/To range picker without selecting Custom, and hides the mode seg + Windows", () => {
    renderModal();
    enterWfoMode();
    // Two datetime-local inputs are always present in WFO mode.
    const container = screen.getByText("Data window").closest("section, div")!;
    expect(within(container).getByText("From")).toBeTruthy();
    expect(within(container).getByText("To")).toBeTruthy();
    // The Bars/Day/.../Custom mode seg and the Windows label are gone in WFO.
    expect(screen.queryByRole("button", { name: "Custom" })).toBeNull();
    expect(screen.queryByText("Windows")).toBeNull();
  });

  it("a relative chip sets a rolling mode; a calendar chip sets a fixed range", () => {
    renderModal();
    enterWfoMode();
    // Relative: rolling -> mode becomes lastMonth, fromMs/toMs cleared.
    fireEvent.click(screen.getByRole("button", { name: "1M" }));
    expect(within(modeSeg()).getByRole("button", { name: /Walk-fwd/ })).toBeTruthy();
    // Calendar: fixed -> a year chip writes explicit dates (mode custom).
    const yearChip = screen.getAllByRole("button").find((b) => /^\d{4}$/.test(b.textContent ?? ""));
    expect(yearChip).toBeTruthy();
    fireEvent.click(yearChip!);
    // After a fixed calendar pick, no relative chip is highlighted.
    expect(screen.getByRole("button", { name: "1M" }).className).not.toMatch(/seg-on/);
  });

  it("renders the Schedule section with the WfoConfig Train control under it", () => {
    renderModal();
    enterWfoMode();
    expect(screen.getByText("Schedule")).toBeTruthy();
    expect(screen.getByText("Train")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm run test:unit -- BacktestSettingsModal`
Expected: FAIL — "Data window"/"Schedule" text not found; "Custom" button still present.

- [ ] **Step 3: Add the relative-chip constant**

Near the other module const tables (after `CHIP_UNIT`, ~171):

```tsx
// WFO quick-fill: relative presets stay rolling (mode set, fromMs/toMs cleared),
// mirroring the non-WFO relative modes.
const WFO_RELATIVE_CHIPS: { mode: RangeMode; label: string }[] = [
  { mode: "lastDay", label: "1D" },
  { mode: "lastWeek", label: "1W" },
  { mode: "lastMonth", label: "1M" },
  { mode: "lastYear", label: "1Y" },
];
```

- [ ] **Step 4: Branch the Period section markup**

Wrap the existing `<Section title="Time range" …>…</Section>` (the block from ~1935 to its `</Section>` at ~2172) in a ternary. Keep the entire existing Section as the `: (…)` non-WFO branch verbatim, and remove the now-unused inline `{btMode === "walkforward" && (<WfoConfig … />)}` from inside it (it moves to the Schedule section). The WFO branch:

```tsx
{btMode === "walkforward" ? (
  <>
    <Section
      title="Data window"
      info="The span of history walk-forward runs over. Set From/To directly, or use a quick-fill chip: relative chips roll with today, calendar chips pin a fixed year."
    >
      <div className="bt-range-mode-row">
        {rangePicker}
        {timeframeSelect}
        {holdoutSelect}
      </div>
      <div className="bt-chip-row bt-range-chip-row">
        {WFO_RELATIVE_CHIPS.map((c) => (
          <button
            key={c.mode}
            className={cfg.range.mode === c.mode ? "seg-on bt-chip" : "bt-chip"}
            onClick={() => setRange({ mode: c.mode, fromMs: undefined, toMs: undefined })}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="bt-chip-row bt-range-chip-row">
        {buildRangeChips("year", Date.now(), chartTimezone).map((chip) => {
          const on = cfg.range.fromMs === chip.fromMs && cfg.range.toMs === chip.toMs;
          return (
            <button
              key={chip.label}
              className={on ? "seg-on bt-chip" : "bt-chip"}
              onClick={() => setRange({ fromMs: chip.fromMs, toMs: chip.toMs })}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
      {holdout && (
        <>
          <div className="al-note">
            Holdout: last {holdout.pct}% reserved
            {holdoutReserved ? ` (${holdoutReserved})` : ""}
          </div>
          <button
            type="button"
            className="ghost bt-holdout-eval"
            disabled={runInFlight}
            onClick={evaluateHoldout}
          >
            Evaluate on holdout
          </button>
          {holdout.peeks > 0 && (
            <div className="al-note">
              Holdout result viewed {holdout.peeks} times. Each look makes it less
              out-of-sample.
            </div>
          )}
        </>
      )}
    </Section>
    <Section
      title="Schedule"
      info="The train/test cadence walk-forward optimizes on: how much history each fold trains over, how far it tests forward, and which metric picks the winning cell."
    >
      <WfoConfig
        cfg={wfoCfg}
        onChange={changeWfoCfg}
        comboTotal={wfoComboTotal}
        droppedAxes={wfoDroppedAxes}
      />
    </Section>
  </>
) : (
  <Section
    title="Time range"
    info="The span of history the backtest trades over. Pick a relative window (last day/week/month/year), a calendar period via the chips, or a custom from/to."
  >
    {/* …existing Time range content, unchanged, minus the inline WfoConfig… */}
  </Section>
)}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npm run test:unit -- BacktestSettingsModal`
Expected: PASS — new WFO layout tests green AND all pre-existing period tests still green (non-WFO branch unchanged).

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run build`
Expected: clean `tsc -b`, Vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(wfo-ui): two-section Period tab — always-on range picker + Schedule"
```

---

### Task 3: Style pass and real-app verification

Confirm the two sections and chip rows read correctly in the running app (light theme first), add only any CSS actually needed for spacing/wrapping, and confirm the WfoConfig footer (combos x scheme) + dropped-axes note sit at the bottom of the Schedule section.

**Files:**
- Modify (only if needed): `frontend/src/App.css` (near existing `bt-chip-row` / `wfo-*` blocks ~2226)
- Verify: WFO Period tab in the running dev app.

- [ ] **Step 1: Launch the app and open the WFO Period tab**

Use the project run/verify flow (do not kill an existing HMR dev server; reuse it if running). Open the Backtest modal, switch the footer mode to **Walk-fwd**, and view the Period tab. Confirm, in light theme:
- The From/To picker shows real resolved dates in a rolling relative mode (e.g. after clicking `1Y`), not blank inputs.
- The `Bars/Day/…/Custom` mode seg and the `Windows` input are absent.
- The relative row (`1D 1W 1M 1Y`) and calendar row (`YTD 2025 …`) both fill From/To; the resolved dates update.
- The Schedule section header sits below Data window, with Train/Test/Objective and the `N combos × M scheme(s)` footer at its bottom.

- [ ] **Step 2: Add spacing CSS only if a visual gap is wrong**

If the two chip rows or the section gap need adjustment, add minimal rules near the existing chip styles, e.g.:

```css
/* WFO Data window: keep the two quick-fill chip rows tight under the picker. */
.bt-mode-walkforward .bt-range-chip-row + .bt-range-chip-row { margin-top: 4px; }
```

Skip this step entirely if the existing `bt-chip-row` spacing already looks right. Do not add shadows; keep content-sized.

- [ ] **Step 3: Final full-suite run + typecheck**

Run: `cd frontend && npm run test:unit && npm run build`
Expected: entire unit suite PASS, `tsc -b` clean.

- [ ] **Step 4: Commit (only if CSS changed)**

```bash
git add frontend/src/App.css
git commit -m "style(wfo-ui): spacing for Data window quick-fill chip rows"
```

---

## Self-Review

- **Spec coverage:** Data window always-on From/To (Task 1 `rangePicker` + Task 2 unconditional render); Timeframe + Holdout kept (Task 1 consts, Task 2 render); relative rolling + calendar fixed chips (Task 2 Step 4); removed mode seg / Windows / Bars in WFO (Task 2 branch omits them); Schedule section wraps WfoConfig with footer/dropped-axes at bottom (Task 2); rolling-vs-fixed semantics preserved (relative chips clear fromMs/toMs; calendar chips set them; manual edit sets custom); normal/sweep untouched (non-WFO branch verbatim, guarded by existing suite). All spec sections map to a task.
- **Placeholder scan:** the only `{/* …existing… */}` marker is an explicit "keep verbatim" instruction pointing at concrete lines (1935-2172), not missing content. No TBD/TODO/"handle edge cases".
- **Type consistency:** `WFO_RELATIVE_CHIPS` uses `RangeMode` (the existing type behind `RANGE_MODES`). `pickerFromMs`/`pickerToMs` are `number | undefined`, matching `cfg.range.fromMs`. `rangePicker`/`timeframeSelect`/`holdoutSelect` are `JSX.Element`, consumed as such in both branches. `buildRangeChips("year", …)` matches its existing call-site signature.

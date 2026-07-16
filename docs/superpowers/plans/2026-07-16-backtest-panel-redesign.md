# Backtest Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declutter the backtest panel: in-place sweep range chips replace injected rows, rule rows become a structured two-line grid, actions collapse into the kebab, the footer is rebuilt around the mode switch, sections calm down, and the panel is resizable from its left edge.

**Architecture:** One new leaf component (`RangeChip`) is adopted at every swept-field site (`StrategyParams`, `OperandPicker`, `CountField`, `RiskSection`), retiring `SweepAxisRow`. The rule row inside `RuleGroupSection` (shared with the Live panel) is restructured into a two-row grid. The footer is extracted into `RunBar`. Panel width becomes persisted device-local state with a drag handle. Everything else is CSS in `App.css`.

**Tech Stack:** React + TypeScript, vitest + @testing-library/react, plain CSS in `frontend/src/App.css`.

**Spec:** `docs/superpowers/specs/2026-07-16-backtest-panel-redesign-design.md`

## Global Constraints

- **Sequencing gate: SATISFIED.** The explicit Backtest/Sweep mode work landed as commit `1f3dee2`; this plan's code excerpts reflect it (e.g. `btMode`, `bt-mode-seg` in the footer). Confirm `frontend/src/BacktestSettingsModal.tsx` is clean in `git status` before Task 1 anyway.
- **Backtest-mode behavior of chips:** the mode work passes `displayAxes = sweepEditable ? sweepAxes : []` down every `sweep` prop (BacktestSettingsModal.tsx ~line 480). In Backtest mode no axes reach the components, so `RangeChip` naturally never renders there and swept fields show their plain editable inputs. Do not add per-call-site `disabled` wiring; the chip's `disabled` prop exists only for completeness and its unit test.
- Work directly on `main`, commit per task, never branch.
- Line numbers in this plan reference the 2026-07-16 working tree; if drifted, locate by the quoted symbol/code, not the number.
- UI copy: no em dashes ("—" or "--") in any user-facing text. Plain, concise language; standard trading terms are fine.
- Visuals: light theme first, flat (no box-shadows), content-sized controls, dismiss-on-outside-click for menus/popovers.
- Always use the shared `Tooltip` (`frontend/src/components/Tooltip.tsx`) / `InfoTip` components, never `title=`.
- Preserve existing aria-labels and menu item names; tests select by them.
- Test command: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run <file>`. Type check: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc -b`.
- `RuleGroupSection`, `RiskSection`, `StrategyParams` are also rendered by `LiveTradingPanel.tsx` (without the `sweep` prop). Never make `sweep` required; every change must keep the sweep-less render identical in behavior.
- Commit trailer for every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `RangeChip` component

A compact chip that stands in for a swept field's value input: shows `from … to / step` plus a step-count badge; clicking opens a portaled popover with from/to/step editors and a "Remove from sweep" action.

**Files:**
- Create: `frontend/src/components/RangeChip.tsx`
- Create: `frontend/src/components/RangeChip.test.tsx`
- Modify: `frontend/src/App.css` (append new styles)

**Interfaces:**
- Consumes: `RangeAxis` and `comboCount` from `frontend/src/lib/sweep.ts` (`RangeAxis = { kind: "range"; target: string; label: string; from: number; to: number; step: number }`; `comboCount(axes: SweepAxis[]): number`), `NumberField` from `frontend/src/components/NumberField.tsx` (props: `value`, `onChange`, `signed?`, `className?`).
- Produces: `export function RangeChip(props: { axis: RangeAxis; onPatch: (patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void; onRemove: () => void; disabled?: boolean })` — Tasks 2, 3, 4 import exactly this.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/RangeChip.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { RangeChip } from "./RangeChip";
import type { RangeAxis } from "../lib/sweep";

const axis: RangeAxis = { kind: "range", target: "param:len", label: "len", from: -2, to: 2, step: 0.5 };

describe("RangeChip", () => {
  it("renders the range and its step count", () => {
    render(<RangeChip axis={axis} onPatch={() => {}} onRemove={() => {}} />);
    const chip = screen.getByRole("button", { name: /sweep len/i });
    expect(chip.textContent).toContain("-2 … 2 / 0.5");
    expect(chip.textContent).toContain("9×");
  });

  it("opens a popover whose fields patch the axis", () => {
    const onPatch = vi.fn();
    render(<RangeChip axis={axis} onPatch={onPatch} onRemove={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /sweep len/i }));
    const from = screen.getByLabelText("From");
    fireEvent.change(from, { target: { value: "-3" } });
    fireEvent.blur(from);
    expect(onPatch).toHaveBeenCalledWith({ from: -3 });
  });

  it("popover offers Remove from sweep", () => {
    const onRemove = vi.fn();
    render(<RangeChip axis={axis} onPatch={() => {}} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /sweep len/i }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from sweep" }));
    expect(onRemove).toHaveBeenCalled();
  });

  it("flags a degenerate range instead of a count", () => {
    render(
      <RangeChip axis={{ ...axis, step: 0 }} onPatch={() => {}} onRemove={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /sweep len/i }).textContent).toContain("∞");
  });

  it("disabled renders inert", () => {
    render(<RangeChip axis={axis} onPatch={() => {}} onRemove={() => {}} disabled />);
    const chip = screen.getByRole("button", { name: /sweep len/i });
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(screen.queryByLabelText("From")).toBeNull();
  });
});
```

Note: `NumberField` commits on change of its inner input; if the `From` assertion fails, check `NumberField.test.tsx` for the exact interaction it expects (change + blur is its committed path) and mirror it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/components/RangeChip.test.tsx`
Expected: FAIL — `Cannot find module './RangeChip'`.

- [ ] **Step 3: Implement `RangeChip`**

Create `frontend/src/components/RangeChip.tsx`. Follow the portal + outside-click pattern of `OperatorPicker` in `BacktestSettingsModal.tsx` (capture-phase mousedown, close on resize/scroll):

```tsx
// In-place editor for one swept numeric axis. Replaces the field's value input
// while its sweep axis is on: a chip reading "from … to / step" with the axis's
// step count, and a click-to-open popover holding the from/to/step fields plus
// a "Remove from sweep" action. Retires the old injected SweepAxisRow line.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { comboCount, type RangeAxis } from "../lib/sweep";
import NumberField from "./NumberField";
import Tooltip from "./Tooltip";

const POP_WIDTH = 230;

export function RangeChip({
  axis,
  onPatch,
  onRemove,
  disabled = false,
}: {
  axis: RangeAxis;
  onPatch: (patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    // Capture phase: the backtest modal stops mousedown from bubbling past
    // itself, which would swallow a bubble-phase listener (see OperatorPicker).
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_WIDTH - 8));
      setPos({ top: r.bottom + 4, left });
    }
    setOpen((v) => !v);
  }

  const n = comboCount([axis]);
  const bad = !isFinite(n);
  return (
    <>
      <Tooltip
        content={
          disabled
            ? "Switch to Sweep mode to edit sweep ranges"
            : bad
              ? "This range never ends (check the step). Click to edit."
              : `Sweeps ${n} values. Click to edit the range.`
        }
      >
        <button
          ref={btnRef}
          type="button"
          className={`range-chip${bad ? " range-chip-bad" : ""}${open ? " open" : ""}`}
          aria-label={`Sweep ${axis.label}: ${axis.from} to ${axis.to} step ${axis.step}`}
          aria-expanded={open}
          disabled={disabled}
          onClick={toggle}
        >
          <span className="range-chip-range">
            {axis.from} … {axis.to} / {axis.step}
          </span>
          <span className="range-chip-count">{bad ? "∞" : `${n}×`}</span>
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="dropdown range-chip-pop"
            style={{ position: "fixed", top: pos.top, left: pos.left }}
          >
            <label className="range-chip-field">
              <span>From</span>
              <NumberField value={axis.from} onChange={(v) => onPatch({ from: v })} signed className="bt-num" aria-label="From" />
            </label>
            <label className="range-chip-field">
              <span>To</span>
              <NumberField value={axis.to} onChange={(v) => onPatch({ to: v })} signed className="bt-num" aria-label="To" />
            </label>
            <label className="range-chip-field">
              <span>Step</span>
              <NumberField value={axis.step} onChange={(v) => onPatch({ step: v })} signed className="bt-num" aria-label="Step" />
            </label>
            <div className="range-chip-pop-foot">
              <span className="range-chip-pop-count">{bad ? "∞ runs" : `${n} runs`}</span>
              <button type="button" className="ghost range-chip-remove" onClick={() => { setOpen(false); onRemove(); }}>
                Remove from sweep
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
```

If `NumberField` doesn't forward `aria-label` to its input, wrap each field's label text in the `<label>` (already done above) and drop the `aria-label` props — `getByLabelText` resolves through the `<label>` element.

- [ ] **Step 4: Add CSS**

Append to `frontend/src/App.css`:

```css
/* --- RangeChip: in-place swept-range editor -------------------------------- */
.range-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 8px; border: 1px solid var(--accent); border-radius: 6px;
  background: var(--surface-2); color: var(--accent);
  font: inherit; font-size: 12px; cursor: pointer; min-width: 0;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.range-chip:hover, .range-chip.open { background: var(--surface-hover, rgba(127,127,127,0.12)); }
.range-chip:disabled { opacity: 0.5; cursor: default; }
.range-chip-count {
  font-size: 10px; font-weight: 600; padding: 1px 4px; border-radius: 4px;
  background: var(--accent); color: var(--accent-text);
}
.range-chip-bad { border-color: var(--neg); color: var(--neg); }
.range-chip-bad .range-chip-count { background: var(--neg); }
.range-chip-pop { padding: 8px; display: flex; flex-direction: column; gap: 6px; width: 214px; }
.range-chip-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
.range-chip-field .bt-num { width: 90px; }
.range-chip-pop-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; }
.range-chip-pop-count { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.range-chip-remove { font-size: 12px; color: var(--neg); }
```

Check `--accent-text`, `--surface-2`, `--neg` exist in `App.css` `:root` (they are used by existing rules cited in this plan; if a name differs, match the existing variable).

- [ ] **Step 5: Run tests, verify pass**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/components/RangeChip.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/mahmoudparham/auto_trader && git add frontend/src/components/RangeChip.tsx frontend/src/components/RangeChip.test.tsx frontend/src/App.css && git commit -m "feat(backtest-ui): RangeChip in-place swept-range editor"
```

---

### Task 2: Adopt `RangeChip` in `StrategyParams`

**Files:**
- Modify: `frontend/src/components/StrategyParams.tsx`
- Test: `frontend/src/components/StrategyParams.test.tsx` (update existing)

**Interfaces:**
- Consumes: `RangeChip` from Task 1.
- Produces: `StrategyParams`'s `sweep` prop unchanged externally (`{ axes, onToggle(target, spec), onAxisChange(target, patch) }`); `onToggle` on an already-swept param removes the axis (existing behavior in `BacktestSettingsModal.toggleSweepAxis`), so it doubles as the chip's `onRemove`.

- [ ] **Step 1: Update the component**

In `frontend/src/components/StrategyParams.tsx`:

1. Replace the import `import { SweepAxisRow } from "./SweepAxisRow";` with `import { RangeChip } from "./RangeChip";`.
2. In the numeric branch (the `NumberField` at line ~80), render the chip **instead of** the disabled input when swept:

```tsx
            ) : axis && sweep ? (
              <RangeChip
                axis={axis}
                onPatch={(p) => sweep.onAxisChange(axis.target, p)}
                onRemove={() => sweep.onToggle(`param:${s.name}`, s)}
              />
            ) : (
              <NumberField
                value={v as number}
                step={s.step ?? undefined}
                onChange={(n) => set(s.name, clamp(s, n))}
                className="sp-num"
              />
            )}
```

(The `disabled={swept}` prop on `NumberField` goes away — the input is no longer rendered while swept.)
3. Delete the trailing block:

```tsx
            {axis && sweep && (
              <SweepAxisRow axis={axis} onChange={(p) => sweep.onAxisChange(axis.target, p)} />
            )}
```

and the now-unneeded `Fragment` wrapper if nothing else needs it (keep `key` on the remaining root element).

- [ ] **Step 2: Update the existing test**

Open `frontend/src/components/StrategyParams.test.tsx`. Any assertion that finds the injected `SweepAxisRow` (text `"len sweep"`, class `sweep-axis-row`, or a from/to/step input while swept) must instead assert the chip: `screen.getByRole("button", { name: /sweep/i })` within the row. Any assertion that a swept param's `NumberField` is disabled must instead assert the input is absent and the chip present.

- [ ] **Step 3: Run tests**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/components/StrategyParams.test.tsx src/components/RangeChip.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/mahmoudparham/auto_trader && git add -A frontend/src/components && git commit -m "feat(backtest-ui): strategy params sweep via RangeChip, no injected row"
```

---

### Task 3: Adopt `RangeChip` in rule rows (`OperandPicker`, `CountField`, `RuleGroupSection`)

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (`OperandPicker` ~line 3164, `CountField` ~line 3100, `RuleGroupSection` rule map ~line 3025)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `RangeChip` from Task 1.
- Produces: `OperandPicker`'s `sweep` prop grows two members, supplied by `RuleGroupSection`:
  `sweep?: { axes: SweepAxis[]; onToggle: (target: string, current: number) => void; onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void; target: (leaf: "length" | "value") => string }`.
  `CountField`'s `sweep` prop likewise gains `onAxisChange`.

- [ ] **Step 1: Extend `OperandPicker`**

In `OperandPicker`:

1. Add `onAxisChange` to the `sweep` prop type (exactly the signature above).
2. Add a helper next to `isSwept`:

```tsx
  const sweptAxis = (leaf: "length" | "value") =>
    sweep?.axes.find((a): a is RangeAxis => a.kind === "range" && a.target === sweptTarget(leaf));
```

(Import `RangeAxis` type — it is already imported at the top of the file via `from "./lib/sweep"`; extend that import if not.)
3. Indicator length: replace the disabled input + toggle pair

```tsx
              <input
                type="number"
                min={1}
                className="bt-operand-length"
                value={value.length ?? 9}
                disabled={isSwept("length")}
                ...
              />
              {sweepToggle("length", value.length ?? 9)}
```

with a swept/unswept branch:

```tsx
              {(() => {
                const axis = sweptAxis("length");
                return axis && sweep ? (
                  <RangeChip
                    axis={axis}
                    onPatch={(p) => sweep.onAxisChange(axis.target, p)}
                    onRemove={() => sweep.onToggle(axis.target, value.length ?? 9)}
                  />
                ) : (
                  <>
                    <input
                      type="number"
                      min={1}
                      className="bt-operand-length"
                      value={value.length ?? 9}
                      onKeyDown={blockNegKeys}
                      onChange={(e) => onChange({ ...value, length: Number(cleanNumInput(e.currentTarget)) })}
                      onBlur={(e) => clampPosOnBlur(e.currentTarget, 1, (n) => onChange({ ...value, length: n }))}
                    />
                    {sweepToggle("length", value.length ?? 9)}
                  </>
                );
              })()}
```

4. Const value: same pattern around the `NumberField`/`sweepToggle("value", ...)` pair (keep the `%/hr` unit hint rendering in both branches).

- [ ] **Step 2: Extend `CountField` the same way**

`CountField` (~line 3100) has `sweep?: { axes; onToggle; target: string }`. Add `onAxisChange` to its type; when `sweep.axes` contains a range axis with `target === sweep.target`, render `<RangeChip axis={axis} onPatch={(p) => sweep.onAxisChange(axis.target, p)} onRemove={() => sweep.onToggle(sweep.target, n || 1)} />` in place of its number input (keep the ordinal suffix hidden while swept).

- [ ] **Step 3: Wire and strip `RuleGroupSection`**

1. The two `OperandPicker` call sites (~lines 2936, 2945) and the `CountField` site (~2947) each add `onAxisChange: sweep.onAxisChange` to the `sweep` object they pass.
2. Delete the injected rows block (~lines 3025-3031):

```tsx
        {sweep && rule.enabled !== false && sweep.axes
          .filter((a): a is RangeAxis =>
            a.kind === "range" &&
            a.target.startsWith(`rule:${sweep.side}.${sweep.group}.${activeRuleIndex(i)}.`))
          .map((a) => (
            <SweepAxisRow key={a.target} axis={a} onChange={(p) => sweep.onAxisChange(a.target, p)} />
          ))}
```

Keep the operator list-axis chips block above it (it is a `list` axis, not a range).

- [ ] **Step 4: Run the modal tests**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: PASS. If a test asserted the old `sweep-axis-row` under a rule, update it to find the chip (`getByRole("button", { name: /sweep .*: .* to .* step/i })`).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader && git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx && git commit -m "feat(backtest-ui): rule-field sweeps edit in place via RangeChip"
```

---

### Task 4: Adopt `RangeChip` in `RiskSection`, retire `SweepAxisRow`

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (`RiskSection` ~lines 2090-2252)
- Delete: `frontend/src/components/SweepAxisRow.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes: `RangeChip` from Task 1; `RiskSection.sweep` prop unchanged externally.
- Produces: nothing new; `SweepAxisRow` no longer exists anywhere.

- [ ] **Step 1: Replace `axisRow` with in-place chips**

In `RiskSection`:

1. Change the `num(...)` helper's `disabled` parameter usage: the swept branches stop rendering `num(...)` at all. For each of the four swept-capable sites (stop value, stop mult, target value, target mult), apply this pattern (stop/pct shown; mirror for the other three):

```tsx
        {(risk.stop.kind === "pct" || risk.stop.kind === "trailPct") && (() => {
          const axis = sweep?.axes.find(
            (a): a is RangeAxis => a.kind === "range" && a.target === `risk:${sweepSide}.stop.value`);
          return axis && sweep ? (
            <>
              <RangeChip
                axis={axis}
                onPatch={(p) => sweep.onAxisChange(axis.target, p)}
                onRemove={() => sweep.onToggle(axis.target, risk.stop.value ?? 2)}
              />
              <span>%</span>
            </>
          ) : (
            <>
              {num(risk.stop.value, (n) => onChange({ ...risk, stop: { ...risk.stop, value: n } }), "any", 0.01)}
              <span>%</span>
              {sweepBtn("stop", "value", risk.stop.value ?? 2)}
            </>
          );
        })()}
```

For ATR sites keep the length input rendered in both branches (only `mult` is swept).
2. Delete the `axisRow` helper and its four call sites (`{axisRow("stop", "value")}` etc.).
3. The synced-sides visibility rule that lived in `axisRow` (`if (sync?.on && sweep.side !== "long" && !sweep.mirrorEditor) return null;`) is now moot: the chip renders wherever the field renders, both sides show the same synced value. The `mirrorEditor` flag becomes unused: remove it from `RiskSection`'s prop type and from both call sites (`SidePanel` ~line 2425 passes `mirrorEditor: true`; the coded-mode call site does not pass it).

- [ ] **Step 2: Delete `SweepAxisRow`**

```bash
cd /Users/mahmoudparham/auto_trader && grep -rn "SweepAxisRow" frontend/src --include='*.tsx' --include='*.ts'
```

Expected remaining hits: only the import in `BacktestSettingsModal.tsx` (line 63) and the file itself. Remove the import, then `git rm frontend/src/components/SweepAxisRow.tsx`. The `.sweep-axis-row` CSS class stays (the period-sweep row `bt-period-sweep`, time-window row, and operator-chips row still use it).

- [ ] **Step 3: Type check + tests**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc -b && npx vitest run src/BacktestSettingsModal.test.tsx src/components/StrategyParams.test.tsx`
Expected: clean build, tests PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/mahmoudparham/auto_trader && git add -A frontend/src && git commit -m "feat(backtest-ui): risk sweeps via RangeChip; retire SweepAxisRow"
```

---

### Task 5: Two-line rule row grid + actions into the kebab

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (`RuleGroupSection` rule map ~2933-2999, `RuleMenu` ~2678)
- Modify: `frontend/src/App.css` (`.bt-rule-row` block ~1230)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RuleMenu` gains an `onSwapSides: () => void` prop and a "Swap sides" menuitem. The rule row DOM becomes `.bt-rule-row > .bt-rule-main + .bt-rule-meta`.

- [ ] **Step 1: Restructure the row markup**

In the `group.rules.map` body, replace the current flat row with:

```tsx
        <div className={`bt-rule-row${rule.enabled === false ? " bt-rule-disabled" : ""}`}>
          <div className="bt-rule-main">
            <OperandPicker ... (unchanged props, left) />
            <OperatorPicker ... (unchanged) />
            <OperandPicker ... (unchanged props, right) />
          </div>
          <div className="bt-rule-meta">
            {isExit && <CountField ... (unchanged props) />}
            <div className="bt-rule-actions">
              <RuleMenu
                enabled={rule.enabled !== false}
                onDuplicate={() => duplicateRule(i)}
                onCopy={() => onCopy(rule)}
                onToggleEnabled={() => setRule(i, { ...rule, enabled: rule.enabled === false })}
                onSwapSides={() => setRule(i, swapSides(rule))}
                onRemove={() => removeRule(i)}
              />
            </div>
          </div>
        </div>
```

The three standalone buttons (eye `Enable/Disable rule`, `Swap sides` ⇄, `Delete rule` trash) are deleted; the `EyeIcon` component stays (RuleMenu may use it, see below), delete it only if unreferenced after this step.

- [ ] **Step 2: Add "Swap sides" to `RuleMenu`**

Add the prop `onSwapSides: () => void` and, in the menu list between the existing items (order: Duplicate, Copy, Swap sides, Disable/Enable, Remove):

```tsx
            <li role="menuitem" onClick={() => run(onSwapSides)}>Swap sides</li>
```

Match the exact `<li role="menuitem">` idiom of the surrounding items (they use a `run` helper that closes the menu first — reuse it).

- [ ] **Step 3: Grid CSS**

Replace the `.bt-rule-row` rule (~line 1230):

```css
.bt-rule-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
}
/* Line 1: left operand, operator, right operand. Never wraps; operands shrink
   and their chip labels ellipsize instead. */
.bt-rule-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
}
/* Line 2: modifiers left, actions pinned right. Collapses to nothing when a
   plain entry rule has no count and actions are the only content. */
.bt-rule-meta { display: flex; align-items: center; gap: 6px; min-height: 24px; }
.bt-rule-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; opacity: 0.45; transition: opacity 120ms; }
.bt-rule-row:hover .bt-rule-actions,
.bt-rule-row:focus-within .bt-rule-actions { opacity: 1; }
```

and change `.bt-operand` to never wrap, letting the AVWAP anchor shrink instead:

```css
.bt-operand { display: flex; align-items: center; flex-wrap: nowrap; gap: 4px; min-width: 0; }
.bt-operand-chip { min-width: 0; }
.bt-operand-anchor { flex: 1 1 120px; min-width: 0; }
```

(Remove the old `.bt-rule-actions` rule at ~1361 and the `.bt-operand-anchor { flex: 1 1 100%; }` at ~1320; keep `.bt-rule-disabled .bt-rule-toggle` and related disabled styling.)

- [ ] **Step 4: Update tests**

In `BacktestSettingsModal.test.tsx`:
- ~line 208 `fireEvent.click(within(entry).getByLabelText("Delete rule"));` → `ruleAction(entry, "Remove");`
- Search the file for `getByLabelText("Swap sides")`, `"Enable rule"`, `"Disable rule"` on standalone buttons and convert to `ruleAction(section, "Swap sides")` / `ruleAction(section, "Disable")` as needed.

- [ ] **Step 5: Run tests**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: PASS.

Also run the Live panel's tests (shared component): `npx vitest run src/LiveTradingPanel.test.tsx` (if the file exists; skip if not).

- [ ] **Step 6: Commit**

```bash
cd /Users/mahmoudparham/auto_trader && git add -A frontend/src && git commit -m "feat(backtest-ui): two-line rule rows, actions consolidated into kebab"
```

---

### Task 6: Section hierarchy (compact segments, AND/OR in header, inline arm switch)

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (side tabs ~1706, `SidePanel` ~2359, `RuleGroupSection` ~2916)
- Modify: `frontend/src/App.css` (~1406-1428, ~4201)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SidePanel` loses its internal `.bt-arm` block; the parent renders the arm switch beside the side tabs. `RuleGroupSection` renders AND/OR inside the `Section` `extra`.

- [ ] **Step 1: Compact the segmented controls**

In `App.css`, replace:

```css
.bt-side-tabs { width: 100%; margin-top: 4px; }
.bt-side-tabs button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
```

with:

```css
.bt-side-tabs { margin-top: 4px; }
.bt-side-tabs button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 4px 14px; }
```

and delete the full-color selected fills (~1419-1420):

```css
.bt-side-tabs .bt-side-long.seg-on { background: var(--pos); }
.bt-side-tabs .bt-side-short.seg-on { background: var(--neg); }
```

plus the two `.seg-on .bt-side-dot` compensation rules below them (~1421-1428) — the colored dot (`.bt-side-long .bt-side-dot { background: var(--pos); }`) now carries the side color in every state. Same treatment for `.bt-mode-tabs` (~4201): drop `width: 100%` and `button { flex: 1 }`.

- [ ] **Step 2: Arm switch inline with the side tabs**

In `BacktestSettingsModal.tsx` (~1706), wrap the side tabs and move the arm switch out of `SidePanel`:

```tsx
          <div className="bt-side-row">
            <div className="bt-side-tabs seg">
              ... (both side buttons unchanged) ...
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={sideEnabled}
              aria-label={`Trade the ${side} side`}
              className={`bt-switch${sideEnabled ? " on" : ""}`}
              onClick={() => setCfg({ ...cfg, [side === "long" ? "longEnabled" : "shortEnabled"]: !sideEnabled })}
            >
              <span className="bt-switch-knob" />
            </button>
            <span className={`bt-arm-state${sideEnabled ? " on" : ""}`} aria-hidden="true">{sideEnabled ? "Trading" : "Parked"}</span>
          </div>
```

with `const sideEnabled = (side === "long" ? cfg.longEnabled : cfg.shortEnabled) !== false;` declared beside it. In `SidePanel` delete the whole `.bt-arm` block (lines ~2359-2375) and its `enabled` derivation stays (the parked note and `inert` wrapper remain unchanged). Add CSS:

```css
.bt-side-row { display: flex; align-items: center; gap: 10px; }
.bt-side-row .bt-arm-state { margin-left: auto; }
```

The `.bt-arm` / `.bt-arm-label` CSS rules become unused — delete them.

- [ ] **Step 3: AND/OR into the group header**

In `RuleGroupSection`, delete the `bt-rule-groophead` block (~2921-2932) and prepend the combiner to the `extra` cluster (only with 2+ rules):

```tsx
      extra={
        group.rules.length > 0 ? (
          <div className="bt-groophead-actions">
            {group.rules.length > 1 && (
              <div className="seg bt-combine-seg" role="group" aria-label="Combine rules with">
                <button className={group.combine === "AND" ? "seg-on" : ""} onClick={() => setCombine("AND")}>AND</button>
                <button className={group.combine === "OR" ? "seg-on" : ""} onClick={() => setCombine("OR")}>OR</button>
              </div>
            )}
            ... (existing reverse / copy-all / delete-all buttons unchanged) ...
          </div>
        ) : undefined
      }
```

Add hover-reveal for the icon actions only (never hide the AND/OR state):

```css
.bt-combine-seg { font-size: 11px; }
.bt-groophead-actions > .bt-rule-toggle { opacity: 0.4; transition: opacity 120ms; }
.instrument-section-title:hover .bt-rule-toggle,
.bt-groophead-actions > .bt-rule-toggle:focus-visible { opacity: 1; }
```

(Verify the section title row's class is `instrument-section-title bt-section-title` — see `SectionTitle` ~2446 — and scope the hover to it.)

- [ ] **Step 4: Tests + visual check**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: PASS. Tests that clicked the AND/OR buttons or the arm switch by role/name still pass (names unchanged: `role="switch"` + `Trade the long side`, buttons `AND`/`OR`).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader && git add -A frontend/src && git commit -m "feat(backtest-ui): compact segments, AND/OR in group header, inline arm switch"
```

---

### Task 7: `RunBar` footer component

**Files:**
- Create: `frontend/src/components/RunBar.tsx`
- Modify: `frontend/src/BacktestSettingsModal.tsx` (footer ~1933-2056)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: existing footer contents (mode seg, sweep info, compute toggle, Inspect, Go live, Run).
- Produces:

```tsx
export function RunBar(props: {
  mode: "backtest" | "sweep";
  onSelectMode: (m: "backtest" | "sweep") => void;
  modeBadge: ReactNode;          // combo count / progress, rendered inside the Sweep segment
  sweepInfo: ReactNode;          // per-axis math, estimate, compute toggle (sweep mode only)
  inspectOn: boolean;
  onToggleInspect: () => void;
  onGoLive: () => void;
  runLabel: string;
  runDisabled: boolean;
  onRun: () => void;
}): JSX.Element
```

- [ ] **Step 1: Create `RunBar`**

`frontend/src/components/RunBar.tsx` renders, in order: mode segment (left, with `modeBadge` inside the Sweep button), `sweepInfo` slot, then a right-aligned cluster: Inspect ghost toggle (magnifier svg + label, `aria-pressed`), "Go live →" ghost, and the primary Run button. Copy the existing footer JSX for each piece verbatim from `BacktestSettingsModal.tsx` (~1933-2056) — including the `Tooltip` wrappers and all class names (`bt-mode-seg`, `bt-mode-badge`, `bt-sweep-foot-info`, `bt-inspect-foot`, `bt-golive`, `bt-run-btn`) — swapping direct state reads for the props above. **The `Close` button is dropped entirely** (the header × remains the only close).

- [ ] **Step 2: Use it in the modal**

Replace the footer block with:

```tsx
        <div className="modal-foot bt-cfg-foot">
          <RunBar
            mode={btMode}
            onSelectMode={selectMode}
            modeBadge={sweepState?.running ? (
              <span className="bt-mode-badge">{sweepState.done}/{sweepState.total}</span>
            ) : btMode === "backtest" && sweepAxes.length > 0 && isFinite(sweepCombos) ? (
              <span className="bt-mode-badge">{sweepCombos}</span>
            ) : null}
            sweepInfo={<>
              {/* Copied verbatim from the old footer (~lines 1989-2036): the
                  `btMode === "sweep" && sweepAxes.length === 0` hint span, the
                  per-axis `sweep-counter` math span, the `bt-sweep-estimate`
                  span, and the `bt-compute-toggle` Local/Remote seg. All four
                  keep their exact JSX; only their enclosing slot moves. */}
            </>}
            inspectOn={inspectMode}
            onToggleInspect={() => inspectModeSignal.set(!inspectModeSignal.value)}
            onGoLive={() => requestGoLive(cfg)}
            runLabel={runInFlight ? "Running…" : btMode === "sweep" ? "Run sweep" : "Run backtest"}
            runDisabled={runInFlight || (btMode === "sweep" && sweepAxes.length === 0)}
            onRun={runFromFooter}
          />
        </div>
```

(If `RunBar` owning the `modal-foot` div reads cleaner, that's fine — keep the class names either way.)

- [ ] **Step 3: Footer CSS polish**

```css
.bt-cfg-foot { display: flex; align-items: center; gap: 10px; }
.bt-cfg-foot .bt-run-cluster { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }
.bt-inspect-foot, .bt-golive { color: var(--text-faint); }
.bt-inspect-foot:hover, .bt-golive:hover, .bt-inspect-foot.on { color: var(--text); }
```

(Wrap Inspect/Go live/Run in `<div className="bt-run-cluster">` inside `RunBar`.)

- [ ] **Step 4: Update tests + run**

Any test clicking the footer `Close` button must use the header close instead (`CloseButton` — find its aria-label in `components/` and target that). Then:
Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestSettingsModal.test.tsx src/BacktestButton.test.tsx`
Expected: PASS (skip `BacktestButton.test.tsx` if it doesn't exist).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader && git add -A frontend/src && git commit -m "feat(backtest-ui): RunBar footer, primary Run, Close moves to header only"
```

---

### Task 8: Resizable panel (left-edge drag)

**Files:**
- Modify: `frontend/src/lib/persist/defaults.ts` (add width load/save)
- Modify: `frontend/src/lib/persist/core.ts` (`DEVICE_LOCAL_FLAT_KEYS` ~line 117)
- Modify: `frontend/src/BacktestSettingsModal.tsx` (panel root ~1130)
- Modify: `frontend/src/App.css` (`.bt-cfg-panel` ~1052)

**Interfaces:**
- Produces in `defaults.ts`:

```ts
export function loadBacktestPanelWidth(): number;
export function saveBacktestPanelWidth(w: number): void;
```

- [ ] **Step 1: Persist plumbing**

In `defaults.ts`, next to `loadBacktestSplit` (~line 173):

```ts
// Backtest panel width (px), dragged via its left-edge handle. Device-local
// view preference like the split above.
const BACKTEST_PANEL_WIDTH_KEY = `${PREFIX}.backtestPanelWidth`;
export const BACKTEST_PANEL_DEFAULT_WIDTH = 720;
export function loadBacktestPanelWidth(): number {
  const w = load<number>(BACKTEST_PANEL_WIDTH_KEY, BACKTEST_PANEL_DEFAULT_WIDTH);
  return Number.isFinite(w) && w >= 560 ? w : BACKTEST_PANEL_DEFAULT_WIDTH;
}
export function saveBacktestPanelWidth(w: number): void {
  saveLocal(BACKTEST_PANEL_WIDTH_KEY, w);
}
```

In `core.ts`, add `` `${PREFIX}.backtestPanelWidth`, `` to `DEVICE_LOCAL_FLAT_KEYS` (this is mandatory — without it hydrateFromBackend prunes the key on the second reload; see the comment above the set).

- [ ] **Step 2: Handle + state in the modal**

In `BacktestSettingsModal`:

```tsx
  const [panelWidth, setPanelWidth] = useState<number>(() => loadBacktestPanelWidth());
  const clampWidth = (w: number) =>
    Math.max(560, Math.min(w, Math.max(560, window.innerWidth - 380)));
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let w = startW;
    const onMove = (ev: PointerEvent) => {
      // Left edge: dragging left (negative dx) grows the panel.
      w = clampWidth(startW + (startX - ev.clientX));
      setPanelWidth(w);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      saveBacktestPanelWidth(w);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };
```

Root render (~1130) gains the handle and the width style:

```tsx
    <aside className={`bt-cfg-panel bt-mode-${btMode}`} style={{ width: panelWidth }}>
      <div
        className="bt-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize backtest panel"
        onPointerDown={onResizeStart}
        onDoubleClick={() => { setPanelWidth(BACKTEST_PANEL_DEFAULT_WIDTH); saveBacktestPanelWidth(BACKTEST_PANEL_DEFAULT_WIDTH); }}
      />
```

Follow the existing `bt-split` splitter's pointer pattern if it differs (check `splitRef` usage ~1138 first and stay consistent with it). Import the three new persist symbols.

- [ ] **Step 3: CSS**

```css
.bt-cfg-panel { position: relative; }  /* merge into the existing rule; width: 720px stays as fallback */
.bt-resize-handle {
  position: absolute; left: -3px; top: 0; bottom: 0; width: 6px;
  cursor: col-resize; z-index: 5;
}
.bt-resize-handle:hover, .bt-resize-handle:active { background: var(--accent); opacity: 0.35; }
```

- [ ] **Step 4: Verify by hand + tests**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc -b && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: clean, PASS. Then in the running dev app (do not start/kill the user's HMR servers if already running; use the existing one): open the backtest panel, drag the left edge both directions, double-click to reset, reload the page twice and confirm the width survives both reloads (the second reload is the prune trap).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader && git add -A frontend/src && git commit -m "feat(backtest-ui): drag left edge to resize panel, width persists device-local"
```

---

### Task 9: Results-region consistency + final polish pass

**Files:**
- Modify: `frontend/src/App.css`
- Modify (only if copy/markup warrants): `frontend/src/SweepResults.tsx`, `frontend/src/BacktestPanel.tsx`

- [ ] **Step 1: Audit and align**

With the app open, compare the RESULTS header, sweep table, and heatmap against the settings sections and fix in CSS only: same small-caps header treatment as `.bt-section-title`, `font-variant-numeric: tabular-nums` on numeric table cells, matching row padding/border tokens, no leftover full-width color fills. Do not restructure either results component.

- [ ] **Step 2: Sweep-mode walkthrough (visual verification)**

In the browser (existing dev server): configure 2 rule sweeps + 1 risk sweep, and verify end to end: chips render in place (no injected rows), rule rows hold two lines with no ragged wrap at 560px and at 1000px width, footer shows mode seg + single combo caption + one primary Run, sweep runs and the table/heatmap render, applying a combo flips to Backtest mode. Take a screenshot for the user (light theme).

- [ ] **Step 3: Full test suite + types**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc -b && npx vitest run`
Expected: clean build, all tests PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/mahmoudparham/auto_trader && git add -A frontend/src && git commit -m "polish(backtest-ui): results region typography + spacing consistency"
```

# Inline Numeric Sweep Editors (SweepAxisRow Retrofit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the numeric sweep editors (from/to/step) for indicator length, const value, risk value/mult, exit count, and coded params from the three standalone `SweepAxisRow` blocks to render inline beneath their subject field, matching the operator/period/time-window pattern.

**Architecture:** `SweepAxisRow` is extracted to a shared component. The modal gains one `patchAxis(target, patch)` helper passed down as `onAxisChange` through the existing `sweep` props. `StrategyParams`, `RiskSection`, and `RuleGroupSection` render the axis row themselves, beneath the field's row; the three standalone render blocks in `BacktestSettingsModal.tsx` are deleted. No change to axis state, enumeration, mirroring, wire format, or backend.

**Tech Stack:** React + TypeScript, vitest + testing-library (jsdom).

**Spec:** `docs/superpowers/specs/2026-07-14-inline-numeric-sweep-editors-design.md`

## Global Constraints

- No change to `SweepAxisRow`'s fields/behavior, axis enumeration, caps (200/20/50), max 2 axes, mirroring, or the run path.
- Sweep axes are session-only state, never persisted.
- NEVER use an em dash ("—" or "--") in any new UI copy, test strings, comments, or labels. Use a colon, comma, or plain hyphen. (Pre-existing em dashes in surrounding lines stay.)
- Use the shared `Tooltip` component for tooltips, never `title=`.
- No legacy/back-compat paths: the standalone blocks are removed, not flag-gated.
- Inactive side (rules mode): an axis on the unselected side tab simply has no visible editor; it still sweeps and counts in the footer. Do NOT add fallback rows.
- Synced risk: axes are canonical on `risk:long.*`. In coded mode (both sides visible at once) the editor renders under the long block only, as today. In rules mode (one side visible) the editor renders under whichever side tab is viewed (`mirrorEditor`).
- Commands: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx` (plus named files); typecheck `cd frontend && npx tsc -b`. Pre-existing tsc errors from concurrent sessions (e.g. `avg_win_loss_ratio` fixtures, BacktestPanel `StoredBacktestResult`) are NOT yours; introduce no new ones.
- The working tree contains unrelated modified files from other sessions: `git add` ONLY the files you changed, never `git add -A`.
- Commit directly to main. End commit messages with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Shared `SweepAxisRow` + inline coded-param editors

**Files:**
- Create: `frontend/src/components/SweepAxisRow.tsx`
- Modify: `frontend/src/BacktestSettingsModal.tsx` (SweepAxisRow definition ~line 1867-1888; param axis block ~1481-1491; `StrategyParams` call ~1475-1480; add `patchAxis` near the other sweep handlers, around the `toggleSweepAxis` definitions)
- Modify: `frontend/src/components/StrategyParams.tsx`
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `RangeAxis` from `frontend/src/lib/sweep`; `NumberField` (default export) from `frontend/src/components/NumberField`.
- Produces (later tasks rely on these exactly):
  - `frontend/src/components/SweepAxisRow.tsx` exporting
    `export function SweepAxisRow({ axis, onChange }: { axis: RangeAxis; onChange: (patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void })`
  - In the modal component scope:
    `const patchAxis = (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => setSweepAxes((axes) => axes.map((a) => (a.target === target && a.kind === "range" ? { ...a, ...patch } : a)));`

- [ ] **Step 1: Write the failing test**

Append to the `describe("coded mode: params, risk, and exit-rule sections", ...)` block in `frontend/src/BacktestSettingsModal.test.tsx` (reuse its `strategies` fixture):

```tsx
  it("param sweep editor renders inline inside the params block", async () => {
    mockStrategies.mockResolvedValue(strategies);
    const initial = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    renderModal(initial);
    openStrategy();
    expect(await screen.findByText("Fast EMA")).toBeTruthy();

    const params = document.querySelector(".strategy-params") as HTMLElement;
    expect(params.querySelector(".sweep-axis-row")).toBeNull();

    // Toggle the param's sweep glyph on: the from/to/step row appears INSIDE
    // the params block (inline), not as a sibling after it.
    fireEvent.click(params.querySelector(".sp-sweep")!);
    expect(params.querySelector(".sweep-axis-row")).toBeTruthy();
    expect(document.querySelectorAll(".sweep-axis-row")).toHaveLength(1);

    // Editing "to" patches the axis: footer combo count grows past 1 run.
    const nums = [...params.querySelectorAll(".sweep-axis-fields input")] as HTMLInputElement[];
    fireEvent.change(nums[1], { target: { value: "15" } });
    fireEvent.blur(nums[1]);
    expect(screen.getByText(/runs$/).textContent).not.toContain("1 = 1");

    // Toggle off: row gone.
    fireEvent.click(params.querySelector(".sp-sweep")!);
    expect(params.querySelector(".sweep-axis-row")).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "param sweep editor"`
Expected: FAIL on `params.querySelector(".sweep-axis-row")` being null after the glyph click (the row currently renders as a SIBLING of `.strategy-params`, not inside it).

- [ ] **Step 3: Create the shared component**

Create `frontend/src/components/SweepAxisRow.tsx`:

```tsx
// One swept numeric axis's from/to/step controls. Rendered inline beneath the
// field it sweeps (param row, risk row, rule row); the field's own input is
// hidden while its axis is on, so this row replaces it.

import type { RangeAxis } from "../lib/sweep";
import NumberField from "./NumberField";

export function SweepAxisRow({
  axis,
  onChange,
}: {
  axis: RangeAxis;
  onChange: (patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
}) {
  return (
    <div className="sp-row sweep-axis-row">
      <span className="sp-label">{axis.label} sweep</span>
      <span className="sweep-axis-fields">
        <NumberField value={axis.from} onChange={(n) => onChange({ from: n })} signed className="bt-num" />
        <span>to</span>
        <NumberField value={axis.to} onChange={(n) => onChange({ to: n })} signed className="bt-num" />
        <span>step</span>
        <NumberField value={axis.step} onChange={(n) => onChange({ step: n })} signed className="bt-num" />
      </span>
    </div>
  );
}
```

In `frontend/src/BacktestSettingsModal.tsx`:
- Delete the local `SweepAxisRow` function (the block starting with the comment `// One swept axis's from/to/step controls ...` through its closing brace, ~lines 1867-1888).
- Add `import { SweepAxisRow } from "./components/SweepAxisRow";` next to the other `./components/` imports.
- Add `patchAxis` in the modal component, next to the sweep toggle handlers:

```tsx
  // Shared inline-editor patch: SweepAxisRow edits flow back through here.
  const patchAxis = (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) =>
    setSweepAxes((axes) => axes.map((a) => (a.target === target && a.kind === "range" ? { ...a, ...patch } : a)));
```

- [ ] **Step 4: Move the param editor inline**

In `frontend/src/components/StrategyParams.tsx`:

```tsx
import type { ParamSpec, ParamValues } from "../api";
import type { RangeAxis, SweepAxis } from "../lib/sweep";
import InfoTip from "./InfoTip";
import NumberField from "./NumberField";
import { SweepAxisRow } from "./SweepAxisRow";
import Tooltip from "./Tooltip";

interface Props {
  specs: ParamSpec[];
  values: ParamValues;
  onChange: (values: ParamValues) => void;
  // Undefined = no sweep toggles shown (Live panel).
  sweep?: {
    axes: SweepAxis[];
    onToggle: (target: string, spec: ParamSpec) => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  };
}
```

Inside `specs.map((s) => { ... })`, resolve the axis object next to the existing `swept` line:

```tsx
        const axis = sweep?.axes.find(
          (a): a is RangeAxis => a.kind === "range" && a.target === `param:${s.name}`);
        const swept = !!axis;
```

(The old `swept` line, `sweep?.axes.some(...) ?? false`, is replaced by the two lines above.)

Wrap the row so the editor renders beneath it, replacing `return ( <div key={s.name} ...> ... </div> );` with:

```tsx
        return (
          <Fragment key={s.name}>
            <div className={`sp-row${changed ? " sp-changed" : ""}`}>
              {/* ...existing row content unchanged, but remove key={s.name} from this div... */}
            </div>
            {axis && sweep && (
              <SweepAxisRow axis={axis} onChange={(p) => sweep.onAxisChange(axis.target, p)} />
            )}
          </Fragment>
        );
```

Add `import { Fragment } from "react";` at the top.

In `frontend/src/BacktestSettingsModal.tsx`:
- Extend the `StrategyParams` call's sweep prop: `sweep={{ axes: sweepAxes, onToggle: toggleSweepAxis, onAxisChange: patchAxis }}`.
- Delete the standalone param block that immediately follows it (the `{sweepAxes .filter((a): a is RangeAxis => a.kind === "range" && a.target.startsWith("param:")) .map((a) => ( <SweepAxisRow ... /> ))}` JSX, ~lines 1481-1491).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: PASS, including the new test.

Run: `cd frontend && npx tsc -b`
Expected: no NEW errors (pre-existing concurrent-session errors are not yours).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/SweepAxisRow.tsx frontend/src/components/StrategyParams.tsx frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "refactor(sweep): shared SweepAxisRow, coded param editors inline"
```

---

### Task 2: Inline risk editors (both modes, synced gating)

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx`:
  - `RiskSection` (~1895-2037 pre-Task-1 numbering: sweep prop type, `sweepBtn` area, both `bt-risk-row` blocks)
  - `SidePanel` sweep prop type (~2125-2133) and its `RiskSection` call (~2199-2207)
  - the modal's coded-mode `RiskSection` call (~1512-1526) and the coded risk standalone block (~1545-1555)
  - the rules-mode standalone block filter (~1612-1614)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `SweepAxisRow` and `patchAxis` from Task 1.
- Produces: `RiskSection`'s `sweep` prop gains
  `onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void` and
  `mirrorEditor?: boolean`. `SidePanel`'s `sweep` prop gains the same `onAxisChange` (Task 3 reuses it for rules).

- [ ] **Step 1: Write the failing tests**

Append a new describe to `frontend/src/BacktestSettingsModal.test.tsx`:

```tsx
describe("inline risk sweep editors", () => {
  const strategies = [
    {
      filename: "ema_cross.py", name: "EMA Cross", description: "", hedged: false, error: null,
      params: [
        { name: "ema_fast", label: "Fast EMA", type: "int" as const, default: 9, min: 2, max: 50, step: 1, options: null, help: null },
      ],
    },
  ];

  it("coded mode: a swept stop % renders its editor inline inside the risk block (long only when synced)", async () => {
    mockStrategies.mockResolvedValue(strategies);
    const initial = { ...defaultBacktestConfig(), mode: "coded" as const, codedStrategy: "ema_cross.py" };
    renderModal(initial);
    openStrategy();
    expect(await screen.findByText("Fast EMA")).toBeTruthy();

    // Set the LONG stop kind to % so the value field and its glyph render.
    const riskBlocks = [...document.querySelectorAll(".bt-risk")] as HTMLElement[];
    expect(riskBlocks.length).toBe(2);
    const stopKind = riskBlocks[0].querySelectorAll("select")[0];
    fireEvent.change(stopKind, { target: { value: "pct" } });

    // Toggle the stop-value sweep glyph on (sync defaults ON, axis canonical on long).
    fireEvent.click(riskBlocks[0].querySelector(".sp-sweep")!);

    // Editor renders inline inside the LONG risk block, exactly once app-wide.
    expect(riskBlocks[0].querySelector(".sweep-axis-row")).toBeTruthy();
    expect(document.querySelectorAll(".sweep-axis-row")).toHaveLength(1);
  });

  it("rules mode: with sync on, the short tab shows the synced axis's editor too", () => {
    renderModal();
    openStrategy();

    // Long tab: set stop kind to %, toggle its sweep glyph.
    const longRisk = document.querySelector(".bt-risk") as HTMLElement;
    fireEvent.change(longRisk.querySelectorAll("select")[0], { target: { value: "pct" } });
    fireEvent.click(longRisk.querySelector(".sp-sweep")!);
    expect(longRisk.querySelector(".sweep-axis-row")).toBeTruthy();

    // Switch to the short tab: the same canonical axis's editor is visible there.
    fireEvent.click(screen.getByRole("button", { name: /Short/ }));
    const shortRisk = document.querySelector(".bt-risk") as HTMLElement;
    expect(shortRisk.querySelector(".sweep-axis-row")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "inline risk"`
Expected: both FAIL (the editor currently renders outside `.bt-risk`).

- [ ] **Step 3: Implement**

In `RiskSection`:

1. Extend the sweep prop type:

```tsx
  sweep?: {
    axes: SweepAxis[];
    side: "long" | "short";
    onToggle: (target: string, current: number) => void;
    onKindChange: (field: "stop" | "target") => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
    // Rules mode shows one side at a time, so a synced (long-canonical) axis
    // must render its editor under whichever side is visible. Coded mode
    // (both sides stacked) leaves this off and renders it under long only.
    mirrorEditor?: boolean;
  };
```

2. Below the `sweepBtn` helper, add:

```tsx
  // Inline from/to/step editor for a swept risk field, rendered beneath its
  // bt-risk-row. Synced axes are canonical on long: render under the long
  // block, or under this block too when the caller opted into mirroring.
  const axisRow = (field: "stop" | "target", prop: "value" | "mult") => {
    if (!sweep) return null;
    const axis = sweep.axes.find(
      (a): a is RangeAxis => a.kind === "range" && a.target === `risk:${sweepSide}.${field}.${prop}`);
    if (!axis) return null;
    if (sync?.on && sweep.side !== "long" && !sweep.mirrorEditor) return null;
    return <SweepAxisRow axis={axis} onChange={(p) => sweep.onAxisChange(axis.target, p)} />;
  };
```

3. Render beneath each row: after the closing `</div>` of the Stop `bt-risk-row`, add

```tsx
      {axisRow("stop", "value")}
      {axisRow("stop", "mult")}
```

and after the closing `</div>` of the Take-profit `bt-risk-row`, add

```tsx
      {axisRow("target", "value")}
      {axisRow("target", "mult")}
```

4. Update the stale comment above `sweepSide` (it says the range row "renders once (under the long block)"): replace that sentence with `and its editor renders under the long block (coded) or the visible side (rules mode, mirrorEditor).`

In `SidePanel`:
- Add `onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;` to its sweep prop type.
- In its `RiskSection` call, extend the sweep object: `onAxisChange: sweep.onAxisChange, mirrorEditor: true,`.

In the modal:
- Coded-mode `RiskSection` call: add `onAxisChange: patchAxis,` to the sweep object.
- Rules-mode `SidePanel` call: add `onAxisChange: patchAxis,` to the sweep object.
- Delete the coded risk standalone block (the `{sweepAxes .filter(... a.target.startsWith(\`risk:${s}.\`)) .map(...)}` JSX after the coded `RiskSection`, ~1545-1555).
- Narrow the rules-mode standalone block's filter from `a.target.startsWith("rule:") || a.target.startsWith("risk:")` to `a.target.startsWith("rule:")` only (risk axes are now inline; rule axes move in Task 3).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: PASS. Then `npx tsc -b`: no new errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "refactor(sweep): risk value/mult editors inline in RiskSection"
```

---

### Task 3: Inline rule-term editors + remove the last standalone block

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx`:
  - `RuleGroupSection` sweep prop type (~2580-2587) and the post-row render (after the op-chip-row IIFE, ~2774-2798)
  - the rules-mode standalone block + its cross-side comment (~1609-1623)
  - the modal's rules-mode `SidePanel` sweep object (already carries `onAxisChange` from Task 2; nothing more to add there)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `SweepAxisRow`, `patchAxis`, `SidePanel.sweep.onAxisChange` (Tasks 1-2); `ruleAxisTarget`, `activeRuleIndex`, `RangeAxis`.
- Produces: `RuleGroupSection`'s `sweep` prop gains
  `onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void`.

- [ ] **Step 1: Write the failing test**

Append to the existing `describe("operator sweep", ...)` block (it already renders rules mode and clicks glyphs; follow its setup style):

```tsx
  it("a swept indicator length renders its editor inline inside the rule group", () => {
    renderModal();
    openStrategy();

    const section = groupSection("Buy to open");
    // The left operand's length glyph is the first .sp-sweep inside the rule row.
    const row = ruleRows(section)[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);

    // The from/to/step editor renders inside this group section, after the row,
    // and nowhere else in the document.
    expect(section.querySelector(".sweep-axis-row")).toBeTruthy();
    expect(document.querySelectorAll(".sweep-axis-row")).toHaveLength(1);

    // Toggle off: gone.
    fireEvent.click(row.querySelector(".sp-sweep")!);
    expect(section.querySelector(".sweep-axis-row")).toBeNull();
  });

  it("a swept exit count renders its editor inline inside its rule group", () => {
    renderModal();
    openStrategy();

    // Exit groups carry the count field; its glyph is the LAST .sp-sweep in
    // the row (after both operands' length/value glyphs). Tooltip wraps each
    // glyph in its own span, so sibling selectors on .bt-rule-count won't hit it.
    const section = groupSection("Sell to close");
    const row = ruleRows(section)[0];
    const glyphs = row.querySelectorAll(".sp-sweep");
    fireEvent.click(glyphs[glyphs.length - 1]);

    expect(section.querySelector(".sweep-axis-row")).toBeTruthy();
    expect(document.querySelectorAll(".sweep-axis-row")).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "swept indicator length"`
Expected: FAIL (the editor renders outside the section today).

- [ ] **Step 3: Implement**

In `RuleGroupSection`:

1. Add to the sweep prop type:

```tsx
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
```

2. Immediately after the operator-chip-row IIFE (`{sweep && rule.enabled !== false && (() => { ... })()}`), still inside the `<Fragment>`, add:

```tsx
        {sweep && rule.enabled !== false && sweep.axes
          .filter((a): a is RangeAxis =>
            a.kind === "range" &&
            a.target.startsWith(`rule:${sweep.side}.${sweep.group}.${activeRuleIndex(i)}.`))
          .map((a) => (
            <SweepAxisRow key={a.target} axis={a} onChange={(p) => sweep.onAxisChange(a.target, p)} />
          ))}
```

(The trailing dot in the prefix means index 1 cannot match index 10.)

Note: `SidePanel` spreads `{ ...sweep, group }` into `RuleGroupSection`, so `onAxisChange` flows through with no further plumbing. Coded mode's own `RuleGroupSection` calls pass `sweep` undefined and are unaffected.

3. In the modal, delete the rules-mode standalone block AND the comment above it (`{/* Rendered here (not inside SidePanel) so a swept field on the inactive side ... */}` plus the `{sweepAxes.filter(...rule:...).map(...)}` JSX). After this, `RangeAxis` may become an unused import in the modal ONLY if nothing else references it; `patchAxis` still does, so the import stays.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx src/lib/sweep.test.ts`
Expected: PASS. Then `npx tsc -b`: no new errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "refactor(sweep): rule length/value/count editors inline; drop standalone axis blocks"
```

---

### Task 4: Verification

**Files:**
- No planned source changes (fixes only if verification finds problems; App.css spacing tweaks allowed via existing classes).

- [ ] **Step 1: Full frontend suite + typecheck**

Run: `cd frontend && npx vitest run && npx tsc -b`
Expected: green except failures already known to come from concurrent sessions (anything in files this feature never touched; compare against the ledger's list).

- [ ] **Step 2: Drive the app (do NOT kill the user's dev servers)**

If the shared checkout's app is broken by another session's in-progress edits, verify in an isolated worktree at HEAD: `git worktree add <scratchpad>/inline-sweep-verify HEAD`, symlink `frontend/node_modules`, run `VITE_API_BASE="" npx vite --port 5199 --strictPort` (the vite proxy forwards /api to :8000), and clean up (kill vite, `git worktree remove`) when done.

Check inline placement and editing for each site:
1. Rules mode: sweep an EMA length; the from/to/step row appears under that rule's row; edit `to`, footer count updates; run a small sweep end to end.
2. Rules mode risk: set stop to %, sweep it; editor under the Stop row; switch to Short tab (sync on): editor visible there too.
3. Exit count: sweep an exit rule's "Nth time"; editor under that rule row.
4. Coded mode: sweep a param; editor under the param row. Sweep a risk mult (ATR); editor under its row, once, under the long block.
5. Confirm NO standalone editor rows render anywhere, and the operator/period/time-window editors still render as before.
6. If nested rows look cramped, adjust spacing in `frontend/src/App.css` by extending the existing `.sweep-axis-row` rules (no new class names unless necessary).

- [ ] **Step 3: Fix anything found, re-run affected tests, commit (skip if nothing found)**

```bash
git add <only-the-files-you-touched>
git commit -m "fix(sweep): findings from inline-editor verification"
```

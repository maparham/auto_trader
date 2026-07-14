# Sweep: Operators, Trading Period, Time Window - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new sweepable dimensions to the backtest parameter sweep: a rule's operator (discrete subset of the 7), the trading period (walk-forward: split the range into N windows), and the intraday trading time window (discrete list of windows), each with an inline editor next to its subject field.

**Architecture:** Frontend `SweepAxis` becomes a discriminated union (`range | list | period`); list-axis options carry a multi-key `patch` written into each combo, and labels are resolved frontend-side. The wire (`SweepDTO.combos`) is unchanged (string values already allowed). The backend gains an `op:` target in `_apply_rule_combo` plus a per-combo "environment" step (`period:` truncates candles + patches `tradeFromTime`; `timeWindow:` patches/synthesizes the mask) applied in both the rule and coded sweep branches.

**Tech Stack:** React + TypeScript (vitest) frontend, FastAPI + pydantic (pytest) backend.

**Spec:** `docs/superpowers/specs/2026-07-14-sweep-operators-period-timewindow-design.md`

## Global Constraints

- Max **2** sweep axes at a time stays (existing `addAxis`/slice behavior). Caps unchanged: `SWEEP_MAX_COMBOS = 200`, `SWEEP_CHUNK_SIZE = 20`, backend `_SWEEP_MAX_COMBOS = 50`.
- Operator enum values (exact, both sides of the wire): `crossesAbove`, `crossesBelow`, `crosses`, `gt`, `lt`, `gte`, `lte`.
- NEVER use an em dash ("—" or "--") in any new UI copy, test strings, comments, or labels. Use a colon, comma, or plain hyphen.
- Use the shared `Tooltip` component (`frontend/src/components/Tooltip.tsx`) for tooltips, never `title=`.
- Commit directly to `main` (1-person team, no branches).
- Sweep axes are session-only state, never persisted; no migration/back-compat code anywhere.
- Rule sweep targets index the **enabled-only** rule list (disabled rules are dropped before POST).
- Backend behavior on bad input: request-shaped problems (malformed target, bad operator value, bad period pair, unknown tz) raise `HTTPException(422)` and fail the chunk; a per-combo runtime failure becomes a `SweepRowDTO(error=...)` row.
- Run commands: backend `cd backend && python -m pytest tests/<file> -q`; frontend `cd frontend && npx vitest run src/<file>`.

---

### Task 1: Axis foundation - `SweepAxis` union + enumeration + helpers

**Files:**
- Modify: `frontend/src/lib/sweep.ts`
- Modify: `frontend/src/BacktestSettingsModal.tsx` (3 axis constructors, `SweepAxisRow` prop type, 3 render filters; compile-only, no behavior change)
- Test: `frontend/src/lib/sweep.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by every later task):
  - `type SweepAxis = RangeAxis | ListAxis | PeriodAxis` where `RangeAxis = { kind: "range"; target: string; label: string; mirrorTarget?: string; from: number; to: number; step: number }`, `ListAxis = { kind: "list"; target: string; label: string; options: SweepOption[] }`, `PeriodAxis = { kind: "period"; target: string; label: string; n: number }`
  - `interface SweepOption { label: string; patch: Record<string, number | string> }`
  - `type SweepCombo = Record<string, number | string>`
  - `function opAxisTarget(side: "long" | "short", group: "entry" | "exit", idx: number): string` returns `` `op:${side}.${group}.${idx}` ``
  - `function materializePeriodAxes(axes: SweepAxis[], fromMs: number, toMs: number): SweepAxis[]` (replaces each `period` axis with a `list` axis of N window options)
  - `function axisOptionFor(axis: SweepAxis, combo: SweepCombo): SweepOption | null`
  - `function comboAxisText(axis: SweepAxis, combo: SweepCombo): string`
  - `comboCount` / `enumerateCombos` handle all three kinds (`enumerateCombos` throws on an unmaterialized `period` axis).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/sweep.test.ts` (also update the existing `axis` helper at the top of the file to stamp the new required `kind`):

```ts
// Existing helper gains the required kind (all existing tests keep passing):
const axis = (target: string, from: number, to: number, step: number) =>
  ({ kind: "range" as const, target, label: target, from, to, step });

const listAxis = (target: string, options: { label: string; patch: Record<string, number | string> }[]) =>
  ({ kind: "list" as const, target, label: target, options });

describe("list axes", () => {
  const op = listAxis("op:long.entry.0", [
    { label: "greater than", patch: { "op:long.entry.0": "gt" } },
    { label: "less than", patch: { "op:long.entry.0": "lt" } },
  ]);

  it("enumerates each option's patch and counts options", () => {
    expect(enumerateCombos([op])).toEqual([
      { "op:long.entry.0": "gt" }, { "op:long.entry.0": "lt" },
    ]);
    expect(comboCount([op])).toBe(2);
    expect(comboCount([listAxis("timeWindow", [])])).toBe(Infinity); // empty list blocks Run
  });

  it("spreads multi-key patches and crosses with a range axis", () => {
    const tw = listAxis("timeWindow", [
      { label: "morning", patch: { "timeWindow:startMin": 480, "timeWindow:endMin": 720, "timeWindow:tz": "UTC" } },
    ]);
    const combos = enumerateCombos([tw, axis("param:n", 1, 2, 1)]);
    expect(combos).toHaveLength(2);
    expect(combos[0]).toEqual({
      "timeWindow:startMin": 480, "timeWindow:endMin": 720, "timeWindow:tz": "UTC", "param:n": 1,
    });
  });

  it("resolves a row's option by patch-subset match", () => {
    expect(axisOptionFor(op, { "op:long.entry.0": "lt", "param:n": 3 })?.label).toBe("less than");
    expect(axisOptionFor(op, { "op:long.entry.0": "gte" })).toBeNull();
    expect(comboAxisText(op, { "op:long.entry.0": "gt" })).toBe("greater than");
    expect(comboAxisText(axis("param:n", 1, 2, 1), { "param:n": 1.5 })).toBe("1.5");
  });
});

describe("period axes", () => {
  const period = { kind: "period" as const, target: "period", label: "Period", n: 2 };

  it("counts n and refuses to enumerate unmaterialized", () => {
    expect(comboCount([period])).toBe(2);
    expect(() => enumerateCombos([period])).toThrow(/materialized/);
  });

  it("materializes into n contiguous equal windows in unix seconds", () => {
    const fromMs = 1_700_000_000_000;
    const toMs = fromMs + 2 * 86_400_000;
    const [m] = materializePeriodAxes([period], fromMs, toMs);
    if (m.kind !== "list") throw new Error("expected list axis");
    expect(m.options).toHaveLength(2);
    expect(m.options[0].patch).toEqual({
      "period:from": 1_700_000_000, "period:to": 1_700_086_400,
    });
    expect(m.options[1].patch).toEqual({
      "period:from": 1_700_086_400, "period:to": 1_700_172_800,
    });
    expect(m.options[0].label).toMatch(/^W1/);
    // Non-period axes pass through untouched.
    const passthrough = axis("param:n", 1, 2, 1);
    expect(materializePeriodAxes([passthrough], fromMs, toMs)).toEqual([passthrough]);
  });
});

describe("opAxisTarget", () => {
  it("builds the op target path", () => {
    expect(opAxisTarget("long", "entry", 0)).toBe("op:long.entry.0");
    expect(opAxisTarget("short", "exit", 2)).toBe("op:short.exit.2");
  });
});
```

Add the new names to the import line at the top of the test file: `axisOptionFor, comboAxisText, materializePeriodAxes, opAxisTarget`.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd frontend && npx vitest run src/lib/sweep.test.ts`
Expected: FAIL (missing exports `axisOptionFor` etc.; type errors on `kind`).

- [ ] **Step 3: Implement in `frontend/src/lib/sweep.ts`**

Replace the `SweepAxis` interface (lines 9-24) with the union, and update the helpers. Keep `runSweep` and `sweepCatchState` untouched except for the `SweepCombo` type:

```ts
// One sweep option of a discrete-list axis: `patch` is spread verbatim into
// every combo this option participates in (may write several keys at once,
// e.g. a period writes period:from + period:to).
export interface SweepOption {
  label: string;
  patch: Record<string, number | string>;
}

// Numeric range axis (the original kind). Targets:
// "param:<name>" | "risk:<side>.<stop|target>.<value|mult>" |
// "rule:<side>.<entry|exit>.<idx>.<left|right>.<length|value>" |
// "rule:<side>.<entry|exit>.<idx>.count"
export interface RangeAxis {
  kind: "range";
  target: string;
  // Synced-risk sweeps ("Same for long & short" on): the opposite side's
  // target, written with the same value into every combo so both legs move
  // together through the sweep. Attached by mirrorRiskAxes right before the
  // run; never persisted with the axis while editing.
  mirrorTarget?: string;
  label: string;
  from: number;
  to: number;
  step: number;
}

// Discrete-list axis. Targets: "op:<side>.<entry|exit>.<idx>" (operator per
// rule term) | "timeWindow" (intraday window; patch keys timeWindow:startMin/
// endMin/tz) | "period" (after materialization; patch keys period:from/to,
// unix seconds).
export interface ListAxis {
  kind: "list";
  target: string;
  label: string;
  options: SweepOption[];
}

// Walk-forward period axis while EDITING: just the window count. Materialized
// into a ListAxis (n equal contiguous windows over the resolved range) by
// materializePeriodAxes right before the run; enumerateCombos refuses it raw.
export interface PeriodAxis {
  kind: "period";
  target: string;
  label: string;
  n: number;
}

export type SweepAxis = RangeAxis | ListAxis | PeriodAxis;
export type SweepCombo = Record<string, number | string>;
```

```ts
/** Builds an `op:` sweep-axis target for a rule's operator. `idx` is the rule's
 * position in the ENABLED-only list (same convention as ruleAxisTarget). */
export function opAxisTarget(side: "long" | "short", group: "entry" | "exit", idx: number): string {
  return `op:${side}.${group}.${idx}`;
}
```

`mirrorRiskAxes` gains a kind guard (only range axes can be risk axes):

```ts
export function mirrorRiskAxes(axes: SweepAxis[]): SweepAxis[] {
  return axes.map((a) =>
    a.kind === "range" && a.target.startsWith("risk:long.")
      ? { ...a, mirrorTarget: a.target.replace(/^risk:long\./, "risk:short.") }
      : a);
}
```

`axisValues` takes `RangeAxis` (signature change only). `comboCount` and `enumerateCombos`:

```ts
export function comboCount(axes: SweepAxis[]): number {
  return axes.reduce((n, a) => {
    const len = a.kind === "range" ? axisValues(a).length
      : a.kind === "list" ? a.options.length
      : a.n;
    return len === 0 ? Infinity : n * len;
  }, axes.length ? 1 : 0);
}

export function enumerateCombos(axes: SweepAxis[]): SweepCombo[] {
  let combos: SweepCombo[] = [{}];
  for (const a of axes) {
    if (a.kind === "period") throw new Error("period axis must be materialized before enumerating");
    combos = a.kind === "list"
      ? a.options.flatMap((o) => combos.map((c) => ({ ...c, ...o.patch })))
      : axisValues(a).flatMap((v) =>
          combos.map((c) =>
            a.mirrorTarget ? { ...c, [a.target]: v, [a.mirrorTarget]: v } : { ...c, [a.target]: v }));
  }
  return axes.length ? combos : [];
}
```

Materialization + results-label helpers (import `formatPeriodDateRange` from `./backtestPeriods`):

```ts
/** Replace each period axis with a list axis of n equal, contiguous,
 * non-overlapping windows over [fromMs, toMs]. Patch values are unix SECONDS
 * (the backend's candle time unit). Called right before a run so the windows
 * always reflect the range as currently configured. */
export function materializePeriodAxes(axes: SweepAxis[], fromMs: number, toMs: number): SweepAxis[] {
  return axes.map((a) => {
    if (a.kind !== "period") return a;
    const n = Math.max(1, Math.round(a.n));
    const options: SweepOption[] = [];
    for (let i = 0; i < n; i++) {
      const wFrom = fromMs + ((toMs - fromMs) * i) / n;
      const wTo = fromMs + ((toMs - fromMs) * (i + 1)) / n;
      options.push({
        label: `W${i + 1}: ${formatPeriodDateRange(wFrom, wTo)}`,
        patch: { "period:from": Math.round(wFrom / 1000), "period:to": Math.round(wTo / 1000) },
      });
    }
    return { kind: "list", target: a.target, label: a.label, options };
  });
}

/** The list-axis option a result row's combo came from: the option whose every
 * patch entry matches the combo. Null for range/period axes or no match. */
export function axisOptionFor(axis: SweepAxis, combo: SweepCombo): SweepOption | null {
  if (axis.kind !== "list") return null;
  return axis.options.find((o) => Object.entries(o.patch).every(([k, v]) => combo[k] === v)) ?? null;
}

/** Display text for one axis of a combo: the option label for a list axis,
 * the raw value for a range axis. */
export function comboAxisText(axis: SweepAxis, combo: SweepCombo): string {
  if (axis.kind === "list") return axisOptionFor(axis, combo)?.label ?? "?";
  return String(combo[axis.target] ?? "?");
}
```

In `runSweep`, type `combos` as `SweepCombo[]` (no other change; `runSweepChunk` already accepts string values).

- [ ] **Step 4: Compile fixes in `frontend/src/BacktestSettingsModal.tsx` (no behavior change)**

1. The three axis constructors add `kind: "range"`: in `toggleSweepAxis` (~line 426), `toggleRiskSweepAxis` (~line 444), `toggleRuleSweepAxis` (~line 462), change `const next: SweepAxis = { target, ...}` to `const next: SweepAxis = { kind: "range", target, ... }`.
2. `SweepAxisRow` (~line 1623) narrows its prop: `axis: RangeAxis` (import `RangeAxis` from `./lib/sweep`).
3. The three `SweepAxisRow` render loops gain a kind guard so only range axes reach it (param loop ~line 1239, risk loop ~line 1303, rule/risk loop ~line 1368). Example for the rule/risk loop:

```tsx
{sweepAxes
  .filter((a): a is RangeAxis =>
    a.kind === "range" && (a.target.startsWith("rule:") || a.target.startsWith("risk:")))
  .map((a) => (
```

Param loop: `.filter((a): a is RangeAxis => a.kind === "range" && a.target.startsWith("param:"))`. Risk loop: `.filter((a): a is RangeAxis => a.kind === "range" && a.target.startsWith(`risk:${s}.`))`.
4. In the risk-sync remap (~line 1295), the spread `{ ...a, target: ... }` still type-checks against the union; if TS complains, guard with `a.kind === "range" && a.target.startsWith("risk:short.")`.

- [ ] **Step 5: Run the full frontend sweep tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/sweep.test.ts src/SweepResults.test.tsx && npx tsc --noEmit`
Expected: sweep.test.ts PASSES. `SweepResults.test.tsx` and tsc may FAIL on the axes fixture missing `kind` - if so, add `kind: "range" as const` to the two axis objects in `SweepResults.test.tsx` (lines 17-20) and re-run. Everything green before committing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/sweep.ts frontend/src/lib/sweep.test.ts frontend/src/BacktestSettingsModal.tsx frontend/src/SweepResults.test.tsx
git commit -m "feat(sweep): SweepAxis union (range/list/period) + materialization and label helpers"
```

---

### Task 2: SweepResults - list-axis labels + heatmap ordinal ticks

**Files:**
- Modify: `frontend/src/SweepResults.tsx`
- Test: `frontend/src/SweepResults.test.tsx`

**Interfaces:**
- Consumes: `comboAxisText`, `axisOptionFor`, `SweepOption`, `SweepAxis` from Task 1.
- Produces: `SweepResults` renders correct combo labels and heatmap axes for `list` axes; no API change (`rows`, `axes`, `onApply`, `progress` props unchanged).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/SweepResults.test.tsx`:

```tsx
const opRows = [
  { combo: { "op:long.entry.0": "gt", "param:n": 5 },
    metrics: { net_pnl: 10, n_trades: 1, win_rate: 1, max_drawdown: 0,
               profit_factor: null, return_pct: 0.1 }, error: null },
  { combo: { "op:long.entry.0": "lt", "param:n": 5 },
    metrics: { net_pnl: -10, n_trades: 1, win_rate: 0, max_drawdown: 10,
               profit_factor: null, return_pct: -0.1 }, error: null },
];
const opAxes = [
  { kind: "list" as const, target: "op:long.entry.0", label: "long entry 1 op", options: [
    { label: "greater than", patch: { "op:long.entry.0": "gt" } },
    { label: "less than", patch: { "op:long.entry.0": "lt" } },
  ] },
  { kind: "range" as const, target: "param:n", label: "n", from: 5, to: 5, step: 1 },
];

describe("SweepResults list axes", () => {
  it("labels combos with the matched option label", () => {
    render(<SweepResults rows={opRows} axes={opAxes} onApply={() => {}} />);
    expect(screen.getAllByText(/greater than/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/less than/).length).toBeGreaterThan(0);
  });

  it("renders heatmap ticks from option labels and applies the cell's combo", () => {
    const onApply = vi.fn();
    render(<SweepResults rows={opRows} axes={opAxes} onApply={onApply} />);
    const cells = document.querySelectorAll(".sweep-cell");
    expect(cells.length).toBe(2);            // 2 op options x 1 n value
    fireEvent.click(cells[0]);
    expect(onApply).toHaveBeenCalledWith(opRows[0].combo);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/SweepResults.test.tsx`
Expected: FAIL (labels render as `undefined`/raw, heatmap collects no numeric values for the list axis so 0 cells).

- [ ] **Step 3: Implement in `frontend/src/SweepResults.tsx`**

Import the helpers: `import { comboAxisText, type SweepAxis } from "./lib/sweep";` (replace the existing type-only import).

Replace `comboLabel` (lines 50-52):

```tsx
function comboLabel(combo: SweepRow["combo"], axes: SweepAxis[]): string {
  return axes.map((a) => `${a.label} ${comboAxisText(a, combo as Record<string, number | string>)}`).join(", ");
}
```

Rework `SweepHeatmap`'s axis handling. Replace `axisVals` and the `xVals`/`yVals` block (lines 242-254) with tick objects (a tick = display label + the combo entries a row must match):

```tsx
type HeatTick = { key: string; label: string; match: Record<string, number | string> };

const axisTicks = (a: SweepAxis): HeatTick[] => {
  if (a.kind === "list") {
    return a.options.map((o, i) => ({ key: `o${i}`, label: o.label, match: o.patch }));
  }
  const set = new Set<number>();
  for (const r of rows) {
    const v = r.combo[a.target];
    if (typeof v === "number") set.add(v);
  }
  return [...set].sort((x, y) => x - y).map((v) => ({ key: String(v), label: String(v), match: { [a.target]: v } }));
};

const xAxis = axes[0];
const yAxis = axes[1];
const xTicks = axisTicks(xAxis);
const yTicks: (HeatTick | null)[] = yAxis ? axisTicks(yAxis) : [null];
```

Update `find` to the same match shape (type only): `const find = (match: Record<string, number | string>) => rows.find((r) => Object.entries(match).every(([k, v]) => r.combo[k] === v));`

Update the grid JSX (lines 290-328): `gridTemplateColumns` uses `xTicks.length`; x labels map `xTicks` rendering `t.label` with `key={`hx-${t.key}`}`; y rows map `yTicks` rendering `t?.label ?? ""`; each cell builds `const match = { ...xt.match, ...(yt ? yt.match : {}) };` then `const row = find(match);` (rest of the cell body unchanged; cell `key={`hc-${xt.key}-${yt?.key ?? ""}`}`).

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/SweepResults.test.tsx && npx tsc --noEmit`
Expected: PASS (all old + new tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/SweepResults.tsx frontend/src/SweepResults.test.tsx
git commit -m "feat(sweep): SweepResults renders list-axis labels and ordinal heatmap ticks"
```

---

### Task 3: Backend - operator sweep target (`op:`)

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py` (`_apply_rule_combo`, new regex/constants near line 500)
- Modify: `backend/auto_trader/api/schemas.py` (`SweepDTO` docstring, ~line 421)
- Test: `backend/tests/test_api_backtest_sweep_dims.py` (new file)

**Interfaces:**
- Consumes: existing `_apply_rule_combo(req, combo)` / `_RULE_TARGET` machinery.
- Produces: combo key `op:<long|short>.<entry|exit>.<idx>` with a string value from the 7-operator set patches that rule's `op`. Out-of-range idx or a non-member value raises `HTTPException(422)`. In coded mode an `op:` target 422s (falls through `_apply_combo`'s existing "bad sweep target").

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_backtest_sweep_dims.py`:

```python
"""POST /api/backtest/sweep: the operator / period / timeWindow sweep
dimensions (spec 2026-07-14). Rule-mode requests are hand-built (price vs
const rules need no posted series: the backend recomputes natives)."""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

client = TestClient(app)

T0 = 19676 * 86400  # a UTC midnight, hourly bars land on clean day boundaries


def make_step_candles(n=80, split=40, lo=95.0, hi=105.0):
    """First `split` bars close at `lo`, the rest at `hi`."""
    out = []
    for i in range(n):
        px = lo if i < split else hi
        out.append({"time": T0 + i * 3600, "open": px, "high": px + 1,
                    "low": px - 1, "close": px, "volume": 100})
    return out


def make_ramp_candles(n=80, split=40, base=100.0):
    """Flat at `base` for `split` bars, then +1 per bar."""
    out = []
    for i in range(n):
        px = base + max(0, i - split + 1)
        out.append({"time": T0 + i * 3600, "open": px, "high": px + 1,
                    "low": px - 1, "close": px, "volume": 100})
    return out


def rule_request(candles, combos, entry_op="gt", entry_value=100.0, exit_rules=None):
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "TEST", "resolution": "HOUR", "candles": candles, "series": {},
        "longEntry": {"combine": "AND", "rules": [{
            "left": {"kind": "price", "field": "close"},
            "op": entry_op,
            "right": {"kind": "const", "value": entry_value},
        }]},
        "longExit": {"combine": "AND", "rules": exit_rules} if exit_rules else empty,
        "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": 0, "startingCash": 10000},
        "tradeFromTime": candles[0]["time"],
        "sweep": {"combos": combos},
    }


def post_rows(req):
    res = client.post("/api/backtest/sweep", json=req)
    assert res.status_code == 200, res.text
    return res.json()["rows"]


def test_op_sweep_patches_operator():
    # Step candles: "gt 100" enters at the step (entry ~105, ends ~105);
    # "lt 100" enters at bar 0 (entry ~95, ends ~105). Different net P/L.
    rows = post_rows(rule_request(make_step_candles(), [
        {"op:long.entry.0": "gt"}, {"op:long.entry.0": "lt"},
    ]))
    assert rows[0]["error"] is None and rows[1]["error"] is None
    assert rows[0]["metrics"]["net_pnl"] != rows[1]["metrics"]["net_pnl"]


def test_op_sweep_crosses_above_fires():
    rows = post_rows(rule_request(make_step_candles(), [
        {"op:long.entry.0": "crossesAbove"},
    ]))
    assert rows[0]["error"] is None
    assert rows[0]["metrics"]["n_trades"] == 1


def test_op_sweep_invalid_operator_422():
    res = client.post("/api/backtest/sweep", json=rule_request(
        make_step_candles(), [{"op:long.entry.0": "banana"}]))
    assert res.status_code == 422
    assert "op:long.entry.0" in res.json()["detail"]


def test_op_sweep_index_out_of_range_422():
    res = client.post("/api/backtest/sweep", json=rule_request(
        make_step_candles(), [{"op:long.entry.5": "gt"}]))
    assert res.status_code == 422
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_api_backtest_sweep_dims.py -q`
Expected: FAIL, all four tests, with 422 "bad sweep target 'op:long.entry.0'" on the first two.

- [ ] **Step 3: Implement in `backend/auto_trader/api/routers/backtest.py`**

Next to `_RULE_TARGET` (~line 501) add:

```python
_OP_TARGET = re.compile(r"^op:(long|short)\.(entry|exit)\.(\d+)$")
# RuleDTO.op's Literal set. model_copy(update=...) skips pydantic validation,
# so membership is checked explicitly before the patch.
_OPERATORS = {"crossesAbove", "crossesBelow", "crosses", "gt", "lt", "gte", "lte"}
```

In `_apply_rule_combo` (~line 545), inside the `for target, value in combo.items():` loop, after the `risk:` short-circuit and before the `_RULE_TARGET` match, add:

```python
        m = _OP_TARGET.match(target)
        if m:
            side, grp, idx_s = m.groups()
            rules = groups[(side, grp)]
            idx = int(idx_s)
            if idx >= len(rules):
                raise HTTPException(422, f"sweep target '{target}' index out of range")
            if value not in _OPERATORS:
                raise HTTPException(
                    422, f"sweep target '{target}' needs one of {sorted(_OPERATORS)}")
            rules[idx] = rules[idx].model_copy(update={"op": value})
            continue
```

Update `_apply_rule_combo`'s docstring to mention `op:`. In `backend/auto_trader/api/schemas.py`, extend the `SweepDTO` docstring key list with:

```
    "op:<long|short>.<entry|exit>.<idx>" (operator patch, one of the 7 Rule ops),
```

- [ ] **Step 4: Run to verify pass (plus no regressions)**

Run: `cd backend && python -m pytest tests/test_api_backtest_sweep_dims.py tests/test_api_backtest_sweep.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/backtest.py backend/auto_trader/api/schemas.py backend/tests/test_api_backtest_sweep_dims.py
git commit -m "feat(sweep): backend op:<side>.<group>.<idx> operator sweep target"
```

---

### Task 4: Backend - period + timeWindow environment combos

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py` (new `_split_env_combo` / `_apply_env_combo` near line 505; both sweep-loop branches in `backtest_sweep`)
- Modify: `backend/auto_trader/api/schemas.py` (`SweepDTO` docstring)
- Test: `backend/tests/test_api_backtest_sweep_dims.py`

**Interfaces:**
- Consumes: `RecurrenceMaskDTO`, `DayTimeWindowDTO` (already imported by the router via schemas), Task 3's test helpers.
- Produces:
  - `_split_env_combo(combo: dict) -> tuple[dict, dict]` returning `(env, rest)` where env holds `period:*` / `timeWindow:*` keys.
  - `_apply_env_combo(req: BacktestRequest, candles: list[Candle], env: dict) -> tuple[BacktestRequest, list[Candle]]`: `timeWindow:` patches/synthesizes `req.mask` (timeOfDay + tz, enabled); `period:` sets `tradeFromTime = period:from` and truncates candles to `time <= period:to` (a prefix of the posted list, so warm-up head and series positional alignment are preserved; chart-operand series stay full-length, which is safe because the engine indexes bars positionally and never reads past the truncated candle count).
  - Both sweep branches call these per combo, before `_apply_rule_combo` / `_apply_combo`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api_backtest_sweep_dims.py`:

```python
# --- period + timeWindow environment combos ----------------------------------

ALWAYS_TRUE = 0.0  # entry "close gt 0" is true on every bar


def test_period_sweep_truncates_and_gates():
    # Ramp candles: flat first half, +1/bar second half. W1 (flat half) must
    # end at the midpoint: near-zero P/L. W2 rides the ramp: clearly positive.
    candles = make_ramp_candles()
    mid = T0 + 40 * 3600
    end = T0 + 79 * 3600
    rows = post_rows(rule_request(candles, [
        {"period:from": T0, "period:to": mid},
        {"period:from": mid, "period:to": end},
    ], entry_value=ALWAYS_TRUE))
    assert rows[0]["error"] is None and rows[1]["error"] is None
    # Truncation proof: without it W1's open trade would exit at the ramp top
    # (P/L ~ +39); truncated it exits at the flat midpoint.
    assert abs(rows[0]["metrics"]["net_pnl"]) < 5
    assert rows[1]["metrics"]["net_pnl"] > rows[0]["metrics"]["net_pnl"]


def test_period_sweep_bad_pair_422():
    candles = make_ramp_candles()
    for combos in ([{"period:from": T0 + 3600, "period:to": T0}],   # to <= from
                   [{"period:from": T0}],                            # missing to
                   [{"period:banana": 1}]):                          # unknown subkey
        res = client.post("/api/backtest/sweep",
                          json=rule_request(candles, combos, entry_value=ALWAYS_TRUE))
        assert res.status_code == 422, combos


def test_timewindow_sweep_restricts_entries():
    # Always-true entry + always-true exit cycles trades all day. A narrow
    # 3-hour window admits fewer entries than the full day. No mask is
    # configured on the request: the backend synthesizes one per combo.
    candles = make_ramp_candles(n=96, split=96)   # 4 days, flat (P/L noise-free)
    exit_rules = [{"left": {"kind": "price", "field": "close"},
                   "op": "gt", "right": {"kind": "const", "value": 0.0}}]
    rows = post_rows(rule_request(candles, [
        {"timeWindow:startMin": 0, "timeWindow:endMin": 1440, "timeWindow:tz": "UTC"},
        {"timeWindow:startMin": 180, "timeWindow:endMin": 360, "timeWindow:tz": "UTC"},
    ], entry_value=ALWAYS_TRUE, exit_rules=exit_rules))
    assert rows[0]["error"] is None and rows[1]["error"] is None
    assert rows[0]["metrics"]["n_trades"] > rows[1]["metrics"]["n_trades"] > 0


def test_timewindow_sweep_bad_tz_422():
    res = client.post("/api/backtest/sweep", json=rule_request(
        make_ramp_candles(),
        [{"timeWindow:startMin": 0, "timeWindow:endMin": 60, "timeWindow:tz": "Not/AZone"}],
        entry_value=ALWAYS_TRUE))
    assert res.status_code == 422


# --- coded-mode environment combos --------------------------------------------

ALWAYS_BUY = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="go")]
    return []
'''


@pytest.fixture
def coded_strategies(tmp_path, monkeypatch):
    (tmp_path / "always_buy.py").write_text(ALWAYS_BUY)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


def coded_request(candles, combos):
    req = rule_request(candles, combos)
    empty = {"combine": "AND", "rules": []}
    req["longEntry"] = empty
    req["codedStrategy"] = "always_buy.py"
    return req


def test_period_sweep_coded_mode(coded_strategies):
    candles = make_ramp_candles()
    mid = T0 + 40 * 3600
    rows = post_rows(coded_request(candles, [
        {"period:from": T0, "period:to": mid},
        {"period:from": mid, "period:to": T0 + 79 * 3600},
    ]))
    assert rows[0]["error"] is None and rows[1]["error"] is None
    assert abs(rows[0]["metrics"]["net_pnl"]) < 5
    assert rows[1]["metrics"]["net_pnl"] > rows[0]["metrics"]["net_pnl"]


def test_op_target_in_coded_mode_422(coded_strategies):
    res = client.post("/api/backtest/sweep", json=coded_request(
        make_ramp_candles(), [{"op:long.entry.0": "gt"}]))
    assert res.status_code == 422
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && python -m pytest tests/test_api_backtest_sweep_dims.py -q`
Expected: the new tests FAIL with 422 "bad sweep target 'period:from'" etc.; `test_op_target_in_coded_mode_422` may already pass (fine).

- [ ] **Step 3: Implement in `backend/auto_trader/api/routers/backtest.py`**

Add `from zoneinfo import ZoneInfo` to the imports if not present. Near `_apply_combo` (~line 505) add:

```python
# Environment combo keys: they change the RUN's candle window / session mask
# rather than a strategy knob, so they're split off and applied to the request
# + candle list before the per-combo strategy patch (_apply_rule_combo /
# _apply_combo) runs. Shared by the rule and coded sweep branches.
_ENV_PREFIXES = ("period:", "timeWindow:")
_ENV_KEYS = {"period:from", "period:to",
             "timeWindow:startMin", "timeWindow:endMin", "timeWindow:tz"}


def _split_env_combo(combo: dict) -> tuple[dict, dict]:
    env = {k: v for k, v in combo.items() if k.startswith(_ENV_PREFIXES)}
    rest = {k: v for k, v in combo.items() if not k.startswith(_ENV_PREFIXES)}
    return env, rest


def _apply_env_combo(
    req: BacktestRequest, candles: list[Candle], env: dict,
) -> tuple[BacktestRequest, list[Candle]]:
    """Apply period/timeWindow keys. period: gates entries at period:from
    (tradeFromTime) and truncates candles to time <= period:to. Truncation
    only cuts the END, so the result is a PREFIX of the posted candles: the
    warm-up head survives, native series recompute correctly, and the
    browser-supplied chart-operand series (full-length, positional) stay
    index-aligned without slicing (the engine never reads past the candle
    count). timeWindow: patches the mask's timeOfDay + tz, synthesizing an
    enabled all-days mask when the request has none. Malformed keys 422 (a
    request-shaped problem fails the whole chunk)."""
    if not env:
        return req, candles
    unknown = set(env) - _ENV_KEYS
    if unknown:
        raise HTTPException(422, f"bad sweep target '{sorted(unknown)[0]}'")
    updates: dict = {}
    if any(k.startswith("timeWindow:") for k in env):
        try:
            start = int(env["timeWindow:startMin"])
            end = int(env["timeWindow:endMin"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(422, "timeWindow sweep needs integer startMin and endMin")
        base = req.mask or RecurrenceMaskDTO(enabled=True)
        tz = env.get("timeWindow:tz", base.tz)
        try:
            ZoneInfo(str(tz))
        except Exception:
            raise HTTPException(422, f"unknown timezone '{tz}'")
        # model_copy skips validators, so tz was checked explicitly above.
        updates["mask"] = base.model_copy(update={
            "enabled": True,
            "timeOfDay": DayTimeWindowDTO(startMin=start, endMin=end),
            "tz": str(tz),
        })
    if any(k.startswith("period:") for k in env):
        try:
            from_s = int(env["period:from"])
            to_s = int(env["period:to"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(422, "period sweep needs integer from and to")
        if to_s <= from_s:
            raise HTTPException(422, "period sweep 'to' must be after 'from'")
        updates["tradeFromTime"] = from_s
        candles = [c for c in candles if c.time <= to_s]
    return (req.model_copy(update=updates) if updates else req), candles
```

(`RecurrenceMaskDTO` and `DayTimeWindowDTO` come from `..schemas`; extend the router's existing schemas import.)

Wire into **both** branches of `backtest_sweep`:

Rule branch (~line 607), replace the loop head:

```python
        for combo in req.sweep.combos:
            try:
                env, rest = _split_env_combo(combo)
                patched, combo_candles = _apply_env_combo(req, candles, env)
                patched = _apply_rule_combo(patched, rest)
                result = await _run_rule(patched, combo_candles, htf_candles=rule_htf_candles)
```

Coded branch (~line 648), replace the loop head:

```python
    for combo in req.sweep.combos:
        env, rest = _split_env_combo(combo)
        patched_req, combo_candles = _apply_env_combo(req, candles, env)
        params_sent, long_risk, short_risk = _apply_combo(patched_req, rest)
        try:
            resolved = resolve_params(module, params_sent)
            result, _ = await _run_coded(
                patched_req, combo_candles, module, resolved, long_risk, short_risk, htf_candles,
            )
```

(Note: `_apply_env_combo` raising `HTTPException` outside the coded branch's try is correct: request-shaped problems fail the chunk, matching the rule branch.)

Extend the `SweepDTO` docstring in `schemas.py` with:

```
    "period:from" + "period:to" (unix-second walk-forward window: entries gate
    at from, candles truncate at to),
    "timeWindow:startMin" + "timeWindow:endMin" + "timeWindow:tz" (intraday
    mask window patch; a mask is synthesized when the request has none).
```

- [ ] **Step 4: Run to verify pass (full backend sweep suites)**

Run: `cd backend && python -m pytest tests/test_api_backtest_sweep_dims.py tests/test_api_backtest_sweep.py tests/test_api_backtest_coded.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/backtest.py backend/auto_trader/api/schemas.py backend/tests/test_api_backtest_sweep_dims.py
git commit -m "feat(sweep): backend period and timeWindow environment combos in both sweep branches"
```

---

### Task 5: Frontend - operator sweep UI + combo apply

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (`OperatorPicker`, `RuleGroupSection`, `SidePanel` sweep prop, modal handlers, `applyRuleSweepCombo`)
- Modify: `frontend/src/App.css` (one small rule)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `opAxisTarget`, `ListAxis`, `SweepOption` from Task 1; existing `OPERATORS` array, `SweepGlyph`, `activeRuleIndex`.
- Produces:
  - `OperatorPicker` gains optional `sweep?: { swept: boolean; onToggle: () => void }` rendering the `sp-sweep` glyph beside the operator button.
  - `RuleGroupSection`'s `sweep` prop gains `onToggleOp: (target: string, current: Operator) => void; onTickOp: (target: string, op: Operator) => void` and renders the inline chip editor beneath a swept rule's row.
  - Modal: `toggleOpSweepAxis`, `tickOpOption`; `applyRuleSweepCombo` handles `op:` keys; `rawRuleIndex(rules, activeIdx)` maps an enabled-only index back to the raw UI index (also fixes the existing `rule:`-apply path, which wrongly indexed the raw list).

- [ ] **Step 1: Write the failing test**

Check how `BacktestSettingsModal.test.tsx` renders the modal (existing patterns at the top of that file) and add, following its setup helpers:

```tsx
it("toggles an operator sweep axis and shows the 7-operator chip editor inline", () => {
  // render the modal via the file's existing setup helper, with one long-entry rule
  // (the default config has none: add one via the "+ Add rule" button first)
  fireEvent.click(screen.getByText("+ Add rule"));
  // the operator sweep glyph sits beside the operator button
  const glyphs = document.querySelectorAll(".bt-op-menu + .sp-sweep, .bt-op-sweep-toggle");
  expect(glyphs.length).toBeGreaterThan(0);
  fireEvent.click(glyphs[0]);
  // inline chip editor lists all 7 operators; the rule's current op is ticked
  const editor = document.querySelector(".bt-op-sweep-row")!;
  expect(editor).toBeTruthy();
  expect(editor.querySelectorAll(".bt-chip").length).toBe(7);
  expect(editor.querySelectorAll(".seg-on").length).toBe(1);
  // ticking a second operator marks it selected
  fireEvent.click(editor.querySelectorAll(".bt-chip")[3]);
  expect(editor.querySelectorAll(".seg-on").length).toBe(2);
});
```

Adapt selector/setup details to the file's existing conventions (it already renders the modal in other tests; reuse its mount helper and afterEach cleanup). The structural assertions (glyph toggles a `.bt-op-sweep-row` with 7 chips, current op pre-ticked, tick adds) are the contract.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: new test FAILS (no glyph / no editor row).

- [ ] **Step 3: Implement**

**(a) Modal handlers** (next to `toggleRuleSweepAxis`, ~line 458). Extract the shared max-2 append first (reuse it in the three existing toggles too):

```ts
  // Appending past the 2-axis cap drops the oldest (shared by every toggle).
  const addAxis = (axes: SweepAxis[], next: SweepAxis) => {
    const appended = [...axes, next];
    return appended.length > 2 ? appended.slice(appended.length - 2) : appended;
  };

  const opOption = (target: string, op: Operator): SweepOption => ({
    label: OPERATORS.find((o) => o.value === op)?.label ?? op,
    patch: { [target]: op },
  });
  // Operator axis: a discrete list seeded with the rule's current operator.
  const toggleOpSweepAxis = (target: string, current: Operator) => {
    setSweepAxes((axes) =>
      axes.some((a) => a.target === target)
        ? axes.filter((a) => a.target !== target)
        : addAxis(axes, {
            kind: "list", target,
            label: `${target.replace(/^op:/, "").replace(/\./g, " ")} op`,
            options: [opOption(target, current)],
          }));
  };
  // Tick/untick one operator in the axis's option list; unticking the last
  // option removes the axis (nothing left to sweep). Options keep OPERATORS
  // order so results enumerate in dropdown order.
  const tickOpOption = (target: string, op: Operator) => {
    setSweepAxes((axes) =>
      axes
        .map((a) => {
          if (a.target !== target || a.kind !== "list") return a;
          const has = a.options.some((o) => o.patch[target] === op);
          const options = has
            ? a.options.filter((o) => o.patch[target] !== op)
            : OPERATORS.filter((o) =>
                o.value === op || a.options.some((x) => x.patch[target] === o.value),
              ).map((o) => opOption(target, o.value));
          return { ...a, options };
        })
        .filter((a) => !(a.target === target && a.kind === "list" && a.options.length === 0)));
  };
```

(`SweepOption` joins the `SweepAxis` import from `./lib/sweep`; also import `opAxisTarget`.)

**(b) Thread through `SidePanel` and `RuleGroupSection`.** Extend the `sweep` prop type on BOTH (`SidePanel` ~line 1879, `RuleGroupSection` ~line 2316) with:

```ts
    onToggleOp: (target: string, current: Operator) => void;
    onTickOp: (target: string, op: Operator) => void;
```

At the modal's `SidePanel`/rule-mode call site (~line 1272, the object passed as `sweep={{...}}`), add `onToggleOp: toggleOpSweepAxis, onTickOp: tickOpOption,`. The coded call sites (~lines 1933/1949) spread `...sweep`, so they inherit the fields; add the same two fields to the object built at ~line 1954 if it's built inline there.

**(c) `OperatorPicker` glyph** (~line 2049). Add the prop and render the glyph after the button:

```tsx
function OperatorPicker({ value, onChange, sweep }: {
  value: Operator;
  onChange: (op: Operator) => void;
  // Optional operator-sweep toggle (the equalizer glyph beside the button).
  sweep?: { swept: boolean; onToggle: () => void };
}) {
```

and just after the `</button>` closing the op button (before the portal):

```tsx
      {sweep && (
        <Tooltip content="Sweep this operator">
          <button
            type="button"
            className={`sp-sweep bt-op-sweep-toggle${sweep.swept ? " on" : ""}`}
            onClick={sweep.onToggle}
          >
            <SweepGlyph />
          </button>
        </Tooltip>
      )}
```

**(d) `RuleGroupSection` wiring** (~line 2441). Replace the `OperatorPicker` line:

```tsx
          <OperatorPicker
            value={rule.op}
            onChange={(op) => setRule(i, { ...rule, op })}
            sweep={sweep && rule.enabled !== false ? {
              swept: sweep.axes.some((a) => a.target === opAxisTarget(sweep.side, sweep.group, activeRuleIndex(i))),
              onToggle: () => sweep.onToggleOp(opAxisTarget(sweep.side, sweep.group, activeRuleIndex(i)), rule.op),
            } : undefined}
          />
```

And directly after the closing `</div>` of `.bt-rule-row` (still inside the `group.rules.map` body, wrap row + editor in a `<Fragment key={i}>` and move the `key` off the row div):

```tsx
          {sweep && rule.enabled !== false && (() => {
            const target = opAxisTarget(sweep.side, sweep.group, activeRuleIndex(i));
            const axis = sweep.axes.find((a) => a.target === target);
            if (axis?.kind !== "list") return null;
            return (
              <div className="sp-row sweep-axis-row bt-op-sweep-row">
                <span className="sp-label">operators</span>
                <span className="bt-chip-row">
                  {OPERATORS.map((o) => {
                    const on = axis.options.some((opt) => opt.patch[target] === o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        className={on ? "seg-on bt-chip" : "bt-chip"}
                        onClick={() => sweep.onTickOp(target, o.value)}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </span>
              </div>
            );
          })()}
```

`import { Fragment } from "react"` if not already imported.

**(e) Apply-combo support** in `applyRuleSweepCombo` (~line 491). Add the raw-index helper (module level, near `ordinal`):

```ts
// A sweep target's rule index counts ENABLED rules only (activeGroup drops
// disabled ones before POST); map it back to the raw UI index for apply.
function rawRuleIndex(rules: Rule[], activeIdx: number): number {
  let seen = -1;
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].enabled !== false) seen++;
    if (seen === activeIdx) return i;
  }
  return -1;
}
```

In the loop, BEFORE the `if (typeof value !== "number") continue;` guard, add the op branch:

```ts
      // op:<side>.<entry|exit>.<idx> carries a string operator.
      if (key.startsWith("op:") && typeof value === "string") {
        const [oside, ogroup, oidxStr] = key.slice("op:".length).split(".");
        const groupKey = `${oside}${ogroup === "entry" ? "Entry" : "Exit"}` as
          "longEntry" | "longExit" | "shortEntry" | "shortExit";
        const ruleGroup = next[groupKey];
        const idx = rawRuleIndex(ruleGroup.rules, Number(oidxStr));
        const rule = ruleGroup.rules[idx];
        if (!rule) continue;
        const rules = ruleGroup.rules.slice();
        rules[idx] = { ...rule, op: value as Operator };
        next = { ...next, [groupKey]: { ...ruleGroup, rules } };
        continue;
      }
```

Also fix the existing `rule:` branch (~line 513) to use the same mapping: replace `const idx = Number(idxStr);` + `const rule = ruleGroup.rules[idx];` with `const idx = rawRuleIndex(ruleGroup.rules, Number(idxStr));` + the same lookup (this is a real pre-existing bug: a disabled rule above the swept one made apply patch the wrong rule).

**(f) CSS** in `frontend/src/App.css`, next to the existing `.sweep-axis-row` styles:

```css
.bt-op-sweep-row .bt-chip-row { flex-wrap: wrap; }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx src/lib/sweep.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/App.css frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(sweep): inline operator sweep (glyph + 7-op chip editor) with combo apply"
```

---

### Task 6: Frontend - time-window sweep UI + combo apply

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (mask time-of-day row ~line 1107, modal handlers, `applyRuleSweepCombo` + coded `applySweepCombo`)
- Modify: `frontend/src/App.css`
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `ListAxis`, `SweepOption` (Task 1); `SESSION_PRESETS`, `minToTime` (already imported, line 55); `addAxis` (Task 5).
- Produces: `toggleTimeWindowSweepAxis`, `addTimeWindowOption`, `removeTimeWindowOption`; axis target `"timeWindow"`; combo keys `timeWindow:startMin` / `timeWindow:endMin` (numbers) / `timeWindow:tz` (string); apply patches `cfg.range.mask`.

- [ ] **Step 1: Write the failing test**

Add to `BacktestSettingsModal.test.tsx` (again reusing its mount helpers; the mask block renders once "Trading sessions" is enabled - follow how existing tests enable it, or set the initial config's `range.mask = { enabled: true, timeOfDay: { startMin: 480, endMin: 720 }, tz: "UTC" }`):

```tsx
it("toggles a time-window sweep axis and lists candidate windows inline", () => {
  // with an enabled mask whose timeOfDay is 08:00-12:00 UTC
  const glyph = document.querySelector(".bt-tw-sweep-toggle")!;
  expect(glyph).toBeTruthy();
  fireEvent.click(glyph);
  const editor = document.querySelector(".bt-tw-sweep")!;
  expect(editor).toBeTruthy();
  // seeded with the current window
  expect(editor.textContent).toContain("08:00-12:00 UTC");
  // a session preset can be added as another option
  fireEvent.change(editor.querySelector("select")!, { target: { value: "London" } });
  expect(editor.querySelectorAll(".bt-tw-option").length).toBe(2);
  // removing an option works
  fireEvent.click(editor.querySelectorAll(".bt-tw-option button")[0]);
  expect(editor.querySelectorAll(".bt-tw-option").length).toBe(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: new test FAILS (no `.bt-tw-sweep-toggle`).

- [ ] **Step 3: Implement**

**(a) Modal handlers** (next to the Task 5 handlers):

```ts
  const timeWindowAxis = sweepAxes.find((a) => a.target === "timeWindow");
  const twOption = (startMin: number, endMin: number, tz: string, label?: string): SweepOption => ({
    label: label ?? `${minToTime(startMin)}-${minToTime(endMin)} ${tz}`,
    patch: { "timeWindow:startMin": startMin, "timeWindow:endMin": endMin, "timeWindow:tz": tz },
  });
  // Time-window axis: a discrete list of intraday windows, seeded with the
  // mask's current window when one is set.
  const toggleTimeWindowSweepAxis = () => {
    setSweepAxes((axes) => {
      if (axes.some((a) => a.target === "timeWindow")) return axes.filter((a) => a.target !== "timeWindow");
      const t = cfg.range.mask?.timeOfDay;
      const tz = cfg.range.mask?.tz ?? "UTC";
      return addAxis(axes, {
        kind: "list", target: "timeWindow", label: "Window",
        options: t ? [twOption(t.startMin, t.endMin, tz)] : [],
      });
    });
  };
  const addTimeWindowOption = (o: SweepOption) =>
    setSweepAxes((axes) => axes.map((a) =>
      a.target === "timeWindow" && a.kind === "list" && !a.options.some((x) => x.label === o.label)
        ? { ...a, options: [...a.options, o] }
        : a));
  // Session presets resolve to an explicit window + the preset's OWN tz, so
  // the tz travels with each option (no conversion into the mask tz needed).
  const addSessionWindowOption = (key: SessionPreset | "") => {
    if (!key) return;
    const p = SESSION_PRESETS[key];
    if (!p.window) return; // Crypto: 24h, no window to sweep
    addTimeWindowOption(twOption(p.window.startMin, p.window.endMin, p.tz, p.label));
  };
  const removeTimeWindowOption = (i: number) =>
    setSweepAxes((axes) => axes.map((a) =>
      a.target === "timeWindow" && a.kind === "list"
        ? { ...a, options: a.options.filter((_, j) => j !== i) }
        : a));
```

(Check `SESSION_PRESETS`'s value shape in `frontend/src/lib/backtestSchedule.ts` line 12 before coding: if `window` is never null, drop that guard.)

**(b) UI** inside the mask block. In the `!cfg.range.mask?.session &&` time From/To row (~line 1108), append after the "To" label, inside the row div:

```tsx
                    <Tooltip content="Sweep the time window: run each of several intraday windows">
                      <button
                        type="button"
                        className={`sp-sweep bt-tw-sweep-toggle${timeWindowAxis ? " on" : ""}`}
                        disabled={resSeconds >= 86400}
                        onClick={toggleTimeWindowSweepAxis}
                      >
                        <SweepGlyph />
                      </button>
                    </Tooltip>
```

Directly after that row's closing `</div>`, the editor:

```tsx
                {timeWindowAxis?.kind === "list" && (
                  <div className="sp-row sweep-axis-row bt-tw-sweep">
                    <span className="sp-label">Window sweep</span>
                    <span className="bt-tw-options">
                      {timeWindowAxis.options.map((o, i) => (
                        <span key={o.label} className="bt-chip seg-on bt-tw-option">
                          {o.label}
                          <button
                            type="button"
                            aria-label={`Remove ${o.label}`}
                            onClick={() => removeTimeWindowOption(i)}
                          >
                            x
                          </button>
                        </span>
                      ))}
                      <button
                        type="button"
                        className="ghost"
                        disabled={!cfg.range.mask?.timeOfDay}
                        onClick={() => {
                          const t = cfg.range.mask?.timeOfDay;
                          if (t) addTimeWindowOption(twOption(t.startMin, t.endMin, cfg.range.mask?.tz ?? "UTC"));
                        }}
                      >
                        + current window
                      </button>
                      <select
                        aria-label="Add session window"
                        value=""
                        onChange={(e) => addSessionWindowOption(e.target.value as SessionPreset | "")}
                      >
                        <option value="">+ session</option>
                        {Object.entries(SESSION_PRESETS).map(([k, v]) => (
                          <option key={k} value={k}>{v.label}</option>
                        ))}
                      </select>
                    </span>
                  </div>
                )}
```

**(c) Apply-combo.** In `applyRuleSweepCombo`, before the key loop:

```ts
    // timeWindow combo: patch the applied window onto the mask.
    const twS = combo["timeWindow:startMin"];
    const twE = combo["timeWindow:endMin"];
    if (typeof twS === "number" && typeof twE === "number") {
      const tz = typeof combo["timeWindow:tz"] === "string" ? combo["timeWindow:tz"] : next.range.mask?.tz ?? "UTC";
      next = {
        ...next,
        range: {
          ...next.range,
          mask: {
            ...(next.range.mask ?? { enabled: true }),
            enabled: true,
            timeOfDay: { startMin: twS, endMin: twE },
            tz,
            session: undefined,
          },
        },
      };
    }
```

In the coded `applySweepCombo` (~line 547): period/timeWindow live on `cfg` (range/mask), not `codedCfg`. Build a `cfgNext` alongside `next`: start `let cfgNext = cfg;`, apply the same timeWindow block (and Task 7's period block) to `cfgNext`, and before `run()` do `if (cfgNext !== cfg) setCfg(cfgNext);` then `run(cfgNext !== cfg ? cfgNext : undefined)`.

**(d) CSS** next to Task 5's rule:

```css
.bt-tw-sweep .bt-tw-options { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.bt-tw-option button { margin-left: 4px; border: none; background: none; cursor: pointer; }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/App.css frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(sweep): inline time-window sweep (window list + session presets) with combo apply"
```

---

### Task 7: Frontend - period sweep UI + materialization at run + combo apply

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (Range section ~line 857, `runFromFooter` ~line 803, `SweepResults` axes prop ~line 1531, apply functions)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `materializePeriodAxes` (Task 1); `resolveWindow` (already imported, line 26); `addAxis` (Task 5).
- Produces: period axis `{ kind: "period", target: "period", label: "Period", n }`; `runFromFooter` publishes MATERIALIZED axes to `sweepAxesSignal` and stores them as `ranAxes` for `SweepResults`; applying a period combo sets `range = { mode: "custom", fromMs, toMs }`.

- [ ] **Step 1: Write the failing test**

```tsx
it("toggles a period sweep axis with an inline windows stepper", () => {
  const glyph = document.querySelector(".bt-period-sweep-toggle")!;
  expect(glyph).toBeTruthy();
  fireEvent.click(glyph);
  const editor = document.querySelector(".bt-period-sweep")!;
  expect(editor).toBeTruthy();
  const input = editor.querySelector("input")! as HTMLInputElement;
  expect(input.value).toBe("4");                      // default N
  fireEvent.change(input, { target: { value: "6" } });
  expect((editor.querySelector("input") as HTMLInputElement).value).toBe("6");
  fireEvent.click(glyph);                              // toggles off
  expect(document.querySelector(".bt-period-sweep")).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: FAIL (no `.bt-period-sweep-toggle`).

- [ ] **Step 3: Implement**

**(a) Handlers:**

```ts
  const periodAxis = sweepAxes.find((a) => a.target === "period");
  // Period axis: walk-forward, the range split into n equal windows. Stored as
  // just n while editing; materialized into concrete windows at run time so it
  // always reflects the range as currently configured.
  const togglePeriodSweepAxis = () => {
    setSweepAxes((axes) =>
      axes.some((a) => a.target === "period")
        ? axes.filter((a) => a.target !== "period")
        : addAxis(axes, { kind: "period", target: "period", label: "Period", n: 4 }));
  };
  const setPeriodN = (n: number) =>
    setSweepAxes((axes) => axes.map((a) =>
      a.kind === "period" ? { ...a, n: Math.max(2, Math.min(50, Math.round(n) || 2)) } : a));
```

**(b) UI.** In the range-mode row (~line 857), after the Timeframe `</label>`:

```tsx
              <Tooltip content="Sweep the trading period: split the range into N equal windows and run each">
                <button
                  type="button"
                  className={`sp-sweep bt-period-sweep-toggle${periodAxis ? " on" : ""}`}
                  onClick={togglePeriodSweepAxis}
                >
                  <SweepGlyph />
                </button>
              </Tooltip>
```

After the `bt-range-subtitle` div (~line 912):

```tsx
            {periodAxis?.kind === "period" && (
              <div className="sp-row sweep-axis-row bt-period-sweep">
                <span className="sp-label">Period sweep</span>
                <span className="sweep-axis-fields">
                  <span>windows</span>
                  <input
                    type="number"
                    min={2}
                    max={50}
                    step={1}
                    value={periodAxis.n}
                    onChange={(e) => setPeriodN(Number(e.target.value))}
                  />
                </span>
              </div>
            )}
```

**(c) Materialize at run.** Add state near `sweepAxes`: `const [ranAxes, setRanAxes] = useState<SweepAxis[]>([]);`. Replace `runFromFooter` (~line 803):

```ts
  function runFromFooter() {
    // Synced SL/TP: stamp risk axes with their short-side mirror so the sweep
    // moves both legs together (the axes themselves stay long-side only).
    const synced = cfg.mode === "coded" ? riskSyncOn(codedCfg) : riskSyncOn(cfg);
    const mirrored = synced ? mirrorRiskAxes(sweepAxes) : sweepAxes;
    // Period axes materialize against the range as configured RIGHT NOW, so an
    // edit between toggle and run can never sweep stale windows.
    const { fromMs, toMs } = resolveWindow(cfg, resSeconds, Date.now());
    const finalAxes = materializePeriodAxes(mirrored, fromMs, toMs);
    setRanAxes(finalAxes);
    sweepAxesSignal.set(finalAxes);
    run();
  }
```

(Import `materializePeriodAxes` from `./lib/sweep`.) Change the `SweepResults` render (~line 1531) to use the axes that actually ran: `axes={ranAxes.length ? ranAxes : sweepAxes}`.

**(d) Apply-combo.** In `applyRuleSweepCombo`, next to Task 6's timeWindow block:

```ts
    // period combo: apply the window as a custom range.
    const pFrom = combo["period:from"];
    const pTo = combo["period:to"];
    if (typeof pFrom === "number" && typeof pTo === "number") {
      next = { ...next, range: { ...next.range, mode: "custom", fromMs: pFrom * 1000, toMs: pTo * 1000 } };
    }
```

Add the same block to the coded `applySweepCombo`'s `cfgNext` (from Task 6 step 3c).

- [ ] **Step 4: Run to verify pass (full frontend)**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS across the suite.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(sweep): inline walk-forward period sweep, materialized at run time"
```

---

### Task 8: End-to-end verification

**Files:**
- No planned source changes (fixes only if verification finds problems).

**Interfaces:**
- Consumes: everything above.
- Produces: verified feature; use the `verify` skill conventions (drive the real flow, not just tests).

- [ ] **Step 1: Full test suites**

Run: `cd backend && python -m pytest -q` and `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 2: Drive the app (dev servers are usually already running; do NOT kill the user's HMR servers)**

In the running app (or start it per the project's run skill), open the Backtest panel on any instrument and verify each dimension end to end:
1. **Operator:** add a long-entry rule, click the sweep glyph beside the operator button, tick 2-3 operators in the inline chip row, Run backtest. Confirm: results table rows labeled "greater than" / "less than" etc., heatmap ticks show operator labels, clicking a row applies that operator to the rule and re-runs.
2. **Period:** toggle the glyph beside the Range controls, set windows to 4, Run. Confirm 4 rows labeled `W1:`...`W4:` with date ranges, different metrics per window, clicking a row switches the range to Custom with that window's dates.
3. **Time window:** enable Trading sessions, set a From/To time, toggle the glyph on the time row, add a session preset option, Run. Confirm one row per window and that applying one patches the mask's From/To (and tz for a preset).
4. **Cross:** operator x period (2 axes) renders the heatmap with labels on both axes.
5. **Guardrails:** a third glyph drops the oldest axis; combo counter and the 200-cap warning behave; Cancel mid-sweep still works.

- [ ] **Step 3: Fix anything found, re-run the affected tests, commit**

```bash
git add -A && git commit -m "fix(sweep): findings from end-to-end verification"
```

(Skip the commit if nothing needed fixing.)

# Sweep Setup Persistence + Clear Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backtest sweep setup stops being throwaway: each field remembers its last-run from/to/step, the toggled axis set survives close/apply/reload, and sweep results get a Clear button.

**Architecture:** A new `lib/sweepMemory.ts` module owns all storage (range memory map with an LRU cap, per-context axis-set keys, restore-time pruning) on top of the existing synced `save()`/`load()` in `lib/persist/core.ts`. `BacktestSettingsModal.tsx` consumes it: recall inside the three sweep-toggle functions, record inside `runFromFooter`, restore/persist the `sweepAxes` state, and stop clearing axes on apply. The Clear button is a sibling of the existing Cancel button in the results region.

**Tech Stack:** React + TypeScript, vitest + @testing-library/react (jsdom). All commands run from `frontend/`.

**Spec:** `docs/superpowers/specs/2026-07-15-sweep-setup-persistence-design.md`

## Global Constraints

- Never use em dashes ("—" or "--") as punctuation in any new text: code comments, UI copy, test names. Rephrase with colon/comma/period. (Existing occurrences stay.)
- Storage goes through `save()`/`load()` from `frontend/src/lib/persist/core.ts` (synced flavor, like codedCfg). Do NOT use `saveLocal` and do NOT touch `DEVICE_LOCAL_FLAT_KEYS`.
- Commit directly to `main` after each task (single-dev repo convention).
- Test command: `cd frontend && npx vitest run <file>`.
- The mode-switch clearing of cross-mode axes is a documented correctness invariant; this plan restores each mode's axes from its OWN key, it never lets one mode's axes survive in memory into the other mode.

---

### Task 1: `lib/sweepMemory.ts` storage module

**Files:**
- Create: `frontend/src/lib/sweepMemory.ts`
- Test: `frontend/src/lib/sweepMemory.test.ts`

**Interfaces:**
- Consumes: `save`/`load`/`PREFIX` from `./persist/core`; `SweepAxis`, `RangeAxis` from `./sweep`; `sweepAxisLabel`, `LabelConfig` from `./sweepLabels`.
- Produces (Tasks 2 and 3 import these exact names):
  - `interface SweepRange { from: number; to: number; step: number }`
  - `sweepContext(mode: "rules" | "coded" | undefined, codedStrategy?: string | null): string`
  - `recallSweepRange(ctx: string, target: string): SweepRange | null`
  - `recordSweepRanges(ctx: string, axes: SweepAxis[]): void`
  - `loadSweepAxes(ctx: string): SweepAxis[]`
  - `saveSweepAxes(ctx: string, axes: SweepAxis[]): void`
  - `pruneSweepAxes(axes: SweepAxis[], cfg: LabelConfig): SweepAxis[]`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/sweepMemory.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  sweepContext,
  recallSweepRange,
  recordSweepRanges,
  loadSweepAxes,
  saveSweepAxes,
  pruneSweepAxes,
} from "./sweepMemory";
import type { RangeAxis, ListAxis, SweepAxis } from "./sweep";
import type { LabelConfig } from "./sweepLabels";

const range = (target: string, from = 10, to = 20, step = 2): RangeAxis => ({
  kind: "range", target, label: target, from, to, step,
});

beforeEach(() => localStorage.clear());

describe("sweepContext", () => {
  it("is 'rules' for rules mode and per-file for coded mode", () => {
    expect(sweepContext("rules", null)).toBe("rules");
    expect(sweepContext(undefined, null)).toBe("rules");
    expect(sweepContext("coded", "ema_cross.py")).toBe("coded.ema_cross.py");
    expect(sweepContext("coded", null)).toBe("coded.");
  });
});

describe("range memory", () => {
  it("recalls nothing before any record", () => {
    expect(recallSweepRange("rules", "risk:long.stop.value")).toBeNull();
  });

  it("records range axes on run and recalls them per target", () => {
    recordSweepRanges("rules", [range("risk:long.stop.value", 1, 3, 0.5)]);
    expect(recallSweepRange("rules", "risk:long.stop.value")).toEqual({ from: 1, to: 3, step: 0.5 });
  });

  it("does not record list axes", () => {
    const list: ListAxis = { kind: "list", target: "op:long.entry.0", label: "op", options: [] };
    recordSweepRanges("rules", [list]);
    expect(recallSweepRange("rules", "op:long.entry.0")).toBeNull();
  });

  it("keys by context: two strategy files do not collide", () => {
    recordSweepRanges("coded.a.py", [range("param:n", 5, 10, 1)]);
    recordSweepRanges("coded.b.py", [range("param:n", 50, 100, 10)]);
    expect(recallSweepRange("coded.a.py", "param:n")).toEqual({ from: 5, to: 10, step: 1 });
    expect(recallSweepRange("coded.b.py", "param:n")).toEqual({ from: 50, to: 100, step: 10 });
  });

  it("re-recording a target updates it in place", () => {
    recordSweepRanges("rules", [range("param:n", 1, 2, 1)]);
    recordSweepRanges("rules", [range("param:n", 3, 4, 1)]);
    expect(recallSweepRange("rules", "param:n")).toEqual({ from: 3, to: 4, step: 1 });
  });

  it("evicts the oldest entry past the 300-entry cap", () => {
    recordSweepRanges("rules", [range("param:first")]);
    for (let i = 0; i < 300; i++) recordSweepRanges("rules", [range(`param:p${i}`)]);
    expect(recallSweepRange("rules", "param:first")).toBeNull();
    expect(recallSweepRange("rules", "param:p299")).not.toBeNull();
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("auto-trader.sweepRanges", "not json");
    expect(recallSweepRange("rules", "param:n")).toBeNull();
    recordSweepRanges("rules", [range("param:n")]);
    expect(recallSweepRange("rules", "param:n")).toEqual({ from: 10, to: 20, step: 2 });
  });
});

describe("axis-set persistence", () => {
  it("round-trips an axis list per context", () => {
    const axes: SweepAxis[] = [range("risk:long.stop.value")];
    saveSweepAxes("rules", axes);
    expect(loadSweepAxes("rules")).toEqual(axes);
    expect(loadSweepAxes("coded.a.py")).toEqual([]);
  });

  it("returns [] for missing or malformed storage", () => {
    expect(loadSweepAxes("rules")).toEqual([]);
    localStorage.setItem("auto-trader.sweepAxes.rules", JSON.stringify({ nope: 1 }));
    expect(loadSweepAxes("rules")).toEqual([]);
  });
});

describe("pruneSweepAxes", () => {
  // One enabled long-entry rule at index 0, so index 5 is stale.
  const cfg: LabelConfig = {
    longEntry: {
      combine: "AND",
      rules: [{ left: { kind: "indicator", indicator: "EMA", length: 20 }, op: "crossesAbove", right: { kind: "indicator", indicator: "EMA", length: 50 } }],
    },
  } as unknown as LabelConfig;

  it("drops a rule axis whose rule no longer exists, keeps resolvable and self-labelled axes", () => {
    const axes: SweepAxis[] = [
      range("rule:long.entry.0.left.length"),
      range("rule:long.entry.5.left.length"),
      range("risk:long.stop.value"),
      range("param:n"),
      { kind: "period", target: "period", label: "Periods", n: 3 },
    ];
    const kept = pruneSweepAxes(axes, cfg);
    expect(kept.map((a) => a.target)).toEqual([
      "rule:long.entry.0.left.length",
      "risk:long.stop.value",
      "param:n",
      "period",
    ]);
  });
});
```

Note: if the `cfg` literal above does not satisfy `LabelConfig` (check the real shape at `frontend/src/lib/sweepLabels.ts:14` before writing), build it from `defaultBacktestConfig()` instead: `const cfg = defaultBacktestConfig()` already seeds one enabled long-entry rule and satisfies `LabelConfig` structurally. Prefer that if it compiles.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/sweepMemory.test.ts`
Expected: FAIL, cannot resolve `./sweepMemory`.

- [ ] **Step 3: Implement the module**

Create `frontend/src/lib/sweepMemory.ts`:

```ts
// Sweep setup persistence: (1) a per-field "last used from/to/step" memory so
// re-toggling a sweep restores the previous round's range, and (2) the whole
// axis set saved per context so the panel's sweep setup survives close/apply/
// reload. Context is "rules" for rules mode or "coded.<filename>" for a coded
// strategy, so the same target name on two .py files never collides.
// (Spec: docs/superpowers/specs/2026-07-15-sweep-setup-persistence-design.md)

import { load, save, PREFIX } from "./persist/core";
import type { SweepAxis } from "./sweep";
import { sweepAxisLabel, type LabelConfig } from "./sweepLabels";

export interface SweepRange {
  from: number;
  to: number;
  step: number;
}

const RANGES_KEY = `${PREFIX}.sweepRanges`;
const RANGES_CAP = 300;
const axesKey = (ctx: string) => `${PREFIX}.sweepAxes.${ctx}`;

export function sweepContext(
  mode: "rules" | "coded" | undefined,
  codedStrategy?: string | null,
): string {
  return mode === "coded" ? `coded.${codedStrategy ?? ""}` : "rules";
}

// Stored as an entry list in least-recently-recorded order (oldest first),
// so the cap can evict from the front without a separate timestamp.
type RangeEntries = Array<[string, SweepRange]>;

function loadRanges(): RangeEntries {
  const raw = load<RangeEntries>(RANGES_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

export function recallSweepRange(ctx: string, target: string): SweepRange | null {
  const key = `${ctx}|${target}`;
  const hit = loadRanges().find(([k]) => k === key);
  return hit ? hit[1] : null;
}

/** Records every RANGE axis's from/to/step under the context. Called when a
 * sweep actually runs: "last used" means "last swept with", not "last typed". */
export function recordSweepRanges(ctx: string, axes: SweepAxis[]): void {
  const fresh: RangeEntries = axes
    .filter((a): a is Extract<SweepAxis, { kind: "range" }> => a.kind === "range")
    .map((a) => [`${ctx}|${a.target}`, { from: a.from, to: a.to, step: a.step }]);
  if (!fresh.length) return;
  const freshKeys = new Set(fresh.map(([k]) => k));
  const entries = loadRanges().filter(([k]) => !freshKeys.has(k));
  entries.push(...fresh);
  save(RANGES_KEY, entries.slice(-RANGES_CAP));
}

export function loadSweepAxes(ctx: string): SweepAxis[] {
  const raw = load<SweepAxis[]>(axesKey(ctx), []);
  return Array.isArray(raw) ? raw : [];
}

export function saveSweepAxes(ctx: string, axes: SweepAxis[]): void {
  save(axesKey(ctx), axes);
}

/** Restore-time validation: drop any axis whose target no longer resolves
 * against the current config (e.g. a rule deleted since the axis was saved).
 * param axes pass here (the strategy schema loads async; the modal prunes them
 * once it arrives), and period/timeWindow axes always resolve. */
export function pruneSweepAxes(axes: SweepAxis[], cfg: LabelConfig): SweepAxis[] {
  return axes.filter((a) => {
    const t = a.target;
    if (t.startsWith("param:") || t === "period" || t === "timeWindow") return true;
    return sweepAxisLabel(t, cfg) !== null;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/sweepMemory.test.ts`
Expected: PASS (all describes). If the pruneSweepAxes test fails on the `cfg` shape, fix the test's config per the note in Step 1, not the implementation.

- [ ] **Step 5: Typecheck and commit**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

```bash
git add frontend/src/lib/sweepMemory.ts frontend/src/lib/sweepMemory.test.ts
git commit -m "feat(sweep): storage module for range memory + persistent axis sets"
```

---

### Task 2: Recall ranges on toggle, record on run

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (the three toggle functions near line 431, and `runFromFooter` near line 970)
- Test: `frontend/src/BacktestSettingsModal.test.tsx` (append a describe block)

**Interfaces:**
- Consumes from Task 1: `sweepContext`, `recallSweepRange`, `recordSweepRanges` from `./lib/sweepMemory`.
- Produces: no new exports; behavior only.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/BacktestSettingsModal.test.tsx` (reuse the existing `renderModal`, `openStrategy`, `groupSection`, `ruleRows` helpers; add the sweepMemory imports at the top of the file):

```ts
import { recordSweepRanges, recallSweepRange } from "./lib/sweepMemory";
```

```ts
describe("sweep range memory", () => {
  it("toggling a sweep on recalls the last-run range instead of the heuristic", () => {
    // 30..60 step 3 enumerates 11 values; the heuristic seed would not.
    recordSweepRanges("rules", [
      { kind: "range", target: "rule:long.entry.0.left.length", label: "len", from: 30, to: 60, step: 3 },
    ]);
    renderModal();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    // Footer combo count proves the recalled range seeded the axis: 11 runs.
    expect(screen.getByText(/runs$/).textContent).toContain("11");
  });

  it("running a sweep records each range axis's from/to/step", () => {
    renderModal();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    expect(recallSweepRange("rules", "rule:long.entry.0.left.length")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run sweep" }));
    const rec = recallSweepRange("rules", "rule:long.entry.0.left.length");
    expect(rec).not.toBeNull();
    expect(rec!.step).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "sweep range memory"`
Expected: both FAIL (first: footer count reflects the heuristic seed, not 11; second: recall stays null after Run sweep).

- [ ] **Step 3: Implement recall + record**

In `frontend/src/BacktestSettingsModal.tsx`:

Add the import:

```ts
import { sweepContext, recallSweepRange, recordSweepRanges } from "./lib/sweepMemory";
```

Add a context helper next to the sweep state (near line 425):

```ts
// The storage context sweep memory/axes are keyed by: "rules", or the coded
// strategy file, so param:n on two different .py files never collide.
const sweepCtx = () => sweepContext(cfg.mode, cfg.codedStrategy);
```

In `toggleSweepAxis`, replace the `next` literal with:

```ts
      const mem = recallSweepRange(sweepCtx(), target);
      const next: SweepAxis = {
        kind: "range",
        target,
        label: spec.label,
        from: mem?.from ?? spec.min ?? (spec.default as number),
        to: mem?.to ?? spec.max ?? (spec.default as number) * 2,
        step: mem?.step ?? spec.step ?? 1,
      };
```

In `toggleRiskSweepAxis`, replace the `next` literal with:

```ts
      const base = current || 1;
      const mem = recallSweepRange(sweepCtx(), target);
      const next: SweepAxis = {
        kind: "range",
        target,
        label: sweepAxisLabel(target, labelCfg()) ?? target.split(".").slice(1).join(" "),
        from: mem?.from ?? base,
        to: mem?.to ?? base * 2,
        step: mem?.step ?? Math.max(base / 10, 0.1),
      };
```

In `toggleRuleSweepAxis`, replace the `next` literal with:

```ts
      const base = current || 1;
      const mem = recallSweepRange(sweepCtx(), target);
      const next: SweepAxis = {
        kind: "range",
        target,
        label: sweepAxisLabel(target, labelCfg()) ?? target.replace(/^rule:/, ""),
        from: mem?.from ?? base,
        to: mem?.to ?? base * 2,
        step: mem?.step ?? Math.max(base / 10, 1),
      };
```

In `runFromFooter`, record the editable axes (not the mirrored/materialized copies) right before `setRanAxes(finalAxes)`:

```ts
    // "Last used" range memory: recorded at run time, keyed per context.
    recordSweepRanges(sweepCtx(), sweepAxes);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "sweep range memory"`
Expected: PASS.

- [ ] **Step 5: Run the whole modal suite + typecheck, commit**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx && npx tsc -b`
Expected: all PASS, no type errors.

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(sweep): toggling a sweep recalls the field's last-run range"
```

---

### Task 3: Sweep axis set survives close, apply, reload, and mode switches

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx`:
  - `sweepAxes` useState initializer (near line 425)
  - the coded-file-change effect (near line 412)
  - the two mode-switch button handlers (near lines 1458 and 1467)
  - `applyRuleSweepCombo` (its `setSweepAxes([])` near line 681)
  - `applySweepCombo` coded branch (its `setSweepAxes([])` near line 742)
  - new save effect + param prune effect
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes from Task 1: `loadSweepAxes`, `saveSweepAxes`, `pruneSweepAxes` from `./lib/sweepMemory` (add to the existing import), plus `sweepCtx` from Task 2.
- Produces: no new exports; behavior only.

**Invariants to preserve:**
- The unmount cleanup (near line 583) keeps clearing `sweepAxesSignal` and `sweepStateSignal`. Do not touch it: React state dies with unmount, storage is the restore source.
- Both apply paths keep `sweepAxesSignal.set([])` and `sweepStateSignal.set(null)` before `run(...)`: the post-apply run must be a plain backtest, only the EDITABLE axes survive.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/BacktestSettingsModal.test.tsx`. Extend the sweepMemory import with `saveSweepAxes`:

```ts
import { recordSweepRanges, recallSweepRange, saveSweepAxes } from "./lib/sweepMemory";
```

```ts
describe("persistent sweep setup", () => {
  it("restores the axis set after unmount/remount", () => {
    renderModal();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    expect(document.querySelector(".sweep-axis-row")).toBeTruthy();
    cleanup();
    renderModal();
    openStrategy();
    expect(document.querySelector(".sweep-axis-row")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run sweep" })).toBeTruthy();
  });

  it("prunes a stored axis whose rule no longer exists", () => {
    saveSweepAxes("rules", [
      { kind: "range", target: "rule:long.entry.5.left.length", label: "stale", from: 1, to: 2, step: 1 },
    ]);
    renderModal();
    openStrategy();
    // The stale axis must not survive restore: footer stays in plain-run mode.
    expect(screen.getByRole("button", { name: "Run backtest" })).toBeTruthy();
    expect(document.querySelector(".sweep-axis-row")).toBeNull();
  });

  it("keeps the axes after applying a combo, but the follow-up run is not a sweep", () => {
    const onRun = vi.fn();
    render(
      <BacktestSettingsModal
        initial={defaultBacktestConfig()} epic="TEST" resolution="MINUTE" controller={null}
        onRun={onRun} onClose={vi.fn()}
      />,
    );
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    const rows: SweepRow[] = [
      { combo: { "rule:long.entry.0.left.length": 30 }, metrics: { net_pnl: 1, n_trades: 1, win_rate: 0.5, max_drawdown: 0, profit_factor: 1, avg_win_loss_ratio: 1, return_pct: 1 }, error: null },
    ];
    act(() => sweepStateSignal.set({ rows, done: 1, total: 1, running: false }));
    fireEvent.click(document.querySelector(".sweep-row") as HTMLElement);
    expect(onRun).toHaveBeenCalledTimes(1);
    // The field is still in sweep mode for round two.
    expect(document.querySelector(".sweep-axis-row")).toBeTruthy();
    // But the run that just fired was a plain backtest, not a sweep.
    expect(sweepAxesSignal.value).toEqual([]);
  });

  it("mode switch round-trip restores each mode's own axes", () => {
    renderModal();
    openStrategy();
    const row = ruleRows(groupSection("Buy to open"))[0];
    fireEvent.click(row.querySelector(".sp-sweep")!);
    expect(document.querySelector(".sweep-axis-row")).toBeTruthy();
    // The Rules|Strategy segmented switch reuses the vertical tab's "Strategy"
    // label; the seg button is the one that is NOT inside .bt-htabs.
    const segStrategy = screen
      .getAllByRole("button", { name: "Strategy" })
      .find((b) => !b.closest(".bt-htabs"))!;
    fireEvent.click(segStrategy);
    expect(document.querySelector(".sweep-axis-row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rules" }));
    expect(document.querySelector(".sweep-axis-row")).toBeTruthy();
  });
});
```

Add `afterEach` hygiene to this describe (the axes now persist, so leaked signal state must still be reset):

```ts
  afterEach(() => {
    sweepStateSignal.set(null);
    sweepAxesSignal.set([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "persistent sweep setup"`
Expected: all four FAIL (axes are session-only today; apply clears them; mode switch discards them).

- [ ] **Step 3: Implement persistence**

All edits in `frontend/src/BacktestSettingsModal.tsx`. Extend the Task 2 import:

```ts
import {
  sweepContext, recallSweepRange, recordSweepRanges,
  loadSweepAxes, saveSweepAxes, pruneSweepAxes,
} from "./lib/sweepMemory";
```

**(a) Initializer.** Replace `useState<SweepAxis[]>([])` and update the comment block above it (it currently says "session-only, never persisted, cleared on close/apply"; that is no longer true):

```ts
  // Sweep axes: persisted per context (rules / coded file) so the setup
  // survives close, apply, reload, and mode switches. Restored axes are pruned
  // against the current config so a deleted rule cannot leave a phantom axis.
  // labelCfg() is declared below (TDZ), so the initializer inlines the ternary.
  const [sweepAxes, setSweepAxes] = useState<SweepAxis[]>(() =>
    pruneSweepAxes(
      loadSweepAxes(sweepContext(cfg.mode, cfg.codedStrategy)),
      cfg.mode === "coded" ? codedCfg : cfg,
    ),
  );
```

(Keep the existing `ranAxes` state and the `SWEEP_MAX_COMBOS` sentence of the old comment if it reads naturally.)

**(b) Write-through save effect.** Add right after the `patchAxis` helper:

```ts
  // Write-through: every axes change lands in the current context's key. Deps
  // are [sweepAxes] ON PURPOSE: on a mode/file switch the axes swap in the
  // same update (or a later effect) as cfg, so this never writes one
  // context's axes under another context's key.
  useEffect(() => {
    saveSweepAxes(sweepCtx(), sweepAxes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepAxes]);
```

**(c) Coded-file switch.** In the existing effect keyed on `[cfg.codedStrategy]` (near line 412), capture the fresh coded config and reload that file's axes:

```ts
  useEffect(() => {
    const nextCoded = applyRiskSync(
      cfg.codedStrategy ? loadCodedCfg("backtest", cfg.codedStrategy) : defaultCodedCfg(),
      "long",
    );
    setCodedCfg(nextCoded);
    // Coded axes are per-file: switching files swaps in that file's saved set.
    if (cfg.mode === "coded") {
      setSweepAxes(pruneSweepAxes(loadSweepAxes(sweepContext("coded", cfg.codedStrategy)), nextCoded));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.codedStrategy]);
```

**(d) Mode switch.** The two segmented buttons currently call `setSweepAxes([])`. Replace each so switching loads the target mode's own stored set (this keeps the documented cross-mode invariant AND restores on switch-back). Update the comment above the Rules button: axes are mode-scoped, so each switch swaps to the target mode's persisted set.

Rules button:

```ts
                setSweepAxes(pruneSweepAxes(loadSweepAxes(sweepContext("rules", null)), cfg));
                setCfg({ ...cfg, mode: "rules" });
```

Strategy button:

```ts
                setSweepAxes(pruneSweepAxes(loadSweepAxes(sweepContext("coded", cfg.codedStrategy)), codedCfg));
                setCfg({ ...cfg, mode: "coded" });
```

**(e) Param-schema prune.** The strategy schema loads async, so `param:` axes are pruned once it arrives. Add near the `selectedStrategy` declaration (line 402):

```ts
  // param: axes can only be validated once the strategy schema loads; drop any
  // axis naming a param the selected file no longer declares.
  useEffect(() => {
    if (cfg.mode !== "coded" || !selectedStrategy) return;
    const names = new Set(selectedStrategy.params.map((p) => p.name));
    setSweepAxes((axes) => {
      const kept = axes.filter(
        (a) => !a.target.startsWith("param:") || names.has(a.target.slice("param:".length)),
      );
      return kept.length === axes.length ? axes : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStrategy]);
```

(Note: `selectedStrategy` is a plain `const` computed per render, so this effect needs it stable-ish; if lint or behavior complains about identity churn, key the effect on `[strategyList, cfg.codedStrategy]` and compute `selectedStrategy` inside.)

**(f) Apply keeps axes.** In `applyRuleSweepCombo` AND the coded `applySweepCombo`, delete the `setSweepAxes([]);` line. Keep `sweepAxesSignal.set([]);` and `sweepStateSignal.set(null);` exactly as they are. Update the nearby comment if one references clearing the axes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "persistent sweep setup"`
Expected: PASS (all four).

- [ ] **Step 5: Run the whole modal suite + sweep-related suites + typecheck**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx src/SweepResults.test.tsx src/lib/sweep.test.ts src/lib/sweepMemory.test.ts && npx tsc -b`
Expected: all PASS. Existing tests that assumed apply/close clears axes may fail; fix THOSE TESTS to the new contract (axes survive), not the implementation, unless the failure reveals a real leak (e.g. axes bleeding across modes, which must stay impossible).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(sweep): axis setup survives close, apply, reload, and mode switches"
```

---

### Task 4: Clear-results button

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (the `sweep-panel` block in the results region, near line 1737)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `sweepStateSignal` (already imported in the modal), `setRanAxes` (existing state setter).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/BacktestSettingsModal.test.tsx`:

```ts
describe("clear sweep results", () => {
  afterEach(() => {
    sweepStateSignal.set(null);
    sweepAxesSignal.set([]);
  });

  const rows: SweepRow[] = [
    { combo: { "rule:long.entry.0.left.length": 30 }, metrics: { net_pnl: 1, n_trades: 1, win_rate: 0.5, max_drawdown: 0, profit_factor: 1, avg_win_loss_ratio: 1, return_pct: 1 }, error: null },
  ];

  it("shows Clear results only when a sweep is finished, and clicking it clears the table", () => {
    renderModal();
    act(() => sweepStateSignal.set({ rows, done: 1, total: 2, running: true }));
    // While running: Cancel, no Clear.
    expect(screen.getByRole("button", { name: "Cancel sweep" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear results" })).toBeNull();
    act(() => sweepStateSignal.set({ rows, done: 2, total: 2, running: false }));
    expect(screen.queryByRole("button", { name: "Cancel sweep" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear results" }));
    expect(sweepStateSignal.value).toBeNull();
    expect(document.querySelector(".sweep-panel")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "clear sweep results"`
Expected: FAIL, no "Clear results" button.

- [ ] **Step 3: Implement the button**

In the `sweep-panel` block, replace the running-only Cancel button:

```tsx
                {sweepState.running ? (
                  <button className="ghost sweep-cancel" onClick={requestSweepCancel}>
                    Cancel sweep
                  </button>
                ) : (
                  <button
                    className="ghost sweep-cancel"
                    onClick={() => {
                      sweepStateSignal.set(null);
                      setRanAxes([]);
                    }}
                  >
                    Clear results
                  </button>
                )}
```

The sweep AXES are deliberately untouched: the setup stays ready for a rerun (Task 3's contract). Clearing `ranAxes` drops the labels of the run that no longer exists. Reuses the `sweep-cancel` class so no CSS change is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx -t "clear sweep results"`
Expected: PASS.

- [ ] **Step 5: Full frontend test run + typecheck, commit**

Run: `cd frontend && npx vitest run && npx tsc -b`
Expected: all PASS.

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(sweep): Clear results button on the sweep results block"
```

---

## Final verification (after Task 4)

Manual pass in the running app (dev servers are already up; do not restart them):

1. Open the backtest panel, toggle two sweeps (a rule length + a risk field), edit their ranges, Run sweep.
2. Close the panel, reopen: both fields still in sweep mode with the edited ranges.
3. Apply the best combo: axes stay on, the follow-up run is a single backtest.
4. Click Clear results: table gone, sweep setup intact, Run sweep still works.
5. Reload the page, reopen the panel: setup restored.
6. Switch Rules -> Strategy -> Rules: the rules-mode axes come back.

# Progress Feedback (backtest / sweep / WFO) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a short label of what a run is doing, but only during a stall window with no moving bar: "Downloading candles" (fetch), "Submitting" / "Uploading to compute host" (submit POST), "Running backtest" (the synchronous backtest POST).

**Architecture:** Frontend only. A single `progressStageSignal` (`string | null`) is set in `BacktestButton`'s run handler at the stall windows and cleared when a moving bar takes over (sweep/WFO first poll) or on completion. The three result panels render the label from that signal while it is non-null. No backend changes: the synchronous `POST /api/backtest` and the existing sweep/WFO submit + poll are untouched.

**Tech Stack:** React + TypeScript, a custom `Signal` class (`frontend/src/lib/signals.ts`), Vitest.

## Global Constraints

- No em dashes ("—" / "--") in end-user copy or chat prose. Code, tests, commits are fine.
- Any info affordance uses the shared `Tooltip` / `InfoTip`, never a native `title=`.
- Plain, direct labels; audience is educated traders.
- Frontend only — do NOT touch backend job models, routes, or the synchronous backtest POST.
- Only four stage keys exist: `downloading`, `submitting`, `uploading`, `engine`. Do not add fast-step labels.

---

### Task 1: Stage vocabulary, signal, and run-handler wiring

**Files:**
- Create: `frontend/src/lib/progressLabels.ts`
- Create: `frontend/src/lib/progressLabels.test.ts`
- Modify: `frontend/src/lib/signals.ts` (add `progressStageSignal`, near `backtestRunningSignal` line 406)
- Modify: `frontend/src/BacktestButton.tsx` (set/clear the signal in the `run()` handler)

**Interfaces:**
- Produces: `stageLabel(stage: string | null | undefined): string`; `progressStageSignal: Signal<string | null>` (null when idle).

- [ ] **Step 1: Write the failing label test**

Create `frontend/src/lib/progressLabels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { stageLabel } from "./progressLabels";

describe("stageLabel", () => {
  it("maps the four stall-window keys", () => {
    expect(stageLabel("downloading")).toBe("Downloading candles");
    expect(stageLabel("submitting")).toBe("Submitting");
    expect(stageLabel("uploading")).toBe("Uploading to compute host");
    expect(stageLabel("engine")).toBe("Running backtest");
  });
  it("returns empty for null/undefined/unknown", () => {
    expect(stageLabel(null)).toBe("");
    expect(stageLabel(undefined)).toBe("");
    expect(stageLabel("nope")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/progressLabels.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the vocabulary**

Create `frontend/src/lib/progressLabels.ts`:

```ts
// Labels for the "what is it doing" line, shown ONLY during a stall window with
// no moving progress bar (see the progress-feedback spec). Four keys only:
// candle download, the submit POST (local/remote), and the synchronous backtest
// run. Everything else is fast and stays unlabeled. Unknown/null -> "".
const LABELS: Record<string, string> = {
  downloading: "Downloading candles",
  submitting: "Submitting",
  uploading: "Uploading to compute host",
  engine: "Running backtest",
};

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "";
  return LABELS[stage] ?? "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/progressLabels.test.ts`
Expected: PASS

- [ ] **Step 5: Add the signal**

In `frontend/src/lib/signals.ts`, next to `backtestRunningSignal` (line 406):

```ts
// The current stall-window label for the active run (backtest/sweep/WFO), or
// null when idle or when a moving progress bar has taken over. Set in
// BacktestButton's run handler; read by the result panels. Values are stage keys
// (see lib/progressLabels.ts).
export const progressStageSignal = new Signal<string | null>(null);
```

- [ ] **Step 6: Wire set/clear into the run handler**

In `frontend/src/BacktestButton.tsx`, import `progressStageSignal` from `./lib/signals`, then:

- Before the candle fetch (`let bars = await fetchBars(...)`, line 279):

```tsx
      progressStageSignal.set("downloading");
      let bars = await fetchBars(resolveHistoryStart(effCfg, windowFromMs, resSeconds));
```

- WFO branch: before `runWalkForward(...)` (line 410) set the submit label, and clear it on the first state callback. Set:

```tsx
        progressStageSignal.set(sweepTargetSignal.value === "remote" ? "uploading" : "submitting");
```

  and inside the existing `onState` callback (line 417), clear it so the phase/count bar takes over:

```tsx
            onState: (st) => {
              if (ctl.signal.aborted) return;
              progressStageSignal.set(null);
              wfoStateSignal.set(st);
            },
```

- Sweep branch: before `runSweep(...)` (line 472) set the submit label:

```tsx
        progressStageSignal.set(sweepTargetSignal.value === "remote" ? "uploading" : "submitting");
```

  and inside the existing `onRows` callback (line 482), clear it:

```tsx
            onRows: (chunkRows, done, total, etaSeconds) => {
              if (ctl.signal.aborted) return;
              progressStageSignal.set(null);
              landed.push(...chunkRows);
              sweepStateSignal.set({ rows: landed, done, total, running: true, etaSeconds, startedAt: runStart });
            },
```

- Single-run branch: before `runAndRender(...)` (line 528) set the engine label:

```tsx
      progressStageSignal.set("engine");
      const res = await runAndRender(
```

- Shared cleanup: in the outer `finally` (line 567-569), clear it alongside the running reset:

```tsx
    } finally {
      backtestRunningSignal.set(false);
      progressStageSignal.set(null);
    }
```

Do NOT change `runAndRender` or `runBacktest` — the backtest POST stays synchronous; "Running backtest" simply shows for its duration and clears in the finally.

- [ ] **Step 7: Typecheck + tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/lib/progressLabels.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/progressLabels.ts frontend/src/lib/progressLabels.test.ts frontend/src/lib/signals.ts frontend/src/BacktestButton.tsx
git commit -m "feat(progress): stall-window stage signal + labels, wired into run handler"
```

---

### Task 2: Render the label in the three result panels

**Files:**
- Modify: `frontend/src/BacktestPanel.tsx` (running-state placeholder, line 159)
- Modify: `frontend/src/SweepResults.tsx` (empty/running state, where the sweep panel body renders before rows land)
- Modify: `frontend/src/WfoResults.tsx` (running state, near the existing progress block line 198)

**Interfaces:**
- Consumes: `stageLabel` (Task 1), `progressStageSignal` (Task 1).

- [ ] **Step 1: Backtest panel — show the label while running**

In `frontend/src/BacktestPanel.tsx`, subscribe to `progressStageSignal` with the same `useSyncExternalStore` pattern used for `backtestRunningSignal` (line 64), import `stageLabel`, and update the placeholder at line 159:

```tsx
  const stage = useSyncExternalStore(
    (cb) => progressStageSignal.subscribe(cb),
    () => progressStageSignal.value,
  );
  // ... at line 159:
          {running
            ? (stageLabel(stage) || "Backtest running…")
            : "Run a backtest to see results here."}
```

- [ ] **Step 2: Sweep panel — show the label during the download/submit stall**

In `frontend/src/SweepResults.tsx`, subscribe to `progressStageSignal` (same `useSyncExternalStore` pattern; import `stageLabel` and `progressStageSignal`). When a stage label is present and no rows have landed yet (the count bar is not moving), render the label in the panel's running/empty area, above the `SweepProgress` bar. Concretely, at the top of the results body:

```tsx
  const stage = useSyncExternalStore(
    (cb) => progressStageSignal.subscribe(cb),
    () => progressStageSignal.value,
  );
  // ... in the running/empty render, before the count bar:
  {stageLabel(stage) && (
    <div className="sweep-progress"><span>{stageLabel(stage)}</span></div>
  )}
```

Place this where the panel already renders while running (near the existing `SweepProgress` usage). Once the first poll clears `progressStageSignal` (Task 1), this line disappears and the moving count bar shows.

- [ ] **Step 3: WFO panel — show the label during the download/submit stall**

In `frontend/src/WfoResults.tsx`, subscribe to `progressStageSignal` (same pattern; import `stageLabel`, `progressStageSignal`). Just above the existing `state.running` progress block (line 198), render the stall label when present:

```tsx
      {stageLabel(stage) && (
        <div className="sweep-progress"><span>{stageLabel(stage)}</span></div>
      )}
      {state.running && (
        <div className="sweep-progress">
          <span>{PHASE_LABEL[state.phase] ?? state.phase}</span>
          {/* ...existing... */}
```

Once the first poll clears `progressStageSignal`, only the existing phase/count block shows.

- [ ] **Step 4: Typecheck + all frontend tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src`
Expected: PASS

- [ ] **Step 5: End-to-end verification (use the `run` / `verify` skill)**

Launch the app (do not kill the user's HMR dev servers; close any browser tabs you open) and drive each flow:
- **Backtest:** click Run over a wide range, confirm "Downloading candles" then "Running backtest" appear, then results render and the label clears.
- **Sweep:** confirm "Downloading candles" then "Submitting" (or "Uploading to compute host" on a remote run) appear, then the label clears and the count bar moves.
- **WFO:** same opening labels, then the existing phase label + count bar take over.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/BacktestPanel.tsx frontend/src/SweepResults.tsx frontend/src/WfoResults.tsx
git commit -m "feat(progress): render stall-window label in backtest/sweep/WFO panels"
```

---

## Self-Review

**Spec coverage:** Four stall-window labels → Task 1 vocabulary. Signal + set/clear at download/submit/engine and clear-on-first-poll → Task 1 handler wiring. Distinct remote label (`uploading`) → Task 1 (per `sweepTargetSignal`). Render in all three panels → Task 2. No backend changes → respected (no backend files touched). Tests → Task 1 unit + Task 2 e2e. All spec sections map to a task.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Each code step shows the code. The one lookup ("where the sweep panel renders while running") is anchored to the existing `SweepProgress` usage.

**Type consistency:** `stage` is `string | null` end to end. `stageLabel` (Task 1) returns `string`, consumed in Task 2. `progressStageSignal` (Task 1) is read via `useSyncExternalStore` in every Task 2 file. The four keys in `LABELS` are exactly the strings set in the Task 1 handler wiring (`downloading`, `submitting`, `uploading`, `engine`).

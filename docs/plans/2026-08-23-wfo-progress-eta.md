# Walk-Forward Progress Bar: Elapsed + Live ETA Readout

> **For agentic workers:** Implement task-by-task using checkbox (`- [ ]`) tracking. Run targeted test files only.

**Goal:** Render the elapsed / "~eta left" timing readout on the walk-forward progress bar (parity with the sweep bar), reusing `fmtRunDuration` / `remainingEta` via a shared component.

## Background / findings (from review, 2026-08-23)

- **Where WFO's `startedAt` actually comes from:** the seed at
  `frontend/src/BacktestButton.tsx:669` only covers the pre-poll state. From the
  first poll onward, `runWalkForward` overwrites it with its own
  `const startedAt = Date.now()` (`frontend/src/lib/wfo.ts:382`), captured AFTER
  `submitWfoJob` resolves, via `pollWfoToCompletion` → `buildWfoState`
  (`lib/wfo.ts:292-311`) → `onState` → `wfoStateSignal.set`. So `lib/wfo.ts:382`
  is the authoritative line; changing only BacktestButton reaches nothing on
  screen after the first poll (~700ms in).
- **Clock inconsistency:** sweeps seed `performance.now()`
  (`BacktestButton.tsx:230`); WFO uses `Date.now()` (`BacktestButton.tsx:669`
  AND `lib/wfo.ts:382`). Once `<RunTiming>` computes
  `performance.now() - startedAt`, a `Date.now()`-based value renders as ≈
  `-1790000000.0s` through `fmtRunDuration`'s `s < 10` branch — for the whole run.
- **Why not just flip `lib/wfo.ts:382` to `performance.now()`:** that fixes the
  sign but makes elapsed jump BACKWARD when the first poll lands — 382 is
  captured after `submitWfoJob` resolves while `wfoRunStart`
  (`BacktestButton.tsx:665`, already present) is captured before. On
  `target: "remote"` that gap is seconds. Instead, thread the caller's timestamp
  through `runWalkForward`'s opts.
- **Re-attach is unaffected:** `resumeWfo`/`continueResumeWfo` call
  `pollWfoToCompletion` WITHOUT `startedAt` (`lib/wfo.ts:525,530`) → `undefined`
  → ETA-only rendering. Keep it that way.
- **Scope of breakage if unfixed:** only elapsed; the ETA half is self-consistent
  (syncRef.at and now are both `performance.now()` inside `<RunTiming>`).
- The behavior to replicate lives in `SweepProgress`
  (`frontend/src/SweepResults.tsx:316-335`): own 1s interval tick, distinct-ETA
  sync ref (re-sync client clock when the polled eta value CHANGES), elapsed =
  `fmtRunDuration(now - startedAt)`, eta = `~{fmtRunDuration(remainingEta(...)*1000)} left`,
  parts joined `" · "` and hidden while absent. CSS `.sweep-progress-timing`
  exists (`App.css:5568-5571`) and is reusable for the WFO row.
- No backend changes required.

## Global Constraints

- Frontend-only change. Backend files untouched.
- `lib/wfo.ts` may change ONLY inside `runWalkForward` (its opts type + the
  `startedAt` capture at L382). Do NOT touch `buildWfoState`,
  `pollWfoToCompletion`, `wfoCatchState`, or the resume paths.
- All `startedAt` values are `performance.now()`-clock. No `Date.now()` may remain
  in any WFO `startedAt` code path (pre-poll seed, runWalkForward default, caller).
- Re-attached runs keep passing NO `startedAt` → `undefined` → ETA-only rendering
  (matches sweep convention).
- `etaSeconds == null` (before first combo lands) → omit the eta part entirely.
- The 1s tick must live inside the new component so per-second re-renders never
  touch `WfoResults`' tables or `SweepResults`' results tree.
- `wfoCatchState` carries `startedAt` only into `running: false` states where
  `<RunTiming>` is not mounted — leave as-is.
- Frontend test baseline may not be fully green on main (known failures exist);
  run targeted vitest files, never "fix" unrelated failures.
- Commands: `cd frontend && npx vitest run <file>`; lint: `npm run lint`.

---

### Task 1: Create shared `<RunTiming>` component

**Files:**
- Create: `frontend/src/components/RunTiming.tsx`

**Interfaces:**
```ts
export function RunTiming(props: {
  etaSeconds?: number | null;
  startedAt?: number;
  className?: string;
}): JSX.Element | null
```

- [ ] **Step 1:** Extract the logic verbatim from `SweepProgress`
      (`SweepResults.tsx:317-335`): `useState(0)` + `setInterval(…, 1000)` tick,
      distinct-value sync ref keyed on `progress.etaSeconds`, `performance.now()`
      reads, `fmtRunDuration`/`remainingEta` from `../lib/duration`.
- [ ] **Step 2:** Render `[elapsed, eta].filter(Boolean).join(" · ")` inside
      `<span className={className}>`; return `null` when both parts are empty
      (caller then renders nothing).

### Task 2: Thread `wfoRunStart` through to the streamed states

**Files:**
- Modify: `frontend/src/lib/wfo.ts` (ONLY `runWalkForward`: opts type ~L369-375, capture ~L382)
- Modify: `frontend/src/BacktestButton.tsx` (~L669 seed, ~L672 call site)

- [ ] **Step 1:** Add `startedAt?: number` to `runWalkForward`'s opts. Replace
      `const startedAt = Date.now();` (L382) with
      `const startedAt = opts.startedAt ?? performance.now();` — comment why the
      fallback exists (re-attach-free direct calls/tests) and why the caller's
      timestamp wins (submit gap must not rewind elapsed).
- [ ] **Step 2:** In `BacktestButton.tsx`, seed the pre-poll state (L669) with
      `startedAt: wfoRunStart` instead of `Date.now()`, and pass
      `startedAt: wfoRunStart` into the `runWalkForward(...)` call (L672) so the
      polled states share the exact same origin as the seed and `wfoDurationSignal`.

### Task 3: Wire into WFO render + delegate sweep timing

**Files:**
- Modify: `frontend/src/WfoResults.tsx` (~L267-278, running block)
- Modify: `frontend/src/SweepResults.tsx` (~L316-348)

- [ ] **Step 1:** In the running block, append
      `{<RunTiming etaSeconds={state.etaSeconds} startedAt={state.startedAt} className="sweep-progress-timing" />}`
      after the fill-bar div (reuses the sweep row's CSS).
- [ ] **Step 2:** In `SweepProgress`, replace the inline tick/sync/format logic
      with `<RunTiming etaSeconds={progress.etaSeconds} startedAt={progress.startedAt} className="sweep-progress-timing" />`.
      Keep the outer `.sweep-progress` layout unchanged; rendered output must stay
      identical. (`useState/useEffect/useRef` remain used elsewhere in the file.)

### Task 4: Tests

**Files:**
- Modify: `frontend/src/WfoResults.test.tsx`
- Modify: `frontend/src/lib/wfoRun.test.ts`

- [ ] **Step 1 (seam, wfoRun.test.ts):** pass `startedAt: T` (any fixed number)
      to `runWalkForward` in the existing happy-path test; assert EVERY state
      streamed through `onState` has `startedAt === T` — regression guard against
      wfo.ts recapturing its own clock.
- [ ] **Step 2 (clock, wfoRun.test.ts):** without `opts.startedAt`, the streamed
      `startedAt` is defined and NOT epoch-scaled
      (`expect(st.startedAt).toBeLessThan(1e12)` — catches a `Date.now()`
      regression, since epoch ms ≈ 1.75e12 vs performance ms ≈ small).
- [ ] **Step 3 (re-attach, wfoRun.test.ts):** in the `resumeWfo` flow, streamed
      states carry `startedAt === undefined` (ETA-only contract preserved).
- [ ] **Step 4 (render, WfoResults.test.tsx):** hand-built running state with
      `startedAt` + numeric `etaSeconds` renders elapsed and "~… left"
      (mock `performance.now`); without `startedAt` → ETA only; `etaSeconds: null`
      → no "~… left".
- [ ] **Step 5:** Existing suites stay green: `wfoRun.test.ts`, `wfoApi.test.ts`,
      `duration.test.ts`, `SweepResults`-touching sweep tests.

## Verification

```
cd frontend && npx vitest run src/lib/wfoRun.test.ts src/WfoResults.test.tsx src/lib/wfoApi.test.ts src/lib/duration.test.ts
cd frontend && npm run lint
```

Manual: start a walk-forward run — bar shows phase label, `done / total`, and
`elapsed · ~eta left` ticking between polls, with NO backward jump when polling
begins (exercise a remote target if available); reload mid-run → re-attach shows
ETA only.

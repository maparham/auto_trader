# Progress feedback for backtest, sweep, and walk-forward

**Date:** 2026-07-20
**Status:** Approved design, pending implementation plan

## Goal

Backtest, sweep, and walk-forward optimization (WFO) should each show, at any
moment, a human-readable line describing what they are doing right now — e.g.
"Downloading candles", "Fetching higher-timeframe data", "Running backtest",
"Testing fold 2/5". Today:

- **Backtest** is one blocking POST with an empty running pane — zero feedback.
- **Sweep** is opaque during prep + submit (HTF prefetch + probe run), then
  count-only (no phase label).
- **WFO** shows "evaluating grid 0/0" *during* prep/submit (mislabeled), then a
  coarse phase; no per-fold granularity.

## Constraints from the codebase

- Sweep and WFO already use an **in-memory job + 700ms cursor-poll** model
  (`sweep_jobs.py`, `wfo_jobs.py`); combos run in a `ProcessPoolExecutor` behind
  an instance-level FIFO `Semaphore(1)` gate. No WebSocket/SSE anywhere.
- The prep steps to label "Downloading candles" / "Preparing indicators" live in
  the **shared** region of `BacktestButton.tsx` (`fetchBars` → then
  `buildChartOperandSeries`), above where the three run branches diverge.
- WFO already carries a `phase` enum (`grid|test|aggregate|done`) that the
  results view keys off for control flow; sweep has only `done/total/etaSeconds`;
  backtest has only a boolean `running`.
- Remote (`?target=remote`) forwards submit/poll/cancel verbatim to an EC2 host
  via `compute.forward()`; any new JSON field rides through automatically.
- `backend-owns-business-logic`: label existing frontend prep steps, but do not
  add new backend→frontend round-trips purely to feed labels.

## Approved decisions

1. **Backtest reports backend sub-steps** — it becomes a lightweight in-memory
   polled job (like sweep/WFO) with a `stage` string and a **Cancel** button.
   No reload/re-attach/resume (single runs are short).
2. **Backtest executes in a daemon thread** (not a process pool). The label is
   set before each CPU step, so the UI shows the correct label while the step
   churns; polls resolve at the GIL switch interval. No pickling.
3. **Sweep/WFO submit-time HTF-prefetch + probe move into the job thread** so
   that previously-blind window reports `htf`/`probe` stages. Fast,
   request-shaped validation (combo targets, series presence) **stays
   synchronous at submit** and still 422s. A probe/HTF-fetch failure now
   surfaces as a **job-error state** instead of a synchronous 422 — accepted.
4. **Remote runs get distinct labels** ("Uploading to compute host", plus the
   existing host start/boot states); local runs say "Submitting".

## Unified stage vocabulary

One shared label map on the frontend (replaces WFO's `PHASE_LABEL`), consumed by
all three panels:

| stage key      | label                          | driven by |
|----------------|--------------------------------|-----------|
| `downloading`  | Downloading candles            | frontend  |
| `indicators`   | Preparing indicators           | frontend  |
| `submitting`   | Submitting                     | frontend  |
| `uploading`    | Uploading to compute host      | frontend (remote) |
| `queued`       | Waiting for a free slot        | backend   |
| `htf`          | Fetching higher-timeframe data | backend   |
| `probe`        | Running a probe                | backend   |
| `engine`       | Running backtest               | backend   |
| `cost`         | Testing cost sensitivity       | backend   |
| `enrich`       | Finalizing                     | backend   |
| `saving`       | Saving                         | backend   |
| `grid`         | Evaluating grid                | backend   |
| `test`         | Testing fold N/M               | backend   |
| `aggregate`    | Aggregating                    | backend   |

Frontend-driven stages are set in the shared prep region of `BacktestButton.tsx`
before the branches diverge, so all three operations share the same
"Downloading candles" / "Preparing indicators" / "Submitting|Uploading" opening.
Backend-driven stages are carried on the existing poll response.

## Per-operation flow

**Backtest:** `downloading → indicators → submitting → htf → engine → cost →
enrich → saving → done(result)`. Cancel checked between steps, notably before
each of the 4 cost-sensitivity re-runs.

**Sweep:** `downloading → indicators → submitting|uploading → queued → htf →
probe (coded only) → grid/"Running combos" (done/total) → done`.

**WFO:** `downloading → indicators → submitting|uploading → queued → htf →
probe (coded only) → grid (combo done/total) → test (per-fold "Testing fold
N/M") → aggregate → done`. Keep `phase` for the results-view control flow; add
`stage` as the human label.

## Backend changes

- **`schemas.py`**: add `stage: str | None` to `SweepJobStatusResponse` and
  `WfoJobStatusResponse`. New `BacktestJobSubmitResponse{jobId}` and
  `BacktestJobStatusResponse{stage, running, cancelled, error, result}`
  (`result` is the existing `BacktestResponse`, present only when done).
- **New `backtest_jobs.py`**: `BacktestJobManager` + `BACKTEST_JOBS` singleton,
  mirroring `sweep_jobs.py` but without the pool/rows/archive. A `BacktestJob`
  dataclass holds `job_id, stage, running, cancelled, error, result,
  created_at, finished_at`. `submit()` starts a daemon thread that runs the
  refactored backtest core with a `set_stage` callback; `get`, `cancel`, and a
  TTL prune (1h, from completion) match the sweep manager.
- **Refactor `backtest()` handler**: extract the execution body (HTF fetch,
  engine run, cost sensitivity, enrichment, run-store save, response build) into
  a callable that accepts `set_stage` and a `is_cancelled` predicate. The
  synchronous validation block stays in the route. New routes:
  `POST /api/backtest/jobs` (submit, returns `jobId` after validation),
  `GET /api/backtest/jobs/{job_id}` (poll), `POST .../{job_id}/cancel`. Each
  route honors `?target=remote` via `compute.forward()` like the sweep routes.
  The existing synchronous `POST /api/backtest` may remain for any non-UI
  caller, or be removed if unused — decide during planning (check callers).
- **`sweep_jobs.py`**: add `stage` to `SweepJob`; set `queued` before the gate,
  then run HTF-prefetch + probe (moved from the route) inside `_run` as
  `htf`/`probe`, then `grid` while the pool loop advances. Expose `stage` in the
  status route. Keep the fast synchronous validation in `submit_sweep_job`.
- **`wfo_jobs.py`**: add `stage` to `WfoJob`; set `queued`, `htf`, `probe`
  (moved from the route), then per-phase stages; in the test loop set
  `stage = f"Testing fold {i}/{n}"`. Keep `phase` for control flow. Expose
  `stage` in the status route.
- **`backtest.py` route module**: move the sweep/WFO probe + HTF-prefetch calls
  out of `submit_sweep_job`/`submit_wfo_job` into the job managers; keep
  validation. Wire the new backtest job routes.

## Frontend changes

- **New `lib/progressLabels.ts`**: the stage→label vocabulary above, plus a
  helper that renders `test` with its `N/M` detail. Replaces
  `WfoResults.tsx`'s local `PHASE_LABEL`.
- **`api.ts`**: `submitBacktestJob` / `pollBacktestJob` / `cancelBacktestJob`
  (with `target`), and parse the new `stage` field on sweep/WFO polls.
- **New `lib/backtestJob.ts`**: `runBacktestJob(baseReq, opts)` — submit, then
  poll to completion (reusing the sweep/WFO poll cadence), driving a stage
  callback and returning the final `BacktestResponse`. Mirrors `lib/sweep.ts`'s
  `pollToCompletion`.
- **`BacktestButton.tsx`**: introduce a `progressStageSignal`. In the shared
  prep region set `downloading` (around `fetchBars`) then `indicators` (around
  `buildChartOperandSeries`); set `submitting` or `uploading` per
  `sweepTargetSignal` just before each submit. The single-run branch swaps the
  one blocking `runAndRender` POST for `runBacktestJob` (driving the signal via
  its stage callback), then renders the returned result through the existing
  render path. Add a Cancel wired to `cancelBacktestJob` + an `AbortController`,
  matching the sweep/WFO cancel plumbing.
- **UI**: reuse `.sweep-progress`. Backtest shows the stage label + an
  indeterminate bar (no count for a single run) in the pane's running state.
  `SweepResults.tsx` gains the stage label above its `done/total` count.
  `WfoResults.tsx` switches to the shared labels and shows the fold detail.
- Follow `CLAUDE.md`: any info affordance uses the shared `Tooltip`/`InfoTip`,
  not native `title=`. No em dashes in end-user copy.

## Testing

- **Backend**: assert the stage sequence per operation by monkeypatching the
  engine/fetch to record `set_stage` transitions. Backtest job: submit → poll →
  done returns the result; cancel mid-run stops before the next step; error path
  sets `error` and clears `running`. Sweep/WFO: `queued`/`htf`/`probe` appear;
  probe/HTF failure yields a job-error state (not a 422); fast validation still
  422s at submit. Follow `wfoApi.test`/`sweep.test` patterns.
- **Frontend**: label-map unit tests (incl. `test` N/M formatting and
  local-vs-remote submit label); `runBacktestJob` poll-loop test with mocked
  fetch, mirroring `sweep.test.ts` / `wfo.test.ts`.

## Risks / notes

- Backtest daemon thread holds the GIL during pure-Python CPU sections; polls
  resolve at the interpreter switch interval. Labels are set at step boundaries,
  so the correct label is already showing before a CPU step blocks. Acceptable
  for progress display; revisit only if polls visibly stall.
- Moving probe/HTF into the job thread changes sweep/WFO submit failure timing
  from a synchronous 422 to a job-error state (decision 3). The frontend already
  renders job-error state; ensure its copy reads sensibly for these cases.
- `phase` stays on the WFO job for control flow; `stage` is additive.
- Do not add backend round-trips solely to feed labels; frontend prep labels are
  set client-side from steps that already run there.

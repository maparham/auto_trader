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

## Hard constraint discovered

`CANDLE_CACHE` is a module singleton (`candle_cache.py:625`) whose per-key
`asyncio.Lock`s (`candle_cache.py:70,92`) bind to the **server's event loop** on
first use. Therefore **any candle fetch must run on the server event loop** — a
job thread with its own `asyncio.run()` loop would raise "lock bound to a
different event loop." This shapes decisions 2 and 3 below.

## Approved decisions

1. **Backtest reports backend sub-steps** — it becomes a lightweight in-memory
   polled job with a `stage` string and a **Cancel** button. No
   reload/re-attach/resume (single runs are short).
2. **Backtest executes as an asyncio background task on the server loop** (not a
   thread, not a process pool — the cache constraint above). Submit does the
   fast synchronous validation, starts the task, returns `jobId`. The task runs
   the refactored backtest core, setting `stage` before each step. The engine's
   CPU blocks the loop only as the current synchronous POST already does; the
   label is set before the block, and the `await`s between the 4 cost-sensitivity
   re-runs let polls through. No pickling.
3. **Sweep/WFO keep HTF-prefetch + probe on the async submit route** (they fetch,
   so they must stay on the loop). The frontend `submitting`/`uploading` label —
   already shown for the whole submit POST — covers that window. This
   **preserves the synchronous 422** on a probe/HTF failure. Backend `stage`
   then covers only the pool phases (sweep: "Running combos"; WFO: grid → test
   "Testing fold N/M" → aggregate). No separate "queued" stage — a job waiting on
   the FIFO gate keeps showing the last frontend label until the pool starts.
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
| `htf`          | Fetching higher-timeframe data | backend (backtest) |
| `engine`       | Running backtest               | backend (backtest) |
| `cost`         | Testing cost sensitivity       | backend (backtest) |
| `enrich`       | Finalizing                     | backend (backtest) |
| `saving`       | Saving                         | backend (backtest) |
| `grid`         | Running combos / Evaluating grid | backend (sweep/WFO) |
| `test`         | Testing fold N/M               | backend (WFO) |
| `aggregate`    | Aggregating                    | backend (WFO) |

Frontend-driven stages are set in the shared prep region of `BacktestButton.tsx`
before the branches diverge, so all three operations share the same
"Downloading candles" / "Preparing indicators" / "Submitting|Uploading" opening.
`htf`/`engine`/`cost`/`enrich`/`saving` are polled from the **backtest** job
(which runs on the loop under polling). Sweep/WFO fetch+probe happen inside the
submit POST, so `submitting`/`uploading` covers them; their poll then reports the
pool-phase stages. There is no `queued` stage (decision 3).

## Per-operation flow

**Backtest:** `downloading → indicators → submitting → [job: htf → engine →
cost → enrich → saving] → done(result)`. The bracketed stages are polled from
the job. Cancel checked between steps, notably before each of the 4
cost-sensitivity re-runs.

**Sweep:** `downloading → indicators → submitting|uploading (covers route-side
fetch+probe) → [job: grid/"Running combos" (done/total)] → done`.

**WFO:** `downloading → indicators → submitting|uploading (covers route-side
fetch+probe) → [job: grid (combo done/total) → test (per-fold "Testing fold
N/M") → aggregate] → done`. Keep `phase` for the results-view control flow; add
`stage` as the human label.

## Backend changes

- **`schemas.py`**: add `stage: str | None` to `SweepJobStatusResponse` and
  `WfoJobStatusResponse`. New `BacktestJobSubmitResponse{jobId}` and
  `BacktestJobStatusResponse{stage, running, cancelled, error, result}`
  (`result` is the existing `BacktestResponse`, present only when done).
- **New `backtest_jobs.py`**: `BacktestJobManager` + `BACKTEST_JOBS` singleton.
  A `BacktestJob` dataclass holds `job_id, stage, running, cancelled, error,
  result, created_at, finished_at`. `submit(coro_factory)` calls
  `asyncio.create_task(...)` on the running loop to execute the async backtest
  core (passed a `set_stage` callback and reading `job.cancelled`); `get`,
  `cancel` (sets the flag), and a TTL prune (1h from completion) mirror the
  sweep manager. No thread, no pool.
- **Refactor `backtest()` handler**: extract the execution body (HTF fetch,
  engine run, cost sensitivity, enrichment, run-store save, response build) into
  an **async** `run_backtest_core(req, set_stage, is_cancelled) ->
  BacktestResponse` that sets stage `htf → engine → cost → enrich → saving` and
  checks `is_cancelled()` before each cost-sensitivity re-run. The synchronous
  validation block stays in the route. New routes:
  `POST /api/backtest/jobs` (validate, start task, return `jobId`),
  `GET /api/backtest/jobs/{job_id}` (poll → `BacktestJobStatusResponse`),
  `POST .../{job_id}/cancel`. Each honors `?target=remote` via
  `compute.forward()` like the sweep routes. Keep the existing synchronous
  `POST /api/backtest` (its callers/tests still use it); the UI switches to the
  job route.
- **`sweep_jobs.py`**: add `stage: str = "grid"` to `SweepJob`; the existing
  `_run` thread already computes only the pool loop, so `stage` stays "grid"
  (label "Running combos") for its lifetime. Expose `stage` in the status route.
  HTF-prefetch + probe stay in `submit_sweep_job` (unchanged).
- **`wfo_jobs.py`**: add `stage: str` to `WfoJob`, kept in lockstep with the
  existing phase transitions (`grid` at start, `aggregate` at phase 3); in the
  test-phase loop set `stage = f"Testing fold {i}/{n}"` as each fold runs. Keep
  `phase` for control flow. Expose `stage` in the status route. HTF-prefetch +
  probe stay in `submit_wfo_job` (unchanged).
- **`backtest.py` route module**: add `stage=job.stage` to the sweep/WFO status
  responses; wire the new backtest job routes. Sweep/WFO submit routes are
  otherwise unchanged (fetch+probe stay put).

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
  sets `error` and clears `running`. Sweep: status carries `stage="grid"`. WFO:
  `stage` advances `grid → "Testing fold N/M" → aggregate` in lockstep with
  `phase`; the existing submit 422s are unchanged. Follow the `test_sweep_jobs`,
  `test_wfo_jobs`, and `test_api_wfo` patterns.
- **Frontend**: label-map unit tests (incl. `test` N/M formatting and
  local-vs-remote submit label); `runBacktestJob` poll-loop test with mocked
  fetch, mirroring `sweep.test.ts` / `wfo.test.ts`.

## Risks / notes

- The backtest job runs as an asyncio task on the server loop. Its engine step
  is CPU-bound and blocks the loop exactly as the current synchronous POST does;
  the stage label is set before the block, and the `await`s between the 4
  cost-sensitivity re-runs let concurrent polls resolve. Acceptable for progress
  display; the run is short.
- Candle fetches must stay on the server loop (shared loop-bound cache locks) —
  never introduce a job thread that fetches. This is why sweep/WFO fetch+probe
  stay on the submit route and backtest runs as a loop task, not a thread.
- Sweep/WFO submit keeps its synchronous 422s (fetch+probe unchanged). The
  frontend `submitting`/`uploading` label covers that window.
- `phase` stays on the WFO job for control flow; `stage` is additive.
- Do not add backend round-trips solely to feed labels; frontend prep labels are
  set client-side from steps that already run there.

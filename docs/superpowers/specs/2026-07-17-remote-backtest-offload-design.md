# Remote backtest offload — design

Date: 2026-07-17
Status: approved

## Goal

Let a single backtest run (Backtest mode, not Sweep) optionally execute on the
remote Fly compute host, the same way sweeps already can. The user picks
Local/Remote; results render and persist exactly as a local run does today.

## Background

- The remote host is a byte-identical copy of the backend behind
  `compute.forward()` (`backend/auto_trader/api/routers/compute.py`), which
  relays any method/path with a bearer token. `/api/backtest` is not in
  `DEALING_PATHS`, so a `COMPUTE_ONLY` host already permits it.
- Sweeps use a submit/poll/cancel job API (`sweep_jobs.py`,
  `routers/backtest.py` job handlers) with `target=local|remote` on each
  endpoint; the frontend toggle is `sweepTargetSignal`
  (`frontend/src/lib/signals.ts`).
- A single backtest today is synchronous: `runBacktest()` in
  `frontend/src/api.ts` POSTs `/api/backtest`; the handler runs the engine
  in-request, does cost-sensitivity re-runs, exit-time/what-if enrichment, and
  persists to `RUN_STORE`.

Decision: use the job/poll pattern (not a synchronous forward) so remote runs
get cancel and resilience to Fly cold starts, matching sweeps.

## Design

### 1. Backend job API for single runs

New endpoints on the backtest router, mirroring the sweep job handlers:

- `POST /api/backtest/jobs` — validate request, submit a job, return
  `{ jobId }`.
- `GET /api/backtest/jobs/{job_id}` — status (`running | done | error |
  cancelled`); when `done`, includes the complete backtest result payload
  (identical shape to the synchronous `/api/backtest` response).
- `POST /api/backtest/jobs/{job_id}/cancel` — request cancellation.

Each endpoint takes `target: str = "local"`; when `target == "remote"` the
handler relays the request verbatim via `compute.forward()`, exactly like
`submit_sweep_job` / `sweep_job_status` / `cancel_sweep_job`.

Execution: a job runs the existing single-run path — the same code the
synchronous handler uses today (`_run_rule` / `_run_coded`, cost-sensitivity
re-runs, exit-time and what-if enrichment) — in a background thread. No
process pool: one run is one unit of work. Factor the body of the current
`backtest()` handler into a shared function so the synchronous endpoint and
the job path cannot drift. Cancellation is a cooperative flag checked between
phases (main run, cost-sensitivity re-runs, enrichment); a cancelled job
returns `cancelled` and discards partial work.

Job management reuses the `SweepJobManager` shape — either a small generic
job manager or a second manager instance dedicated to backtest jobs. Jobs are
in-memory, single-flight is NOT required (unlike sweeps, a single run is
cheap enough to overlap), and finished jobs are pruned like sweep jobs are.

### 2. Persistence stays local

The job execution path skips `RUN_STORE.insert` (a `persist` flag on the
shared run function, false for job runs). The full result travels back to the
frontend, which persists it through the local backend exactly as a local
synchronous run's result is stored today. The remote host's DB stays
throwaway.

HTF and intra-bar minute fetches during the run use the executing host's own
candle cache and broker config — same as sweeps today. Acceptable: the remote
host has working broker data access.

The synchronous `/api/backtest` endpoint keeps persisting as it does now;
local runs are unchanged.

### 3. Frontend

- `api.ts`: add `submitBacktestJob(req, target)`, `pollBacktestJob(id,
  target)`, `cancelBacktestJob(id, target)` mirroring the sweep job
  functions (`?target=remote` query param).
- A poll loop akin to `runSweep()` in `lib/sweep.ts` — submit, poll until
  terminal, return the result object. `BacktestButton.run()`'s single-run
  branch uses it when the target is remote; when local it keeps calling the
  existing synchronous `runBacktest()` (no behavior change for local runs).
- Toggle: the existing Local/Remote control in `BacktestSettingsModal`
  (currently shown only in sweep mode with axes) also shows in Backtest mode
  whenever `remoteCompute` is configured. One shared signal drives both
  modes; rename `sweepTargetSignal` to `computeTargetSignal` (persistence key
  migrates accordingly — no back-compat shim, per project convention).
- Cancel wires into the existing run-cancel affordance for backtests; it
  calls `cancelBacktestJob` and stops the poll loop.
- Downstream is untouched: `runAndRender` receives the same result object a
  local run produces, so rendering, markers, and local persistence work as-is.

### 4. Errors

- Remote unreachable / forward failure / job error: surface via the same
  toast path sweep errors use. No automatic local fallback — the user flips
  the toggle back to Local and re-runs.
- A job that dies on the remote (host restart) is detected by poll returning
  404/unknown-job; treat as error with the same toast.

## Testing

- Backend: unit tests for the job lifecycle (submit → poll → done payload
  matches the synchronous endpoint's payload for the same request; cancel
  mid-run yields `cancelled`; `persist=false` skips `RUN_STORE`).
- Frontend: vitest for the poll loop (done, error, cancel paths) and for the
  toggle visibility in Backtest mode.
- Manual: run the same backtest Local and Remote against the deployed Fly
  host; results match and the run appears in local history both times.

## Out of scope

- Hybrid local+remote split (tracked separately for sweeps).
- Progress reporting within a single run (poll returns running/done only).
- Any change to sweep behavior.

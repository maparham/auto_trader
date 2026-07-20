# Progress Feedback (backtest / sweep / WFO) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live, human-readable "what is it doing right now" line for backtest, sweep, and walk-forward optimization (e.g. "Downloading candles", "Running backtest", "Testing fold 2/5").

**Architecture:** A shared stage vocabulary. Frontend-driven stages (`downloading`, `indicators`, `submitting`/`uploading`) are set in the shared prep region of `BacktestButton.tsx` before the three run branches diverge. Backend-driven stages ride the existing 700ms cursor-poll: sweep/WFO gain a `stage` string on their job + status DTO; backtest becomes a lightweight in-memory polled job (an asyncio task on the server loop) so its backend sub-steps become pollable. Candle fetches always stay on the server event loop (shared loop-bound cache locks), so backtest runs as a loop task (not a thread) and sweep/WFO keep their submit-time fetch+probe on the async route.

**Tech Stack:** Backend — Python 3.14, FastAPI, Pydantic, `asyncio`, in-memory job managers (existing `sweep_jobs.py` / `wfo_jobs.py` pattern), pytest. Frontend — React + TypeScript, a custom `Signal` class (`lib/signals.ts`), Vitest.

## Global Constraints

- No em dashes ("—" / "--") in end-user copy (labels, tooltips) or chat prose. Code, tests, commits are fine.
- Any info affordance uses the shared `Tooltip` / `InfoTip` components, never a native `title=`.
- Plain, direct copy — no "How much/far…" framing; audience is educated traders.
- Do not add backend→frontend round-trips solely to feed labels; frontend prep labels are set client-side from steps that already run there.
- Candle fetches (`deps._fetch_symbol_candles`, `CANDLE_CACHE`) must run on the server event loop; never introduce a job thread that fetches.
- Keep the existing synchronous `POST /api/backtest` route working — its tests and any non-UI callers still use it.
- WFO's `phase` field stays for control flow; `stage` is additive.

---

### Task 1: Sweep job `stage` field + status DTO

**Files:**
- Modify: `backend/auto_trader/api/sweep_jobs.py` (add `stage` to `SweepJob`, ~line 34-50)
- Modify: `backend/auto_trader/api/schemas.py` (add `stage` to `SweepJobStatusResponse`, ~line 580)
- Modify: `backend/auto_trader/api/routers/backtest.py` (set `stage` in `sweep_job_status`, ~line 766)
- Test: `backend/tests/test_sweep_jobs.py`

**Interfaces:**
- Produces: `SweepJob.stage: str` (default `"grid"`); `SweepJobStatusResponse.stage: str | None`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_sweep_jobs.py`:

```python
def test_job_reports_grid_stage(strat_dir):
    mgr = SweepJobManager()
    job = submit(mgr, strat_dir, COMBOS)
    assert job.stage == "grid"
    wait(job)
    assert job.stage == "grid"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_sweep_jobs.py::test_job_reports_grid_stage -v`
Expected: FAIL with `AttributeError: 'SweepJob' object has no attribute 'stage'`

- [ ] **Step 3: Add the field**

In `backend/auto_trader/api/sweep_jobs.py`, inside the `SweepJob` dataclass (after `eta_seconds`, before `created_at`):

```python
    eta_seconds: float | None = None
    # Human-readable pool-phase label for the progress UI. The sweep job runs a
    # single phase (the combo pool loop); submit-time fetch+probe are covered by
    # the frontend "Submitting" label, so this stays "grid" ("Running combos").
    stage: str = "grid"
    created_at: float = 0.0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_sweep_jobs.py::test_job_reports_grid_stage -v`
Expected: PASS

- [ ] **Step 5: Expose `stage` in the status DTO**

In `backend/auto_trader/api/schemas.py`, in `SweepJobStatusResponse` (after `etaSeconds`):

```python
    etaSeconds: float | None = None
    stage: str | None = None            # pool-phase label, e.g. "grid"
```

- [ ] **Step 6: Set it in the status route**

In `backend/auto_trader/api/routers/backtest.py`, in `sweep_job_status`, add `stage=job.stage` to the `SweepJobStatusResponse(...)` construction:

```python
    return SweepJobStatusResponse(
        rows=job.rows[cursor:],
        done=job.done,
        total=job.total,
        running=job.running,
        cancelled=job.cancelled,
        error=job.error,
        etaSeconds=job.eta_seconds,
        stage=job.stage,
    )
```

- [ ] **Step 7: Run the sweep API + job tests**

Run: `cd backend && python -m pytest tests/test_sweep_jobs.py tests/test_api_backtest_sweep.py -q`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/api/sweep_jobs.py backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_sweep_jobs.py
git commit -m "feat(progress): sweep job stage field + status DTO"
```

---

### Task 2: WFO job `stage` field (grid / fold N/M / aggregate) + status DTO

**Files:**
- Modify: `backend/auto_trader/api/wfo_jobs.py` (add `stage` to `WfoJob` ~line 34-45; set it in `_run` at ~line 173, 181-215, 219)
- Modify: `backend/auto_trader/api/schemas.py` (add `stage` to `WfoJobStatusResponse` ~line 548)
- Modify: `backend/auto_trader/api/routers/backtest.py` (set `stage` in `wfo_job_status` ~line 1009)
- Test: `backend/tests/test_wfo_jobs.py`

**Interfaces:**
- Produces: `WfoJob.stage: str`; `WfoJobStatusResponse.stage: str | None`. Stage strings: `"grid"`, `f"Testing fold {i}/{n}"` (i is 1-based across all folds, n is the total fold count), `"aggregate"`.

- [ ] **Step 1: Read the current `_run` phase structure**

Read `backend/auto_trader/api/wfo_jobs.py` lines 143-236 to see the phase-1 grid loop, the phase-2 select+test loop (which already has fold indices), and phase-3 aggregate. Note the exact loop variables so the fold counter below matches them.

- [ ] **Step 2: Write the failing test**

Add to `backend/tests/test_wfo_jobs.py` (follow the existing submit/wait helpers in that file; reuse its fixture strategy). Model it on the existing "phase progresses" test if present:

```python
def test_wfo_stage_tracks_phases(strat_dir):
    mgr = WfoJobManager()
    job = submit_wfo(mgr, strat_dir)     # existing helper in this test module
    # stage starts on the grid phase
    assert job.stage == "grid"
    wait(job)
    # terminal stage is the aggregate label (job.phase == "done" by now)
    assert job.stage == "aggregate"
```

If `test_wfo_jobs.py` has no `submit_wfo`/`wait` helpers, copy the harness shape from `test_sweep_jobs.py` (a `submit_wfo` wrapper around `mgr.submit(...)` and a `wait(job)` poll loop on `job.running`).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_wfo_jobs.py::test_wfo_stage_tracks_phases -v`
Expected: FAIL with `AttributeError: 'WfoJob' object has no attribute 'stage'`

- [ ] **Step 4: Add the field**

In `backend/auto_trader/api/wfo_jobs.py`, in the `WfoJob` dataclass, next to `phase`:

```python
    phase: str = "grid"  # "grid" | "test" | "aggregate" | "done"
    # Human-readable label for the progress UI. Tracks phase but with per-fold
    # detail in the test phase ("Testing fold 2/5"). `phase` stays for control
    # flow; `stage` is display only.
    stage: str = "grid"
```

- [ ] **Step 5: Set `stage` through the phases**

In `_run`, keep `stage` in lockstep with `phase`:

- Phase 2 start (where `job.phase = "test"` is set, ~line 181): compute the total fold count once and set the first fold label. Inside the per-fold loop, before running each fold's test, set the running index. Using the existing loop (the plan's fold counter is 1-based and spans all schemes' folds):

```python
                # --- phase 2: select + test ---
                job.phase = "test"
                total_folds = sum(len(sc["folds"]) for sc in schemes)
                fold_i = 0
                for si, sc in enumerate(schemes):
                    for fi, f in enumerate(sc["folds"]):
                        fold_i += 1
                        job.stage = f"Testing fold {fold_i}/{total_folds}"
                        # ... existing per-fold select+test body unchanged ...
```

(Adjust the variable names to the real loop at lines 185+; the only additions are `total_folds`, `fold_i`, and the `job.stage = ...` line.)

- Phase 3 (where `job.phase = "aggregate"` is set, ~line 219): add right after it:

```python
                job.phase = "aggregate"
                job.stage = "aggregate"
```

`stage` is already `"grid"` from the default for phase 1, so no change is needed there. Do NOT set `stage` on the `"done"` transition — the terminal display uses the `result`, and the last meaningful label is "aggregate".

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_wfo_jobs.py::test_wfo_stage_tracks_phases -v`
Expected: PASS

- [ ] **Step 7: Expose `stage` in the status DTO + route**

In `backend/auto_trader/api/schemas.py`, `WfoJobStatusResponse` (after `etaSeconds`):

```python
    etaSeconds: float | None = None
    stage: str | None = None            # per-fold-aware label, e.g. "Testing fold 2/5"
```

In `backend/auto_trader/api/routers/backtest.py`, `wfo_job_status`, add `stage=job.stage` to the `WfoJobStatusResponse(...)` construction (alongside `phase=job.phase`).

- [ ] **Step 8: Run the WFO tests**

Run: `cd backend && python -m pytest tests/test_wfo_jobs.py tests/test_api_wfo.py -q`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/api/wfo_jobs.py backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_wfo_jobs.py
git commit -m "feat(progress): WFO job stage field with per-fold detail"
```

---

### Task 3: Extract `run_backtest_core` (async, stage-aware) — keep sync route green

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py` (extract the body of `backtest()` at lines 182-432 into an async helper; the route calls it)
- Test: `backend/tests/test_api_backtest.py` (regression only — must stay green)

**Interfaces:**
- Produces: `async def run_backtest_core(req: BacktestRequest, set_stage: Callable[[str], None], is_cancelled: Callable[[], bool]) -> BacktestResponse`. Stage strings it emits, in order: `"htf"`, `"engine"`, `"cost"` (only when cost-sensitivity runs), `"enrich"`, `"saving"`. `is_cancelled()` is checked before each cost-sensitivity re-run; when it returns True mid-run the function raises `BacktestCancelled` (defined in this task).

- [ ] **Step 1: Add a cancellation sentinel + helper signature**

In `backend/auto_trader/api/routers/backtest.py`, near the top (after imports):

```python
from collections.abc import Callable


class BacktestCancelled(Exception):
    """Raised by run_backtest_core when is_cancelled() flips mid-run."""
```

- [ ] **Step 2: Extract the core**

Move the execution body of `backtest()` (everything after the synchronous validation block — i.e. from `candles = [candle_from_dto(c) for c in req.candles]` at line 211 through the `return BacktestResponse(...)` at line 432) into:

```python
async def run_backtest_core(
    req: BacktestRequest,
    set_stage: Callable[[str], None],
    is_cancelled: Callable[[], bool],
) -> BacktestResponse:
    candles = [candle_from_dto(c) for c in req.candles]
    set_stage("htf")
    # ... existing coded/rule branch that fetches HTF and runs the engine ...
    set_stage("engine")
    # (the _run_coded / _run_rule calls stay; "engine" labels the run itself)
    # ... window trim + enrich_trades ...
    set_stage("enrich")
    # ... attach_exit_times, enrich_trades_whatif ...
    # cost sensitivity block:
    if req.costSensitivity and req.sweep is None:
        set_stage("cost")
        # ... existing multiples loop, but check cancellation before each re-run:
        for m in multiples:
            if is_cancelled():
                raise BacktestCancelled()
            # ... existing per-multiple body ...
    # ... trades_dto, metrics, analysis ...
    set_stage("saving")
    # ... RUN_STORE.insert block + return BacktestResponse(...)
```

Place `set_stage("htf")` before the HTF fetch, `set_stage("engine")` immediately before the `_run_coded`/`_run_rule` call, `set_stage("enrich")` before `attach_exit_times`, `set_stage("cost")` at the top of the cost-sensitivity `if`, and `set_stage("saving")` before the `RUN_STORE.insert`. Keep every existing line otherwise identical (this is a pure extraction).

- [ ] **Step 3: Point the existing route at the core**

Rewrite the tail of `backtest()` (after its validation block, lines 190-209 stay) to delegate:

```python
@router.post("/api/backtest", response_model=BacktestResponse)
async def backtest(req: BacktestRequest) -> BacktestResponse:
    # ... existing validation block (lines 190-209) unchanged ...
    return await run_backtest_core(req, set_stage=lambda _s: None, is_cancelled=lambda: False)
```

- [ ] **Step 4: Run the full backtest route regression suite**

Run: `cd backend && python -m pytest tests/test_api_backtest.py tests/test_api_backtest_coded.py tests/test_api_backtest_analysis.py -q`
Expected: PASS (behavior is unchanged; this is a refactor)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/backtest.py
git commit -m "refactor(backtest): extract async run_backtest_core with stage hooks"
```

---

### Task 4: Backtest job manager + submit/poll/cancel routes + DTOs

**Files:**
- Create: `backend/auto_trader/api/backtest_jobs.py`
- Modify: `backend/auto_trader/api/schemas.py` (add `BacktestJobSubmitResponse`, `BacktestJobStatusResponse`)
- Modify: `backend/auto_trader/api/routers/backtest.py` (add 3 routes; import the manager)
- Test: `backend/tests/test_backtest_jobs.py` (new)

**Interfaces:**
- Consumes: `run_backtest_core` (Task 3), `BacktestResponse`.
- Produces: `BACKTEST_JOBS` singleton with `submit(req) -> BacktestJob`, `get(job_id)`, `cancel(job_id) -> bool`. `BacktestJob` fields: `job_id: str, stage: str, running: bool, cancelled: bool, error: str | None, result: BacktestResponse | None, created_at: float, finished_at: float`. Routes: `POST /api/backtest/jobs` → `BacktestJobSubmitResponse{jobId}`; `GET /api/backtest/jobs/{job_id}` → `BacktestJobStatusResponse`; `POST /api/backtest/jobs/{job_id}/cancel`.

- [ ] **Step 1: Write the job manager**

Create `backend/auto_trader/api/backtest_jobs.py`:

```python
"""Background single-backtest job manager.

A single backtest is CPU-light but has several distinct steps (HTF fetch, engine,
cost-sensitivity re-runs, enrichment, save). To surface a live "what is it doing"
label, we run it as an asyncio task ON THE SERVER LOOP (candle fetches use the
shared, loop-bound candle cache, so the work cannot move to a thread). The submit
route validates synchronously, starts the task, and returns a job id the frontend
polls; the final poll carries the BacktestResponse.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from ..schemas import BacktestRequest, BacktestResponse

logger = logging.getLogger(__name__)

_TTL_SECONDS = 3600.0


@dataclass
class BacktestJob:
    job_id: str
    stage: str = "htf"
    running: bool = True
    cancelled: bool = False
    error: str | None = None
    result: BacktestResponse | None = None
    created_at: float = 0.0
    finished_at: float = 0.0


class BacktestJobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, BacktestJob] = {}

    def submit(self, req: BacktestRequest) -> BacktestJob:
        job = BacktestJob(job_id=uuid.uuid4().hex, created_at=time.time())
        self._jobs[job.job_id] = job
        # create_task schedules on the running server loop; the coroutine runs the
        # extracted async core, which shares the loop-bound candle cache safely.
        asyncio.create_task(self._run(job, req))
        return job

    def get(self, job_id: str) -> BacktestJob | None:
        self._prune()
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None or not job.running:
            return False
        job.cancelled = True
        return True

    def _prune(self) -> None:
        now = time.time()
        stale = [
            jid for jid, j in self._jobs.items()
            if not j.running and now - (j.finished_at or j.created_at) > _TTL_SECONDS
        ]
        for jid in stale:
            del self._jobs[jid]

    async def _run(self, job: BacktestJob, req: BacktestRequest) -> None:
        # Imported here (not at module top) to avoid a router<->manager import cycle.
        from .routers.backtest import BacktestCancelled, run_backtest_core

        def set_stage(s: str) -> None:
            job.stage = s

        try:
            job.result = await run_backtest_core(
                req, set_stage=set_stage, is_cancelled=lambda: job.cancelled,
            )
        except BacktestCancelled:
            job.cancelled = True
        except Exception as e:  # noqa: BLE001  surface, never leak a traceback
            job.error = str(e)
        finally:
            job.finished_at = time.time()
            job.running = False


BACKTEST_JOBS = BacktestJobManager()
```

- [ ] **Step 2: Add the DTOs**

In `backend/auto_trader/api/schemas.py` (near the other job DTOs):

```python
class BacktestJobSubmitResponse(BaseModel):
    """POST /api/backtest/jobs: the job handle the frontend polls."""
    jobId: str


class BacktestJobStatusResponse(BaseModel):
    """GET /api/backtest/jobs/{job_id}: live stage + terminal flags; `result`
    is the finished BacktestResponse, present only once running is False and no
    error/cancel occurred."""
    stage: str
    running: bool
    cancelled: bool
    error: str | None = None
    result: BacktestResponse | None = None
```

- [ ] **Step 3: Write the failing route test**

Create `backend/tests/test_backtest_jobs.py`. Reuse the request/candles builders the existing backtest tests use (import from `test_api_backtest`). Drive the routes through FastAPI's `TestClient` (or the async client the other API tests use — match `test_api_backtest.py`'s harness):

```python
import time
from fastapi.testclient import TestClient
from auto_trader.api.app import app
from test_api_backtest import rule_request  # existing helper: a valid rule backtest body


def _poll_until_done(client, job_id, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = client.get(f"/api/backtest/jobs/{job_id}").json()
        if not st["running"]:
            return st
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_job_runs_and_returns_result():
    client = TestClient(app)
    body = rule_request()
    sub = client.post("/api/backtest/jobs", json=body)
    assert sub.status_code == 200
    job_id = sub.json()["jobId"]
    st = _poll_until_done(client, job_id)
    assert st["error"] is None and st["cancelled"] is False
    assert st["result"] is not None
    assert st["result"]["resolution"] == body["resolution"]


def test_unknown_job_404s():
    client = TestClient(app)
    assert client.get("/api/backtest/jobs/nope").status_code == 404
```

If `test_api_backtest.py` exposes its request builder under a different name, use that name; the body must be a valid rule-mode `BacktestRequest` dict.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_backtest_jobs.py -v`
Expected: FAIL (routes 404 — not wired yet)

- [ ] **Step 5: Wire the routes**

In `backend/auto_trader/api/routers/backtest.py`, import the manager + DTOs and add the routes near the other job routes. Reuse the existing synchronous validation from `backtest()` by factoring it into a small `_validate_backtest(req)` helper that both the sync route and the submit route call (extract lines 190-209 into it), so the submit still 422s on bad input:

```python
from ..backtest_jobs import BACKTEST_JOBS
from ..schemas import BacktestJobSubmitResponse, BacktestJobStatusResponse


@router.post("/api/backtest/jobs", response_model=BacktestJobSubmitResponse)
async def submit_backtest_job(req: BacktestRequest, target: str = "local"):
    if target == "remote":
        return await compute.forward(
            "POST", "/api/backtest/jobs", json_body=req.model_dump(mode="json"),
        )
    _validate_backtest(req)                       # 422s synchronously, same as POST /api/backtest
    job = BACKTEST_JOBS.submit(req)
    return BacktestJobSubmitResponse(jobId=job.job_id)


@router.get("/api/backtest/jobs/{job_id}", response_model=BacktestJobStatusResponse)
async def backtest_job_status(job_id: str, target: str = "local"):
    if target == "remote":
        return await compute.forward("GET", f"/api/backtest/jobs/{job_id}")
    job = BACKTEST_JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "backtest job not found")
    return BacktestJobStatusResponse(
        stage=job.stage, running=job.running, cancelled=job.cancelled,
        error=job.error, result=job.result,
    )


@router.post("/api/backtest/jobs/{job_id}/cancel")
async def cancel_backtest_job(job_id: str, target: str = "local"):
    if target == "remote":
        return await compute.forward("POST", f"/api/backtest/jobs/{job_id}/cancel")
    if BACKTEST_JOBS.get(job_id) is None:
        raise HTTPException(404, "backtest job not found")
    BACKTEST_JOBS.cancel(job_id)
    return {"ok": True}
```

Note: declare `GET /api/backtest/jobs/{job_id}` such that the literal `/api/backtest/runs` and `/api/backtest/sweeps` routes still resolve first — they are separate literals, so ordering is not a conflict, but keep the new routes grouped with the sweep job routes.

Extract the validation helper (lines 190-209 of the current `backtest()`):

```python
def _validate_backtest(req: BacktestRequest) -> None:
    if not req.candles:
        raise HTTPException(422, "candles must not be empty")
    if req.codedStrategy is None:
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
            # ... existing series-presence checks ...
    elif req.codedStrategy is not None:
        _validate_coded_exit_series(req)
```

and call `_validate_backtest(req)` at the top of the existing `backtest()` route in place of the inlined block.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_backtest_jobs.py -v`
Expected: PASS

- [ ] **Step 7: Add cancel + validation tests**

Append to `tests/test_backtest_jobs.py`:

```python
def test_submit_validates_synchronously():
    client = TestClient(app)
    bad = rule_request()
    bad["candles"] = []
    assert client.post("/api/backtest/jobs", json=bad).status_code == 422


def test_cancel_unknown_404s():
    client = TestClient(app)
    assert client.post("/api/backtest/jobs/nope/cancel").status_code == 404
```

Run: `cd backend && python -m pytest tests/test_backtest_jobs.py tests/test_api_backtest.py -q`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/api/backtest_jobs.py backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_backtest_jobs.py
git commit -m "feat(progress): backtest polled job (asyncio task) + submit/poll/cancel routes"
```

---

### Task 5: Shared frontend stage-label vocabulary

**Files:**
- Create: `frontend/src/lib/progressLabels.ts`
- Modify: `frontend/src/WfoResults.tsx` (replace local `PHASE_LABEL`, line 20-24 and its use at line 200)
- Test: `frontend/src/lib/progressLabels.test.ts` (new)

**Interfaces:**
- Produces: `stageLabel(stage: string | null | undefined): string` — maps a stage key to display copy; unknown keys pass through verbatim (so backend `"Testing fold 2/5"` renders as-is); null/undefined → `""`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/progressLabels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { stageLabel } from "./progressLabels";

describe("stageLabel", () => {
  it("maps known stage keys", () => {
    expect(stageLabel("downloading")).toBe("Downloading candles");
    expect(stageLabel("indicators")).toBe("Preparing indicators");
    expect(stageLabel("submitting")).toBe("Submitting");
    expect(stageLabel("uploading")).toBe("Uploading to compute host");
    expect(stageLabel("htf")).toBe("Fetching higher-timeframe data");
    expect(stageLabel("engine")).toBe("Running backtest");
    expect(stageLabel("cost")).toBe("Testing cost sensitivity");
    expect(stageLabel("enrich")).toBe("Finalizing");
    expect(stageLabel("saving")).toBe("Saving");
    expect(stageLabel("grid")).toBe("Running combos");
    expect(stageLabel("aggregate")).toBe("Aggregating");
  });
  it("passes through backend detail strings verbatim", () => {
    expect(stageLabel("Testing fold 2/5")).toBe("Testing fold 2/5");
  });
  it("returns empty for null/undefined", () => {
    expect(stageLabel(null)).toBe("");
    expect(stageLabel(undefined)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/progressLabels.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the vocabulary**

Create `frontend/src/lib/progressLabels.ts`:

```ts
// Shared human-readable labels for the "what is it doing right now" progress
// line across backtest, sweep, and WFO. Frontend-driven stages (downloading /
// indicators / submitting / uploading) are set in BacktestButton's shared prep
// region; the rest arrive on the job poll. Unknown keys pass through verbatim so
// backend detail strings like "Testing fold 2/5" render as-is.
const LABELS: Record<string, string> = {
  downloading: "Downloading candles",
  indicators: "Preparing indicators",
  submitting: "Submitting",
  uploading: "Uploading to compute host",
  htf: "Fetching higher-timeframe data",
  engine: "Running backtest",
  cost: "Testing cost sensitivity",
  enrich: "Finalizing",
  saving: "Saving",
  grid: "Running combos",
  aggregate: "Aggregating",
};

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "";
  return LABELS[stage] ?? stage;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/progressLabels.test.ts`
Expected: PASS

- [ ] **Step 5: Replace WfoResults' local PHASE_LABEL**

In `frontend/src/WfoResults.tsx`: delete the local `PHASE_LABEL` map (lines 20-24) and import `stageLabel`. At line 200, render the backend `stage` when present, falling back to the coarse phase label:

```tsx
import { stageLabel } from "./lib/progressLabels";
// ...
          <span>{stageLabel(state.stage) || stageLabel(state.phase)}</span>
```

(`state.stage` is added to the WFO run-state type in Task 6/7; until then TypeScript will flag it — Task 6 adds the field. If executing strictly task-by-task, add `stage?: string` to the WFO state type now as a one-line forward declaration; Task 6 wires it through.)

To keep this task self-contained and green, add `stage?: string | null` to the WFO run-state interface (find it via `grep -n "phase:" frontend/src/lib/signals.ts frontend/src/api.ts` — it is the `WfoRunState`/`wfoStateSignal` payload type) as part of this step.

- [ ] **Step 6: Typecheck + tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/lib/progressLabels.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/progressLabels.ts frontend/src/lib/progressLabels.test.ts frontend/src/WfoResults.tsx frontend/src/lib/signals.ts
git commit -m "feat(progress): shared stage-label vocabulary; WFO uses it"
```

---

### Task 6: API client — stage fields on sweep/WFO polls; backtest job endpoints; `runBacktestJob`

**Files:**
- Modify: `frontend/src/api.ts` (add `stage` to `SweepJobStatus` ~line 499 and `WfoJobStatus` ~line 734; add backtest-job submit/poll/cancel + a `BacktestJobStatus` type)
- Create: `frontend/src/lib/backtestJob.ts`
- Test: `frontend/src/lib/backtestJob.test.ts` (new)

**Interfaces:**
- Consumes: `BacktestRequest`, `BacktestResult` (existing `api.ts` types), `SweepTarget`.
- Produces:
  - `SweepJobStatus.stage?: string | null`, `WfoJobStatus.stage?: string | null`.
  - `submitBacktestJob(req, target): Promise<{ jobId: string }>`
  - `pollBacktestJob(jobId, target): Promise<BacktestJobStatus>` where `BacktestJobStatus = { stage: string; running: boolean; cancelled: boolean; error: string | null; result: BacktestResult | null }`
  - `cancelBacktestJob(jobId, target): Promise<void>`
  - `runBacktestJob(req, opts): Promise<BacktestResult>` in `lib/backtestJob.ts`, `opts: { onStage?: (stage: string) => void; signal?: AbortSignal; target: SweepTarget; shouldCancelServer?: () => boolean }`.

- [ ] **Step 1: Add `stage` to the poll status types**

In `frontend/src/api.ts`, `SweepJobStatus` (line 499) and `WfoJobStatus` (line 734), add:

```ts
  stage?: string | null;
```

- [ ] **Step 2: Add the backtest-job API functions**

In `frontend/src/api.ts`, near the sweep job helpers:

```ts
export interface BacktestJobStatus {
  stage: string;
  running: boolean;
  cancelled: boolean;
  error: string | null;
  result: BacktestResult | null;
}

const backtestJobsBase = (target: SweepTarget) =>
  `${BASE}/api/backtest/jobs${target === "remote" ? "?target=remote" : ""}`;

export async function submitBacktestJob(
  req: BacktestRequest, target: SweepTarget,
): Promise<{ jobId: string }> {
  const res = await fetch(backtestJobsBase(target), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `backtest submit failed (${res.status})`));
  return res.json();
}

export async function pollBacktestJob(
  jobId: string, target: SweepTarget,
): Promise<BacktestJobStatus> {
  const res = await fetch(
    `${BASE}/api/backtest/jobs/${jobId}${target === "remote" ? "?target=remote" : ""}`,
  );
  if (!res.ok) throw new Error(await errorDetail(res, `backtest poll failed (${res.status})`));
  return res.json();
}

export async function cancelBacktestJob(jobId: string, target: SweepTarget): Promise<void> {
  const res = await fetch(
    `${BASE}/api/backtest/jobs/${jobId}/cancel${target === "remote" ? "?target=remote" : ""}`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(await errorDetail(res, `backtest cancel failed (${res.status})`));
}
```

- [ ] **Step 3: Write the failing `runBacktestJob` test**

Create `frontend/src/lib/backtestJob.test.ts` (mirror the fetch-mock style of `lib/sweep.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runBacktestJob } from "./backtestJob";
import * as api from "../api";

describe("runBacktestJob", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("submits, polls stages, resolves the final result", async () => {
    vi.spyOn(api, "submitBacktestJob").mockResolvedValue({ jobId: "j1" });
    const result = { resolution: "MINUTE" } as unknown as api.BacktestResult;
    const poll = vi.spyOn(api, "pollBacktestJob")
      .mockResolvedValueOnce({ stage: "htf", running: true, cancelled: false, error: null, result: null })
      .mockResolvedValueOnce({ stage: "engine", running: true, cancelled: false, error: null, result: null })
      .mockResolvedValueOnce({ stage: "saving", running: false, cancelled: false, error: null, result });
    const stages: string[] = [];
    const out = await runBacktestJob({} as api.BacktestRequest, {
      target: "local", onStage: (s) => stages.push(s),
    });
    expect(out).toBe(result);
    expect(stages).toContain("engine");
    expect(poll).toHaveBeenCalled();
  });

  it("throws on job error", async () => {
    vi.spyOn(api, "submitBacktestJob").mockResolvedValue({ jobId: "j2" });
    vi.spyOn(api, "pollBacktestJob").mockResolvedValue({
      stage: "engine", running: false, cancelled: false, error: "boom", result: null,
    });
    await expect(runBacktestJob({} as api.BacktestRequest, { target: "local" }))
      .rejects.toThrow("boom");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestJob.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 5: Implement `runBacktestJob`**

Create `frontend/src/lib/backtestJob.ts` (reuse the poll cadence + cancellable sleep idiom from `lib/sweep.ts`; keep it small):

```ts
import {
  submitBacktestJob, pollBacktestJob, cancelBacktestJob,
  type BacktestRequest, type BacktestResult, type SweepTarget,
} from "../api";

const BACKTEST_POLL_MS = 300;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Submit a single backtest as a job and poll it to completion, reporting each
// backend stage via onStage. Resolves with the final BacktestResult. On abort it
// stops polling and (when shouldCancelServer() is true) cancels the server job.
export async function runBacktestJob(
  req: BacktestRequest,
  opts: {
    target: SweepTarget;
    onStage?: (stage: string) => void;
    signal?: AbortSignal;
    shouldCancelServer?: () => boolean;
  },
): Promise<BacktestResult> {
  const shouldCancelServer = opts.shouldCancelServer ?? (() => true);
  const { jobId } = await submitBacktestJob(req, opts.target);
  for (;;) {
    await sleep(BACKTEST_POLL_MS, opts.signal);
    if (opts.signal?.aborted) {
      if (shouldCancelServer()) cancelBacktestJob(jobId, opts.target).catch(() => {});
      throw new Error("backtest aborted");
    }
    const st = await pollBacktestJob(jobId, opts.target);
    if (st.stage) opts.onStage?.(st.stage);
    if (!st.running) {
      if (st.error) throw new Error(st.error);
      if (st.cancelled) throw new Error("backtest cancelled");
      if (st.result) return st.result;
      throw new Error("backtest finished without a result");
    }
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/backtestJob.test.ts`
Expected: PASS

- [ ] **Step 7: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/backtestJob.ts frontend/src/lib/backtestJob.test.ts
git commit -m "feat(progress): backtest job API client + runBacktestJob poll loop"
```

---

### Task 7: BacktestButton — progress signal, shared prep labels, backtest-as-job, cancel

**Files:**
- Modify: `frontend/src/lib/signals.ts` (add `progressStageSignal`)
- Modify: `frontend/src/lib/backtest.ts` (`runAndRender` uses `runBacktestJob` + accepts stage/signal opts, ~line 1065-1074)
- Modify: `frontend/src/BacktestButton.tsx` (set stage in shared prep + per-branch submit; pass opts to `runAndRender`; add backtest cancel)

**Interfaces:**
- Consumes: `runBacktestJob` (Task 6), `stageLabel` (Task 5).
- Produces: `progressStageSignal: Signal<string | null>` (null when idle). `runAndRender(..., opts?: { onStage?: (s: string) => void; signal?: AbortSignal; target?: SweepTarget })`.

- [ ] **Step 1: Add the progress signal**

In `frontend/src/lib/signals.ts`, next to `backtestRunningSignal` (line 406):

```ts
// The current progress stage for the active run (backtest/sweep/WFO), or null
// when idle. Set by BacktestButton's shared prep region and the backtest job
// poll; read by BacktestPanel (single run) — sweep/WFO panels read their own
// state.stage. Values are stage keys (see lib/progressLabels.ts) or verbatim
// backend detail strings.
export const progressStageSignal = new Signal<string | null>(null);
```

- [ ] **Step 2: Thread stage/signal into `runAndRender`**

In `frontend/src/lib/backtest.ts`, change the signature (line 1065) and the fetch call (line 1074):

```ts
export async function runAndRender(
  chart: Chart,
  req: BacktestRequest,
  scope: string,
  displayResolution: string,
  period?: BacktestPeriod,
  opts?: { onStage?: (s: string) => void; signal?: AbortSignal; target?: SweepTarget },
): Promise<StoredBacktestResult> {
  const t0 = performance.now();
  const result = await runBacktestJob(req, {
    target: opts?.target ?? "local",
    onStage: opts?.onStage,
    signal: opts?.signal,
  });
  // ... rest unchanged (setInspectTraces(result.bar_traces), teardownArtifacts, etc.)
```

Replace the `import { runBacktest, ... }` at line 22 with an import of `runBacktestJob` from `./backtestJob` (keep the `BacktestRequest`, `Marker` type imports from `../api`; add `SweepTarget`).

- [ ] **Step 3: Set the shared prep labels in BacktestButton**

In `frontend/src/BacktestButton.tsx`, import `progressStageSignal` and set it in the shared prep region:

- Right before `let bars = await fetchBars(...)` (line 279): `progressStageSignal.set("downloading");`
- Right before `const series = await buildChartOperandSeries(...)` (line 319): `progressStageSignal.set("indicators");`
- In the shared `finally` that resets `backtestRunningSignal` (find the `finally` around line 560+ that does `backtestRunningSignal.set(false)`): add `progressStageSignal.set(null);` so every exit path clears it.

- [ ] **Step 4: Set submit/upload label per branch, and swap the single-run path**

- WFO branch (line 391+): right before `runWalkForward(...)` add `progressStageSignal.set(sweepTargetSignal.value === "remote" ? "uploading" : "submitting");`
- Sweep branch (line 449+): right before `runSweep(...)` add the same line.
- Single-run path (line 528): set the submit label and pass opts so the job's stages drive the signal, plus a cancel controller:

```tsx
      progressStageSignal.set(sweepTargetSignal.value === "remote" ? "uploading" : "submitting");
      const btCtl = new AbortController();
      const unsubBt = backtestCancelRequest.subscribe(() => btCtl.abort());
      let res;
      try {
        res = await runAndRender(
          chart, baseReq, controller!.scope, period.resolution,
          { fromMs: windowFromMs, toMs: windowToMs, mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined },
          { onStage: (s) => progressStageSignal.set(s), signal: btCtl.signal, target: sweepTargetSignal.value },
        );
      } finally {
        unsubBt();
      }
```

Add a `backtestCancelRequest` signal in `lib/signals.ts` mirroring `sweepCancelRequest` (a `Signal<number>` bumped to request cancel), and a helper `requestBacktestCancel()` that bumps it. Wire a Cancel affordance (button) in the running-state UI — see Task 8 (the panel renders it). For this task, exporting `backtestCancelRequest` + `requestBacktestCancel` from `lib/signals.ts` is enough; Task 8 renders the button.

- [ ] **Step 5: Typecheck + existing frontend tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/lib`
Expected: PASS (no test asserts the removed `runBacktest` path; `runAndRender`'s callers are unchanged except the new optional arg)

- [ ] **Step 6: Manual smoke (documented, run in Step 7 verification)**

Note for the reviewer: a full UI smoke happens in Task 8's verification. This task's deliverable is the wiring + typecheck.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/signals.ts frontend/src/lib/backtest.ts frontend/src/BacktestButton.tsx
git commit -m "feat(progress): backtest runs as a polled job; shared prep stage labels"
```

---

### Task 8: Render the stage label in all three panels

**Files:**
- Modify: `frontend/src/BacktestPanel.tsx` (running-state placeholder, line 159; add Cancel)
- Modify: `frontend/src/SweepResults.tsx` (`SweepProgress`, add stage label, ~line 271-303; thread `stage` into `SweepProgressInfo` ~line 257)
- Modify: `frontend/src/lib/sweep.ts` and the sweep run-state so `stage` flows from poll → `sweepStateSignal`
- Modify: `frontend/src/lib/wfo.ts` so `stage` flows from poll → `wfoStateSignal` (WfoResults already renders it after Task 5)

**Interfaces:**
- Consumes: `stageLabel` (Task 5), `progressStageSignal` (Task 7), `SweepJobStatus.stage` / `WfoJobStatus.stage` (Task 6).

- [ ] **Step 1: Backtest panel — show the stage while running**

In `frontend/src/BacktestPanel.tsx`, subscribe to `progressStageSignal` (same `useSyncExternalStore` pattern as `backtestRunningSignal` at line 64) and replace the placeholder copy at line 159:

```tsx
  const stage = useSyncExternalStore(
    (cb) => progressStageSignal.subscribe(cb),
    () => progressStageSignal.value,
  );
  // ...
          {running
            ? (stageLabel(stage) || "Backtest running…")
            : "Run a backtest to see results here."}
```

When running, render it inside the shared `.sweep-progress` shell with an indeterminate bar (no count for a single run):

```tsx
      {running && (
        <div className="sweep-progress">
          <span>{stageLabel(stage) || "Backtest running…"}</span>
          <div className="sweep-progress-bar">
            <div className="sweep-progress-fill sweep-progress-fill--indeterminate" />
          </div>
          <button type="button" className="ghost" onClick={requestBacktestCancel}>Cancel</button>
        </div>
      )}
```

Add a minimal `.sweep-progress-fill--indeterminate` CSS rule (an animated width pulse) wherever `.sweep-progress-fill` is defined (grep `sweep-progress-fill` under `frontend/src` for the stylesheet). Import `stageLabel`, `progressStageSignal`, `requestBacktestCancel`.

- [ ] **Step 2: Thread `stage` through the sweep run-state**

In `frontend/src/lib/sweep.ts` `pollToCompletion`, extend the `onRows` payload OR the run state to carry `status.stage`. Simplest: widen the `onRows` signature to pass `stage` and set it into `sweepStateSignal`. Find the `SweepRunState` type (grep `sweepStateSignal` in `lib/signals.ts`) and add `stage?: string | null`. In `BacktestButton.tsx`'s sweep `onRows` callback (line 482) include `stage` when setting `sweepStateSignal`. Pass `status.stage` out of `pollToCompletion` (add it to the `onRows(...)` call there).

- [ ] **Step 3: Sweep panel — show the label above the count**

In `frontend/src/SweepResults.tsx`: add `stage?: string | null` to `SweepProgressInfo` (line 257). In `SweepProgress` (line 271), render the label:

```tsx
  return (
    <div className="sweep-progress">
      {progress.stage && <span>{stageLabel(progress.stage)}</span>}
      <span>{progress.done} / {progress.total}</span>
      <div className="sweep-progress-bar">
        <div className="sweep-progress-fill" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
      </div>
      {timing && <span className="sweep-progress-timing">{timing}</span>}
    </div>
  );
```

Pass `stage` from `sweepStateSignal` into the `SweepProgressInfo` the component receives (wherever `SweepResults` builds `progress`).

- [ ] **Step 4: Thread `stage` through the WFO run-state**

In `frontend/src/lib/wfo.ts` `pollWfoToCompletion`/`onState`, copy `status.stage` into the `wfoStateSignal` payload (the `WfoRunState` type got `stage?: string | null` in Task 5 Step 5). WfoResults already renders `stageLabel(state.stage) || stageLabel(state.phase)` from Task 5.

- [ ] **Step 5: Typecheck + tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src`
Expected: PASS

- [ ] **Step 6: End-to-end verification (use the `verify` skill / run skill)**

Start the app and drive each flow, confirming the label updates live:
- Backtest: click Run, observe "Downloading candles" → "Preparing indicators" → "Submitting" → "Running backtest" → (with cost sensitivity) "Testing cost sensitivity" → "Finalizing" → "Saving", then results render. Click Cancel mid-run and confirm it stops.
- Sweep: observe "Submitting"/"Uploading to compute host" then "Running combos" with the count.
- WFO: observe the prep labels then "Running combos"/"evaluating grid" → "Testing fold N/M" → "Aggregating".

Follow the project's `run` skill to launch; do not kill the user's HMR dev servers, and close any browser tabs you opened.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/BacktestPanel.tsx frontend/src/SweepResults.tsx frontend/src/lib/sweep.ts frontend/src/lib/wfo.ts frontend/src/lib/signals.ts frontend/src/BacktestButton.tsx
git commit -m "feat(progress): render live stage label in backtest/sweep/WFO panels"
```

---

## Self-Review

**Spec coverage:**
- Unified vocabulary → Task 5. Frontend prep labels (downloading/indicators/submitting/uploading) → Task 7. Backtest backend stages (htf/engine/cost/enrich/saving) as an asyncio-task job → Tasks 3, 4. Sweep `stage` → Task 1. WFO `stage` + fold N/M → Task 2. Distinct remote label → Task 7 (`uploading`) + every route's `target=remote` forward (Tasks 4). Cancel for backtest → Tasks 4, 7, 8. Render in panels → Task 8. Tests → each task. All spec sections map to a task.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" left; each code step shows the code. The two soft spots (exact `SweepRunState`/`WfoRunState` type location, and the stylesheet holding `.sweep-progress-fill`) are given as `grep` instructions with the exact symbol to find, because the type/stylesheet location is a lookup, not a decision.

**Type consistency:** `stage` is `str`/`string | null` end to end. `run_backtest_core(req, set_stage, is_cancelled)` (Task 3) is consumed with those exact params by `BacktestJobManager._run` (Task 4). `runBacktestJob(req, opts)` (Task 6) returns `BacktestResult`, matching the old `runBacktest` return that `runAndRender` (Task 7) expects. `stageLabel` (Task 5) is used in Tasks 7, 8. `progressStageSignal` (Task 7) is read in Task 8. Stage keys in `LABELS` (Task 5) match the strings emitted by `run_backtest_core` (Task 3) and the sweep/WFO jobs (Tasks 1, 2).

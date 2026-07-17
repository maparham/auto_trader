# Remote Backtest Offload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single backtest run execute on the remote Fly compute host via a submit/poll/cancel job API, with results persisted locally.

**Architecture:** Extract the body of the synchronous `/api/backtest` handler into a shared `_execute_backtest()` (engine calls offloaded to a thread so the event loop stays responsive), add an asyncio-task job manager + three job routes that forward to the remote host on `target=remote` (same pattern as sweep jobs), add a `POST /api/backtest/runs` archive endpoint so remote results land in the local `RUN_STORE`, and on the frontend a poll loop + a Local/Remote toggle shared with sweeps (signal renamed `computeTargetSignal`).

**Tech Stack:** FastAPI + pydantic (backend, Python 3.12), React + TypeScript + vitest (frontend). Backend tests: pytest with `TestClient` / direct handler calls.

Spec: `docs/superpowers/specs/2026-07-17-remote-backtest-offload-design.md`

## Global Constraints

- Commit directly to `main` (user rule: never branch unless asked).
- No backward-compat/migration code: the localStorage key rename ships without a shim.
- No em dashes ("—") in any end-user-visible copy (tooltips, errors, button labels). Code comments/commits are fine.
- End-user copy is plain language for educated traders.
- Reuse shared components (`Tooltip`, existing `seg` button group) in UI work.
- Backend test command: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest <file> -v`
- Frontend test command: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run <file>`
- End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01VeSBryyFaUmDDgeim9u7rv`

---

### Task 1: Extract `_execute_backtest` with `persist` + cancellation hooks

The synchronous handler `backtest()` in `backend/auto_trader/api/routers/backtest.py:172-421` currently does validation, engine run, enrichment, cost sensitivity, DTO mapping, and `RUN_STORE` persistence inline. Extract everything after the request-shape validation into a shared coroutine the job path (Task 3) can call with `persist=False` and a cancellation probe. Also wrap the blocking engine calls in `asyncio.to_thread` so a background job doesn't freeze the event loop (today the sync handler blocks the loop for the whole run; moving to a thread is safe because `run_rule_sync`/`run_coded_sync` are pure compute over passed-in data, which is why the sweep pool can already run them in separate processes).

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py`
- Create: `backend/auto_trader/api/backtest_jobs.py` (only the `JobCancelled` exception in this task; the manager comes in Task 2)
- Test: `backend/tests/test_api_backtest_execute.py`

**Interfaces:**
- Produces: `JobCancelled(Exception)` in `auto_trader/api/backtest_jobs.py`.
- Produces: `async def _execute_backtest(req: BacktestRequest, *, persist: bool = True, is_cancelled: Callable[[], bool] | None = None) -> BacktestResponse` in `routers/backtest.py`. Raises `HTTPException` on validation/engine errors (unchanged), raises `JobCancelled` when `is_cancelled()` returns True at a phase boundary. With `persist=False` it never touches `RUN_STORE` and returns `run_id=None`.
- Consumes: everything already in `routers/backtest.py` (`_run_rule`, `_run_coded`, `RUN_STORE`, DTO mapping).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_backtest_execute.py`. Reuse the request-building helpers from `test_api_backtest.py` (copy them; they are module-private there):

```python
"""_execute_backtest: the shared single-run core used by both the synchronous
/api/backtest handler and the background job path (persist + cancellation)."""

from __future__ import annotations

import asyncio

import pytest

from auto_trader.api import app as app_module
from auto_trader.api.backtest_jobs import JobCancelled
from auto_trader.api.routers.backtest import _execute_backtest
from auto_trader.core.run_store import RUN_STORE


def _candles(closes: list[float]) -> list[dict]:
    return [
        {"time": 1_700_000_000 + i * 60, "open": c, "high": c, "low": c, "close": c, "volume": 0.0}
        for i, c in enumerate(closes)
    ]


def _ind(name: str, length: int | None = None) -> dict:
    return {"kind": "indicator", "indicator": name, "length": length, "anchor": None}


def _costs() -> dict:
    return {"quantity": 1.0, "commissionPerSide": 0.0, "slippage": {"kind": "fixed", "value": 0.0}, "startingCash": 10_000.0}


def _body() -> dict:
    candles = _candles([10, 10, 10, 10, 11, 12, 13, 14, 15, 16])
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        "longEntry": {"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesAbove", "right": _ind("EMA", 9)}]},
        "longExit": empty,
        "shortEntry": empty,
        "shortExit": empty,
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }


def test_execute_matches_sync_handler():
    async def scenario():
        req = app_module.BacktestRequest(**_body())
        return await _execute_backtest(req), await app_module.backtest(app_module.BacktestRequest(**_body()))

    executed, handled = asyncio.run(scenario())
    # run_id differs per run; everything else must be identical.
    assert executed.model_dump(exclude={"run_id"}) == handled.model_dump(exclude={"run_id"})


def test_persist_false_skips_run_store(monkeypatch):
    inserted: list[dict] = []

    async def fake_insert(rec: dict) -> None:
        inserted.append(rec)

    monkeypatch.setattr(RUN_STORE, "insert", fake_insert)

    async def scenario():
        return await _execute_backtest(app_module.BacktestRequest(**_body()), persist=False)

    res = asyncio.run(scenario())
    assert res.run_id is None
    assert inserted == []


def test_persist_true_writes_run_store(monkeypatch):
    inserted: list[dict] = []

    async def fake_insert(rec: dict) -> None:
        inserted.append(rec)

    monkeypatch.setattr(RUN_STORE, "insert", fake_insert)

    async def scenario():
        return await _execute_backtest(app_module.BacktestRequest(**_body()))

    res = asyncio.run(scenario())
    assert res.run_id is not None
    assert len(inserted) == 1
    assert inserted[0]["id"] == res.run_id


def test_is_cancelled_raises_job_cancelled():
    async def scenario():
        req = app_module.BacktestRequest(**_body())
        return await _execute_backtest(req, is_cancelled=lambda: True)

    with pytest.raises(JobCancelled):
        asyncio.run(scenario())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_api_backtest_execute.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.api.backtest_jobs'` (or ImportError on `_execute_backtest`).

- [ ] **Step 3: Create `backtest_jobs.py` with the exception, refactor the handler**

Create `backend/auto_trader/api/backtest_jobs.py`:

```python
"""Background single-backtest job manager (the manager itself lands in Task 2).

`JobCancelled` lives here (not in routers/backtest.py) so the router can import
it without a cycle: routers/backtest imports this module, never the reverse.
"""
from __future__ import annotations


class JobCancelled(Exception):
    """Raised inside _execute_backtest at a phase boundary after a cancel."""
```

In `backend/auto_trader/api/routers/backtest.py`:

1. Add imports at the top (with the existing imports):

```python
import asyncio
from collections.abc import Callable

from ..backtest_jobs import JobCancelled
```

2. Wrap the engine calls in threads. In `_run_rule` (line ~98), change the final line:

```python
    return await asyncio.to_thread(run_rule_sync, req, candles, htf_candles)
```

In `_run_coded` (line ~110), change the `run_coded_sync` call inside the retry loop:

```python
        try:
            return await asyncio.to_thread(
                run_coded_sync,
                req, candles, module, resolved_params,
                long_risk_dto, short_risk_dto, htf_candles,
            )
```

(`run_rule_sync`/`run_coded_sync` are pure compute over their arguments; the sweep pool already runs them in separate processes, so a thread is safe. The awaited HTF fetches in the retry loop stay on the event loop.)

3. Split the handler. `backtest()` keeps ONLY its docstring and delegates:

```python
@router.post("/api/backtest", response_model=BacktestResponse)
async def backtest(req: BacktestRequest) -> BacktestResponse:
    """No broker call (D1): the request carries the exact candles the series were
    computed on, so re-fetching (which can shift by one forming bar) can't
    silently misalign series and candles. Indicators warm up over the full
    posted `candles`, but only bars at/after `tradeFromTime` are tradeable or
    returned (D6) — that split is what lets a long indicator be fully warm on
    the trading window's first bar."""
    return await _execute_backtest(req)
```

Directly below it, add `_execute_backtest` containing the ENTIRE former handler body (lines 180-421) verbatim, with exactly these changes:

```python
async def _execute_backtest(
    req: BacktestRequest,
    *,
    persist: bool = True,
    is_cancelled: Callable[[], bool] | None = None,
) -> BacktestResponse:
    """The single-run core shared by the synchronous /api/backtest handler
    (persist=True) and the background job path (persist=False + a cancellation
    probe checked at phase boundaries; the engine run itself is not
    interruptible). Raises JobCancelled when the probe fires."""
    cancelled = is_cancelled or (lambda: False)
    if cancelled():
        raise JobCancelled()
    # ... former handler body, unchanged except the three edits below ...
```

Edit (a) — after the main engine run (right after the `result = await _run_rule(...)` / `result, strategy = await _run_coded(...)` block, before the `window = ...` line):

```python
    if cancelled():
        raise JobCancelled()
```

Edit (b) — inside the cost-sensitivity loop, first line of `for m in multiples:`:

```python
            for m in multiples:
                if cancelled():
                    raise JobCancelled()
                if m == 1.0:
```

Edit (c) — the persistence gate. Replace

```python
    run_id: str | None = None if req.sweep is not None else uuid.uuid4().hex
```

with

```python
    run_id: str | None = None if (req.sweep is not None or not persist) else uuid.uuid4().hex
```

- [ ] **Step 4: Run the new tests and the existing backtest suites**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_api_backtest_execute.py tests/test_api_backtest.py tests/test_api_backtest_coded.py tests/test_api_backtest_analysis.py tests/test_api_backtest_sweep.py -v`
Expected: all PASS (the refactor must not change synchronous behavior).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/api/backtest_jobs.py backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_execute.py
git commit -m "refactor(backtest): extract _execute_backtest with persist + cancel hooks"
```

---

### Task 2: `BacktestJobManager` (asyncio-task jobs with TTL prune)

An in-memory job store like `SweepJobManager` (`backend/auto_trader/api/sweep_jobs.py:53`), but asyncio-task based (no process pool: one run is one unit of work, and Task 1 already moved the heavy compute onto a thread via `asyncio.to_thread`, so the event loop keeps serving polls while a job runs). No single-flight gate: overlapping single runs are cheap and the engine cores are pure.

**Files:**
- Modify: `backend/auto_trader/api/backtest_jobs.py`
- Test: `backend/tests/test_backtest_jobs.py`

**Interfaces:**
- Consumes: `JobCancelled` (Task 1, same module).
- Produces, in `auto_trader/api/backtest_jobs.py`:
  - `@dataclass class BacktestJob:` fields `job_id: str`, `epic: str`, `timeframe: str`, `running: bool = True`, `cancelled: bool = False`, `error: str | None = None`, `result: dict | None = None`, `created_at: float = 0.0`, `finished_at: float = 0.0`.
  - `class BacktestJobManager:` with `submit(*, epic: str, timeframe: str, run: Callable[[BacktestJob], Awaitable[dict]]) -> BacktestJob` (must be called from a running event loop), `get(job_id: str) -> BacktestJob | None`, `cancel(job_id: str) -> bool`.
  - Module singleton `BT_JOBS = BacktestJobManager()`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_backtest_jobs.py`:

```python
"""BacktestJobManager: asyncio-task lifecycle, cancel, error capture, TTL prune."""

from __future__ import annotations

import asyncio

from fastapi import HTTPException

from auto_trader.api.backtest_jobs import BacktestJobManager, JobCancelled


def test_submit_runs_and_stores_result():
    async def scenario():
        mgr = BacktestJobManager()

        async def run(job):
            return {"net": 42}

        job = mgr.submit(epic="EURUSD", timeframe="MINUTE_5", run=run)
        assert job.running is True
        # Let the task complete.
        for _ in range(50):
            if not job.running:
                break
            await asyncio.sleep(0.01)
        assert job.running is False
        assert job.result == {"net": 42}
        assert job.error is None
        assert job.cancelled is False
        assert mgr.get(job.job_id) is job

    asyncio.run(scenario())


def test_cancel_sets_flag_and_job_cancelled_lands_as_cancelled():
    async def scenario():
        mgr = BacktestJobManager()
        started = asyncio.Event()

        async def run(job):
            started.set()
            while True:
                await asyncio.sleep(0.01)
                if job.cancelled:
                    raise JobCancelled()

        job = mgr.submit(epic="EURUSD", timeframe="MINUTE_5", run=run)
        await started.wait()
        assert mgr.cancel(job.job_id) is True
        for _ in range(50):
            if not job.running:
                break
            await asyncio.sleep(0.01)
        assert job.running is False
        assert job.cancelled is True
        assert job.result is None
        # Cancelling a finished job is a no-op.
        assert mgr.cancel(job.job_id) is False

    asyncio.run(scenario())


def test_http_exception_becomes_error_detail():
    async def scenario():
        mgr = BacktestJobManager()

        async def run(job):
            raise HTTPException(422, "no candles for timeframe 'HOUR'")

        job = mgr.submit(epic="EURUSD", timeframe="MINUTE_5", run=run)
        for _ in range(50):
            if not job.running:
                break
            await asyncio.sleep(0.01)
        assert job.error == "no candles for timeframe 'HOUR'"
        assert job.result is None

    asyncio.run(scenario())


def test_unknown_job_and_ttl_prune(monkeypatch):
    async def scenario():
        mgr = BacktestJobManager()
        assert mgr.get("nope") is None
        assert mgr.cancel("nope") is False

        async def run(job):
            return {}

        job = mgr.submit(epic="E", timeframe="T", run=run)
        for _ in range(50):
            if not job.running:
                break
            await asyncio.sleep(0.01)
        # Age the finished job past the TTL; get() prunes on access.
        job.finished_at -= 4000.0
        assert mgr.get(job.job_id) is None

    asyncio.run(scenario())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_backtest_jobs.py -v`
Expected: FAIL with `ImportError: cannot import name 'BacktestJobManager'`.

- [ ] **Step 3: Implement the manager**

Replace `backend/auto_trader/api/backtest_jobs.py` with:

```python
"""Background single-backtest job manager.

Runs one backtest as an asyncio task on the app's event loop so the HTTP submit
returns immediately with a job id the frontend polls. The heavy engine compute
inside _execute_backtest already runs via asyncio.to_thread (Task 1), so a job
never starves poll requests. Unlike sweeps there is no process pool and no
single-flight gate: one run is one unit of work and the engine cores are pure.

`JobCancelled` lives here (not in routers/backtest.py) so the router can import
it without a cycle: routers/backtest imports this module, never the reverse.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from fastapi import HTTPException

# Jobs finished longer ago than this (seconds) are pruned on access, matching
# sweep_jobs._TTL_SECONDS: a completed run gets a full hour of poll life.
_TTL_SECONDS = 3600.0


class JobCancelled(Exception):
    """Raised inside _execute_backtest at a phase boundary after a cancel."""


@dataclass
class BacktestJob:
    job_id: str
    epic: str
    timeframe: str
    running: bool = True
    cancelled: bool = False
    error: str | None = None
    result: dict | None = None
    created_at: float = 0.0
    finished_at: float = 0.0
    # `_task` (the driving asyncio.Task) is set as a bare instance attribute in
    # `submit`, NOT a dataclass field, so it stays out of fields()/asdict() and
    # never leaks into a serialized API payload. Holding it also keeps the task
    # from being garbage-collected mid-run.


class BacktestJobManager:
    """Owns the job store; one asyncio task per job."""

    def __init__(self) -> None:
        self._jobs: dict[str, BacktestJob] = {}

    def submit(
        self,
        *,
        epic: str,
        timeframe: str,
        run: Callable[[BacktestJob], Awaitable[dict]],
    ) -> BacktestJob:
        """Start `run(job)` as a task on the RUNNING loop (submit is only ever
        called from a request handler). The job's terminal state is derived
        from how the coroutine ends: value -> result, JobCancelled ->
        cancelled, HTTPException -> its detail, anything else -> str(e)."""
        job = BacktestJob(
            job_id=uuid.uuid4().hex,
            epic=epic,
            timeframe=timeframe,
            created_at=time.time(),
        )
        self._jobs[job.job_id] = job

        async def _drive() -> None:
            try:
                job.result = await run(job)
            except JobCancelled:
                job.cancelled = True
            except HTTPException as e:
                job.error = str(e.detail)
            except Exception as e:  # noqa: BLE001  surface, never leak a traceback
                job.error = str(e) or e.__class__.__name__
            finally:
                # finished_at before running flips, so a poll that sees
                # running=False can trust the terminal fields are already set.
                job.finished_at = time.time()
                job.running = False

        job._task = asyncio.get_running_loop().create_task(_drive())  # bare attr
        return job

    def get(self, job_id: str) -> BacktestJob | None:
        self._prune()
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        """Cooperative cancel: sets the flag _execute_backtest's probe reads at
        its next phase boundary. False when unknown or already finished."""
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


BT_JOBS = BacktestJobManager()
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_backtest_jobs.py tests/test_api_backtest_execute.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/api/backtest_jobs.py backend/tests/test_backtest_jobs.py
git commit -m "feat(backtest): BacktestJobManager - asyncio-task single-run jobs"
```

---

### Task 3: Job routes (submit / poll / cancel) with `target=remote` forwarding

Three routes mirroring the sweep job handlers (`routers/backtest.py:573-718`), each relaying verbatim through `compute.forward()` when `target == "remote"`. Deep validation (missing series, bad strategy file, HTF fetch failures) happens inside `_execute_backtest` and surfaces as `job.error` at poll time; the submit itself only rejects an empty candle list, keeping submit fast.

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (after `SweepJobInfoDTO`, line ~500)
- Modify: `backend/auto_trader/api/routers/backtest.py` (after the sweep-job routes at the file's end)
- Test: `backend/tests/test_api_backtest_jobs.py`

**Interfaces:**
- Consumes: `_execute_backtest` (Task 1), `BT_JOBS` (Task 2), `compute.forward` (existing).
- Produces:
  - `class BacktestJobSubmitResponse(BaseModel): jobId: str`
  - `class BacktestJobStatusResponse(BaseModel): running: bool; cancelled: bool; error: str | None = None; result: dict | None = None`
  - `POST /api/backtest/jobs?target=` -> `BacktestJobSubmitResponse`
  - `GET /api/backtest/jobs/{job_id}?target=` -> `BacktestJobStatusResponse` (`result` set only when finished cleanly; it is the exact `BacktestResponse` dump)
  - `POST /api/backtest/jobs/{job_id}/cancel?target=` -> `{"ok": True}`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_backtest_jobs.py`:

```python
"""POST/GET /api/backtest/jobs — single-run background jobs + remote forward."""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from auto_trader.api import app as app_module
from auto_trader.api.app import app
from auto_trader.api.routers import backtest as bt_router

client = TestClient(app)


def _candles(closes: list[float]) -> list[dict]:
    return [
        {"time": 1_700_000_000 + i * 60, "open": c, "high": c, "low": c, "close": c, "volume": 0.0}
        for i, c in enumerate(closes)
    ]


def _ind(name: str, length: int | None = None) -> dict:
    return {"kind": "indicator", "indicator": name, "length": length, "anchor": None}


def _body() -> dict:
    candles = _candles([10, 10, 10, 10, 11, 12, 13, 14, 15, 16])
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        "longEntry": {"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesAbove", "right": _ind("EMA", 9)}]},
        "longExit": empty,
        "shortEntry": empty,
        "shortExit": empty,
        "costs": {"quantity": 1.0, "commissionPerSide": 0.0, "slippage": {"kind": "fixed", "value": 0.0}, "startingCash": 10_000.0},
        "tradeFromTime": candles[0]["time"],
    }


def _poll_until_done(job_id: str, tries: int = 100) -> dict:
    for _ in range(tries):
        res = client.get(f"/api/backtest/jobs/{job_id}")
        assert res.status_code == 200
        status = res.json()
        if not status["running"]:
            return status
    raise AssertionError("job never finished")


def test_job_result_matches_sync_endpoint():
    sync = client.post("/api/backtest", json=_body())
    assert sync.status_code == 200

    submit = client.post("/api/backtest/jobs", json=_body())
    assert submit.status_code == 200
    job_id = submit.json()["jobId"]

    status = _poll_until_done(job_id)
    assert status["error"] is None
    assert status["cancelled"] is False
    result = status["result"]
    # Jobs never persist server-side; the sync endpoint does.
    assert result["run_id"] is None
    expect = sync.json()
    expect["run_id"] = None
    assert result == expect


def test_submit_rejects_empty_candles():
    body = _body()
    body["candles"] = []
    res = client.post("/api/backtest/jobs", json=body)
    assert res.status_code == 422


def test_engine_error_lands_as_job_error():
    body = _body()
    # A rule referencing a browser-only series that was never posted: the shape
    # check inside _execute_backtest 422s, which the job surfaces as its error.
    body["longEntry"] = {
        "combine": "AND",
        "rules": [{"left": {"kind": "series", "name": "ghost"}, "op": "crossesAbove", "right": _ind("EMA", 9)}],
    }
    submit = client.post("/api/backtest/jobs", json=body)
    assert submit.status_code == 200
    status = _poll_until_done(submit.json()["jobId"])
    assert status["result"] is None
    assert "ghost" in (status["error"] or "")


def test_poll_and_cancel_unknown_job_404():
    assert client.get("/api/backtest/jobs/nope").status_code == 404
    assert client.post("/api/backtest/jobs/nope/cancel").status_code == 404


def test_cancel_running_job():
    async def scenario():
        from auto_trader.api.backtest_jobs import BT_JOBS, JobCancelled

        started = asyncio.Event()

        async def run(job):
            started.set()
            while True:
                await asyncio.sleep(0.01)
                if job.cancelled:
                    raise JobCancelled()

        job = BT_JOBS.submit(epic="EURUSD", timeframe="MINUTE_5", run=run)
        await started.wait()
        resp = await bt_router.cancel_backtest_job(job.job_id)
        assert resp == {"ok": True}
        for _ in range(50):
            if not job.running:
                break
            await asyncio.sleep(0.01)
        status = await bt_router.backtest_job_status(job.job_id)
        assert status.cancelled is True
        assert status.running is False
        assert status.result is None

    asyncio.run(scenario())


def test_remote_target_forwards(monkeypatch):
    calls: list[tuple] = []

    async def fake_forward(method, path, *, json_body=None, params=None):
        calls.append((method, path))
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=200, content={"jobId": "r1"})

    monkeypatch.setattr(bt_router.compute, "forward", fake_forward)
    res = client.post("/api/backtest/jobs?target=remote", json=_body())
    assert res.status_code == 200
    assert res.json() == {"jobId": "r1"}
    client.get("/api/backtest/jobs/r1?target=remote")
    client.post("/api/backtest/jobs/r1/cancel?target=remote")
    assert calls == [
        ("POST", "/api/backtest/jobs"),
        ("GET", "/api/backtest/jobs/r1"),
        ("POST", "/api/backtest/jobs/r1/cancel"),
    ]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_api_backtest_jobs.py -v`
Expected: FAIL with 404s / `AttributeError` (routes and DTOs don't exist).

- [ ] **Step 3: Add schemas and routes**

In `backend/auto_trader/api/schemas.py`, after `SweepJobInfoDTO` (~line 500):

```python
class BacktestJobSubmitResponse(BaseModel):
    """POST /api/backtest/jobs: the job handle the frontend polls."""
    jobId: str


class BacktestJobStatusResponse(BaseModel):
    """GET /api/backtest/jobs/{job_id}: running/terminal state. `result` is the
    complete BacktestResponse dump, set only when the job finished cleanly."""
    running: bool
    cancelled: bool
    error: str | None = None
    result: dict | None = None
```

In `backend/auto_trader/api/routers/backtest.py`:

1. Extend the schemas import block (line ~36) with `BacktestJobSubmitResponse, BacktestJobStatusResponse` (keep alphabetical order).
2. Change the existing import `from ..backtest_jobs import JobCancelled` (Task 1) to `from ..backtest_jobs import BT_JOBS, JobCancelled`.
3. Append at the end of the file:

```python
# --- single-run backtest jobs: submit / poll / cancel --------------------------
# The job path exists for target=remote (the poll survives Fly cold starts and
# long runs where one synchronous forward could not), but runs locally too so
# both targets exercise identical code. Deep validation happens inside
# _execute_backtest and surfaces as the job's error at poll time; jobs never
# persist to RUN_STORE (persist=False) — the frontend archives the result to
# the LOCAL backend via POST /api/backtest/runs, so a remote run's history
# never strands on the remote host's DB.


@router.post("/api/backtest/jobs", response_model=BacktestJobSubmitResponse)
async def submit_backtest_job(req: BacktestRequest, target: str = "local"):
    # target=remote forwards the raw request BEFORE any local work: the remote
    # host owns validation and job creation (same contract as sweep jobs).
    if target == "remote":
        return await compute.forward(
            "POST", "/api/backtest/jobs", json_body=req.model_dump(mode="json"),
        )
    if not req.candles:
        raise HTTPException(422, "candles must not be empty")

    async def _run(job) -> dict:
        return (
            await _execute_backtest(
                req, persist=False, is_cancelled=lambda: job.cancelled,
            )
        ).model_dump(mode="json")

    job = BT_JOBS.submit(epic=req.epic, timeframe=req.resolution, run=_run)
    return BacktestJobSubmitResponse(jobId=job.job_id)


@router.get("/api/backtest/jobs/{job_id}", response_model=BacktestJobStatusResponse)
async def backtest_job_status(job_id: str, target: str = "local"):
    if target == "remote":
        return await compute.forward("GET", f"/api/backtest/jobs/{job_id}")
    job = BT_JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "backtest job not found")
    return BacktestJobStatusResponse(
        running=job.running,
        cancelled=job.cancelled,
        error=job.error,
        result=job.result,
    )


@router.post("/api/backtest/jobs/{job_id}/cancel")
async def cancel_backtest_job(job_id: str, target: str = "local"):
    if target == "remote":
        return await compute.forward("POST", f"/api/backtest/jobs/{job_id}/cancel")
    if BT_JOBS.get(job_id) is None:
        raise HTTPException(404, "backtest job not found")
    BT_JOBS.cancel(job_id)
    return {"ok": True}
```

(Note: `GET /api/backtest/jobs/{job_id}` cannot shadow anything: unlike sweeps there is no literal `GET /api/backtest/jobs` list route.)

- [ ] **Step 4: Run tests**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_api_backtest_jobs.py tests/test_api_backtest.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_jobs.py
git commit -m "feat(backtest): single-run job routes with target=remote forwarding"
```

---

### Task 4: `POST /api/backtest/runs` — archive a completed run locally

Remote jobs run with `persist=False`, so the frontend must persist the finished result to the LOCAL backend's `RUN_STORE` (the sweep archive at `routers/backtest.py:476-485` is the exact precedent: the frontend posts the finished result set explicitly). The stored record must be shaped identically to what the synchronous handler writes (`routers/backtest.py:361-373`) so the runs read API (`GET /api/backtest/runs`, `GET /api/backtest/runs/{run_id}`) works unchanged.

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py` (next to the existing runs read API, before `GET /api/backtest/runs`)
- Test: `backend/tests/test_api_backtest_runs_archive.py`

**Interfaces:**
- Produces: `POST /api/backtest/runs` accepting `RunArchiveIn` -> `{"id": "<hex>"}`. Body model:

```python
class RunArchiveIn(BaseModel):
    epic: str
    timeframe: str
    rangeFrom: int      # epoch seconds of the posted candle span
    rangeTo: int
    strategyKind: str   # "coded" | "rules"
    strategyName: str | None = None
    request: dict       # the run's BacktestRequest dump; bulky keys stripped server-side
    summary: dict       # {**summary, **metrics}, matching the sync handler's stored shape
    trades: list[dict]
```

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_backtest_runs_archive.py`:

```python
"""POST /api/backtest/runs — archive a completed (remote) run into RUN_STORE."""

from __future__ import annotations

from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.core.run_store import RUN_STORE

client = TestClient(app)


def _archive_body() -> dict:
    return {
        "epic": "EURUSD",
        "timeframe": "MINUTE_5",
        "rangeFrom": 1_700_000_000,
        "rangeTo": 1_700_000_540,
        "strategyKind": "rules",
        "strategyName": None,
        "request": {"epic": "EURUSD", "candles": [{"time": 1}], "series": {"x": [1]}, "sweep": None, "costs": {}},
        "summary": {"net_pnl": 5.0, "n_trades": 1},
        "trades": [{"side": "buy", "pnl": 5.0, "leg": "long"}],
    }


def test_archive_inserts_run_store_record(monkeypatch):
    inserted: list[dict] = []

    async def fake_insert(rec: dict) -> None:
        inserted.append(rec)

    monkeypatch.setattr(RUN_STORE, "insert", fake_insert)
    res = client.post("/api/backtest/runs", json=_archive_body())
    assert res.status_code == 200
    run_id = res.json()["id"]
    assert len(inserted) == 1
    rec = inserted[0]
    assert rec["id"] == run_id
    assert rec["epic"] == "EURUSD"
    assert rec["timeframe"] == "MINUTE_5"
    assert rec["range_from"] == 1_700_000_000
    assert rec["range_to"] == 1_700_000_540
    assert rec["strategy_kind"] == "rules"
    assert rec["strategy_name"] is None
    assert rec["summary"] == {"net_pnl": 5.0, "n_trades": 1}
    assert rec["trades"] == [{"side": "buy", "pnl": 5.0, "leg": "long"}]
    # Bulky keys are stripped server-side even if the client forgot.
    for bulky in ("candles", "series", "sweep"):
        assert bulky not in rec["request"]
    assert rec["created_at"] > 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_api_backtest_runs_archive.py -v`
Expected: FAIL with 405 (no POST route on /api/backtest/runs).

- [ ] **Step 3: Implement the route**

In `backend/auto_trader/api/routers/backtest.py`, directly ABOVE the `list_runs` route (line ~429), add:

```python
class RunArchiveIn(BaseModel):
    """A completed run the frontend archives explicitly. Exists for remote job
    runs (which execute with persist=False so nothing lands on the remote
    host's DB); the record shape matches what the synchronous handler stores,
    so the runs read API serves both identically."""
    epic: str
    timeframe: str
    rangeFrom: int
    rangeTo: int
    strategyKind: str
    strategyName: str | None = None
    request: dict
    summary: dict
    trades: list[dict]


@router.post("/api/backtest/runs")
async def save_run(body: RunArchiveIn) -> dict:
    """Archive a completed run (remote jobs persist through here; local runs
    persist inside the handler and never call this)."""
    request_dump = dict(body.request)
    for bulky in ("candles", "series", "sweep"):
        request_dump.pop(bulky, None)
    run_id = uuid.uuid4().hex
    await RUN_STORE.insert({
        "id": run_id,
        "created_at": int(time.time()),
        "epic": body.epic,
        "timeframe": body.timeframe,
        "range_from": body.rangeFrom,
        "range_to": body.rangeTo,
        "strategy_kind": body.strategyKind,
        "strategy_name": body.strategyName,
        "request": request_dump,
        "summary": body.summary,
        "trades": body.trades,
    })
    return {"id": run_id}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest tests/test_api_backtest_runs_archive.py tests/test_api_backtest_analysis.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_runs_archive.py
git commit -m "feat(backtest): POST /api/backtest/runs archives a completed run locally"
```

---

### Task 5: Frontend API — `ComputeTarget` rename + job functions + run archive

Rename `SweepTarget` to `ComputeTarget` (it now drives both modes; no-legacy rule: no alias), add the three job functions and the archive helper to `frontend/src/api.ts`.

**Files:**
- Modify: `frontend/src/api.ts` (the sweep-jobs section, lines ~493-567)
- Modify: `frontend/src/lib/sweep.ts`, `frontend/src/lib/sweepResume.ts`, `frontend/src/lib/signals.ts` (type-name references only in this task; the signal rename itself is Task 6)
- Test: `frontend/src/api.backtestJobs.test.ts`

**Interfaces:**
- Produces, in `api.ts`:
  - `export type ComputeTarget = "local" | "remote";` (replaces `SweepTarget`; every import site updates)
  - `export interface BacktestJobStatus { running: boolean; cancelled: boolean; error: string | null; result: BacktestResult | null; }`
  - `export async function submitBacktestJob(req: BacktestRequest, target: ComputeTarget): Promise<{ jobId: string }>`
  - `export async function pollBacktestJob(jobId: string, target: ComputeTarget): Promise<BacktestJobStatus>`
  - `export async function cancelBacktestJob(jobId: string, target: ComputeTarget): Promise<void>`
  - `export async function archiveBacktestRun(req: BacktestRequest, result: BacktestResult): Promise<{ id: string }>`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/api.backtestJobs.test.ts` (mirror the fetch-mocking style used elsewhere; a plain `vi.stubGlobal` works):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveBacktestRun,
  cancelBacktestJob,
  pollBacktestJob,
  submitBacktestJob,
  type BacktestRequest,
  type BacktestResult,
} from "./api";

const EMPTY_GROUP = { combine: "AND" as const, rules: [] };

function req(): BacktestRequest {
  return {
    epic: "EURUSD",
    resolution: "MINUTE_5",
    candles: [
      { time: 100, open: 1, high: 1, low: 1, close: 1, volume: 0 },
      { time: 160, open: 1, high: 1, low: 1, close: 1, volume: 0 },
    ],
    series: { big: [1, 2] },
    longEntry: EMPTY_GROUP, longExit: EMPTY_GROUP,
    shortEntry: EMPTY_GROUP, shortExit: EMPTY_GROUP,
    longEnabled: true, shortEnabled: true,
    costs: { quantity: 1, commissionPerSide: 0, slippage: { kind: "fixed", value: 0 }, startingCash: 10000 } as never,
    tradeFromTime: 100,
  };
}

function mockFetch(body: unknown) {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("backtest job api", () => {
  it("submit posts to /api/backtest/jobs and tags remote", async () => {
    const fn = mockFetch({ jobId: "j1" });
    await submitBacktestJob(req(), "remote");
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toContain("/api/backtest/jobs?target=remote");
    expect(init.method).toBe("POST");
  });

  it("poll hits the job id and returns the status", async () => {
    const fn = mockFetch({ running: false, cancelled: false, error: null, result: { epic: "EURUSD" } });
    const status = await pollBacktestJob("j1", "local");
    expect(String(fn.mock.calls[0][0])).toContain("/api/backtest/jobs/j1");
    expect(String(fn.mock.calls[0][0])).not.toContain("target=remote");
    expect(status.result).toEqual({ epic: "EURUSD" });
  });

  it("cancel posts to the cancel route", async () => {
    const fn = mockFetch({ ok: true });
    await cancelBacktestJob("j1", "remote");
    expect(String(fn.mock.calls[0][0])).toContain("/api/backtest/jobs/j1/cancel?target=remote");
  });

  it("archive strips bulky request keys and merges summary+metrics", async () => {
    const fn = mockFetch({ id: "run1" });
    const result = {
      summary: { net_pnl: 5 },
      metrics: { sharpe: 1.2 },
      trades: [{ pnl: 5 }],
    } as unknown as BacktestResult;
    const { id } = await archiveBacktestRun(req(), result);
    expect(id).toBe("run1");
    const body = JSON.parse(fn.mock.calls[0][1].body);
    expect(body.epic).toBe("EURUSD");
    expect(body.rangeFrom).toBe(100);
    expect(body.rangeTo).toBe(160);
    expect(body.strategyKind).toBe("rules");
    expect(body.summary).toEqual({ net_pnl: 5, sharpe: 1.2 });
    expect(body.request.candles).toBeUndefined();
    expect(body.request.series).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/api.backtestJobs.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement**

In `frontend/src/api.ts`:

1. Rename the type (line ~493) and update the comment:

```ts
// Where a run or sweep computes: "local" is the backend process serving the
// UI; "remote" tags the request so the backend forwards it to remote compute.
export type ComputeTarget = "local" | "remote";
```

2. Update every `SweepTarget` reference to `ComputeTarget` in: `api.ts` (`sweepJobsBase`, `submitSweepJob`, `pollSweepJob`, `cancelSweepJob`), `lib/sweep.ts` (import at line ~13, `lastJob`/`getLastSweepJob` at ~243, `pollToCompletion` at ~276, `runSweep` opts at ~334/344), `lib/sweepResume.ts`, `lib/signals.ts` (import at line 440 and the `loadSweepTarget` uses; the full signal rename is Task 6 but the TYPE import must compile now).

3. After `cancelSweepJob` (line ~550), add:

```ts
// --- single-run backtest jobs ---------------------------------------------
// The job path exists for remote runs (submit/poll/cancel survives Fly cold
// starts and long runs); local single runs keep the synchronous runBacktest.

// One poll of a running backtest job. `result` is the complete BacktestResult,
// set only when the job finished cleanly.
export interface BacktestJobStatus {
  running: boolean;
  cancelled: boolean;
  error: string | null;
  result: BacktestResult | null;
}

const btTargetQS = (target: ComputeTarget, first = true) =>
  target === "remote" ? `${first ? "?" : "&"}target=remote` : "";

export async function submitBacktestJob(
  req: BacktestRequest,
  target: ComputeTarget,
): Promise<{ jobId: string }> {
  const res = await fetch(`${BASE}/api/backtest/jobs${btTargetQS(target)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `backtest submit failed (${res.status})`));
  return res.json();
}

export async function pollBacktestJob(
  jobId: string,
  target: ComputeTarget,
): Promise<BacktestJobStatus> {
  const res = await fetch(`${BASE}/api/backtest/jobs/${jobId}${btTargetQS(target)}`);
  if (!res.ok) throw new Error(await errorDetail(res, `backtest poll failed (${res.status})`));
  return res.json();
}

export async function cancelBacktestJob(jobId: string, target: ComputeTarget): Promise<void> {
  const res = await fetch(`${BASE}/api/backtest/jobs/${jobId}/cancel${btTargetQS(target)}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await errorDetail(res, `backtest cancel failed (${res.status})`));
}

// Persist a completed run into the LOCAL backend's run store. Exists for
// remote job runs (which execute with persist off, so nothing lands on the
// remote host's DB); mirrors the record shape the local handler stores.
export async function archiveBacktestRun(
  req: BacktestRequest,
  result: BacktestResult,
): Promise<{ id: string }> {
  const { candles, series, ...request } = req;
  const res = await fetch(`${BASE}/api/backtest/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      epic: req.epic,
      timeframe: req.resolution,
      rangeFrom: candles[0]?.time ?? req.tradeFromTime,
      rangeTo: candles[candles.length - 1]?.time ?? req.tradeFromTime,
      strategyKind: req.codedStrategy != null ? "coded" : "rules",
      strategyName: req.codedStrategy ?? null,
      request,
      summary: { ...result.summary, ...result.metrics },
      trades: result.trades,
    }),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `run archive failed (${res.status})`));
  return res.json();
}
```

(Check the `BacktestResult` interface for the exact `summary`/`metrics`/`trades` field names before wiring `archiveBacktestRun`; adjust if they differ.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/api.backtestJobs.test.ts && npx tsc --noEmit`
Expected: tests PASS; tsc clean (all `SweepTarget` references updated).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/api.ts frontend/src/lib/sweep.ts frontend/src/lib/sweepResume.ts frontend/src/lib/signals.ts frontend/src/api.backtestJobs.test.ts
git commit -m "feat(api): backtest job endpoints + run archive; SweepTarget -> ComputeTarget"
```

---

### Task 6: `runBacktestViaJob` poll loop + signal rename `computeTargetSignal`

The submit/poll loop for single runs (analog of `runSweep`/`pollToCompletion` in `lib/sweep.ts:274-322`, simplified: no rows/cursor, no re-attach). Plus the signal + persist-key rename so one toggle drives both modes.

**Files:**
- Create: `frontend/src/lib/backtestJob.ts`
- Modify: `frontend/src/lib/sweep.ts` (export the private `sleep` helper at line ~253)
- Modify: `frontend/src/lib/signals.ts` (lines ~485-508: rename + add cancel-request signal)
- Modify: `frontend/src/lib/persist/core.ts` (line 143: key rename)
- Modify: `frontend/src/BacktestSettingsModal.tsx`, `frontend/src/BacktestButton.tsx`, `frontend/src/BacktestSettingsModal.test.tsx` (rename call sites)
- Test: `frontend/src/lib/backtestJob.test.ts`

**Interfaces:**
- Consumes: `submitBacktestJob`, `pollBacktestJob`, `cancelBacktestJob` (Task 5).
- Produces:
  - `export async function runBacktestViaJob(req: BacktestRequest, target: ComputeTarget, signal?: AbortSignal): Promise<BacktestResult>` in `lib/backtestJob.ts`. Throws `Error("backtest aborted")` on abort/cancel; throws the job's error message on failure; tolerates up to 5 consecutive poll failures.
  - In `signals.ts`: `computeTargetSignal: Signal<ComputeTarget>`, `saveComputeTarget(t: ComputeTarget): void` (persist key `${PREFIX}.computeTarget`), `backtestCancelRequest: Signal<number>`, `requestBacktestCancel(): void`.
  - In `lib/sweep.ts`: `export function sleep(ms: number, signal?: AbortSignal): Promise<void>` (existing helper, now exported).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/backtestJob.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBacktestViaJob } from "./backtestJob";
import * as api from "../api";
import type { BacktestRequest, BacktestResult } from "../api";

const REQ = { epic: "EURUSD" } as unknown as BacktestRequest;
const RESULT = { epic: "EURUSD", trades: [] } as unknown as BacktestResult;

function status(over: Partial<api.BacktestJobStatus>): api.BacktestJobStatus {
  return { running: true, cancelled: false, error: null, result: null, ...over };
}

afterEach(() => vi.restoreAllMocks());

describe("runBacktestViaJob", () => {
  it("submits, polls until done, returns the result", async () => {
    vi.spyOn(api, "submitBacktestJob").mockResolvedValue({ jobId: "j1" });
    const poll = vi
      .spyOn(api, "pollBacktestJob")
      .mockResolvedValueOnce(status({}))
      .mockResolvedValueOnce(status({ running: false, result: RESULT }));
    const res = await runBacktestViaJob(REQ, "remote");
    expect(res).toBe(RESULT);
    expect(poll).toHaveBeenCalledWith("j1", "remote");
  });

  it("throws the job error on failure", async () => {
    vi.spyOn(api, "submitBacktestJob").mockResolvedValue({ jobId: "j1" });
    vi.spyOn(api, "pollBacktestJob").mockResolvedValue(status({ running: false, error: "no candles" }));
    await expect(runBacktestViaJob(REQ, "remote")).rejects.toThrow("no candles");
  });

  it("cancels the server job and throws on abort", async () => {
    vi.spyOn(api, "submitBacktestJob").mockResolvedValue({ jobId: "j1" });
    vi.spyOn(api, "pollBacktestJob").mockResolvedValue(status({}));
    const cancel = vi.spyOn(api, "cancelBacktestJob").mockResolvedValue();
    const ctl = new AbortController();
    const p = runBacktestViaJob(REQ, "remote", ctl.signal);
    ctl.abort();
    await expect(p).rejects.toThrow("backtest aborted");
    expect(cancel).toHaveBeenCalledWith("j1", "remote");
  });

  it("tolerates transient poll failures, gives up after 5 consecutive", async () => {
    vi.spyOn(api, "submitBacktestJob").mockResolvedValue({ jobId: "j1" });
    const poll = vi
      .spyOn(api, "pollBacktestJob")
      .mockRejectedValueOnce(new Error("502"))
      .mockResolvedValueOnce(status({ running: false, result: RESULT }));
    const res = await runBacktestViaJob(REQ, "remote");
    expect(res).toBe(RESULT);
    expect(poll).toHaveBeenCalledTimes(2);

    vi.spyOn(api, "pollBacktestJob").mockRejectedValue(new Error("502"));
    await expect(runBacktestViaJob(REQ, "remote")).rejects.toThrow("502");
  }, 20_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/backtestJob.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement**

In `frontend/src/lib/sweep.ts`, change `function sleep(` (line ~253) to `export function sleep(` and note in its doc comment that `lib/backtestJob.ts` shares it.

Create `frontend/src/lib/backtestJob.ts`:

```ts
// Single-run backtest over the job API (submit -> poll -> result). Exists for
// target=remote, where one synchronous POST can't ride out a Fly cold start or
// a long run; local single runs keep the synchronous runBacktest path.
import {
  cancelBacktestJob,
  pollBacktestJob,
  submitBacktestJob,
  type BacktestJobStatus,
  type BacktestRequest,
  type BacktestResult,
  type ComputeTarget,
} from "../api";
import { sleep } from "./sweep";

const BT_POLL_MS = 700;

/** Submit the run as a job and poll to completion. Abort cancels the server
 * job (best effort) and rejects with "backtest aborted" — same message a
 * backend-side cancel produces, so callers treat both identically. Transient
 * poll failures (a proxy 502 during a Fly hiccup) don't tear the run down:
 * up to 5 CONSECUTIVE failures are tolerated, mirroring pollToCompletion. */
export async function runBacktestViaJob(
  req: BacktestRequest,
  target: ComputeTarget,
  signal?: AbortSignal,
): Promise<BacktestResult> {
  if (signal?.aborted) throw new Error("backtest aborted");
  const { jobId } = await submitBacktestJob(req, target);
  let consecutiveFailures = 0;
  for (;;) {
    await sleep(BT_POLL_MS, signal);
    if (signal?.aborted) {
      cancelBacktestJob(jobId, target).catch(() => {});
      throw new Error("backtest aborted");
    }
    let status: BacktestJobStatus;
    try {
      status = await pollBacktestJob(jobId, target);
    } catch (e) {
      if (++consecutiveFailures >= 5) throw e;
      continue;
    }
    consecutiveFailures = 0;
    if (!status.running) {
      if (status.cancelled) throw new Error("backtest aborted");
      if (status.error) throw new Error(status.error);
      return status.result!;
    }
  }
}
```

In `frontend/src/lib/signals.ts` (lines ~485-508):

1. Rename the target signal block:

```ts
// Where runs and sweeps compute ("local" | "remote"), device-local, defaulting
// to "local". The compute-target toggle writes it via saveComputeTarget; the
// sweep and single-run submitters read computeTargetSignal.value at run time.
function loadComputeTarget(): ComputeTarget {
  return load<ComputeTarget>(`${PREFIX}.computeTarget`, "local") === "remote" ? "remote" : "local";
}
export function saveComputeTarget(t: ComputeTarget): void {
  saveLocal(`${PREFIX}.computeTarget`, t);
}
export const computeTargetSignal = new Signal<ComputeTarget>(loadComputeTarget());
```

(and change the type import at line 440 to `ComputeTarget` if Task 5 hasn't already).

2. Next to `sweepCancelRequest` (line ~485), add:

```ts
// Bumped by the modal's Cancel button while a REMOTE single backtest is in
// flight; BacktestButton aborts its job poll on it (mirrors sweepCancelRequest,
// minus the keep-server-job option: a single run is always killed).
export const backtestCancelRequest = new Signal<number>(0);
export function requestBacktestCancel(): void {
  backtestCancelRequest.set(backtestCancelRequest.value + 1);
}
```

In `frontend/src/lib/persist/core.ts` line 143, change `` `${PREFIX}.sweepTarget`, `` to `` `${PREFIX}.computeTarget`, ``.

Rename remaining call sites (compile-driven): `BacktestSettingsModal.tsx` lines 27-28 (imports), 828-829 (`sweepTarget` state can keep its local name but read `computeTargetSignal`), 2711 (`computeTargetSignal.set(t); saveComputeTarget(t);`); `BacktestButton.tsx` lines 55, 369; `BacktestSettingsModal.test.tsx` lines 64, 1054, 1106-1107 (the localStorage assertion becomes `"auto-trader.computeTarget"`).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/backtestJob.test.ts src/BacktestSettingsModal.test.tsx && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/backtestJob.ts frontend/src/lib/backtestJob.test.ts frontend/src/lib/sweep.ts frontend/src/lib/signals.ts frontend/src/lib/persist/core.ts frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestButton.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(backtest): runBacktestViaJob poll loop; sweepTargetSignal -> computeTargetSignal"
```

---

### Task 7: Wire the remote path through `runAndRender` + BacktestButton, with Cancel

`runAndRender` (`frontend/src/lib/backtest.ts:1027`) gains an optional result fetcher; `BacktestButton.run()`'s single-run branch passes a remote fetcher (job poll + local archive) when the target is remote, wires the cancel signal, and treats an abort as a cancellation (warning, not error). The modal shows the Local/Remote toggle in Backtest mode too and a Cancel button while a remote single run is in flight.

**Files:**
- Modify: `frontend/src/lib/backtest.ts` (`runAndRender`, line ~1027)
- Modify: `frontend/src/BacktestButton.tsx` (single-run branch, lines ~428-464 + imports)
- Modify: `frontend/src/BacktestSettingsModal.tsx` (toggle visibility ~2697, `runClusterLead` ~1605)
- Test: `frontend/src/BacktestSettingsModal.test.tsx` (toggle visibility in backtest mode)

**Interfaces:**
- Consumes: `runBacktestViaJob` (Task 6), `archiveBacktestRun` (Task 5), `computeTargetSignal`/`backtestCancelRequest`/`requestBacktestCancel` (Task 6).
- Produces: `runAndRender(chart, req, scope, displayResolution, period?, fetchResult?)` where `fetchResult?: (req: BacktestRequest) => Promise<BacktestResult>` defaults to the existing synchronous `runBacktest`.

- [ ] **Step 1: Write the failing test (toggle in backtest mode)**

In `frontend/src/BacktestSettingsModal.test.tsx`, next to the existing sweep-target toggle test (~line 1054), add a test asserting the Local/Remote toggle renders in BACKTEST mode (no sweep axes) when remote compute is configured. Follow the existing test's setup exactly (it already mocks `computeStatus` to `{ remoteConfigured: true }`); assert `screen.getByRole("group", { name: "Compute target" })` is present with `btMode` backtest, and that clicking "Remote" sets `computeTargetSignal.value === "remote"`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: the new test FAILS (toggle only renders in sweep mode).

- [ ] **Step 3: Implement**

**`lib/backtest.ts`** — `runAndRender` signature and first line:

```ts
export async function runAndRender(
  chart: Chart,
  req: BacktestRequest,
  scope: string,
  displayResolution: string,
  period?: BacktestPeriod,
  // How the result is produced: the synchronous local endpoint by default; the
  // remote job poll loop when the run targets remote compute. Everything after
  // the fetch (persist, render) is identical for both.
  fetchResult: (req: BacktestRequest) => Promise<BacktestResult> = runBacktest,
): Promise<StoredBacktestResult> {
  // Temporary phase timing (perf investigation).
  const t0 = performance.now();
  const result = await fetchResult(req);
```

**`BacktestButton.tsx`** — imports: add `archiveBacktestRun` to the `./api` import, `runBacktestViaJob` from `./lib/backtestJob`, and `computeTargetSignal, backtestCancelRequest` to the signals import (drop `sweepTargetSignal`). In `run()`, replace the single-run `runAndRender` call (line ~428) with:

```ts
      // Remote single run: the job poll loop replaces the synchronous POST,
      // and the finished result is archived into the LOCAL run store (remote
      // jobs skip server-side persistence so nothing strands on the remote
      // host's DB). The Cancel button in the modal aborts via
      // backtestCancelRequest. Local runs keep the synchronous path untouched.
      const target = computeTargetSignal.value;
      const btCtl = target === "remote" ? new AbortController() : null;
      const unsubBtCancel = btCtl
        ? backtestCancelRequest.subscribe(() => btCtl.abort())
        : null;
      const remoteFetch = btCtl
        ? async (r: BacktestRequest) => {
            const result = await runBacktestViaJob(r, "remote", btCtl.signal);
            try {
              const { id } = await archiveBacktestRun(r, result);
              result.run_id = id;
            } catch (e) {
              console.warn("run archive failed; result won't appear in run history", e);
            }
            return result;
          }
        : undefined;
      let res: StoredBacktestResult;
      try {
        res = await runAndRender(
          chart,
          baseReq,
          controller!.scope,
          period.resolution,
          {
            fromMs: windowFromMs,
            toMs: windowToMs,
            mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
          },
          remoteFetch,
        );
      } catch (e) {
        // A user Cancel rejects the same promise as a real failure; the abort
        // signal (not the message) says which happened. Cancel is a warning,
        // never the red error box.
        if (btCtl?.signal.aborted) {
          setWarning("backtest cancelled");
          return;
        }
        throw e;
      } finally {
        unsubBtCancel?.();
      }
```

(The lines after it, from `backtestResultSignal.set(res);` on, are unchanged.)

**`BacktestSettingsModal.tsx`**:

1. Toggle visibility (line ~2697). Replace the condition and tooltip copy:

```tsx
              {(btMode === "backtest" || sweepAxes.length > 0) && remoteCompute && (
                <span className="bt-compute-toggle">
                  <span className="seg" role="group" aria-label="Compute target">
                    {(["local", "remote"] as const).map((t) => (
                      <Tooltip
                        key={t}
                        content={t === "local"
                          ? "Run on this machine."
                          : "Run on the remote compute host."}
                      >
                        <button
                          type="button"
                          className={computeTarget === t ? "seg-on" : ""}
                          aria-pressed={computeTarget === t}
                          onClick={() => { computeTargetSignal.set(t); saveComputeTarget(t); }}
                        >
                          {t === "local" ? "Local" : "Remote"}
                        </button>
                      </Tooltip>
                    ))}
                  </span>
                </span>
              )}
```

(`computeTarget` is the Task 6 rename of the `sweepTarget` state at line ~828.)

2. Cancel button. Extend `runClusterLead` (line ~1605) so a remote single run gets one:

```tsx
  const runClusterLead =
    btMode === "sweep" && sweepState ? (
      sweepState.running ? (
        <button className="ghost" onClick={() => requestSweepCancel(true)}>
          Cancel sweep
        </button>
      ) : (
        <button className="ghost" onClick={clearSweepResults}>
          Clear results
        </button>
      )
    ) : btMode === "backtest" && runInFlight && computeTarget === "remote" ? (
      // A remote single run is cancellable (the job API has a cancel route);
      // a local one is not — it is one synchronous request.
      <button className="ghost" onClick={() => requestBacktestCancel()}>
        Cancel
      </button>
    ) : null;
```

Import `requestBacktestCancel` from `./lib/signals`. (`runInFlight` already exists in the modal; verify its exact name near the `durationBusy` block at line ~1618 and reuse it.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestSettingsModal.test.tsx src/lib/backtestJob.test.ts && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/auto_trader
git add frontend/src/lib/backtest.ts frontend/src/BacktestButton.tsx frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(backtest): remote single-run path via job poll + Cancel + toggle in Backtest mode"
```

---

### Task 8: Full-suite pass + live verification against the Fly host

**Files:** none (verification only).

- [ ] **Step 1: Full backend suite**

Run: `cd /Users/mahmoudparham/auto_trader/backend && python -m pytest`
Expected: all PASS.

- [ ] **Step 2: Full frontend suite + typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run && npx tsc --noEmit`
Expected: all PASS / clean.

- [ ] **Step 3: Deploy the backend to the Fly compute host**

The remote host is a byte-identical backend copy; the new job routes must exist there before a remote run can work. Follow the existing deploy flow used for the sweep remote host (see `fly.toml` / deploy notes in the repo; the host is pinned at performance-16x). Deploy, then confirm `GET /api/compute/status` on the LOCAL backend still reports `remoteConfigured: true`.

- [ ] **Step 4: Manual verify (dev app, light theme)**

With the dev servers running (do not restart HMR servers):
1. Open the Backtest panel in Backtest mode; confirm the Local/Remote toggle shows.
2. Run the same config Local, then Remote. Confirm: results render identically on the chart, both runs appear in the run history (Analysis tab / runs list), and the remote run shows a "Took Ns" duration.
3. Start a Remote run and click Cancel; confirm the "backtest cancelled" warning shows, no error box, and no result renders.
4. Flip to Sweep mode; confirm the sweep toggle + remote sweep still work (regression).

- [ ] **Step 5: Commit any fixups, then stop**

If verification surfaced fixes, commit them individually. Implementation is complete after this task; use superpowers:finishing-a-development-branch conventions (work is already on main, so just confirm clean `git status`).

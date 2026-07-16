# Parallel Sweep Jobs + Remote Compute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sweeps become server-side jobs that run combos across all CPU cores, support mid-run cancel, survive tab close, and can optionally execute on a token-gated Fly.io deployment of the same backend.

**Architecture:** The chunked `/api/backtest/sweep` endpoint is replaced by a job API (`POST/GET/cancel` under `/api/backtest/sweep/jobs`). A job thread fans combos out over a `ProcessPoolExecutor`; workers are network-free (HTF candles pre-fetched by the parent; coded mode runs a probe combo first). The local backend proxies job calls to a remote host when `?target=remote`. Spec: `docs/superpowers/specs/2026-07-16-parallel-sweep-jobs-remote-compute-design.md`.

**Tech Stack:** FastAPI + pydantic v2 + `concurrent.futures.ProcessPoolExecutor` + httpx (backend); React + vitest (frontend); Fly.io Machines (deploy).

## Global Constraints

- **Work in a separate git worktree** (user instruction): create it via `superpowers:using-git-worktrees` before Task 1; commit to that worktree's branch, merge to main at the end.
- **No em dashes anywhere** (UI copy, comments, tests, docs): rephrase with colon/comma/period.
- **No legacy/back-compat code**: the chunk endpoint and chunk loop are deleted, not kept alongside.
- Backend tests: `cd backend && uv run pytest tests/<file> -x -q`. Frontend tests: `cd frontend && npx vitest run <file>`. Frontend typecheck: `cd frontend && npx tsc -b`.
- macOS spawns processes (no fork): worker state must come from the pool initializer, never inherited globals. `loader.STRATEGIES_DIR` is monkeypatched in tests, so the worker initializer must receive the strategies dir explicitly.
- New saveLocal-only flat persist keys MUST be added to `DEVICE_LOCAL_FLAT_KEYS` in `frontend/src/lib/persist/core.ts:117`.
- Row payload shape (`SweepRowDTO`) is frozen: `SweepResults` and consumers must not change.

---

### Task 1: Extract combo-apply + sync run cores into `sweep_apply.py`

Pure refactor: move the per-combo patch helpers and the engine-run bodies out of the router into an importable module with no FastAPI-handler coupling, so worker processes can use them. The router keeps thin async wrappers (they own HTF fetching).

**Files:**
- Create: `backend/auto_trader/api/sweep_apply.py`
- Modify: `backend/auto_trader/api/routers/backtest.py` (delete moved code, import instead)
- Test: existing `backend/tests/test_api_backtest_sweep.py`, `test_api_backtest_rule_sweep.py`, `test_api_backtest.py` (behavior must not change)

**Interfaces:**
- Produces (all in `auto_trader.api.sweep_apply`):
  - `apply_combo(req: BacktestRequest, combo: dict) -> tuple[dict, RiskConfigDTO | None, RiskConfigDTO | None]` (was `_apply_combo`)
  - `apply_rule_combo(req: BacktestRequest, combo: dict) -> BacktestRequest` (was `_apply_rule_combo`)
  - `split_env_combo(combo: dict) -> tuple[dict, dict]` (was `_split_env_combo`)
  - `apply_env_combo(req, candles, env) -> tuple[BacktestRequest, list[Candle]]` (was `_apply_env_combo`)
  - `sweep_row(req, combo, result) -> SweepRowDTO` (was `_sweep_row`)
  - `assemble_rule_series_sync(req, candles, htf_candles: dict[str, list[Candle]]) -> dict[str, list[float | None]]`: the body of `_assemble_rule_series` WITHOUT the fetch branch (htf_candles is required, never None)
  - `run_rule_sync(req, candles, htf_candles) -> BacktestResult`: `_run_rule`'s strategy+engine body calling `assemble_rule_series_sync`
  - `run_coded_sync(req, candles, module, resolved_params, long_risk_dto, short_risk_dto, htf_candles) -> BacktestResult`: `_run_coded`'s loop body, except `NeedTimeframe` is re-raised as `TimeframeNotPrefetched(need.timeframe)` instead of fetching
  - `class TimeframeNotPrefetched(Exception)` with attribute `.timeframe: str`
  - `candle_from_dto(c: CandleDTO) -> Candle` (move `_candle_from_dto` here; router re-imports)
  - `class SweepValidationError(Exception)` raised with `(status_code: int, detail: str)`; the moved helpers raise this instead of `HTTPException` so workers never import FastAPI response machinery. The router wraps calls: `except SweepValidationError as e: raise HTTPException(e.status_code, e.detail)`.

- [ ] **Step 1: Run the existing sweep tests to record the green baseline**

Run: `cd backend && uv run pytest tests/test_api_backtest_sweep.py tests/test_api_backtest_rule_sweep.py tests/test_api_backtest_sweep_dims.py -q`
Expected: all PASS (record the count).

- [ ] **Step 2: Create `sweep_apply.py`**

Move the functions listed under Interfaces from `routers/backtest.py` (they live between lines ~78-135 and ~530-720) into `backend/auto_trader/api/sweep_apply.py`. Keep their docstrings. Replace every `raise HTTPException(code, msg)` inside the moved helpers with `raise SweepValidationError(code, msg)`:

```python
"""Per-combo request patching + synchronous engine-run cores.

Importable by worker processes: no FastAPI app/deps imports, no network.
The router owns HTF fetching and wraps SweepValidationError into HTTPException.
"""
from __future__ import annotations

import re
from zoneinfo import ZoneInfo

from auto_trader.core.models import Candle
from auto_trader.core.resolutions import resolution_seconds  # match router's current import path
from auto_trader.engine.backtest import BacktestEngine, BacktestResult
from auto_trader.engine.metrics import compute_metrics, window_metrics  # match router's current import path
from auto_trader.strategy.rule import RuleStrategy, series_name
from auto_trader.strategy.rule_series import build_rule_series
# ... plus the DTO imports the moved code already uses (schemas module)


class SweepValidationError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class TimeframeNotPrefetched(Exception):
    def __init__(self, timeframe: str):
        super().__init__(f"timeframe '{timeframe}' not pre-fetched")
        self.timeframe = timeframe
```

Note: verify the exact import paths for `resolution_seconds`, `compute_metrics`, `window_metrics`, `_rule_operands`/`_rule_atr_lengths` helpers by reading the top of `routers/backtest.py`; move `_rule_operands` and `_rule_atr_lengths` too (they're pure).

`run_coded_sync` is `_run_coded` minus the fetch: same `for _ in range(_MAX_TF_PASSES)` loop, but the `except NeedTimeframe as need:` block becomes `raise TimeframeNotPrefetched(need.timeframe)`. Move `_MAX_TF_PASSES` here.

- [ ] **Step 3: Repoint the router**

In `routers/backtest.py`: import the moved names from `..sweep_apply`, keep `_run_rule`/`_run_coded` as thin async wrappers:

```python
async def _run_rule(req, candles, htf_candles=None):
    if htf_candles is None:
        htf_candles = await _fetch_rule_htf(req)   # extract the existing fetch loop into this helper
    return run_rule_sync(req, candles, htf_candles)


async def _run_coded(req, candles, module, resolved_params, long_risk_dto, short_risk_dto, htf_candles):
    while True:
        try:
            result = run_coded_sync(req, candles, module, resolved_params,
                                    long_risk_dto, short_risk_dto, htf_candles)
            return result, None
        except TimeframeNotPrefetched as need:
            warmup_from = req.candles[0].time - _HTF_WARMUP_BARS * resolution_seconds(need.timeframe)
            fetched = await deps._fetch_symbol_candles(
                req.broker, req.epic, need.timeframe, 1000,
                warmup_from, req.candles[-1].time, req.priceSide)
            if not fetched:
                raise HTTPException(422, f"no candles for timeframe '{need.timeframe}'")
            htf_candles[need.timeframe] = fetched
```

CAREFUL: `_run_coded` currently returns `(result, strategy)` and the single-run route uses the strategy (check its call sites with `grep -n '_run_coded' routers/backtest.py` before changing the return type). If the strategy object is used, have `run_coded_sync` return `(result, strategy)` and thread it through. The `_MAX_TF_PASSES` bound moves into `run_coded_sync`; the wrapper's `while True` is bounded because `run_coded_sync` raises `SweepValidationError(422, "strategy needs too many timeframes (max 5)")` when it re-enters more than `_MAX_TF_PASSES` times: pass an accumulating `htf_candles` dict so each retry gets further. Simplest correct shape: keep the retry loop INSIDE `run_coded_sync` (it retries locally as long as the needed tf is already in `htf_candles`) and only raise `TimeframeNotPrefetched` when it isn't.

Wrap the sweep/backtest handlers' calls into the moved helpers with the `SweepValidationError -> HTTPException` translation (one small `_translate` context manager or try/except at each call site).

- [ ] **Step 4: Run the full backend test suite**

Run: `cd backend && uv run pytest -q`
Expected: same pass count as the baseline, zero failures.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/sweep_apply.py backend/auto_trader/api/routers/backtest.py
git commit -m "refactor(backtest): extract combo-apply + sync run cores into sweep_apply"
```

---

### Task 2: Worker module (`sweep_worker.py`) + determinism test

**Files:**
- Create: `backend/auto_trader/api/sweep_worker.py`
- Test: `backend/tests/test_sweep_worker.py`

**Interfaces:**
- Produces (in `auto_trader.api.sweep_worker`):
  - `worker_init(req_dict: dict, htf_candles: dict[str, list[Candle]], strategies_dir: str | None, windows: list[int] | None) -> None`: pool initializer; builds module-global `_STATE`.
  - `run_combo(combo: dict) -> dict`: runs one combo against `_STATE`, returns `SweepRowDTO(...).model_dump()`. Never raises: any exception becomes `{"combo": combo, "metrics": None, "windows": None, "error": str(e)}`.
- Consumes: everything from Task 1's `sweep_apply`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_sweep_worker.py`:

```python
"""Worker-process combo runner: init-once state, per-combo rows, determinism."""
import pytest
from concurrent.futures import ProcessPoolExecutor

import auto_trader.strategy.loader as loader
from auto_trader.api import sweep_worker
from auto_trader.api.schemas import BacktestRequest

from test_api_backtest_coded import base_request, make_candles

STRAT = '''
meta = {"params": [{"name": "n", "type": "int", "default": 3, "min": 1, "max": 50}]}
def on_bar(ctx):
    if ctx.param("n") == 13:
        raise RuntimeError("unlucky combo")
    if ctx.position.is_flat and len(ctx.closes) >= ctx.param("n"):
        return [ctx.buy(sl=ctx.close * 0.99, reason="go")]
    return []
'''


@pytest.fixture
def strat_dir(tmp_path):
    (tmp_path / "sweep.py").write_text(STRAT)
    return str(tmp_path)


def req_dict(candles):
    return {**base_request("sweep.py", candles), "sweep": {"combos": []}}


COMBOS = [{"param:n": 3}, {"param:n": 5}, {"param:n": 13}, {"param:n": 20}]


def rows_inline(candles, strat_dir):
    sweep_worker.worker_init(req_dict(candles), {}, strat_dir, None)
    return [sweep_worker.run_combo(c) for c in COMBOS]


def test_run_combo_rows_and_error_isolation(strat_dir):
    rows = rows_inline(make_candles(30), strat_dir)
    assert [r["combo"] for r in rows] == COMBOS
    assert rows[0]["error"] is None and rows[0]["metrics"]["n_trades"] > 0
    assert "unlucky" in rows[2]["error"] and rows[2]["metrics"] is None


def test_pool_matches_inline(strat_dir):
    candles = make_candles(30)
    inline = rows_inline(candles, strat_dir)
    with ProcessPoolExecutor(
        max_workers=2, initializer=sweep_worker.worker_init,
        initargs=(req_dict(candles), {}, strat_dir, None),
    ) as pool:
        pooled = list(pool.map(sweep_worker.run_combo, COMBOS))
    assert pooled == inline


def test_missing_htf_is_error_row_not_crash(strat_dir, tmp_path):
    (tmp_path / "mtf.py").write_text(
        'meta = {"params": []}\n'
        'def on_bar(ctx):\n'
        '    ctx.closes_tf("1h")\n'   # adjust to the real ctx HTF accessor: check strategy/coded docs/tests
        '    return []\n'
    )
    d = req_dict(make_candles(30))
    d["codedStrategy"] = "mtf.py"
    sweep_worker.worker_init(d, {}, str(tmp_path), None)
    row = sweep_worker.run_combo({})
    assert row["error"] is not None and "1h" in row["error"]
```

Before finalizing, check the real HTF accessor name used by coded strategies: `grep -n 'NeedTimeframe' backend/auto_trader/strategy/*.py` and mirror an existing MTF test from `tests/test_api_backtest_coded.py`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_sweep_worker.py -q`
Expected: FAIL with `ImportError` (module does not exist).

- [ ] **Step 3: Implement `sweep_worker.py`**

```python
"""ProcessPool worker for sweep combos.

State arrives ONCE via worker_init (spawn-safe: macOS has no fork). Workers do
zero network: HTF candles are pre-fetched by the parent; a coded strategy that
needs an unfetched timeframe yields an error row.
"""
from __future__ import annotations

from pathlib import Path
from types import ModuleType

from auto_trader.core.models import Candle
from auto_trader.api.schemas import BacktestRequest
from auto_trader.api import sweep_apply as sa
import auto_trader.strategy.loader as loader
from auto_trader.strategy.params import resolve_params, validate_params_schema  # match router's import


class _State:
    req: BacktestRequest
    candles: list[Candle]
    htf: dict[str, list[Candle]]
    module: ModuleType | None
    windows: list[int] | None


_STATE: _State | None = None


def worker_init(req_dict, htf_candles, strategies_dir, windows):
    global _STATE
    s = _State()
    s.req = BacktestRequest.model_validate(req_dict)
    s.candles = [sa.candle_from_dto(c) for c in s.req.candles]
    s.htf = htf_candles
    s.windows = windows
    s.module = None
    if s.req.codedStrategy is not None:
        if strategies_dir is not None:
            loader.STRATEGIES_DIR = Path(strategies_dir)
        s.module = loader.load_strategy(s.req.codedStrategy, loader.STRATEGIES_DIR)
    _STATE = s


def run_combo(combo: dict) -> dict:
    s = _STATE
    assert s is not None, "worker_init not called"
    req = s.req.model_copy(update={"sweep": s.req.sweep.model_copy(update={"windows": s.windows})}) \
        if s.windows is not None else s.req
    try:
        env, rest = sa.split_env_combo(combo)
        patched, candles = sa.apply_env_combo(req, s.candles, env)
        if s.module is None:
            patched = sa.apply_rule_combo(patched, rest)
            result = sa.run_rule_sync(patched, candles, dict(s.htf))
        else:
            params, long_risk, short_risk = sa.apply_combo(patched, rest)
            resolved = resolve_params(s.module, params)
            result = sa.run_coded_sync(patched, candles, s.module, resolved,
                                       long_risk, short_risk, dict(s.htf))
        return sa.sweep_row(req, combo, result).model_dump()
    except Exception as e:  # noqa: BLE001  one combo must never kill the worker
        return {"combo": combo, "metrics": None, "windows": None, "error": str(e)}
```

Check whether `run_coded_sync` returns `(result, strategy)` (Task 1 decision) and unpack accordingly. `sweep_row` reads `req.sweep.windows` and the `"period:from" not in combo` guard exactly like the old `_sweep_row`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_sweep_worker.py -q`
Expected: PASS (the pool test proves spawn-safety and determinism).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/sweep_worker.py backend/tests/test_sweep_worker.py
git commit -m "feat(sweep): process-pool worker with init-once state and error-row isolation"
```

---

### Task 3: Job manager (`sweep_jobs.py`)

**Files:**
- Create: `backend/auto_trader/api/sweep_jobs.py`
- Test: `backend/tests/test_sweep_jobs.py`

**Interfaces:**
- Produces (in `auto_trader.api.sweep_jobs`):

```python
@dataclass
class SweepJob:
    job_id: str                      # uuid4 hex
    epic: str
    timeframe: str
    total: int
    rows: list[dict]                 # SweepRowDTO dumps, completion order
    done: int = 0
    running: bool = True
    cancelled: bool = False
    error: str | None = None
    eta_seconds: float | None = None
    created_at: float = 0.0          # time.time()

class SweepJobManager:
    def submit(self, *, req_dict, htf_candles, strategies_dir, windows,
               combos, epic, timeframe, probe_row: dict | None,
               workers: int | None = None) -> SweepJob
    def get(self, job_id) -> SweepJob | None
    def cancel(self, job_id) -> bool          # False if unknown/finished
    def list(self) -> list[SweepJob]          # newest first, running + recent
JOBS = SweepJobManager()                       # module singleton
SWEEP_WORKERS: int                             # env SWEEP_WORKERS, default os.cpu_count()
```
- Consumes: `sweep_worker.worker_init` / `run_combo` (Task 2).

Behavior:
- `submit` appends `probe_row` (if given) to `rows` with `done=1`, then starts one `threading.Thread(target=_run, daemon=True)`.
- `_run`: FIFO gate on a module-level `threading.Semaphore(1)` (one job computes at a time; queued jobs show `running=True, done=0`). Creates `ProcessPoolExecutor(max_workers=workers or SWEEP_WORKERS, initializer=worker_init, initargs=(...))`, submits every remaining combo, iterates `as_completed`, and under a `threading.Lock` appends each row, bumps `done`, updates `eta_seconds = mean_secs_per_combo * (total - done) / max_workers`.
- Cancel: sets `job.cancelled`; the `as_completed` loop checks it each iteration, calls `pool.shutdown(wait=False, cancel_futures=True)`, waits up to 10s for in-flight futures, then `for p in pool._processes.values(): p.kill()` (private attr, acceptable: single-user tool; comment it). Job ends `running=False, cancelled=True`, keeping accumulated rows.
- Any unexpected `_run` exception: `job.error = str(e)`, `running=False`.
- Store: `dict[str, SweepJob]`; `list()`/`get()` prune finished jobs older than 3600s.
- For tests, `submit` takes `workers` and the manager takes an optional `pool_factory` constructor argument (`SweepJobManager(pool_factory=ProcessPoolExecutor)`) so a test can inject a threads-based fake; default stays the real pool.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_sweep_jobs.py`:

```python
"""Sweep job manager: accumulation, FIFO, cancel, TTL. Uses the REAL process
pool with the tiny coded fixture (fast: 30 candles, 4 combos)."""
import time
import pytest

from auto_trader.api.sweep_jobs import SweepJobManager
from test_api_backtest_coded import base_request, make_candles
from test_sweep_worker import STRAT, COMBOS  # reuse fixture strategy + combos


@pytest.fixture
def strat_dir(tmp_path):
    (tmp_path / "sweep.py").write_text(STRAT)
    return str(tmp_path)


def submit(mgr, strat_dir, combos, candles=None, **kw):
    req = {**base_request("sweep.py", candles or make_candles(30)), "sweep": {"combos": []}}
    return mgr.submit(req_dict=req, htf_candles={}, strategies_dir=strat_dir,
                      windows=None, combos=combos, epic="X", timeframe="MINUTE",
                      probe_row=None, workers=2, **kw)


def wait(job, timeout=60):
    t0 = time.time()
    while job.running and time.time() - t0 < timeout:
        time.sleep(0.05)
    assert not job.running, "job did not finish in time"


def test_rows_accumulate_to_done(strat_dir):
    mgr = SweepJobManager()
    job = submit(mgr, strat_dir, COMBOS)
    wait(job)
    assert job.done == job.total == 4
    assert sorted(str(r["combo"]) for r in job.rows) == sorted(str(c) for c in COMBOS)
    errs = [r for r in job.rows if r["error"]]
    assert len(errs) == 1 and "unlucky" in errs[0]["error"]  # param:n 13 row


def test_probe_row_counts(strat_dir):
    mgr = SweepJobManager()
    probe = {"combo": COMBOS[0], "metrics": None, "windows": None, "error": None}
    job = submit(mgr, strat_dir, COMBOS[1:], probe_row=probe)
    assert job.rows[0] == probe and job.done == 1
    wait(job)
    assert job.done == job.total == 4


def test_cancel_stops_and_keeps_partial(strat_dir, tmp_path):
    (tmp_path / "sweep.py").write_text(
        STRAT.replace("return []", "import time; time.sleep(0.3); return []"))
    mgr = SweepJobManager()
    job = submit(mgr, str(tmp_path), [{"param:n": i} for i in range(3, 43)])
    time.sleep(1.0)                       # let a few combos land
    assert mgr.cancel(job.job_id) is True
    wait(job, timeout=15)
    assert job.cancelled is True and 0 < job.done < job.total


def test_get_and_list_and_unknown_cancel(strat_dir):
    mgr = SweepJobManager()
    job = submit(mgr, strat_dir, COMBOS)
    assert mgr.get(job.job_id) is job
    assert mgr.list()[0] is job
    assert mgr.cancel("nope") is False
    wait(job)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_sweep_jobs.py -q`
Expected: FAIL with `ImportError`.

- [ ] **Step 3: Implement `sweep_jobs.py` per the Interfaces block**

Key excerpt (thread body):

```python
def _run(self, job: SweepJob, init: tuple, combos: list[dict], workers: int) -> None:
    with _GATE:                                   # threading.Semaphore(1), FIFO
        if job.cancelled:
            job.running = False
            return
        t0 = time.monotonic()
        try:
            with self._pool_factory(max_workers=workers,
                                    initializer=sweep_worker.worker_init,
                                    initargs=init) as pool:
                futures = [pool.submit(sweep_worker.run_combo, c) for c in combos]
                for fut in as_completed(futures):
                    if job.cancelled:
                        pool.shutdown(wait=False, cancel_futures=True)
                        _reap(pool, futures, grace=10.0)
                        break
                    row = fut.result()
                    with self._lock:
                        job.rows.append(row)
                        job.done += 1
                        pace = (time.monotonic() - t0) / max(1, job.done - self._probe_offset(job))
                        job.eta_seconds = pace * (job.total - job.done)
        except Exception as e:                    # noqa: BLE001
            job.error = str(e)
        finally:
            job.running = False
```

`_reap` waits up to `grace` seconds for still-running futures, then kills `pool._processes` (with the comment justifying the private attribute).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_sweep_jobs.py -q`
Expected: PASS. The cancel test is timing-based; if flaky, raise the sleep in the slow strategy, not the tolerances.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/sweep_jobs.py backend/tests/test_sweep_jobs.py
git commit -m "feat(sweep): job manager with process pool, FIFO gate, cancel + ETA"
```

---

### Task 4: Job API endpoints, delete the chunk endpoint, port tests

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py` (delete `backtest_sweep` handler + `_SWEEP_MAX_COMBOS`; add 4 job handlers)
- Modify: `backend/auto_trader/api/schemas.py` (add job DTOs; delete `SweepResponse`; remove `done`/`total` from `SweepDTO`)
- Modify: `backend/tests/test_api_backtest_sweep.py`, `test_api_backtest_rule_sweep.py`, `test_api_backtest_sweep_dims.py` (port to job API)
- Test: same files

**Interfaces:**
- Produces (HTTP):
  - `POST /api/backtest/sweep/jobs` body: today's `BacktestRequest` with `sweep.combos` = full list. Response `{"jobId": str, "total": int}`.
  - `GET /api/backtest/sweep/jobs/{job_id}?cursor=0` response: `{"rows": [...], "done": int, "total": int, "running": bool, "cancelled": bool, "error": str | None, "etaSeconds": float | None}` where `rows` is `job.rows[cursor:]`.
  - `POST /api/backtest/sweep/jobs/{job_id}/cancel` response `{"ok": true}` (404 unknown job).
  - `GET /api/backtest/sweep/jobs` response: `[{"jobId", "epic", "timeframe", "done", "total", "running", "createdAt"}]`.
- Schemas: `SweepJobSubmitResponse`, `SweepJobStatusResponse`, `SweepJobInfoDTO` (pydantic models matching the shapes above).

Submit handler logic (async, in the router):
1. Validate exactly what the old handler validated: combos non-empty, windows ascending, chart-operand series present (rule mode), coded module loads + swept params declared (coded mode). All 422 at submit. The `_SWEEP_MAX_COMBOS` cap is deleted, not raised.
2. Rule mode: fetch the HTF set (the existing loop, now `_fetch_rule_htf(req)`), `probe_row = None`.
3. Coded mode: run combo `combos[0]` in the handler via the existing async `_run_coded` path with a fresh `htf_candles={}` dict (this is the probe: it discovers and fetches NeedTimeframe TFs). Build `probe_row = sweep_row(req_with_windows, combos[0], result).model_dump()`; on exception build an error row. Pass the populated `htf_candles` and `combos[1:]` to `JOBS.submit`.
4. `strategies_dir = str(loader.STRATEGIES_DIR) if req.codedStrategy else None`.
5. `req_dict = req.model_dump(mode="json")` (workers rehydrate; `htf_candles` travel as pickled `Candle` lists via initargs).

- [ ] **Step 1: Port the three sweep test files to the job API**

Replace direct `client.post("/api/backtest/sweep", ...)` calls with a helper at the top of `test_api_backtest_sweep.py` (import it from there in the other two files):

```python
def run_sweep_via_jobs(client, req, timeout=60):
    """Submit a sweep job and poll it to completion; returns rows in combo order."""
    import time
    sub = client.post("/api/backtest/sweep/jobs", json=req)
    assert sub.status_code == 200, sub.text
    job_id, total = sub.json()["jobId"], sub.json()["total"]
    rows, t0 = [], time.time()
    while time.time() - t0 < timeout:
        st = client.get(f"/api/backtest/sweep/jobs/{job_id}", params={"cursor": len(rows)}).json()
        rows += st["rows"]
        if not st["running"]:
            assert st["error"] is None, st["error"]
            break
        time.sleep(0.05)
    assert len(rows) == total
    order = {str(c): i for i, c in enumerate(req["sweep"]["combos"])}
    return sorted(rows, key=lambda r: order[str(r["combo"])])
```

Delete the two log-position tests (`test_sweep_logs_position_with_done_total`, `test_sweep_logs_chunk_local_without_progress`): chunk positions no longer exist. Add their replacement: one log line per job (`sweep <epic> <tf>: N combos (rule|coded mode)` at submit, `sweep job done in Xs: N ok, M failed` at completion) and assert it. 422-path tests (bad targets, undeclared params, missing series) now hit the submit endpoint and stay synchronous: port them by changing the URL only.

- [ ] **Step 2: Run ported tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_api_backtest_sweep.py -q`
Expected: FAIL with 404 (job endpoints don't exist yet).

- [ ] **Step 3: Implement the handlers, delete the old one**

Delete `backtest_sweep`, `_SWEEP_MAX_COMBOS`, `_log_sweep_start`, `_log_sweep_done` (replace with the two job log lines). Add the four handlers per Interfaces. TestClient note: the job thread is a plain `threading.Thread`, so polling from TestClient works without an event loop dance.

- [ ] **Step 4: Run the whole backend suite**

Run: `cd backend && uv run pytest -q`
Expected: PASS; `grep -rn "api/backtest/sweep\"" backend/` finds no leftover chunk-endpoint references.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api backend/tests
git commit -m "feat(sweep): job API replaces the chunked sweep endpoint"
```

---

### Task 5: Frontend API client for sweep jobs

**Files:**
- Modify: `frontend/src/api.ts` (replace `runSweepChunk`, lines ~408-430)
- Test: `frontend/src/lib/sweep.test.ts` compiles against the new exports (updated in Task 6); this task only needs `npx tsc -b`

**Interfaces:**
- Produces (in `frontend/src/api.ts`; `SweepRow` unchanged):

```ts
export type SweepTarget = "local" | "remote";
export interface SweepJobStatus {
  rows: SweepRow[]; done: number; total: number; running: boolean;
  cancelled: boolean; error: string | null; etaSeconds: number | null;
}
export async function submitSweepJob(
  req: BacktestRequest,
  combos: Array<Record<string, number | boolean | string>>,
  windows: number[] | undefined,
  target: SweepTarget,
): Promise<{ jobId: string; total: number }>
export async function pollSweepJob(jobId: string, cursor: number, target: SweepTarget): Promise<SweepJobStatus>
export async function cancelSweepJob(jobId: string, target: SweepTarget): Promise<void>
export interface ComputeStatus { remoteConfigured: boolean; }
export async function computeStatus(): Promise<ComputeStatus>   // GET /api/compute/status; on fetch error return {remoteConfigured:false}
```

- [ ] **Step 1: Implement**

```ts
const sweepJobsBase = (target: SweepTarget) =>
  `${BASE}/api/backtest/sweep/jobs${target === "remote" ? "?target=remote" : ""}`;

export async function submitSweepJob(req, combos, windows, target) {
  const res = await fetch(sweepJobsBase(target), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, sweep: { combos, windows } }),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `sweep submit failed (${res.status})`));
  return res.json();
}
```

`pollSweepJob`/`cancelSweepJob` hit `${BASE}/api/backtest/sweep/jobs/${jobId}?cursor=${cursor}${target === "remote" ? "&target=remote" : ""}` and `.../cancel` the same way. Delete `runSweepChunk`.

- [ ] **Step 2: Typecheck (sweep.ts still imports runSweepChunk, expected red until Task 6)**

Run: `cd frontend && npx tsc -b 2>&1 | head -20`
Expected: errors ONLY in `lib/sweep.ts`/`lib/sweep.test.ts` about `runSweepChunk`.

- [ ] **Step 3: Commit together with Task 6** (they are one compile unit; no commit here).

---

### Task 6: Rewrite `runSweep` around submit/poll/cancel

**Files:**
- Modify: `frontend/src/lib/sweep.ts` (`runSweep`, delete `SWEEP_CHUNK_SIZE`, rename cap)
- Modify: `frontend/src/lib/sweep.test.ts`
- Test: `frontend/src/lib/sweep.test.ts`

**Interfaces:**
- Produces:
  - `runSweep(baseReq, axes, opts: { onRows(rows, done, total): void; signal?: AbortSignal; windows?: number[]; target?: SweepTarget }): Promise<SweepRow[]>` (same call shape plus `target`, default `"local"`).
  - `SWEEP_WARN_COMBOS = 1000` (replaces `SWEEP_MAX_COMBOS`; same value, warn semantics).
  - `sweepCatchState` unchanged.
- Consumes: Task 5's `submitSweepJob`/`pollSweepJob`/`cancelSweepJob`.

Behavior of the new `runSweep`:
1. `enumerateCombos(axes)`; submit once. If already-aborted, throw `"sweep aborted"` before submitting.
2. Poll loop every 700ms: `pollSweepJob(jobId, rows.length, target)`; append `status.rows`, call `opts.onRows(status.rows, rows.length, status.total)` when non-empty.
3. On `opts.signal` abort: `cancelSweepJob` (fire-and-forget catch), throw `"sweep aborted"`.
4. `running=false`: if `cancelled` throw `"sweep aborted"`; if `error` throw `new Error(error)`; else resolve all rows.
5. Export the module-level `let lastJob: { jobId: string; target: SweepTarget } | null` via `getLastSweepJob()` (Task 7 re-attach hook).

- [ ] **Step 1: Rewrite the tests**

Replace the `runSweepChunk` spies in `frontend/src/lib/sweep.test.ts` with spies on the new api functions:

```ts
import * as api from "../api";

function mockJob(rowBatches: api.SweepRow[][], opts: { cancelled?: boolean; error?: string } = {}) {
  vi.spyOn(api, "submitSweepJob").mockResolvedValue({ jobId: "j1", total: rowBatches.flat().length });
  let call = 0;
  vi.spyOn(api, "pollSweepJob").mockImplementation(async (_id, cursor) => {
    const all = rowBatches.slice(0, ++call).flat();
    const running = call < rowBatches.length && !opts.cancelled && !opts.error;
    return { rows: all.slice(cursor), done: all.length, total: rowBatches.flat().length,
             running, cancelled: !!opts.cancelled && !running, error: opts.error ?? null, etaSeconds: null };
  });
  return vi.spyOn(api, "cancelSweepJob").mockResolvedValue(undefined);
}
```

Test cases (use `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(700)` per poll tick):
- rows stream through `onRows` incrementally and resolve to the full set,
- abort mid-poll calls `cancelSweepJob` and rejects with `"sweep aborted"`,
- backend `cancelled: true` rejects with `"sweep aborted"` (so `sweepCatchState(prev, aborted, e)` still renders a cancel, not an error),
- backend `error` rejects with that message,
- `SWEEP_WARN_COMBOS === 1000` and `enumerateCombos` past 1000 combos still enumerates (no throw).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/sweep.test.ts`
Expected: FAIL (old implementation, missing exports).

- [ ] **Step 3: Implement, then run tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/sweep.test.ts && npx tsc -b`
Expected: PASS, clean build (BacktestSettingsModal's `SWEEP_MAX_COMBOS` import breaks: fix it now by renaming to `SWEEP_WARN_COMBOS` at `BacktestSettingsModal.tsx:62,623` and change `sweepOverCap` to `sweepWarn` without disabling Run; the full footer UX lands in Task 8).

- [ ] **Step 4: Commit Tasks 5+6**

```bash
git add frontend/src/api.ts frontend/src/lib/sweep.ts frontend/src/lib/sweep.test.ts frontend/src/BacktestSettingsModal.tsx
git commit -m "feat(sweep): frontend submit/poll/cancel job client replaces chunk loop"
```

---

### Task 7: Compute-target signal, BacktestButton wiring, re-attach

**Files:**
- Modify: `frontend/src/lib/signals.ts` (add `sweepTargetSignal`)
- Modify: `frontend/src/BacktestButton.tsx:287-320` (pass target, keep cancel semantics)
- Modify: `frontend/src/lib/persist/core.ts:117` (add the new device-local key)
- Create: `frontend/src/lib/sweepResume.ts`
- Test: `frontend/src/lib/sweepResume.test.ts`

**Interfaces:**
- Produces:
  - `signals.ts`: `export const sweepTargetSignal = new Signal<SweepTarget>(loadSweepTarget())` where `loadSweepTarget`/`saveSweepTarget` use `saveLocal` under key `` `${PREFIX}.sweepTarget` `` (added to `DEVICE_LOCAL_FLAT_KEYS`).
  - `sweepResume.ts`:
    - `rememberSweepJob(jobId: string, target: SweepTarget): void` / `clearSweepJob(): void` (sessionStorage key `at.sweepJob`)
    - `resumeSweep(onRows, setState): Promise<void>`: reads the remembered job; if present, polls it to completion exactly like `runSweep`'s loop, publishing to `sweepStateSignal`; clears the memo when the job is done or 404s.
- Consumes: Task 6's `runSweep` internals (extract the poll loop into a shared `pollToCompletion(jobId, target, onRows, signal)` helper exported from `sweep.ts` so `runSweep` and `resumeSweep` share it).

- [ ] **Step 1: Write failing tests for `sweepResume.ts`** (mock `pollSweepJob` as in Task 6; assert: remembered job resumes and publishes rows; 404 clears silently; nothing remembered = no calls).

- [ ] **Step 2: Run to verify fail** (`npx vitest run src/lib/sweepResume.test.ts`).

- [ ] **Step 3: Implement**

- `sweep.ts`: export `pollToCompletion`; `runSweep` calls `rememberSweepJob` after submit and `clearSweepJob` in a `finally` when the job ends (NOT on abort-with-job-still-running: a closed modal keeps the job running, which is the feature).
- `BacktestButton.tsx` sweep branch: `runSweep(baseReq, sweepAxes, { signal, windows, target: sweepTargetSignal.value, onRows })`. Everything else in the branch stays byte-identical (the cancel/ghost guards were reviewed hard; do not restructure them).
- `BacktestSettingsModal.tsx` mount effect: call `resumeSweep` once if `sweepStateSignal.value === null`.
- IMPORTANT: the modal's unmount cleanup (`BacktestSettingsModal.tsx:631-635`) calls `requestSweepCancel()`; that must NOT cancel a server job anymore (jobs surviving modal close is the point). Change `runSweep` abort handling: on abort, STOP POLLING and clear state, but only call `cancelSweepJob` when the abort came from the explicit Cancel button. Implement by giving the modal's Cancel button its own path: `requestSweepCancel()` keeps aborting the controller AND sets a `cancelServerJob` flag read by `runSweep` (export `requestSweepCancel(server: boolean)` variants in `signals.ts`: unmount cleanup passes `false`, the Cancel button passes `true`).

- [ ] **Step 4: Run tests + typecheck** (`npx vitest run src/lib/sweepResume.test.ts src/lib/sweep.test.ts && npx tsc -b`). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib frontend/src/BacktestButton.tsx frontend/src/BacktestSettingsModal.tsx
git commit -m "feat(sweep): compute-target signal, detached server jobs, reload re-attach"
```

---

### Task 8: Footer estimate line + Compute toggle + pace memory

**Files:**
- Modify: `frontend/src/lib/sweepMemory.ts` (pace store)
- Modify: `frontend/src/BacktestSettingsModal.tsx` (footer near the run/cancel controls, ~line 1820)
- Test: `frontend/src/lib/sweepMemory.test.ts`, `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Produces (in `sweepMemory.ts`):
  - `recordSweepPace(epic: string, tf: string, target: string, msPerCombo: number): void` (key `` `${PREFIX}.sweepPace` ``, entry-list capped at 100, same eviction pattern as `RANGES_KEY`)
  - `recallSweepPace(epic: string, tf: string, target: string): number | null`
  - `estimateSweepText(combos: number, msPerCombo: number | null): string`: `"N combos"` when no pace; `"N combos, about Xm on this run target"` otherwise (round up to minutes; under 1 minute say "under a minute"). No em dashes in the copy.
- UI:
  - Footer line replaces the over-cap error: combo count + estimate, `className="bt-sweep-estimate"` plus `bt-sweep-warn` (amber) when `combos > SWEEP_WARN_COMBOS`. Run button NEVER disabled by combo count.
  - `Compute: Local | Remote` segmented control next to the estimate, rendered only when `computeStatus()` (fetched once on modal mount, cached in state) returns `remoteConfigured: true`; writes `sweepTargetSignal` + `saveSweepTarget`.
  - `BacktestButton` records pace on sweep completion: `recordSweepPace(epic, tf, target, elapsedMs / rows.length)`.

- [ ] **Step 1: Write failing pace-store tests** in `sweepMemory.test.ts` (record/recall roundtrip, cap eviction, unknown key null, estimate text for null pace / small / large sweeps).

- [ ] **Step 2: Run to verify fail** (`npx vitest run src/lib/sweepMemory.test.ts`).

- [ ] **Step 3: Implement store + UI + pace recording; add a modal test** asserting: over-1000 combos shows the warn class and Run stays enabled; toggle hidden when `computeStatus` resolves `{remoteConfigured:false}`.

- [ ] **Step 4: Run tests + typecheck** (`npx vitest run src/lib/sweepMemory.test.ts src/BacktestSettingsModal.test.tsx && npx tsc -b`). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(sweep): runtime estimate replaces combo cap, compute target toggle"
```

---

### Task 9: Token gate + compute-only middleware

**Files:**
- Modify: `backend/auto_trader/api/app.py` (register middleware after CORS)
- Create: `backend/auto_trader/api/guard.py`
- Test: `backend/tests/test_api_guard.py`

**Interfaces:**
- Produces (`auto_trader/api/guard.py`):

```python
API_TOKEN_ENV = "API_TOKEN"            # the token value
REQUIRE_TOKEN_ENV = "REQUIRE_API_TOKEN"   # "1" enables the gate
COMPUTE_ONLY_ENV = "COMPUTE_ONLY"         # "1" blocks dealing

DEALING_PATHS: tuple[tuple[str, str], ...] = (
    ("POST", "/api/orders"),
    ("PUT", "/api/positions/"), ("DELETE", "/api/positions/"),
    ("PUT", "/api/orders/working/"), ("DELETE", "/api/orders/working/"),
)

def install_guards(app: FastAPI) -> None   # adds one http middleware reading env at REQUEST time
```
- Middleware behavior: when `REQUIRE_API_TOKEN=1`, any request whose `Authorization` header is not `Bearer <API_TOKEN>` gets 401 (except `GET /api/compute/status`... no: gate everything including status; the proxy always has the token). When `COMPUTE_ONLY=1`, a request matching `DEALING_PATHS` (method match + path `startswith`) gets 403 `{"detail": "dealing disabled on compute host"}`. Env is read per request so tests can monkeypatch without app reload.

- [ ] **Step 1: Write the failing tests**

```python
"""REQUIRE_API_TOKEN + COMPUTE_ONLY guards."""
from fastapi.testclient import TestClient
from auto_trader.api.app import app

client = TestClient(app)


def test_no_flags_no_gate(monkeypatch):
    monkeypatch.delenv("REQUIRE_API_TOKEN", raising=False)
    assert client.get("/api/backtest/sweep/jobs").status_code == 200


def test_token_required_401_and_pass(monkeypatch):
    monkeypatch.setenv("REQUIRE_API_TOKEN", "1")
    monkeypatch.setenv("API_TOKEN", "s3cret")
    assert client.get("/api/backtest/sweep/jobs").status_code == 401
    ok = client.get("/api/backtest/sweep/jobs", headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200


def test_compute_only_blocks_dealing(monkeypatch):
    monkeypatch.setenv("COMPUTE_ONLY", "1")
    r = client.post("/api/orders", json={})
    assert r.status_code == 403 and "dealing disabled" in r.text
    assert client.get("/api/backtest/sweep/jobs").status_code == 200
```

- [ ] **Step 2: Run to verify fail**, **Step 3: implement** (`install_guards(app)` called in `app.py` right after the CORS middleware), **Step 4: full backend suite green**, **Step 5: commit** `feat(api): bearer-token gate and compute-only mode for remote deployment`.

---

### Task 10: `/api/compute/status` + remote proxy (`?target=remote`)

**Files:**
- Create: `backend/auto_trader/api/routers/compute.py` (status endpoint + proxy helper)
- Modify: `backend/auto_trader/api/app.py` (include router)
- Modify: `backend/auto_trader/api/routers/backtest.py` (job handlers honor `target=remote`)
- Test: `backend/tests/test_api_compute_proxy.py`

**Interfaces:**
- Produces:
  - `GET /api/compute/status` → `{"remoteConfigured": bool}` from env `COMPUTE_HOST_URL`/`COMPUTE_HOST_TOKEN` (read per request).
  - In `compute.py`: `async def forward(method: str, path: str, *, json_body=None, params=None) -> Response`: httpx.AsyncClient request to `f"{COMPUTE_HOST_URL}{path}"` with `Authorization: Bearer <token>`, `timeout=httpx.Timeout(connect=30.0, read=120.0, write=120.0, pool=30.0)` (connect absorbs Fly cold start). Maps connect errors to 502 `"remote compute host unreachable"`; passes remote status codes + JSON bodies through verbatim.
- The three job handlers each start with: `if target == "remote": return await compute.forward(...)` (query param `target: str = "local"`; 422 when remote requested but not configured).

- [ ] **Step 1: Write failing proxy tests** using `respx` (add as dev dependency if absent: `uv add --dev respx`): submit with `?target=remote` forwards body + bearer header to `COMPUTE_HOST_URL` and relays the mocked `{"jobId":"r1","total":5}`; poll/cancel forward with cursor param; unconfigured remote 422s; connect error maps to 502.

- [ ] **Step 2: Run to verify fail**, **Step 3: implement**, **Step 4: backend suite green + `npx tsc -b` still green**, **Step 5: commit** `feat(compute): status endpoint and remote job proxy`.

---

### Task 11: Dockerfile, fly.toml, deploy runbook

**Files:**
- Create: `backend/Dockerfile`
- Create: `fly.toml` (repo root)
- Create: `docs/deploy-compute.md`

No unit tests; verification is the build command.

- [ ] **Step 1: Write `backend/Dockerfile`**

```dockerfile
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY auto_trader ./auto_trader
COPY strategies ./strategies
RUN uv sync --frozen --no-dev
ENV SQLITE_DIR=/data
EXPOSE 8000
CMD ["uv", "run", "uvicorn", "auto_trader.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
```

Check how the backend locates its sqlite files first (`grep -rn "candle_history.db" backend/auto_trader | head`): if paths are cwd-relative, add an env override or set `WORKDIR /data` symlinks in the Dockerfile so the DBs land on the volume. Match the Python version to `backend/pyproject.toml`'s `requires-python`.

- [ ] **Step 2: Write `fly.toml`**

```toml
app = "auto-trader-compute"
primary_region = "fra"

[build]
  dockerfile = "backend/Dockerfile"

[env]
  REQUIRE_API_TOKEN = "1"
  COMPUTE_ONLY = "1"

[[mounts]]
  source = "candle_cache"
  destination = "/data"

[http_service]
  internal_port = 8000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "performance-8x"
```

- [ ] **Step 3: Write `docs/deploy-compute.md`**: fly launch/deploy steps, `fly secrets set API_TOKEN=... CAPITAL_API_KEY=... <the broker envs the backend reads>` (enumerate them from `grep -rn 'os.environ\|getenv' backend/auto_trader/api/deps.py backend/auto_trader/brokers/ | head -30`), volume create command, resize command (`fly scale vm performance-16x`), and the local side: `COMPUTE_HOST_URL=https://auto-trader-compute.fly.dev COMPUTE_HOST_TOKEN=...` in the backend env.

- [ ] **Step 4: Verify the image builds**

Run: `cd backend && docker build -t at-compute . && docker run --rm at-compute uv run python -c "import auto_trader.api.app"` (build only; do NOT run the server in docker locally, per user constraint this container is deploy packaging only).
Expected: build succeeds, import succeeds. If Docker isn't installed locally, note it and rely on `fly deploy --build-only` at rollout.

- [ ] **Step 5: Commit** `feat(deploy): Dockerfile, fly.toml and compute-host runbook`.

---

### Task 12: End-to-end verification + merge

- [ ] **Step 1: Full suites**

Run: `cd backend && uv run pytest -q && cd ../frontend && npx vitest run && npx tsc -b`
Expected: all green.

- [ ] **Step 2: Live local verification (verify skill applies here)**

With the user's dev servers running: open the backtest panel, configure a 2-axis sweep (>50 combos), Run. Confirm: rows stream in, ETA line updates, CPU shows multiple worker processes (`ps aux | grep python | grep -v grep`), Cancel mid-run keeps partial rows with the neutral cancelled note, re-running works, reloading the page mid-sweep re-attaches. Compare a small sweep's rows against a pre-change run of the same sweep if one is recorded.

- [ ] **Step 3: Remote verification (requires user's Fly account + broker demo creds)**

Deploy per the runbook, set `COMPUTE_HOST_URL`/`COMPUTE_HOST_TOKEN` locally, restart the local backend, confirm the Compute toggle appears, run the same sweep on Remote, and diff the row sets local vs remote (sort by combo; metrics must be identical). This step needs the user present for secrets; pause and hand off if creds are not available.

- [ ] **Step 4: Merge the worktree branch to main** (use superpowers:finishing-a-development-branch).

---

## Self-review notes

- Spec coverage: job API (T4), parallel pool (T2/T3), no-cap warn + estimate (T6/T8), cancel (T3/T4/T7), remote routing + toggle (T7/T8/T10), safety flags (T9), Fly deploy (T11), determinism test (T2), proxy tests (T10), re-attach (T7), live check (T12). ETA (T3 backend, T8 UI). Chunk-endpoint deletion (T4), `SWEEP_CHUNK_SIZE` deletion (T6).
- Known judgment calls an implementer must verify in-code (flagged inline): `_run_coded`'s `(result, strategy)` return usage; exact import paths for metrics/resolution helpers; the coded ctx HTF accessor name in the T2 test; sqlite path handling in the Dockerfile.

# Backtest Progress UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live phase + percent + ETA in the backtest panel while a backtest runs (download phase from the candle-cache backfill, simulate phase from the engine loop), via a polled side-channel.

**Architecture:** Two in-memory backend registries — active backfills (published by `candle_cache.window()` at the same points it already logs) and per-run simulation progress (keyed by a client-generated `progressId`, fed by a new `on_progress` callback in `BacktestEngine.run`). Two cheap GET endpoints expose them. The frontend polls once per second while `backtestRunningSignal` is on and renders the result in `BacktestPanel`. The single-run engine calls move to `asyncio.to_thread` (they currently block the event loop, which would starve the polls).

**Tech Stack:** FastAPI + Pydantic (backend), pytest (direct-handler-call convention, `asyncio.run`, NO pytest-asyncio and NO TestClient), React + module-level `Signal` stores + vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-08-12-backtest-progress-design.md`

## Global Constraints

- Backend tests: run from `backend/` with `python -m pytest tests/<file> -v` (uses the repo venv; check `backend/.venv` or the active env).
- Frontend tests: run from `frontend/` with `npx vitest run src/<file>`. The frontend baseline has 5–7 known failures on main — only gate on the files you touch.
- Progress is cosmetic: every failure path must degrade to "no progress shown", never to a failed run. Registries are cleaned in `finally`; readers GC entries older than 60 s.
- No `Date.now()`-dependent flakiness in tests: pass/patch clocks where the code allows.
- Do not touch the 5 pre-existing modified files (`frontend/src/BacktestSettingsModal.tsx`, `sweepLiterals.*`, `sweepLabels.*`) — another session owns them. Commit only files this plan creates/modifies. `git add` specific paths, never `-A`.

---

### Task 1: `on_progress` callback in `BacktestEngine.run`

**Files:**
- Modify: `backend/auto_trader/engine/backtest.py` (`run`, line ~130)
- Test: `backend/tests/test_backtest_progress.py` (create)

**Interfaces:**
- Produces: `BacktestEngine.run(candles, *, stop_index=None, on_progress: Callable[[int, int], None] | None = None)`. Callback receives `(bars_done, bars_total)`; called at most ~100 times per run (every `max(1, total // 100)` bars) plus once at the final bar. Exceptions from the callback are NOT caught (callers pass safe callbacks).

- [ ] **Step 1: Write the failing test**

```python
"""Engine progress callback: cadence and totals."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.base import Strategy


class _Noop(Strategy):
    def on_bar(self, ctx, bar):
        return None


def _candles(n: int) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(
            time=int((t0 + timedelta(minutes=i)).timestamp()),
            open=100.0, high=101.0, low=99.0, close=100.5,
        )
        for i in range(n)
    ]


def test_on_progress_reports_total_and_finishes_at_end():
    calls: list[tuple[int, int]] = []
    engine = BacktestEngine(_Noop(), starting_cash=1000.0)
    engine.run(_candles(250), on_progress=lambda done, total: calls.append((done, total)))
    assert calls, "callback never invoked"
    assert all(total == 250 for _, total in calls)
    assert calls[-1][0] == 250
    dones = [d for d, _ in calls]
    assert dones == sorted(dones)
    # every ~1% of 250 bars => step 2 => ~125 calls; bound it loosely
    assert len(calls) <= 130


def test_on_progress_none_is_default_and_harmless():
    engine = BacktestEngine(_Noop(), starting_cash=1000.0)
    result = engine.run(_candles(10))
    assert result is not None
```

Note for the implementer: check `Candle`'s actual constructor in `auto_trader/core/models.py` first (field names/required fields, e.g. whether `time` is int or datetime) and adjust `_candles` to match — copy the construction style from an existing test such as `backend/tests/test_backtest.py`. Same for `BacktestEngine(...)` minimal kwargs and the no-op strategy base (`Strategy.on_bar` signature): mirror the simplest existing engine test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_backtest_progress.py -v`
Expected: FAIL with `TypeError: run() got an unexpected keyword argument 'on_progress'`

- [ ] **Step 3: Implement**

In `engine/backtest.py`:

```python
from typing import Callable  # add to existing imports if absent

    def run(
        self, candles: list[Candle], *, stop_index: int | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> BacktestResult:
```

Inside `run`, before the main loop:

```python
        total = end + 1
        # Progress cadence: ~1% steps. Cosmetic; must stay cheap on huge runs.
        progress_step = max(1, total // 100)
```

At the BOTTOM of the `for i, bar in enumerate(candles):` body (after all per-bar work, still inside the loop):

```python
            if on_progress is not None and ((i + 1) % progress_step == 0 or i == end):
                on_progress(i + 1, total)
```

Keep the existing docstring; append one sentence: "`on_progress(done, total)` is invoked every ~1% of bars for UI progress reporting."

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_backtest_progress.py tests/test_backtest.py -v`
Expected: new tests PASS; `test_backtest.py` still green (no behavior change without the kwarg).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/backtest.py backend/tests/test_backtest_progress.py
git commit -m "feat(engine): optional on_progress callback in BacktestEngine.run"
```

---

### Task 2: Active-backfill registry in `candle_cache`

**Files:**
- Modify: `backend/auto_trader/core/candle_cache.py` (module level + `window()`, lines ~374–424)
- Test: `backend/tests/test_candle_cache.py` (append)

**Interfaces:**
- Produces: module-level `active_backfills(now: float | None = None) -> list[dict]` in `candle_cache.py`, each dict:
  `{"label": str, "done_chunks": int, "total_chunks": int, "bars": int, "elapsed_s": float, "eta_s": float | None, "at": str, "updated_at": float}`.
  `label` is `_key_label(key)` (e.g. `"dukascopy/US100/MINUTE_5/bid"`); `at` is `_stamp()` of the timestamp the walk has reached (empty string until the first chunk lands); `eta_s` is `None` until the first chunk lands. Entries exist only while a multi-chunk (`total_chunks > 1`) walk is in flight; reader drops entries with `updated_at` older than 60 s.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_candle_cache.py` (reuse its existing fixtures/helpers — it already has `KEY`, `_dt`, and fake-fetch helpers; mirror the style of `test_window_cold_fetches_and_stores`):

```python
def test_active_backfills_empty_when_idle(tmp_path):
    from auto_trader.core import candle_cache as cc
    assert cc.active_backfills() == []


def test_window_multi_chunk_publishes_and_clears_progress(tmp_path):
    from auto_trader.core import candle_cache as cc

    cache = _make_cache(tmp_path)  # use this file's existing constructor helper
    seen: list[list[dict]] = []

    async def spying_fetch(from_dt, to_dt):
        # Snapshot the registry mid-walk: entry present with sane fields.
        seen.append(cc.active_backfills())
        return _bars_between(from_dt, to_dt)  # existing helper/fake in this file

    # chunk_bars small enough that the window needs >1 chunk
    asyncio.run(cache.window(KEY, 60, _dt(0), _dt(600), spying_fetch,
                             now=10_000, chunk_bars=3))
    mid = [s for s in seen if s]
    assert mid, "registry never showed an active backfill"
    entry = mid[0][0]
    assert entry["total_chunks"] > 1
    assert entry["label"]  # _key_label(KEY)
    assert 0 <= entry["done_chunks"] <= entry["total_chunks"]
    # cleared after the walk finishes
    assert cc.active_backfills() == []


def test_window_failed_fetch_clears_progress(tmp_path):
    from auto_trader.core import candle_cache as cc

    cache = _make_cache(tmp_path)

    async def failing_fetch(from_dt, to_dt):
        raise RuntimeError("broker down")

    try:
        asyncio.run(cache.window(KEY, 60, _dt(0), _dt(600), failing_fetch,
                                 now=10_000, chunk_bars=3))
    except RuntimeError:
        pass
    assert cc.active_backfills() == []


def test_active_backfills_drops_stale_entries(tmp_path):
    from auto_trader.core import candle_cache as cc
    cc._ACTIVE_BACKFILLS["stale-key"] = {
        "label": "x", "done_chunks": 1, "total_chunks": 5, "bars": 10,
        "elapsed_s": 1.0, "eta_s": 4.0, "at": "", "updated_at": 100.0,
    }
    try:
        assert cc.active_backfills(now=200.0) == []          # >60s old: dropped
        assert len(cc.active_backfills(now=120.0)) == 1      # fresh enough
    finally:
        cc._ACTIVE_BACKFILLS.clear()
```

Adapt helper names (`_make_cache`, `_bars_between`) to whatever `test_candle_cache.py` actually defines — read the file first and reuse its existing fakes rather than inventing new ones. The registry key can be the `CandleKey` tuple itself; the stale test just needs any hashable key.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_candle_cache.py -v -k backfills_or_progress` (adjust `-k` to the new test names)
Expected: FAIL with `AttributeError: module ... has no attribute 'active_backfills'`

- [ ] **Step 3: Implement**

In `candle_cache.py`, module level (near `_key_label`):

```python
# Active multi-chunk backfills, keyed by CandleKey — the UI's "downloading
# data" progress source. Written only inside window()'s walk (same gating as
# its log lines: multi-chunk walks only) and always removed in the finally, so
# a crashed walk can't strand an entry past the reader's 60s staleness cut.
_ACTIVE_BACKFILLS: dict[CandleKey, dict] = {}
_BACKFILL_STALE_S = 60.0


def active_backfills(now: float | None = None) -> list[dict]:
    """Snapshot of in-flight multi-chunk backfills for the progress endpoint."""
    cutoff = (now if now is not None else time.time()) - _BACKFILL_STALE_S
    return [dict(e) for e in _ACTIVE_BACKFILLS.values() if e["updated_at"] >= cutoff]
```

In `window()`, wrap the walk. After `started = time.monotonic()` / `done_chunks = 0` / `bars_in = 0` (line ~381), extend the existing `if total_chunks > 1:` start-log block:

```python
        if total_chunks > 1:
            log.info(...)  # existing start log, unchanged
            _ACTIVE_BACKFILLS[key] = {
                "label": _key_label(key), "done_chunks": 0,
                "total_chunks": total_chunks, "bars": 0, "elapsed_s": 0.0,
                "eta_s": None, "at": "", "updated_at": time.time(),
            }
```

Wrap the `while start < cursor:` loop plus the two post-loop `if total_chunks > 1 ...` log blocks in `try: ... finally: _ACTIVE_BACKFILLS.pop(key, None)` — everything from the `while` down to (and including) the `stopped/done` summary log moves inside the `try`; the subsequent `if fetched_any:` bookkeeping and the error/read-window return logic stay outside. Inside the per-chunk `if total_chunks > 1:` progress-log block (after `eta` is computed), update the entry:

```python
                entry = _ACTIVE_BACKFILLS.get(key)
                if entry is not None:
                    entry.update(
                        done_chunks=done_chunks, bars=bars_in,
                        elapsed_s=elapsed, eta_s=eta,
                        at=_stamp(chunk_from_ts), updated_at=time.time(),
                    )
```

- [ ] **Step 4: Run the full cache test file**

Run: `cd backend && python -m pytest tests/test_candle_cache.py -v`
Expected: all PASS (existing window tests unaffected — single-chunk walks never touch the registry).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/candle_cache.py backend/tests/test_candle_cache.py
git commit -m "feat(cache): publish in-flight multi-chunk backfill progress"
```

---

### Task 3: `GET /api/candle-cache/backfill/active` endpoint

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (near `CandleCacheStatsDTO`, line ~33)
- Modify: `backend/auto_trader/api/routers/charts.py` (near the stats routes, line ~92)
- Test: `backend/tests/test_api_backfill_progress.py` (create)

**Interfaces:**
- Consumes: `candle_cache.active_backfills()` from Task 2.
- Produces: `GET /api/candle-cache/backfill/active` → `list[BackfillProgressDTO]` with fields `label: str`, `doneChunks: int`, `totalChunks: int`, `bars: int`, `elapsedS: float`, `etaS: float | None`, `at: str`.

- [ ] **Step 1: Write the failing test**

```python
"""GET /api/candle-cache/backfill/active — registry snapshot over HTTP.

Direct-call convention per test_api_candles.py (no pytest-asyncio).
"""

from __future__ import annotations

import asyncio

from auto_trader.api.routers import charts
from auto_trader.core import candle_cache as cc


def test_active_backfills_endpoint_maps_registry_entries():
    cc._ACTIVE_BACKFILLS[("b", "E", "MINUTE_5", "bid")] = {
        "label": "b/E/MINUTE_5/bid", "done_chunks": 14, "total_chunks": 70,
        "bars": 27370, "elapsed_s": 49.8, "eta_s": 199.0,
        "at": "2023-08-01 20:45", "updated_at": cc.time.time(),
    }
    try:
        out = asyncio.run(charts.active_backfill_progress())
    finally:
        cc._ACTIVE_BACKFILLS.clear()
    assert len(out) == 1
    dto = out[0]
    assert dto.label == "b/E/MINUTE_5/bid"
    assert dto.doneChunks == 14 and dto.totalChunks == 70
    assert dto.etaS == 199.0 and dto.at == "2023-08-01 20:45"


def test_active_backfills_endpoint_empty():
    assert asyncio.run(charts.active_backfill_progress()) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_backfill_progress.py -v`
Expected: FAIL with `AttributeError: ... no attribute 'active_backfill_progress'`

- [ ] **Step 3: Implement**

`schemas.py` (next to `CandleCacheStatsDTO`):

```python
class BackfillProgressDTO(BaseModel):
    """One in-flight candle-cache backfill, for the backtest progress UI."""
    label: str
    doneChunks: int
    totalChunks: int
    bars: int
    elapsedS: float
    etaS: float | None
    at: str
```

`charts.py` (import `BackfillProgressDTO` alongside the existing DTO imports; the module already imports `CANDLE_CACHE` — add `from auto_trader.core.candle_cache import active_backfills` or call via the module to match existing import style):

```python
@router.get("/api/candle-cache/backfill/active", response_model=list[BackfillProgressDTO])
async def active_backfill_progress() -> list[BackfillProgressDTO]:
    """In-flight multi-chunk backfills (the 'downloading data' phase of a
    backtest run). Cosmetic, best-effort: entries appear only for multi-chunk
    walks and vanish when the walk ends."""
    return [
        BackfillProgressDTO(
            label=e["label"], doneChunks=e["done_chunks"],
            totalChunks=e["total_chunks"], bars=e["bars"],
            elapsedS=e["elapsed_s"], etaS=e["eta_s"], at=e["at"],
        )
        for e in active_backfills()
    ]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_api_backfill_progress.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/charts.py backend/tests/test_api_backfill_progress.py
git commit -m "feat(api): expose active candle-cache backfills for progress UI"
```

---

### Task 4: Simulation progress registry (`core/progress.py`)

**Files:**
- Create: `backend/auto_trader/core/progress.py`
- Test: `backend/tests/test_progress_registry.py` (create)

**Interfaces:**
- Produces (all module functions in `auto_trader.core.progress`):
  - `set_progress(progress_id: str, *, stage: str, done: int = 0, total: int = 0, now: float | None = None) -> None` — upsert; also refreshes `updated_at`.
  - `update_progress(progress_id: str, done: int, total: int, now: float | None = None) -> None` — update counts only, keep current stage; no-op if the id is unknown.
  - `get_progress(progress_id: str, now: float | None = None) -> dict | None` — `{"stage": str, "done": int, "total": int}` or `None` when unknown/stale (>60 s).
  - `clear_progress(progress_id: str) -> None` — idempotent remove.

- [ ] **Step 1: Write the failing tests**

```python
"""In-memory per-run progress registry (simulate phase of a backtest)."""

from __future__ import annotations

from auto_trader.core import progress as pr


def test_set_get_clear_roundtrip():
    pr.set_progress("p1", stage="simulate", done=0, total=100, now=10.0)
    assert pr.get_progress("p1", now=11.0) == {"stage": "simulate", "done": 0, "total": 100}
    pr.clear_progress("p1")
    assert pr.get_progress("p1") is None
    pr.clear_progress("p1")  # idempotent


def test_update_keeps_stage_and_ignores_unknown():
    pr.set_progress("p2", stage="cost-sensitivity", done=1, total=4, now=10.0)
    pr.update_progress("p2", 3, 4, now=12.0)
    assert pr.get_progress("p2", now=13.0) == {"stage": "cost-sensitivity", "done": 3, "total": 4}
    pr.update_progress("nope", 1, 2)  # unknown id: silent no-op
    assert pr.get_progress("nope") is None
    pr.clear_progress("p2")


def test_stale_entries_read_as_none():
    pr.set_progress("p3", stage="simulate", done=5, total=10, now=100.0)
    assert pr.get_progress("p3", now=200.0) is None   # >60s
    assert pr.get_progress("p3", now=150.0) is not None
    pr.clear_progress("p3")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_progress_registry.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.core.progress'`

- [ ] **Step 3: Implement**

```python
"""In-memory progress registry for long blocking runs (single backtests).

The frontend generates a progressId, ships it in the request body, and polls
GET /api/backtest/progress/{id} while the POST is in flight. Entries are
cosmetic and best-effort: handlers set/clear them around the engine call
(clear in a finally), and reads treat >60s-stale entries as gone so a crashed
handler can't serve a frozen bar forever. Callbacks run on worker threads
(asyncio.to_thread) — single-dict-op writes, so no locking needed under the GIL.
"""

from __future__ import annotations

import time

_ENTRIES: dict[str, dict] = {}
_STALE_S = 60.0


def set_progress(progress_id: str, *, stage: str, done: int = 0, total: int = 0,
                 now: float | None = None) -> None:
    _ENTRIES[progress_id] = {
        "stage": stage, "done": done, "total": total,
        "updated_at": now if now is not None else time.time(),
    }


def update_progress(progress_id: str, done: int, total: int,
                    now: float | None = None) -> None:
    entry = _ENTRIES.get(progress_id)
    if entry is None:
        return
    entry.update(done=done, total=total,
                 updated_at=now if now is not None else time.time())


def get_progress(progress_id: str, now: float | None = None) -> dict | None:
    entry = _ENTRIES.get(progress_id)
    if entry is None:
        return None
    if (now if now is not None else time.time()) - entry["updated_at"] > _STALE_S:
        return None
    return {"stage": entry["stage"], "done": entry["done"], "total": entry["total"]}


def clear_progress(progress_id: str) -> None:
    _ENTRIES.pop(progress_id, None)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_progress_registry.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/progress.py backend/tests/test_progress_registry.py
git commit -m "feat(core): in-memory progress registry for single backtest runs"
```

---

### Task 5: Wire progress into `POST /api/backtest` + progress endpoint

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (`BacktestRequest`, line ~276; `ExprBacktestRequest`, line ~695)
- Modify: `backend/auto_trader/api/sweep_apply.py` (`run_coded_sync`, line ~192)
- Modify: `backend/auto_trader/api/routers/backtest.py` (`_run_coded` line ~84, `backtest` handler line ~143, cost-sensitivity loop line ~229, new GET route)
- Test: `backend/tests/test_api_backtest_progress.py` (create)

**Interfaces:**
- Consumes: Task 1's `on_progress` kwarg, Task 4's registry functions.
- Produces:
  - `BacktestRequest.progressId: str | None = None` and `ExprBacktestRequest.progressId: str | None = None`.
  - `run_coded_sync(..., on_progress: Callable[[int, int], None] | None = None)` — threaded through to `engine.run(candles, stop_index=stop_index, on_progress=on_progress)`.
  - `_run_coded(..., on_progress=None)` — same passthrough; the `run_coded_sync` call moves inside `asyncio.to_thread`.
  - `GET /api/backtest/progress/{progress_id}` → `{"stage": str, "done": int, "total": int}` or 404.

- [ ] **Step 1: Write the failing tests**

```python
"""progressId plumbing on POST /api/backtest and the progress GET route.

Direct-call convention per test_api_candles.py (no pytest-asyncio). Reuse the
request-building helpers from test_api_backtest_coded.py — read that file first
and copy its minimal valid BacktestRequest construction (fixtures dir has
strategy files it loads).
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from auto_trader.api.routers import backtest as bt
from auto_trader.core import progress as pr


def test_progress_route_reads_registry_and_404s_when_absent():
    pr.set_progress("live", stage="simulate", done=42, total=100)
    try:
        out = asyncio.run(bt.backtest_progress("live"))
    finally:
        pr.clear_progress("live")
    assert out == {"stage": "simulate", "done": 42, "total": 100}

    with pytest.raises(HTTPException) as e:
        asyncio.run(bt.backtest_progress("gone"))
    assert e.value.status_code == 404


def test_backtest_run_with_progress_id_updates_then_clears(monkeypatch):
    # Build the same minimal coded-run request test_api_backtest_coded.py uses
    # (import/copy its helper), then add progressId="prog-test".
    req = _minimal_coded_request(progressId="prog-test")  # see note above
    snapshots: list[dict | None] = []

    real_update = pr.update_progress

    def spying_update(pid, done, total, now=None):
        real_update(pid, done, total, now=now)
        snapshots.append(pr.get_progress(pid))

    monkeypatch.setattr(pr, "update_progress", spying_update)
    asyncio.run(bt.backtest(req))
    assert snapshots, "engine progress never reached the registry"
    assert snapshots[-1]["done"] == snapshots[-1]["total"] > 0
    assert pr.get_progress("prog-test") is None  # cleared in finally
```

The second test's exact spy mechanics depend on how the handler wires the callback — the requirement it must pin down: during a run with `progressId` set, the registry receives monotonically-advancing updates with `stage == "simulate"`, and after the handler returns the id reads as `None`. Adjust the spy to match the implementation (e.g. patch `pr.update_progress` before calling the handler, as shown) but keep those assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_backtest_progress.py -v`
Expected: FAIL with `AttributeError: ... no attribute 'backtest_progress'`

- [ ] **Step 3: Implement**

`schemas.py` — add to BOTH `BacktestRequest` and `ExprBacktestRequest`:

```python
    # Optional client-generated id for GET /api/backtest/progress/{id} polling.
    # Cosmetic: absent means no progress reporting for this run.
    progressId: str | None = None
```

`sweep_apply.py` — `run_coded_sync` gains a trailing kwarg and passes it through (both places if it has more than one `engine.run` call for coded runs; line ~248):

```python
def run_coded_sync(
    req, candles, module, resolved_params, long_risk_dto, short_risk_dto,
    htf_candles, indicator_cache=None, stop_index=None,
    on_progress=None,
):
    ...
            result = engine.run(candles, stop_index=stop_index, on_progress=on_progress)
```

(Keep existing type annotations style; add `on_progress: Callable[[int, int], None] | None = None` with a `Callable` import matching the file's conventions. Sweep workers don't pass it — default `None`, zero behavior change.)

`routers/backtest.py` — `_run_coded` gains the same kwarg and moves the sync core off the event loop:

```python
async def _run_coded(
    req, candles, module, resolved_params, long_risk_dto, short_risk_dto,
    htf_candles, on_progress=None,
):
    for _ in range(_MAX_TF_PASSES):
        try:
            # to_thread: the engine is CPU-bound sync; on the loop thread it
            # would starve every other request — including the progress polls
            # this callback exists to feed.
            return await asyncio.to_thread(
                run_coded_sync, req, candles, module, resolved_params,
                long_risk_dto, short_risk_dto, htf_candles,
                on_progress=on_progress,
            )
        except TimeframeNotPrefetched as need:
            ...  # unchanged
```

(`import asyncio` if the module doesn't already.) In the `backtest` handler, around the main `_run_coded` call (line ~167):

```python
    from auto_trader.core import progress as pr  # top-of-file import, matching style

    on_progress = None
    if req.progressId:
        pr.set_progress(req.progressId, stage="simulate")
        pid = req.progressId
        on_progress = lambda done, total: pr.update_progress(pid, done, total)
    try:
        ...  # ENTIRE existing handler body from the _run_coded call down to
             # the final `return` moves inside this try
    finally:
        if req.progressId:
            pr.clear_progress(req.progressId)
```

Pass `on_progress=on_progress` to the main `_run_coded` call. In the cost-sensitivity loop (line ~229), before the re-runs:

```python
        if req.progressId:
            pr.set_progress(req.progressId, stage="cost-sensitivity")
```

and pass `on_progress=on_progress` to the re-run `_run_coded` call too (line ~245).

New route (near the other GET routes, line ~430):

```python
@router.get("/api/backtest/progress/{progress_id}")
async def backtest_progress(progress_id: str) -> dict:
    """Simulate-phase progress for an in-flight POST /api/backtest run. 404
    once the run finishes (the handler clears its entry in a finally)."""
    entry = pr.get_progress(progress_id)
    if entry is None:
        raise HTTPException(404, "no such run")
    return entry
```

- [ ] **Step 4: Run the touched suites**

Run: `cd backend && python -m pytest tests/test_api_backtest_progress.py tests/test_api_backtest_coded.py tests/test_api_backtest_sweep.py tests/test_backtest.py -v`
Expected: all PASS (to_thread + default-None kwargs are behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/sweep_apply.py backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_progress.py
git commit -m "feat(api): simulate-phase progress reporting on POST /api/backtest"
```

---

### Task 6: Wire progress into `POST /api/expr/backtest`

**Files:**
- Modify: `backend/auto_trader/api/routers/expr.py` (handler line ~216, `engine.run` line ~282)
- Test: `backend/tests/test_api_expr.py` (append)

**Interfaces:**
- Consumes: `ExprBacktestRequest.progressId` (Task 5), registry (Task 4), engine kwarg (Task 1).
- Produces: same observable contract as Task 5 — during an expr run with `progressId`, `GET /api/backtest/progress/{id}` serves `stage="simulate"` updates; cleared after.

- [ ] **Step 1: Write the failing test**

Append to `test_api_expr.py`, reusing its existing minimal `ExprBacktestRequest` construction (the file already builds valid expr requests — copy the smallest one):

```python
def test_expr_backtest_with_progress_id_updates_then_clears(monkeypatch):
    from auto_trader.core import progress as pr

    req = _minimal_expr_request()          # reuse this file's existing helper/pattern
    req = req.model_copy(update={"progressId": "expr-prog"})
    snapshots: list[dict | None] = []
    real_update = pr.update_progress

    def spying_update(pid, done, total, now=None):
        real_update(pid, done, total, now=now)
        snapshots.append(pr.get_progress(pid))

    monkeypatch.setattr(pr, "update_progress", spying_update)
    asyncio.run(expr.expr_backtest(req))
    assert snapshots and snapshots[-1]["done"] == snapshots[-1]["total"] > 0
    assert pr.get_progress("expr-prog") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_expr.py -v -k progress`
Expected: FAIL — no registry updates (`snapshots` empty), since the handler ignores `progressId`.

- [ ] **Step 3: Implement**

In `expr.py`'s `expr_backtest`, replace `result = engine.run(candles)` (line ~282):

```python
    from auto_trader.core import progress as pr  # top-of-file import

    on_progress = None
    if req.progressId:
        pr.set_progress(req.progressId, stage="simulate")
        pid = req.progressId
        on_progress = lambda done, total: pr.update_progress(pid, done, total)
    try:
        # to_thread: CPU-bound sync run; on the loop thread it would starve the
        # progress polls (and every other request) until it finished.
        result = await asyncio.to_thread(engine.run, candles, on_progress=on_progress)
    finally:
        if req.progressId:
            pr.clear_progress(req.progressId)
```

(`import asyncio` at top if absent.) The rest of the handler (the `_result_to_response` return) stays outside the `finally` — it needs `result`, which exists only on success; the entry must be cleared on failure too, which the `finally` handles.

- [ ] **Step 4: Run the expr suite**

Run: `cd backend && python -m pytest tests/test_api_expr.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/expr.py backend/tests/test_api_expr.py
git commit -m "feat(api): simulate-phase progress on POST /api/expr/backtest"
```

---

### Task 7: Frontend — API functions, signal, and poller

**Files:**
- Modify: `frontend/src/api.ts` (add two fetchers + `progressId?` on both request interfaces)
- Modify: `frontend/src/lib/signals.ts` (near `backtestRunningSignal`, line ~418)
- Create: `frontend/src/lib/backtestProgress.ts`
- Test: `frontend/src/lib/backtestProgress.test.ts` (create)

**Interfaces:**
- Consumes: Task 3 + Task 5 endpoints.
- Produces:
  - `api.ts`: `progressId?: string` on `BacktestRequest` and `ExprBacktestRequest` interfaces; `fetchActiveBackfills(): Promise<BackfillProgress[]>` where `BackfillProgress = { label: string; doneChunks: number; totalChunks: number; bars: number; elapsedS: number; etaS: number | null; at: string }`; `fetchBacktestProgress(id: string): Promise<{ stage: string; done: number; total: number } | null>` (null on 404/network error — progress is cosmetic).
  - `signals.ts`: `export type BacktestProgress = { phase: "download" | "simulate"; label: string; pct: number | null; etaS: number | null };` and `export const backtestProgressSignal = new Signal<BacktestProgress | null>(null);`
  - `backtestProgress.ts`: `startBacktestProgressPoller(progressId: string): () => void` — polls both endpoints every 1000 ms, prefers simulate (a live progressId entry) over download (first active backfill), sets `backtestProgressSignal`; the returned stop function clears the interval AND resets the signal to null.

- [ ] **Step 1: Write the failing tests**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backtestProgressSignal } from "./signals";
import { startBacktestProgressPoller } from "./backtestProgress";
import * as api from "../api";

describe("startBacktestProgressPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    backtestProgressSignal.set(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows download phase from active backfills when no simulate entry", async () => {
    vi.spyOn(api, "fetchBacktestProgress").mockResolvedValue(null);
    vi.spyOn(api, "fetchActiveBackfills").mockResolvedValue([
      { label: "dukascopy/US100/MINUTE_5/bid", doneChunks: 14, totalChunks: 70,
        bars: 27370, elapsedS: 49.8, etaS: 199, at: "2023-08-01 20:45" },
    ]);
    const stop = startBacktestProgressPoller("pid-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(backtestProgressSignal.value).toEqual({
      phase: "download", label: "dukascopy/US100/MINUTE_5/bid",
      pct: 20, etaS: 199,
    });
    stop();
  });

  it("prefers simulate phase once the progress entry exists", async () => {
    vi.spyOn(api, "fetchBacktestProgress").mockResolvedValue({ stage: "simulate", done: 64, total: 100 });
    vi.spyOn(api, "fetchActiveBackfills").mockResolvedValue([]);
    const stop = startBacktestProgressPoller("pid-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(backtestProgressSignal.value).toEqual({
      phase: "simulate", label: "simulate", pct: 64, etaS: null,
    });
    stop();
  });

  it("poll failures leave the signal unchanged, stop() resets it", async () => {
    vi.spyOn(api, "fetchBacktestProgress").mockRejectedValue(new Error("net"));
    vi.spyOn(api, "fetchActiveBackfills").mockRejectedValue(new Error("net"));
    const stop = startBacktestProgressPoller("pid-1");
    await vi.advanceTimersByTimeAsync(2000);
    expect(backtestProgressSignal.value).toBeNull();
    stop();
    expect(backtestProgressSignal.value).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/backtestProgress.test.ts`
Expected: FAIL — module `./backtestProgress` does not exist.

- [ ] **Step 3: Implement**

`api.ts` — add `progressId?: string;` to the `BacktestRequest` interface and the `ExprBacktestRequest` interface (one line each, near the other optional fields), plus:

```typescript
// --- backtest progress side-channel ------------------------------------------
// Both fetchers are best-effort: progress is cosmetic, so ANY failure (network,
// 404, non-JSON) resolves to an empty/null result rather than throwing.
export type BackfillProgress = {
  label: string; doneChunks: number; totalChunks: number;
  bars: number; elapsedS: number; etaS: number | null; at: string;
};

export async function fetchActiveBackfills(): Promise<BackfillProgress[]> {
  try {
    const res = await fetch(`${BASE}/api/candle-cache/backfill/active`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function fetchBacktestProgress(
  id: string,
): Promise<{ stage: string; done: number; total: number } | null> {
  try {
    const res = await fetch(`${BASE}/api/backtest/progress/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
```

`signals.ts` — right after `backtestRunningSignal` (line ~418):

```typescript
// Live progress for the in-flight run: the download phase mirrors the server's
// candle-cache backfill walk, the simulate phase the engine's bar loop. Owned
// by lib/backtestProgress.ts's poller; BacktestPanel renders it. Null when no
// run is in flight or no progress info is available (progress is cosmetic).
export type BacktestProgress = {
  phase: "download" | "simulate";
  label: string;
  pct: number | null;
  etaS: number | null;
};
export const backtestProgressSignal = new Signal<BacktestProgress | null>(null);
```

`lib/backtestProgress.ts`:

```typescript
// 1s poller feeding backtestProgressSignal while a backtest run is in flight.
// Simulate beats download: once the POST is running its progress entry exists,
// and any backfill rows still active belong to background work, not this run.
// Failures are swallowed — a missed poll just leaves the last value showing.
import { fetchActiveBackfills, fetchBacktestProgress } from "../api";
import { backtestProgressSignal } from "./signals";

const POLL_MS = 1000;

export function startBacktestProgressPoller(progressId: string): () => void {
  let stopped = false;
  const tick = async () => {
    const [sim, backfills] = await Promise.all([
      fetchBacktestProgress(progressId).catch(() => null),
      fetchActiveBackfills().catch(() => []),
    ]);
    if (stopped) return; // a late response must not overwrite the reset
    if (sim && sim.total > 0) {
      backtestProgressSignal.set({
        phase: "simulate", label: sim.stage,
        pct: Math.floor((sim.done / sim.total) * 100), etaS: null,
      });
    } else if (backfills.length > 0) {
      const b = backfills[0];
      backtestProgressSignal.set({
        phase: "download", label: b.label,
        pct: b.totalChunks > 0 ? Math.floor((b.doneChunks / b.totalChunks) * 100) : null,
        etaS: b.etaS,
      });
    }
  };
  const interval = setInterval(tick, POLL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
    backtestProgressSignal.set(null);
  };
}
```

Note: the mocks spy on `api` module exports, so `backtestProgress.ts` must call them via the imported bindings exactly as written (`fetchBacktestProgress(...)`, not a destructured local copy taken at module load — the import-binding call form above is fine for `vi.spyOn`; if the project's vitest setup can't spy on ESM exports, switch the test to `vi.mock("../api", ...)` factory form instead).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/backtestProgress.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/signals.ts frontend/src/lib/backtestProgress.ts frontend/src/lib/backtestProgress.test.ts
git commit -m "feat(frontend): backtest progress signal + 1s poller"
```

---

### Task 8: Frontend — wire poller into the run and render in the panel

**Files:**
- Modify: `frontend/src/BacktestButton.tsx` (`run()`, lines ~151–204 and the `finally` at ~684; the request-building spots that construct the POST bodies)
- Modify: `frontend/src/BacktestPanel.tsx` (running branch, line ~136)
- Modify: `frontend/src/App.css` (near `.bt-results-empty`, line ~4638)
- Test: `frontend/src/BacktestPanel.progress.test.tsx` (create)

**Interfaces:**
- Consumes: `startBacktestProgressPoller` + `backtestProgressSignal` (Task 7), `progressId` request fields (Task 7).

- [ ] **Step 1: Write the failing test**

Check for an existing `BacktestPanel` test to copy render scaffolding from (`ls frontend/src | grep -i backtestpanel`); if none, mirror the render setup of any component test in `src` (they use @testing-library/react — confirm via an existing `*.test.tsx`).

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import BacktestPanel from "./BacktestPanel";
import { backtestProgressSignal, backtestRunningSignal, backtestResultSignal } from "./lib/signals";

describe("BacktestPanel progress line", () => {
  afterEach(() => {
    cleanup();
    backtestRunningSignal.set(false);
    backtestProgressSignal.set(null);
    backtestResultSignal.set(null);
  });

  it("shows download progress while running", () => {
    backtestRunningSignal.set(true);
    backtestProgressSignal.set({
      phase: "download", label: "dukascopy/US100/MINUTE_5/bid", pct: 21, etaS: 186,
    });
    render(<BacktestPanel />);
    expect(screen.getByText(/Downloading dukascopy\/US100\/MINUTE_5\/bid — 21%/)).toBeTruthy();
    expect(screen.getByText(/~3m left/)).toBeTruthy();
  });

  it("shows simulate progress", () => {
    backtestRunningSignal.set(true);
    backtestProgressSignal.set({ phase: "simulate", label: "simulate", pct: 64, etaS: null });
    render(<BacktestPanel />);
    expect(screen.getByText(/Simulating — 64%/)).toBeTruthy();
  });

  it("falls back to the static line without progress info", () => {
    backtestRunningSignal.set(true);
    render(<BacktestPanel />);
    expect(screen.getByText("Backtest running…")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestPanel.progress.test.tsx`
Expected: first two cases FAIL (only the static line renders).

- [ ] **Step 3: Implement panel rendering**

In `BacktestPanel.tsx`: subscribe next to the other signals (top of the component):

```tsx
const progress = useSyncExternalStore(
  (cb) => backtestProgressSignal.subscribe(cb),
  () => backtestProgressSignal.value,
);
```

(add `backtestProgressSignal` to the existing `./lib/signals` import). Add a formatter near the other `fmt*` helpers:

```tsx
const fmtEta = (s: number): string => {
  const m = Math.round(s / 60);
  return s < 90 ? `~${Math.max(1, Math.round(s))}s left` : `~${m}m left`;
};
```

Replace the running branch of the empty state (line ~136):

```tsx
        <div className="bt-results-empty">
          {running && progress ? (
            <span className="bt-progress">
              <span>
                {progress.phase === "download"
                  ? `Downloading ${progress.label}${progress.pct != null ? ` — ${progress.pct}%` : ""}`
                  : `Simulating — ${progress.pct ?? 0}%`}
                {progress.etaS != null && `, ${fmtEta(progress.etaS)}`}
              </span>
              {progress.pct != null && (
                <span className="bt-progress-track">
                  <span className="bt-progress-fill" style={{ width: `${progress.pct}%` }} />
                </span>
              )}
            </span>
          ) : running ? (
            "Backtest running…"
          ) : (
            "Run a backtest to see results here."
          )}
        </div>
```

Note the ETA test expects `~3m left` for 186 s — `Math.round(186/60) = 3`. ✓

`App.css`, after `.bt-results-empty` (line ~4638):

```css
.bt-progress { display: flex; flex-direction: column; gap: 6px; }
.bt-progress-track { display: block; height: 3px; border-radius: 2px; background: var(--border, rgba(128,128,128,.25)); overflow: hidden; }
.bt-progress-fill { display: block; height: 100%; background: var(--accent, #4a90d9); transition: width .3s ease; }
```

(Check the file's actual CSS variable names near other progress/track styles and reuse those instead of the fallbacks if the app defines them — grep for `--accent` / `progress` in App.css.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/BacktestPanel.progress.test.tsx`
Expected: PASS

- [ ] **Step 5: Wire the poller + progressId into `run()`**

In `BacktestButton.tsx` `run()` — right after `backtestRunningSignal.set(true);` (line ~168):

```tsx
    // Progress side-channel: the poller feeds backtestProgressSignal (panel
    // renders it); progressId ties the POST to GET /api/backtest/progress/{id}.
    const progressId = crypto.randomUUID();
    const stopProgress = startBacktestProgressPoller(progressId);
```

In the `finally` (line ~684), before `backtestRunningSignal.set(false);`: `stopProgress();`

Then find where the single-run request bodies are built in this file (the objects passed to `runAndRender` — search for `runAndRender(` and the `exprReq`/structured request construction feeding it) and add `progressId` to BOTH the structured and expr single-run bodies. Do NOT add it to sweep (`/api/expr/sweep/jobs`), holdout-evaluate, or walk-forward submissions — those run on job workers with their own status polling, and a shared progressId would cross-talk. Import `startBacktestProgressPoller` from `./lib/backtestProgress`.

- [ ] **Step 6: Typecheck + full touched-files test run**

Run: `cd frontend && npx tsc -b && npx vitest run src/lib/backtestProgress.test.ts src/BacktestPanel.progress.test.tsx`
Expected: clean build, tests PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/BacktestButton.tsx frontend/src/BacktestPanel.tsx frontend/src/App.css frontend/src/BacktestPanel.progress.test.tsx
git commit -m "feat(frontend): live download/simulate progress in the backtest panel"
```

---

### Task 9: End-to-end smoke check

**Files:** none (verification only)

- [ ] **Step 1: Backend regression sweep**

Run: `cd backend && python -m pytest tests/ -v -x -k "backtest or candle_cache or expr or progress or candles"`
Expected: green (module-scoped sweep of everything touched).

- [ ] **Step 2: Manual smoke (if a dev backend is running)**

- `curl -s localhost:<port>/api/candle-cache/backfill/active` → `[]` when idle.
- `curl -s localhost:<port>/api/backtest/progress/nope` → 404.
- If feasible, trigger a backtest over an uncached window from the UI and watch the panel show "Downloading … — N%, ~Xm left" then "Simulating — N%". (Skip if no broker connectivity; the unit tests cover the mechanics.)

- [ ] **Step 3: Final commit if any fixups were needed**

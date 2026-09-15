"""Admin history-download jobs: one background backfill task per series,
with live progress read off the walk's on_progress hook."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from auto_trader.api.history_jobs import HistoryJobManager, JobConflict
from auto_trader.core.candle_cache import CandleCache
from auto_trader.core.models import Candle

KEY = ("capital", "EURUSD", "MINUTE", "mid")


def _c(ts: int, close: float = 1.0) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(ts, tz=timezone.utc),
        open=close, high=close, low=close, close=close, volume=0.0,
    )


class _Source:
    """Broker stand-in: bars exist at `have_ts`; optional gate to hold a fetch
    open (so tests can observe a running job) or an error to raise."""

    def __init__(self, have_ts, *, gate: asyncio.Event | None = None,
                 error: Exception | None = None):
        self._have = sorted(have_ts)
        self._gate = gate
        self._error = error
        self.recent_calls = 0

    async def range(self, start, end):
        if self._gate is not None:
            await self._gate.wait()
        if self._error is not None:
            raise self._error
        s, e = int(start.timestamp()), int(end.timestamp())
        return [_c(t) for t in self._have if s <= t <= e]

    async def recent(self, n):
        self.recent_calls += 1
        return [_c(t) for t in self._have[-n:]]


def _warm(cache: CandleCache, oldest: int = 1000) -> None:
    cache._store_closed(KEY, [_c(oldest)], cutoff_ts=10 ** 12)


async def _wait_done(job, timeout_s: float = 5.0) -> None:
    deadline = asyncio.get_event_loop().time() + timeout_s
    while job.status == "running":
        if asyncio.get_event_loop().time() > deadline:
            pytest.fail(f"job never finished: {job.snapshot()}")
        await asyncio.sleep(0.01)


def test_job_runs_to_target(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    _warm(cache, oldest=1000)
    src = _Source(have_ts=list(range(100, 1060, 60)))
    mgr = HistoryJobManager(cache)

    async def go():
        job = mgr.start(KEY, 60, src.range, src.recent, target_oldest_ts=700)
        assert job.status == "running"
        await _wait_done(job)
        return job

    job = asyncio.run(go())
    assert job.status == "done"
    assert job.result == "target"
    assert job.oldest_ts == 700
    assert job.bars > 0
    assert job.pct == 1.0
    assert cache._coverage(KEY)[0] == 700


def test_job_seeds_cold_series_first(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))  # no coverage at all
    src = _Source(have_ts=list(range(100, 1060, 60)))
    mgr = HistoryJobManager(cache)

    async def go():
        job = mgr.start(KEY, 60, src.range, src.recent, target_oldest_ts=100)
        await _wait_done(job)
        return job

    job = asyncio.run(go())
    assert src.recent_calls == 1
    assert job.status == "done"
    assert cache._coverage(KEY)[0] == 100


def test_duplicate_start_rejected_while_running(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    _warm(cache)
    gate = asyncio.Event()
    src = _Source(have_ts=[100], gate=gate)
    mgr = HistoryJobManager(cache)

    async def go():
        job = mgr.start(KEY, 60, src.range, src.recent, target_oldest_ts=0)
        with pytest.raises(JobConflict):
            mgr.start(KEY, 60, src.range, src.recent, target_oldest_ts=0)
        gate.set()
        await _wait_done(job)

    asyncio.run(go())


def test_restart_allowed_after_finish(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    _warm(cache, oldest=1000)
    src = _Source(have_ts=list(range(100, 1060, 60)))
    mgr = HistoryJobManager(cache)

    async def go():
        first = mgr.start(KEY, 60, src.range, src.recent, target_oldest_ts=700)
        await _wait_done(first)
        second = mgr.start(KEY, 60, src.range, src.recent, target_oldest_ts=400)
        await _wait_done(second)
        return second

    job = asyncio.run(go())
    assert job.status == "done"
    assert cache._coverage(KEY)[0] == 400


def test_cancel_running_job(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    _warm(cache)
    gate = asyncio.Event()  # never set: fetch hangs until cancelled
    src = _Source(have_ts=[100], gate=gate)
    mgr = HistoryJobManager(cache)

    async def go():
        job = mgr.start(KEY, 60, src.range, src.recent, target_oldest_ts=0)
        await asyncio.sleep(0.02)
        assert mgr.cancel(KEY) is True
        await _wait_done(job)
        return job

    job = asyncio.run(go())
    assert job.status == "cancelled"
    assert mgr.cancel(KEY) is False  # nothing left to cancel


def test_fetch_error_marks_job_error(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    _warm(cache)
    src = _Source(have_ts=[], error=RuntimeError("broker down"))
    mgr = HistoryJobManager(cache)

    async def go():
        job = mgr.start(KEY, 60, src.range, src.recent, target_oldest_ts=0)
        await _wait_done(job)
        return job

    job = asyncio.run(go())
    assert job.status == "error"
    assert job.error


def test_pct_is_none_for_full_history(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    _warm(cache, oldest=1000)
    src = _Source(have_ts=list(range(100, 1060, 60)))
    mgr = HistoryJobManager(cache)

    async def go():
        job = mgr.start(KEY, 60, src.range, src.recent, target_oldest_ts=0)
        await _wait_done(job)
        return job

    job = asyncio.run(go())
    assert job.pct is None  # no meaningful denominator for "all history"


def test_jobs_prunes_finished_after_ttl(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    _warm(cache, oldest=1000)
    src = _Source(have_ts=list(range(100, 1060, 60)))
    mgr = HistoryJobManager(cache)

    async def go():
        job = mgr.start(KEY, 60, src.range, src.recent, target_oldest_ts=700)
        await _wait_done(job)
        return job

    job = asyncio.run(go())
    assert mgr.jobs(now=job.finished_at + 1) == [job]
    assert mgr.jobs(now=job.finished_at + 601) == []

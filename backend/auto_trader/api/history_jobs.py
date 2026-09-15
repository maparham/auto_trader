"""Admin-triggered deep history downloads: one background backfill per series.

The chart's admin context menu posts a target depth ("past 10 years", "all"),
and a job here walks CANDLE_CACHE.backfill_below toward it off the request
path, so the download outlives the browser tab. Progress rides the walk's
on_progress hook (cursor + bar counts), which the poll endpoint snapshots.

Deliberately in-process and unpersisted, like sweep_jobs/wfo_jobs: a restart
drops the job record but never the bars — coverage is already durable and
contiguous in the cache, so re-triggering simply resumes from the new oldest.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

from auto_trader.core.candle_cache import CANDLE_CACHE, CandleCache, CandleKey

log = logging.getLogger(__name__)

# Finished (done/error/cancelled) job records linger this long so a polling
# client sees the terminal state before the record disappears.
_FINISHED_TTL_S = 600.0
# Bars to establish a forward block when the series has never been loaded.
_SEED_COUNT = 500

FetchRange = Callable[..., Awaitable[list]]
FetchRecent = Callable[[int], Awaitable[list]]


class JobConflict(Exception):
    """A job for this series is already running."""


class HistoryJob:
    """Mutable job record; the running task writes it, snapshots read it.
    Single event loop, no threads — plain attributes are safe."""

    def __init__(self, key: CandleKey, res_seconds: int, target_oldest_ts: int) -> None:
        self.key = key
        self.res_seconds = res_seconds
        self.target_oldest_ts = target_oldest_ts
        self.status = "running"  # running | done | error | cancelled
        self.result: str | None = None  # backfill outcome: target | floor
        self.error: str | None = None
        self.start_oldest_ts: int | None = None  # coverage.oldest when the walk began
        self.oldest_ts: int | None = None        # the walk's current cursor
        self.bars = 0                            # bars stored by this job
        self.started_at = time.time()
        self.finished_at: float | None = None

    @property
    def pct(self) -> float | None:
        """Fraction of the requested span downloaded, or None when it can't be
        known: before the first coverage read, or for an "all history" job
        (target 0), whose denominator would be the whole epoch."""
        if self.target_oldest_ts <= 0 or self.start_oldest_ts is None or self.oldest_ts is None:
            return None
        span = self.start_oldest_ts - self.target_oldest_ts
        if span <= 0:
            return 1.0
        return min(1.0, max(0.0, (self.start_oldest_ts - self.oldest_ts) / span))

    def snapshot(self) -> dict:
        return {
            "broker": self.key[0],
            "epic": self.key[1],
            "resolution": self.key[2],
            "priceSide": self.key[3],
            "status": self.status,
            "result": self.result,
            "error": self.error,
            "pct": self.pct,
            "oldestTs": self.oldest_ts,
            "targetOldestTs": self.target_oldest_ts,
            "bars": self.bars,
            "elapsedS": (self.finished_at or time.time()) - self.started_at,
        }


class HistoryJobManager:
    def __init__(self, cache: CandleCache) -> None:
        self._cache = cache
        self._jobs: dict[CandleKey, HistoryJob] = {}
        self._tasks: dict[CandleKey, asyncio.Task] = {}

    def start(
        self,
        key: CandleKey,
        res_seconds: int,
        fetch_range: FetchRange,
        fetch_recent: FetchRecent,
        *,
        target_oldest_ts: int,
    ) -> HistoryJob:
        existing = self._jobs.get(key)
        if existing is not None and existing.status == "running":
            raise JobConflict(f"history download already running for {'/'.join(key)}")
        job = HistoryJob(key, res_seconds, target_oldest_ts)
        self._jobs[key] = job
        self._tasks[key] = asyncio.create_task(self._run(job, fetch_range, fetch_recent))
        return job

    def get(self, key: CandleKey) -> HistoryJob | None:
        return self._jobs.get(key)

    def jobs(self, now: float | None = None) -> list[HistoryJob]:
        """All job records, pruning finished ones past their linger TTL."""
        cutoff = (now if now is not None else time.time()) - _FINISHED_TTL_S
        for key, job in list(self._jobs.items()):
            if job.finished_at is not None and job.finished_at < cutoff:
                del self._jobs[key]
        return list(self._jobs.values())

    def cancel(self, key: CandleKey) -> bool:
        task = self._tasks.get(key)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    async def _run(
        self, job: HistoryJob, fetch_range: FetchRange, fetch_recent: FetchRecent
    ) -> None:
        key, res = job.key, job.res_seconds
        try:
            cov = await asyncio.to_thread(self._cache._coverage, key)
            if cov is None:
                # Never-loaded series: establish a forward block so the deep
                # walk has an anchor (same seeding the accumulator does).
                await self._cache.recent(key, res, _SEED_COUNT, fetch_recent)
                cov = await asyncio.to_thread(self._cache._coverage, key)
            if cov is None:
                self._finish(job, "error", error="no data for this series")
                return
            job.start_oldest_ts = job.oldest_ts = cov[0]

            def on_progress(cursor_ts: int, bars_stored: int) -> None:
                job.oldest_ts = cursor_ts
                job.bars += bars_stored

            status = await self._cache.backfill_below(
                key, res, fetch_range,
                target_oldest_ts=job.target_oldest_ts, on_progress=on_progress,
            )
            if status == "error":
                self._finish(job, "error", error="broker fetch failed mid-walk")
            else:
                self._finish(job, "done", result=status)
        except asyncio.CancelledError:
            self._finish(job, "cancelled")
            raise
        except Exception as e:  # noqa: BLE001 — job records the failure, never crashes the loop
            log.exception("history download failed for %s", key)
            self._finish(job, "error", error=str(e))
        finally:
            self._tasks.pop(key, None)

    @staticmethod
    def _finish(job: HistoryJob, status: str, *, result: str | None = None,
                error: str | None = None) -> None:
        job.status = status
        job.result = result
        job.error = error
        job.finished_at = time.time()


MANAGER = HistoryJobManager(CANDLE_CACHE)

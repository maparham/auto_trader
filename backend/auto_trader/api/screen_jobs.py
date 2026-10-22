"""In-memory screen runs: fetch each symbol's candles through the shared
candle cache, judge them in a thread, report progress per symbol.

Not the sweep runner on purpose: that ships one candle set per job to
process workers and sits behind the sweep FairGate, so a screen would queue
behind sweeps. Fetches stay in the event loop (the candle cache is async)
under a per-broker cap shared by every user, so one large screen cannot
swamp a broker that also serves everyone's charts.

Jobs live only in this process and are dropped an hour after they finish."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.core.screen_eval import CompiledScreen, bars_needed, closed_bars, judge

from . import deps

Loader = Callable[[str, str, str, str, int], Awaitable[tuple[list[Candle], bool]]]

_KEEP_FINISHED_S = 3600


class JobBusy(Exception):
    """The user already has a screen running."""


@dataclass
class _Job:
    user_id: str
    total: int
    status: str = "running"
    done: int = 0
    result: dict | None = None
    finished_at: float | None = None
    task: asyncio.Task | None = field(default=None, repr=False)


class ScreenJobs:
    def __init__(self, loader: Loader | None = None, per_broker: int = 4,
                 clock: Callable[[], float] = time.time) -> None:
        self._loader = loader or deps.load_alert_bars
        self._per_broker = per_broker
        self._clock = clock
        self._sems: dict[str, asyncio.Semaphore] = defaultdict(lambda: asyncio.Semaphore(self._per_broker))
        self._jobs: dict[str, _Job] = {}

    def _prune(self) -> None:
        now = self._clock()
        for jid in [j for j, job in self._jobs.items()
                    if job.finished_at is not None and now - job.finished_at > _KEEP_FINISHED_S]:
            del self._jobs[jid]

    def start(self, user_id: str, *, broker: str, resolution: str, side: str,
              symbols: list[str], cs: CompiledScreen) -> str:
        self._prune()
        if any(j.user_id == user_id and j.status == "running" for j in self._jobs.values()):
            raise JobBusy()
        jid = uuid.uuid4().hex[:12]
        job = _Job(user_id=user_id, total=len(symbols))
        self._jobs[jid] = job
        job.task = asyncio.get_running_loop().create_task(
            self._run(job, broker, resolution, side, symbols, cs))
        job.task.add_done_callback(lambda t: self._mark_cancelled_if_needed(job, t))
        return jid

    def _mark_cancelled_if_needed(self, job: _Job, task: asyncio.Task) -> None:
        # A task cancelled before its coroutine ever runs its first step never
        # reaches _run's own except CancelledError (the throw happens before
        # the body executes at all), so this done callback is the only place
        # that observes that case and finalizes the job.
        if job.status == "running" and task.cancelled():
            job.status = "cancelled"
            job.finished_at = self._clock()

    async def _one(self, job: _Job, broker: str, resolution: str, side: str,
                   epic: str, cs: CompiledScreen, res_s: int) -> tuple[dict | None, dict | None]:
        try:
            async with self._sems[broker]:
                bars, degraded = await self._loader(broker, epic, resolution, side, bars_needed(cs) + 1)
            if degraded:
                return None, {"epic": epic, "reason": "broker unavailable, cached bars only"}
            if not bars:
                return None, {"epic": epic, "reason": "no candles"}
            bars = closed_bars(list(bars), res_s, self._clock())
            j = await asyncio.to_thread(judge, cs, bars, resolution)
            if j.skip_reason:
                return None, {"epic": epic, "reason": j.skip_reason}
            if j.matched:
                return {"epic": epic, "bar_time": j.bar_time_ms, "columns": j.columns}, None
            return None, None
        except asyncio.CancelledError:
            raise
        except Exception as e:  # one bad symbol must not kill the run
            return None, {"epic": epic, "reason": str(e) or type(e).__name__}
        finally:
            job.done += 1

    async def _run(self, job: _Job, broker: str, resolution: str, side: str,
                   symbols: list[str], cs: CompiledScreen) -> None:
        t0 = time.perf_counter()
        res_s = resolution_seconds(resolution)
        try:
            pairs = await asyncio.gather(*(
                self._one(job, broker, resolution, side, epic, cs, res_s) for epic in symbols))
        except asyncio.CancelledError:
            job.status = "cancelled"
            job.finished_at = self._clock()
            return
        matches = [m for m, _ in pairs if m]
        skipped = [s for _, s in pairs if s]
        job.result = {"matches": matches, "skipped": skipped,
                      "stats": {"symbols": len(symbols), "matched": len(matches),
                                "skipped": len(skipped),
                                "ms": int((time.perf_counter() - t0) * 1000)}}
        job.status = "done"
        job.finished_at = self._clock()

    def status(self, user_id: str, job_id: str) -> dict | None:
        job = self._jobs.get(job_id)
        if job is None or job.user_id != user_id:
            return None
        return {"status": job.status, "done": job.done, "total": job.total, "result": job.result}

    def cancel(self, user_id: str, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None or job.user_id != user_id or job.status != "running" or job.task is None:
            return False
        job.task.cancel()
        return True


SCREEN_JOBS = ScreenJobs()

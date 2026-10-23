"""In-memory screen runs: fetch each symbol's candles, and the candles of
every timeframe the screen pins, through the shared candle cache, judge
them in a thread, report progress per symbol.

Not the sweep runner on purpose: that ships one candle set per job to
process workers and sits behind the sweep FairGate, so a screen would queue
behind sweeps. Fetches stay in the event loop (the candle cache is async)
under a per-broker cap shared by every user, so one large screen cannot
swamp a broker that also serves everyone's charts.

A job's status is one of "running", "done", "cancelled" or "error". Every
one of those is set from a single place, the task's done callback, so a job
can never get stuck "running" forever: a cancelled task lands as
"cancelled" and anything else that escaped the run (a bad resolution
string, a bug while assembling the result) lands as "error" with a short
reason, rather than locking that user out of ever starting another screen.

Judging runs in threads under a per-runner cap of 2, separate from the
per-broker fetch cap, because heavy panes (Trendlines) cost far more than a
fetch; a cancelled run starts no further judges, though up to two in flight
finish in their threads.

Jobs live only in this process and are dropped an hour after they finish."""

from __future__ import annotations

import asyncio
import dataclasses
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from starlette.exceptions import HTTPException as StarletteHTTPException

from auto_trader.api.htf_source import HtfNeed, closed_before, fetch_htf, warm_window
from auto_trader.api.line_rebase import rebase_lines
from auto_trader.api.schemas import PickedLineDTO
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.core.screen_eval import CompiledScreen, bars_needed, closed_bars, judge
from auto_trader.strategy.expr.lines import PickedLine

from . import deps

Loader = Callable[[str, str, str, str, int], Awaitable[tuple[list[Candle], bool]]]
HtfLoader = Callable[[str, str, HtfNeed, str, int, int], Awaitable[tuple[list[Candle], bool]]]


async def _load_htf(broker: str, epic: str, need: HtfNeed, side: str,
                    from_ts: int, to_ts: int) -> tuple[list[Candle], bool]:
    """Default pinned-candle loader: a warm window through the candle cache,
    reporting the cache's degraded flag like load_alert_bars does."""
    degraded: dict = {}
    start, end, n = warm_window(need, from_ts, to_ts)
    bars = await fetch_htf(need, broker=broker, epic=epic, side=side,
                           from_ts=start, to_ts=end, bars=n, degraded=degraded)
    return bars, bool(degraded)

_KEEP_FINISHED_S = 3600


def _reason(e: Exception) -> str:
    """A skip reason without the "502: " prefix str() gives an HTTPException."""
    if isinstance(e, StarletteHTTPException) and isinstance(e.detail, str) and e.detail:
        return e.detail
    return str(e) or type(e).__name__


class JobBusy(Exception):
    """The user already has a screen running."""


@dataclass
class _Job:
    user_id: str
    total: int
    status: str = "running"
    done: int = 0
    result: dict | None = None
    error: str | None = None
    finished_at: float | None = None
    task: asyncio.Task | None = field(default=None, repr=False)


class ScreenJobs:
    def __init__(self, loader: Loader | None = None, htf_loader: HtfLoader | None = None,
                 per_broker: int = 4, clock: Callable[[], float] = time.time,
                 per_compute: int = 2) -> None:
        self._loader = loader or deps.load_alert_bars
        self._htf_loader = htf_loader or _load_htf
        self._per_broker = per_broker
        self._clock = clock
        self._sems: dict[str, asyncio.Semaphore] = defaultdict(lambda: asyncio.Semaphore(self._per_broker))
        self._compute = asyncio.Semaphore(per_compute)
        self._jobs: dict[str, _Job] = {}

    def _prune(self) -> None:
        now = self._clock()
        for jid in [j for j, job in self._jobs.items()
                    if job.finished_at is not None and now - job.finished_at > _KEEP_FINISHED_S]:
            del self._jobs[jid]

    def start(self, user_id: str, *, broker: str, resolution: str, side: str,
              symbols: list[str], cs: CompiledScreen, include_open: bool = False) -> str:
        self._prune()
        if any(j.user_id == user_id and j.status == "running" for j in self._jobs.values()):
            raise JobBusy()
        jid = uuid.uuid4().hex[:12]
        job = _Job(user_id=user_id, total=len(symbols))
        self._jobs[jid] = job
        job.task = asyncio.get_running_loop().create_task(
            self._run(job, broker, resolution, side, symbols, cs, include_open))
        job.task.add_done_callback(lambda t: self._finalize(job, t))
        return jid

    def _finalize(self, job: _Job, task: asyncio.Task) -> None:
        """The single place that resolves a job still "running" once its
        task ends, whatever the outcome. Normal completion already set
        job.status/result/finished_at inside _run, so this is a no-op then.
        A cancelled task (even one cancelled before its coroutine ever took
        a step, which never reaches a try/except inside _run at all) lands
        as "cancelled"; any other exception that escaped _run (a bad
        resolution string, a bug while assembling the result) lands as
        "error" with a short reason. Either way finished_at is set, so the
        job is never stuck "running" and the user is never locked out of
        starting another screen."""
        if job.status != "running":
            return
        if task.cancelled():
            job.status = "cancelled"
        else:
            exc = task.exception()
            job.status = "error"
            job.error = str(exc) or type(exc).__name__
        job.finished_at = self._clock()

    async def _one(self, job: _Job, broker: str, resolution: str, side: str,
                   epic: str, cs: CompiledScreen, res_s: int,
                   include_open: bool = False) -> tuple[dict | None, dict | None]:
        try:
            async with self._sems[broker]:
                bars, degraded = await self._loader(broker, epic, resolution, side, bars_needed(cs) + 1)
            if degraded:
                return None, {"epic": epic, "reason": "broker unavailable, cached bars only"}
            if not bars:
                return None, {"epic": epic, "reason": "no candles"}
            # The forming bar stays only when the screen asked for it, and then
            # the last closed bar is judged too (judge's also_prev); pinned
            # alignment still reads only pinned bars closed by its open.
            closed = closed_bars(list(bars), res_s, self._clock())
            also_prev = include_open and 0 < len(closed) < len(bars)
            bars = list(bars) if include_open else closed
            if not bars:  # a one-bar history whose only bar is still forming
                return None, {"epic": epic, "reason": "no candles"}
            # Pinned timeframes: one fetch each, each taking the broker slot on
            # its own (never one hold across several awaits). Sufficiency is
            # judged at the judged bar's open, the same rule as a backtest's
            # tradeFromTime; the forming pinned bar closes after now, so the
            # alignment gate never reads it and it needs no trimming.
            htf: dict[str, list[Candle]] = {}
            cutoff = int(bars[-1].time.timestamp())
            for need in cs.htf:
                async with self._sems[broker]:
                    pinned, pinned_degraded = await self._htf_loader(
                        broker, epic, need, side, int(bars[0].time.timestamp()), int(self._clock()))
                if pinned_degraded:
                    return None, {"epic": epic, "reason": "broker unavailable, cached bars only"}
                if closed_before(pinned, need.tf_s, cutoff) < need.need:
                    return None, {"epic": epic, "reason": f"not enough @{need.tf} history"}
                # The closed bar judged beside the open one reads one pinned
                # bar fewer when the open bar starts on a pinned close; short
                # of history, it is left out rather than judged under-warmed.
                if also_prev and closed_before(pinned, need.tf_s, int(bars[-2].time.timestamp())) < need.need:
                    also_prev = False
                htf[need.res] = pinned
            # Picked lines this symbol itself owns may have both anchors
            # before the loaded range (a screen run long after the pick):
            # rebase them onto the first bar actually judged. Other symbols'
            # lines ride along inactive and need no rebase.
            own_lines = {lid: ln for lid, ln in cs.lines.items()
                        if ln.epic == epic and (not broker or not ln.broker or ln.broker == broker)}
            if own_lines:
                dtos = {lid: PickedLineDTO(**dataclasses.asdict(ln)) for lid, ln in own_lines.items()}
                warns = await rebase_lines(dtos, first_ms=int(bars[0].time.timestamp() * 1000),
                                          side=side, loader=self._loader)
                if warns:
                    return None, {"epic": epic, "reason": warns[0]}
                rebased = {lid: PickedLine(**d.model_dump()) for lid, d in dtos.items()}
                cs = dataclasses.replace(cs, lines={**cs.lines, **rebased})
            async with self._compute:
                j = await asyncio.to_thread(judge, cs, bars, resolution, htf, also_prev, epic=epic, broker=broker)
            if j.skip_reason:
                return None, {"epic": epic, "reason": j.skip_reason}
            if j.matched:
                return {"epic": epic, "bar_time": j.bar_time_ms, "columns": j.columns,
                        "divergences": j.divergences}, None
            return None, None
        except asyncio.CancelledError:
            raise
        except Exception as e:  # one bad symbol must not kill the run
            return None, {"epic": epic, "reason": _reason(e)}
        finally:
            job.done += 1

    async def _run(self, job: _Job, broker: str, resolution: str, side: str,
                   symbols: list[str], cs: CompiledScreen, include_open: bool = False) -> None:
        # No try/except here: whatever this raises (CancelledError, or any
        # other exception, such as resolution_seconds on a bad resolution
        # string) is left to propagate and resolved once, in _finalize, the
        # task's done callback.
        t0 = time.perf_counter()
        res_s = resolution_seconds(resolution)
        pairs = await asyncio.gather(*(
            self._one(job, broker, resolution, side, epic, cs, res_s, include_open) for epic in symbols))
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
        out = {"status": job.status, "done": job.done, "total": job.total, "result": job.result}
        if job.error is not None:
            out["error"] = job.error
        return out

    def cancel(self, user_id: str, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None or job.user_id != user_id or job.status != "running" or job.task is None:
            return False
        job.task.cancel()
        return True


SCREEN_JOBS = ScreenJobs()

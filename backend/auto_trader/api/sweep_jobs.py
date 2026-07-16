"""Background sweep job manager.

Runs sweep combos over a `ProcessPoolExecutor` from a daemon thread so the HTTP
request returns immediately with a job id the frontend polls. One job computes at
a time (an instance-level FIFO gate); queued jobs report `running=True, done=0`
until they win the gate. Rows accumulate in completion order; ETA is derived from
observed wall-clock pace over pool-produced rows (the probe row is excluded).

Task 4 imports `JOBS` (module singleton) and `SWEEP_WORKERS` from here.
"""
from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from dataclasses import dataclass, field

from auto_trader.api import sweep_worker

logger = logging.getLogger(__name__)

# Workers per job. Env override, else one process per core.
SWEEP_WORKERS: int = int(os.environ.get("SWEEP_WORKERS") or (os.cpu_count() or 1))

# Jobs finished longer ago than this (seconds) are pruned from the store on
# access. Measured from completion, not submission, so a long-running or
# long-queued sweep's results still get a full hour of poll/re-attach life.
_TTL_SECONDS = 3600.0


@dataclass
class SweepJob:
    job_id: str
    epic: str
    timeframe: str
    total: int
    rows: list[dict] = field(default_factory=list)
    done: int = 0
    running: bool = True
    cancelled: bool = False
    error: str | None = None
    eta_seconds: float | None = None
    created_at: float = 0.0
    finished_at: float = 0.0
    # `_probe_offset` (1 if a probe row was seeded, else 0) is set as a bare
    # instance attribute in `submit`, NOT a dataclass field, so it stays out of
    # `fields()`/`asdict()` and never leaks into a serialized API payload.


class SweepJobManager:
    """Owns the job store, the FIFO gate, and one worker thread per job."""

    def __init__(self, pool_factory=ProcessPoolExecutor, grace_seconds: float = 10.0):
        self._pool_factory = pool_factory
        self._grace_seconds = grace_seconds
        self._jobs: dict[str, SweepJob] = {}
        self._store_lock = threading.Lock()
        # Instance-level gate: one job computes at a time for THIS manager (the
        # app singleton). Separate managers in tests do not serialize together.
        self._gate = threading.Semaphore(1)

    def submit(
        self,
        *,
        req_dict: dict,
        htf_candles: dict,
        strategies_dir: str | None,
        windows: list[int] | None,
        combos: list[dict],
        epic: str,
        timeframe: str,
        probe_row: dict | None,
        workers: int | None = None,
        grace_seconds: float | None = None,
    ) -> SweepJob:
        probe_offset = 1 if probe_row is not None else 0
        job = SweepJob(
            job_id=uuid.uuid4().hex,
            epic=epic,
            timeframe=timeframe,
            total=len(combos) + probe_offset,
            rows=[probe_row] if probe_row is not None else [],
            done=probe_offset,
            created_at=time.time(),
        )
        job._probe_offset = probe_offset  # bare attr, not a dataclass field
        with self._store_lock:
            self._jobs[job.job_id] = job
        init = (req_dict, htf_candles, strategies_dir, windows)
        grace = self._grace_seconds if grace_seconds is None else grace_seconds
        t = threading.Thread(
            target=self._run,
            args=(job, init, combos, workers or SWEEP_WORKERS, grace),
            daemon=True,
        )
        t.start()
        return job

    def get(self, job_id: str) -> SweepJob | None:
        self._prune()
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None or not job.running:
            return False
        # Set cancelled first; the thread flips running=False in its finally, so a
        # poll consumer that sees running=False can trust cancelled is already set.
        job.cancelled = True
        return True

    def list(self) -> list[SweepJob]:
        self._prune()
        with self._store_lock:
            return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)

    def _prune(self) -> None:
        now = time.time()
        with self._store_lock:
            stale = [
                jid for jid, j in self._jobs.items()
                if not j.running and now - (j.finished_at or j.created_at) > _TTL_SECONDS
            ]
            for jid in stale:
                del self._jobs[jid]

    def _run(self, job: SweepJob, init: tuple, combos: list[dict], workers: int,
             grace: float) -> None:
        # row_lock protects rows/done/eta: only this _run thread mutates them.
        row_lock = threading.Lock()
        with self._gate:  # FIFO gate: one job computes at a time
            if job.cancelled:
                job.finished_at = time.time()
                job.running = False
                return
            pool = None
            t0 = time.monotonic()
            try:
                # Managed manually (not via `with`): the context-manager __exit__ calls
                # shutdown(wait=True), which would block on killed/in-flight workers
                # after a cancel. We shut down non-blocking ourselves in `finally`.
                pool = self._pool_factory(
                    max_workers=workers,
                    initializer=sweep_worker.worker_init,
                    initargs=init,
                )
                futures = [pool.submit(sweep_worker.run_combo, c) for c in combos]
                seen: set = set()
                pending = set(futures)
                # Bounded wait (not as_completed) so a cancel is observed even
                # when no combo ever completes (e.g. a coded strategy hangs) —
                # otherwise the thread blocks forever holding the FIFO gate.
                while pending:
                    done_now, pending = wait(pending, timeout=0.5, return_when=FIRST_COMPLETED)
                    # Record finished combos BEFORE honoring a cancel, so work
                    # completed while we slept is never thrown away.
                    for fut in done_now:
                        row = fut.result()  # run_combo never raises
                        seen.add(fut)
                        self._record(job, row, row_lock, t0)
                    if job.cancelled:
                        pool.shutdown(wait=False, cancel_futures=True)
                        self._reap(pool, futures, seen, job, row_lock, t0, grace)
                        break
            except Exception as e:  # noqa: BLE001  surface, never leak a traceback
                job.error = str(e)
            finally:
                if pool is not None:
                    pool.shutdown(wait=False)
                # Emitted BEFORE running flips so a log consumer polling on
                # running=False always finds the line already written.
                failed = sum(1 for r in job.rows if r.get("error"))
                logger.info("sweep job done in %.1fs: %d ok, %d failed",
                            time.monotonic() - t0, len(job.rows) - failed, failed)
                job.finished_at = time.time()
                job.running = False

    def _record(self, job: SweepJob, row: dict, row_lock: threading.Lock,
                t0: float) -> None:
        with row_lock:
            job.rows.append(row)
            job.done += 1
            produced = max(1, job.done - job._probe_offset)
            pace = (time.monotonic() - t0) / produced
            job.eta_seconds = pace * (job.total - job.done)

    def _reap(self, pool, futures: list, seen: set, job: SweepJob,
              row_lock: threading.Lock, t0: float, grace: float) -> None:
        """After a cancel: harvest futures that finished before/while we stopped,
        wait up to `grace` for in-flight ones, then kill any survivors so the
        thread cannot hang on a slow combo. `seen` are futures already recorded by
        the main loop, so we do not double-count them."""
        deadline = time.monotonic() + grace
        pending = [f for f in futures if f not in seen]
        while pending and time.monotonic() < deadline:
            still = []
            for fut in pending:
                if fut.cancelled():
                    continue  # shutdown(cancel_futures=True) dropped a pending combo
                if fut.done():
                    self._record(job, fut.result(), row_lock, t0)
                else:
                    still.append(fut)
            pending = still
            if pending:
                time.sleep(0.05)
        # Kill any workers still running an in-flight combo. `_processes` is a
        # private ProcessPoolExecutor attr: acceptable for a single-user tool, and
        # there is no public API to force-terminate stuck workers. Snapshot first
        # because the dict mutates as processes exit.
        procs = getattr(pool, "_processes", None) or {}
        for p in list(procs.values()):
            try:
                p.kill()
            except Exception:  # noqa: BLE001  process may already be gone
                pass


JOBS = SweepJobManager()

"""Background walk-forward job manager: a meta-job over the sweep pool.

Phase 1 (grid): every combo runs ONCE over the full range; workers return
per-train-window sliced metrics. Phase 2 (test): each fold's selected winner
runs exactly over its test window. Phase 3 (aggregate): selection tables,
stitching, stability, robustness -- pure arithmetic in this thread.

Mirrors SweepJobManager (fair gate round-robin across owners, daemon thread,
bounded-wait cancel loop, reap-and-kill) but drives the three phases above
instead of a flat row stream.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from dataclasses import dataclass, field

from auto_trader.api import wfo_worker
from auto_trader.api.fair_gate import FairGate
from auto_trader.api.sweep_jobs import SWEEP_WORKERS
from auto_trader.api.wfo_select import plateau_breadth, select_fold
from auto_trader.api.wfo_stitch import (
    aggregate, annualized_rate, fold_excess, fold_wfe, stitch,
)
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.engine.stability import parameter_stability

logger = logging.getLogger(__name__)

# Jobs finished longer ago than this (seconds) are pruned from the store on
# access. Measured from completion so a long run keeps a full hour of poll life.
_TTL_SECONDS = 3600.0


@dataclass
class WfoJob:
    job_id: str
    epic: str
    timeframe: str
    total: int
    done: int = 0
    phase: str = "grid"  # "grid" | "test" | "aggregate" | "done"
    fold_rows: list[dict] = field(default_factory=list)  # streamed winner rows
    result: dict | None = None
    # "s{scheme}/f{fold}" -> ranked table rows for the lazy endpoint.
    fold_tables: dict[str, list[dict]] = field(default_factory=dict)
    running: bool = True
    cancelled: bool = False
    error: str | None = None
    eta_seconds: float | None = None
    created_at: float = 0.0
    finished_at: float = 0.0
    owner: str = "dev"


class WfoJobManager:
    """Owns the job store, the fair gate (round-robin across owners), and one
    worker thread per job."""

    def __init__(self, pool_factory=ProcessPoolExecutor, grace_seconds: float = 10.0):
        self._pool_factory = pool_factory
        self._grace_seconds = grace_seconds
        self._jobs: dict[str, WfoJob] = {}
        self._store_lock = threading.Lock()
        # Instance-level gate: one job computes at a time for THIS manager.
        # Waiting jobs are served round-robin across owners so one user's flood
        # of queued jobs cannot starve another user's first job.
        self._gate = FairGate()

    def submit(
        self,
        *,
        req_dict: dict,
        htf_candles: dict,
        strategies_dir: str | None,
        schemes: list[dict],
        axes: list[dict],
        objective: dict,
        schedule_meta: dict,
        epic: str,
        timeframe: str,
        combos: list[dict],
        workers: int | None = None,
        expr: bool = False,
        eval_mode: str = "exact",
        baselines: list[str] | None = None,
        on_complete=None,
        owner: str = "dev",
    ) -> WfoJob:
        # Baselines run per fold for expr AND coded jobs (coded requests are
        # converted to expr null/hold in the worker). De-duplicated because
        # `_run` de-dupes (key, kind) too -- a repeated kind runs once. Coded
        # folds whose winner never traded skip their baselines; the aggregate
        # phase forces done=total, so the shortfall never stalls progress.
        n_baselines = len(set(baselines)) if baselines else 0
        n_folds = sum(len(sc["folds"]) for sc in schemes)
        total = len(combos) + n_folds * (1 + n_baselines)
        job = WfoJob(
            job_id=uuid.uuid4().hex,
            epic=epic,
            timeframe=timeframe,
            total=total,
            created_at=time.time(),
            owner=owner,
        )
        with self._store_lock:
            self._jobs[job.job_id] = job
        kw = {
            "req_dict": req_dict,
            "htf_candles": htf_candles,
            "strategies_dir": strategies_dir,
            "schemes": schemes,
            "axes": axes,
            "objective": objective,
            "schedule_meta": schedule_meta,
            "combos": combos,
            "workers": workers,
            "expr": expr,
            "eval_mode": eval_mode,
            "baselines": baselines,
            "on_complete": on_complete,
        }
        t = threading.Thread(target=self._run, args=(job, kw), daemon=True)
        t.start()
        return job

    def get(self, job_id: str) -> WfoJob | None:
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

    def list(self) -> list[WfoJob]:
        self._prune()
        with self._store_lock:
            return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)

    def running_count(self) -> int:
        with self._store_lock:
            return sum(1 for j in self._jobs.values() if j.running)

    def _prune(self) -> None:
        now = time.time()
        with self._store_lock:
            stale = [
                jid for jid, j in self._jobs.items()
                if not j.running and now - (j.finished_at or j.created_at) > _TTL_SECONDS
            ]
            for jid in stale:
                del self._jobs[jid]

    def _finish(self, job: WfoJob) -> None:
        job.finished_at = time.time()
        job.running = False

    def _run(self, job: WfoJob, kw: dict) -> None:
        self._gate.acquire(job.owner)
        try:  # fair gate: one job computes at a time, released in the finally below
            if job.cancelled:
                self._finish(job)
                return
            pool = None
            t0 = time.monotonic()
            try:
                schemes = kw["schemes"]
                # De-duplicated union of train windows across schemes; each fold
                # remembers its index into the union so the worker slices once.
                union: list[list[int]] = []
                index: dict[tuple[int, int], int] = {}
                for sc in schemes:
                    for f in sc["folds"]:
                        key = (f["train_from"], f["train_to"])
                        if key not in index:
                            index[key] = len(union)
                            union.append([f["train_from"], f["train_to"]])
                        f["_w"] = index[key]

                # Managed manually (not via `with`): __exit__ calls
                # shutdown(wait=True), which would block on killed/in-flight
                # workers after a cancel. We shut down non-blocking in `finally`.
                pool = self._pool_factory(
                    max_workers=kw.get("workers") or SWEEP_WORKERS,
                    initializer=wfo_worker.worker_init,
                    initargs=(kw["req_dict"], kw["htf_candles"],
                              kw["strategies_dir"], union, kw.get("expr", False)),
                )
                # --- phase 1: grid ---
                # Exact: score each train window as a real flat-start run
                # (free-slice clean windows, engine-replay boundary windows).
                # Fast: one full-range run sliced N ways (the legacy approximation).
                grid_fn = (wfo_worker.run_grid_combo_exact
                           if kw.get("eval_mode", "exact") == "exact"
                           else wfo_worker.run_grid_combo)
                grid_rows = self._drain(
                    pool,
                    [pool.submit(grid_fn, c) for c in kw["combos"]],
                    job, t0)
                if job.cancelled:
                    return
                # --- phase 2: select + test ---
                job.phase = "test"
                objective = kw["objective"]
                selections: dict[str, dict] = {}
                test_payloads: list[dict] = []
                for si, sc in enumerate(schemes):
                    for fi, f in enumerate(sc["folds"]):
                        rows = [
                            {"combo": r["combo"],
                             "metrics": (r["folds"][f["_w"]] if r["folds"] else None),
                             "error": r["error"]}
                            for r in grid_rows
                        ]
                        obj = {**objective, "min_trades": sc["min_train_trades"]}
                        best_i, values, scores = select_fold(
                            rows, kw["axes"], obj, objective["selection"])
                        key = f"s{si}/f{fi}"
                        job.fold_tables[key] = [
                            {**rows[i], "objective": values[i],
                             "plateau_score": scores[i]}
                            for i in range(len(rows))
                        ]
                        selections[key] = {"rows": rows, "values": values,
                                           "best_i": best_i}
                        if best_i is not None:
                            test_payloads.append({
                                "key": key, "combo": rows[best_i]["combo"],
                                "test_from": f["test_from"], "test_to": f["test_to"],
                            })
                test_futures = [pool.submit(wfo_worker.run_test, p)
                                for p in test_payloads]
                test_rows = self._drain(
                    pool, test_futures, job, t0,
                    stream=lambda r: job.fold_rows.append(
                        {"key": r["key"], "combo": r["combo"],
                         "oos_metrics": r["metrics"], "error": r["error"]}))
                # A cancel between drains would make fut.result() on a killed
                # worker raise BrokenProcessPool, turning a clean cancel into an
                # error — bail before touching baselines.
                if job.cancelled:
                    return
                # Baselines are dispatched AFTER the test drain (not
                # concurrently) because a coded fold's baseline mirrors the
                # sides its winner actually traded — the coded request
                # hardwires both enabled flags true, and a `1==1` entry on both
                # sides hedges to ~0, flattering every strategy (same rule as
                # the single-run coded baselines). A fold whose winner never
                # traded gets no baseline at all, matching that path too. Expr
                # folds keep their request's own side flags.
                wf_baselines = kw.get("baselines")
                baseline_payloads: list[dict] = []
                if wf_baselines:
                    expr_job = kw.get("expr", False)
                    rows_by_key = {r["key"]: r for r in test_rows if r}
                    seen_bl: set[tuple] = set()
                    for p in test_payloads:
                        payload = {"key": p["key"],
                                   "test_from": p["test_from"],
                                   "test_to": p["test_to"]}
                        if not expr_job:
                            trades = (rows_by_key.get(p["key"]) or {}).get("trades") or []
                            long_traded = any(t["side"] == "buy" for t in trades)
                            short_traded = any(t["side"] == "sell" for t in trades)
                            if not (long_traded or short_traded):
                                continue
                            payload["long_enabled"] = long_traded
                            payload["short_enabled"] = short_traded
                        for kind in wf_baselines:
                            k = (p["key"], kind)
                            if k in seen_bl:
                                continue
                            seen_bl.add(k)
                            baseline_payloads.append({**payload, "kind": kind})
                baseline_futures = [pool.submit(wfo_worker.run_baseline, p)
                                    for p in baseline_payloads]
                baseline_rows = self._drain(pool, baseline_futures, job, t0)
                if job.cancelled:
                    return
                baselines_by_key: dict[str, dict[str, dict]] = {}
                for r in baseline_rows:
                    if r and r.get("key") and r.get("kind"):
                        baselines_by_key.setdefault(r["key"], {})[r["kind"]] = r
                # --- phase 3: aggregate ---
                job.phase = "aggregate"
                job.done = job.total  # folds with no eligible winner finish early
                job.result = self._aggregate(
                    kw, schemes, selections,
                    {r["key"]: r for r in test_rows if r}, grid_rows,
                    baselines_by_key)
                job.phase = "done"
                cb = kw.get("on_complete")
                if cb is not None and not job.cancelled:
                    cb(job)
            except Exception as e:  # noqa: BLE001  surface, never leak a traceback
                job.error = str(e)
            finally:
                if pool is not None:
                    # cancel_futures: a cancel landing between drains can leave
                    # queued baseline futures to run in orphaned workers.
                    pool.shutdown(wait=False, cancel_futures=True)
                # Emitted BEFORE running flips so a log consumer polling on
                # running=False always finds the line already written.
                logger.info("wfo job %s done in %.1fs (phase=%s)",
                            job.job_id, time.monotonic() - t0, job.phase)
                self._finish(job)
        finally:
            self._gate.release()

    def _record(self, job: WfoJob, row_lock: threading.Lock, t0: float) -> None:
        with row_lock:
            job.done += 1
            produced = max(1, job.done)
            pace = (time.monotonic() - t0) / produced
            job.eta_seconds = pace * max(0, job.total - job.done)

    def _drain(self, pool, futures: list, job: WfoJob, t0: float,
               stream=None) -> list:
        """Bounded-wait harvest of `futures` (mirrors SweepJobManager._run's
        loop). Records progress via `_record`, streams each result through
        `stream` if given, and on cancel shuts the pool down and reaps in-flight
        futures. Returns results in completion order."""
        row_lock = threading.Lock()
        results: list = []
        seen: set = set()
        pending = set(futures)
        # Bounded wait (not as_completed) so a cancel is observed even when no
        # combo ever completes -- otherwise the thread blocks forever holding
        # the fair gate.
        while pending:
            done_now, pending = wait(pending, timeout=0.5, return_when=FIRST_COMPLETED)
            # Record finished work BEFORE honoring a cancel, so results produced
            # while we slept are never thrown away.
            for fut in done_now:
                row = fut.result()  # run_grid_combo/run_test never raise
                seen.add(fut)
                results.append(row)
                if stream is not None:
                    stream(row)
                self._record(job, row_lock, t0)
            if job.cancelled:
                # Snapshot BEFORE shutdown: shutdown() nulls the pool's
                # `_processes` dict, so reading it afterwards kills nothing
                # and cancelled workers burn CPU to combo completion.
                procs = list((getattr(pool, "_processes", None) or {}).values())
                pool.shutdown(wait=False, cancel_futures=True)
                self._reap(procs, futures, seen, results, job, row_lock, t0, stream)
                break
        return results

    def _reap(self, procs: list, futures: list, seen: set, results: list, job: WfoJob,
              row_lock: threading.Lock, t0: float, stream) -> None:
        """After a cancel: harvest futures that finished before/while we stopped,
        wait up to `grace` for in-flight ones, then kill any survivors so the
        thread cannot hang on a slow combo. `seen` are futures already recorded
        by the main loop, so we do not double-count them. `procs` is the worker
        process list snapshotted before pool.shutdown() (which nulls it)."""
        deadline = time.monotonic() + self._grace_seconds
        pending = [f for f in futures if f not in seen]
        while pending and time.monotonic() < deadline:
            still = []
            for fut in pending:
                if fut.cancelled():
                    continue  # shutdown(cancel_futures=True) dropped a pending combo
                if fut.done():
                    row = fut.result()
                    results.append(row)
                    if stream is not None:
                        stream(row)
                    self._record(job, row_lock, t0)
                else:
                    still.append(fut)
            pending = still
            if pending:
                time.sleep(0.05)
        # Kill any workers still running an in-flight combo so a cancelled job
        # stops burning CPU immediately instead of at combo completion.
        for p in procs:
            try:
                p.kill()
            except Exception:  # noqa: BLE001  process may already be gone
                pass

    def _aggregate(self, kw: dict, schemes: list[dict], selections: dict,
                   tests_by_key: dict, grid_rows: list[dict],
                   baselines_by_key: dict | None = None) -> dict:
        baselines_by_key = baselines_by_key or {}
        res_s = resolution_seconds(kw["req_dict"]["resolution"])
        cash = kw["req_dict"]["costs"]["startingCash"]
        out_schemes = []
        for si, sc in enumerate(schemes):
            folds_out, fold_tests, chosen = [], [], []
            is_ret_total = oos_ret_total = 0.0
            is_secs = oos_secs = 0
            tables = []
            for fi, f in enumerate(sc["folds"]):
                key = f"s{si}/f{fi}"
                sel = selections[key]
                test = tests_by_key.get(key)
                entry = {
                    "train_from": f["train_from"], "train_to": f["train_to"],
                    "test_from": f["test_from"], "test_to": f["test_to"],
                    "combo": None, "is_metrics": None, "oos_metrics": None,
                    "wfe": None, "low_sample": False,
                    "null_long_metrics": None, "null_short_metrics": None,
                    "hold_long_metrics": None, "hold_short_metrics": None,
                    "reversed_metrics": None,
                    "excess_return_pct": None,
                    "error": test["error"] if test else None,
                }
                tables.append(([r["combo"] for r in sel["rows"]], sel["values"]))
                if sel["best_i"] is not None:
                    row = sel["rows"][sel["best_i"]]
                    entry["combo"] = row["combo"]
                    entry["is_metrics"] = row["metrics"]
                if test and test["metrics"] is not None and entry["is_metrics"]:
                    entry["oos_metrics"] = test["metrics"]
                    base = baselines_by_key.get(key, {})
                    # Null/hold workers report per-side metrics ({"long": m|None,
                    # "short": m|None}); flatten to one field per side.
                    for kind in ("null", "hold"):
                        row = base.get(kind)
                        sides = (row["metrics"] or {}) if row else {}
                        entry[f"{kind}_long_metrics"] = sides.get("long")
                        entry[f"{kind}_short_metrics"] = sides.get("short")
                    rrow = base.get("reversed")
                    entry["reversed_metrics"] = rrow["metrics"] if rrow else None
                    # Excess vs the null reference: the engine's legs are
                    # independent buckets, so the per-side null returns SUM to
                    # exactly what the old combined (hedged) null run reported —
                    # the metric's value and meaning are unchanged.
                    null_rets = [m["return_pct"]
                                 for m in (entry["null_long_metrics"],
                                           entry["null_short_metrics"])
                                 if m and m.get("return_pct") is not None]
                    entry["excess_return_pct"] = fold_excess(
                        entry["oos_metrics"],
                        {"return_pct": sum(null_rets)} if null_rets else None)
                    tr_s = f["train_to"] - f["train_from"]
                    te_s = f["test_to"] - f["test_from"]
                    entry["wfe"] = fold_wfe(entry["is_metrics"], test["metrics"],
                                            tr_s, te_s)
                    entry["low_sample"] = (
                        (test["metrics"].get("n_trades") or 0) < sc["min_test_trades"])
                    if entry["is_metrics"].get("return_pct") is not None:
                        is_ret_total += entry["is_metrics"]["return_pct"]
                        is_secs += tr_s
                    if test["metrics"].get("return_pct") is not None:
                        oos_ret_total += test["metrics"]["return_pct"]
                        oos_secs += te_s
                    chosen.append(entry["combo"])
                    fold_tests.append({"fold": f, "trades": test["trades"],
                                       "equity": test["equity"]})
                folds_out.append(entry)
            stitched = stitch(fold_tests, cash, res_s) if fold_tests else {
                "equity": [], "equity_scaled": [], "trades": [], "metrics": {}}
            stab = parameter_stability(chosen, kw["axes"],
                                       [(c, v) for c, v in tables])
            # Median plateau breadth across fold tables.
            breadths = [plateau_breadth(v) for _, v in tables]
            breadths = [b for b in breadths if b is not None]
            breadth = sorted(breadths)[len(breadths) // 2] if breadths else None
            block = aggregate(folds_out, stitched["metrics"], stab, breadth,
                              oos_trades_total=len(stitched["trades"]))
            is_rate = annualized_rate(is_ret_total, is_secs) if is_secs else None
            oos_rate = annualized_rate(oos_ret_total, oos_secs) if oos_secs else None
            if is_rate and is_rate > 0 and oos_rate is not None:
                block["wfe_aggregate"] = round(oos_rate / is_rate, 4)
            out_schemes.append({
                "train_span": sc["train_span"], "folds": folds_out,
                "stitched": stitched, "stability": stab, "robustness": block,
            })
        # Grid diagnostic: a combo that errored in phase 1 contributes no metrics
        # to any fold, so a run where every combo failed still "completes" with
        # empty tables. Surface the failure count (job.error stays None) so the
        # caller can tell an empty result from a broken one.
        grid_failed = sum(1 for r in grid_rows if r["error"])
        grid_sample = next((r["error"] for r in grid_rows if r["error"]), None)
        return {"eval_mode": kw.get("eval_mode", "exact"), "objective": kw["objective"],
                "schedule": kw["schedule_meta"], "axes": kw["axes"],
                "schemes": out_schemes,
                "grid_errors": {"failed": grid_failed, "total": len(grid_rows),
                                "sample": grid_sample}}


WFO_JOBS = WfoJobManager()  # module singleton

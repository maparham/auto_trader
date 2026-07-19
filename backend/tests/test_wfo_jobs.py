"""WfoJobManager: end-to-end orchestration with an in-process fake pool."""
import time
from concurrent.futures import Future

from auto_trader.api import wfo_jobs, wfo_worker

from tests.wfo_fixtures import _SyncPool


def _wait(job, timeout=30.0):
    t0 = time.time()
    while job.running and time.time() - t0 < timeout:
        time.sleep(0.02)
    assert not job.running, "job did not finish"


def test_wfo_job_end_to_end(tmp_path):
    # Reuse the request/strategy fixtures from tests/test_wfo_worker.py by
    # importing its helpers (move _req_dict/_candles_dto/STRAT into
    # tests/wfo_fixtures.py in this task and import from both test files).
    from tests.wfo_fixtures import make_req_dict, write_strategy, T0, H
    write_strategy(tmp_path)
    day = 24 * H
    folds = [
        {"train_from": T0, "train_to": T0 + 10 * day,
         "test_from": T0 + 10 * day, "test_to": T0 + 13 * day},
        {"train_from": T0 + 3 * day, "train_to": T0 + 13 * day,
         "test_from": T0 + 13 * day, "test_to": T0 + 16 * day},
        {"train_from": T0 + 6 * day, "train_to": T0 + 16 * day,
         "test_from": T0 + 16 * day, "test_to": T0 + 19 * day},
    ]
    mgr = wfo_jobs.WfoJobManager(pool_factory=_SyncPool)
    done_jobs = []
    job = mgr.submit(
        req_dict=make_req_dict(19 * 24),  # 19 days of hourly candles
        htf_candles={}, strategies_dir=str(tmp_path),
        schemes=[{"train_span": "10d", "folds": folds,
                  "min_train_trades": 0, "min_test_trades": 0}],
        axes=[{"kind": "range", "targets": ["param:fast"], "values": [3, 5, 8]}],
        objective={"metric": "net_pnl", "composite": None, "min_trades": 0,
                   "selection": "best"},
        schedule_meta={"mode": "rolling", "trainSpan": "10d", "testSpan": "3d"},
        epic="TEST", timeframe="HOUR",
        combos=[{"param:fast": 3}, {"param:fast": 5}, {"param:fast": 8}],
        on_complete=done_jobs.append,
    )
    _wait(job)
    assert job.error is None
    assert job.phase == "done"
    assert job.done == job.total == 3 + 3        # combos + winner tests
    res = job.result
    scheme = res["schemes"][0]
    assert len(scheme["folds"]) == 3
    for f in scheme["folds"]:
        assert f["combo"] is not None
        assert f["is_metrics"] is not None
    assert "robustness_score" in scheme["robustness"]
    assert scheme["stitched"]["equity"]
    # Streamed winner rows arrived (one per fold).
    assert len(job.fold_rows) == 3
    # Lazy fold tables retained.
    assert "s0/f0" in job.fold_tables
    assert done_jobs == [job]


class _BlockingPool(_SyncPool):
    """Futures resolve only when the test releases the gate, so a cancel can
    land while the grid phase is in flight."""
    gate = None  # threading.Event, set per test

    def submit(self, fn, *args):
        f = Future()

        def _later():
            _BlockingPool.gate.wait(10.0)
            try:
                f.set_result(fn(*args))
            except Exception as e:  # pragma: no cover
                f.set_exception(e)

        import threading
        threading.Thread(target=_later, daemon=True).start()
        return f


def test_cancel_mid_grid(tmp_path):
    import threading
    from tests.wfo_fixtures import make_req_dict, write_strategy, T0, H
    write_strategy(tmp_path)
    _BlockingPool.gate = threading.Event()
    day = 24 * H
    folds = [{"train_from": T0 + i * day, "train_to": T0 + (i + 10) * day,
              "test_from": T0 + (i + 10) * day, "test_to": T0 + (i + 13) * day}
             for i in (0, 3, 6)]
    mgr = wfo_jobs.WfoJobManager(pool_factory=_BlockingPool, grace_seconds=0.2)
    job = mgr.submit(
        req_dict=make_req_dict(19 * 24), htf_candles={},
        strategies_dir=str(tmp_path),
        schemes=[{"train_span": "10d", "folds": folds,
                  "min_train_trades": 0, "min_test_trades": 0}],
        axes=[{"kind": "range", "targets": ["param:fast"], "values": [3, 5, 8]}],
        objective={"metric": "net_pnl", "composite": None, "min_trades": 0,
                   "selection": "best"},
        schedule_meta={}, epic="TEST", timeframe="HOUR",
        combos=[{"param:fast": 3}, {"param:fast": 5}, {"param:fast": 8}],
    )
    time.sleep(0.1)                 # let the grid phase start
    assert mgr.cancel(job.job_id)
    _BlockingPool.gate.set()        # release in-flight combos
    _wait(job)
    assert job.cancelled and job.phase != "done" and job.result is None

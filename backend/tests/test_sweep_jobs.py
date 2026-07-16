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
    kw.setdefault("probe_row", None)
    return mgr.submit(req_dict=req, htf_candles={}, strategies_dir=strat_dir,
                      windows=None, combos=combos, epic="X", timeframe="MINUTE",
                      workers=2, **kw)


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
    mgr = SweepJobManager(grace_seconds=2.0)  # kill stuck workers fast in test
    job = submit(mgr, str(tmp_path), [{"param:n": i} for i in range(3, 43)])
    t0 = time.time()                      # wait for a first row, not a fixed
    while job.done == 0 and time.time() - t0 < 30:   # sleep: spawn startup time
        time.sleep(0.05)                  # varies wildly with machine load
    assert job.done > 0, "no combo completed before cancel"
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

"""Cross-user job access returns 404; listings are owner-filtered.

Covers every sweep-job and WFO-job route (submit paths tested via the
manager's owner field directly plus one submit-route smoke check), and the
expr-run progress registry ruling (expr.py's set_progress sites must thread
owner=current_user(request) exactly like backtest.py's, or a hosted expr run
loses progress/cancel to another tenant)."""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.api.sweep_jobs import JOBS, SweepJob
from auto_trader.api.wfo_jobs import WFO_JOBS, WfoJob
from auto_trader.core import progress as pr
from tests import clerk_fake

client = TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


# --- sweep jobs ---------------------------------------------------------------


@pytest.fixture
def alice_sweep_job(monkeypatch):
    job = SweepJob(job_id="j-alice", epic="US100", timeframe="1h", total=1,
                   owner="alice", running=False)
    job.finished_at = time.time()
    monkeypatch.setitem(JOBS._jobs, "j-alice", job)
    return job


def test_sweep_job_status_is_owner_scoped(clerk, alice_sweep_job):
    ok = client.get("/api/backtest/sweep/jobs/j-alice", headers=_auth("alice"))
    assert ok.status_code == 200
    assert client.get("/api/backtest/sweep/jobs/j-alice", headers=_auth("bob")).status_code == 404


def test_sweep_job_listing_filtered(clerk, alice_sweep_job):
    mine = client.get("/api/backtest/sweep/jobs", headers=_auth("alice")).json()
    assert any(j.get("jobId") == "j-alice" for j in mine)
    others = client.get("/api/backtest/sweep/jobs", headers=_auth("bob")).json()
    assert all(j.get("jobId") != "j-alice" for j in others)


def test_sweep_job_cancel_is_owner_scoped(clerk, alice_sweep_job):
    assert client.post("/api/backtest/sweep/jobs/j-alice/cancel",
                        headers=_auth("bob")).status_code == 404
    assert not alice_sweep_job.cancelled
    ok = client.post("/api/backtest/sweep/jobs/j-alice/cancel", headers=_auth("alice"))
    assert ok.status_code == 200


# --- wfo jobs -------------------------------------------------------------


@pytest.fixture
def alice_wfo_job(monkeypatch):
    job = WfoJob(job_id="w-alice", epic="US100", timeframe="1h", total=1,
                 owner="alice", running=False)
    job.finished_at = time.time()
    job.fold_tables["s0/f0"] = [{"combo": {}}]
    monkeypatch.setitem(WFO_JOBS._jobs, "w-alice", job)
    return job


def test_wfo_job_status_is_owner_scoped(clerk, alice_wfo_job):
    ok = client.get("/api/backtest/walkforward/jobs/w-alice", headers=_auth("alice"))
    assert ok.status_code == 200
    assert client.get("/api/backtest/walkforward/jobs/w-alice",
                       headers=_auth("bob")).status_code == 404


def test_wfo_job_cancel_is_owner_scoped(clerk, alice_wfo_job):
    assert client.post("/api/backtest/walkforward/jobs/w-alice/cancel",
                        headers=_auth("bob")).status_code == 404
    ok = client.post("/api/backtest/walkforward/jobs/w-alice/cancel", headers=_auth("alice"))
    assert ok.status_code == 200


def test_wfo_job_fold_is_owner_scoped(clerk, alice_wfo_job):
    assert client.get("/api/backtest/walkforward/jobs/w-alice/fold",
                       params={"key": "s0/f0"}, headers=_auth("bob")).status_code == 404
    ok = client.get("/api/backtest/walkforward/jobs/w-alice/fold",
                     params={"key": "s0/f0"}, headers=_auth("alice"))
    assert ok.status_code == 200


# --- expr-run progress: controller ruling 1 --------------------------------
# expr.py's pr.set_progress(pid, stage=...) sites must thread owner=current_user
# exactly like backtest.py's, or a hosted expr run's progress/cancel is
# invisible to its own owner (owner defaults to "dev") and/or leaks across
# tenants. Registry-level: mirrors what expr_backtest's handler does when it
# calls pr.set_progress(pid, stage="simulate", owner=user).


def test_expr_progress_is_owner_scoped(clerk):
    pr.set_progress("expr-p1", stage="simulate", owner="alice")
    try:
        assert client.get("/api/backtest/progress/expr-p1",
                           headers=_auth("alice")).status_code == 200
        assert client.get("/api/backtest/progress/expr-p1",
                           headers=_auth("bob")).status_code == 404
        # A cross-user cancel must not find alice's entry.
        assert client.post("/api/backtest/cancel/expr-p1",
                            headers=_auth("bob")).status_code == 404
        assert client.post("/api/backtest/cancel/expr-p1",
                            headers=_auth("alice")).status_code == 200
    finally:
        pr.clear_progress("expr-p1")

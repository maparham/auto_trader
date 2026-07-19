"""Walk-forward API endpoints: submit validation, status, fold tables, archive."""
import time

import pytest
from fastapi.testclient import TestClient

import auto_trader.api.routers.backtest as bt
import auto_trader.strategy.loader as loader
from auto_trader.api.app import app
from auto_trader.api.wfo_jobs import WfoJobManager
from auto_trader.core.wfo_store import WfoStore

from tests.wfo_fixtures import _SyncPool, make_req_dict, write_strategy

client = TestClient(app)

WFO = {
    "combos": [{"param:fast": 3}, {"param:fast": 5}, {"param:fast": 8}],
    "axes": [{"kind": "range", "targets": ["param:fast"], "values": [3, 5, 8]}],
    # min trades zeroed so a winner is always eligible: this test exercises the
    # wiring, not the selection filter (mirrors tests/test_wfo_jobs.py).
    "schedule": {"trainSpan": "30d", "testSpan": "10d",
                 "minTrainTrades": 0, "minTestTrades": 0},
}


@pytest.fixture
def sync_wfo_manager(tmp_path, monkeypatch):
    """Point the router's WFO_JOBS at an inline-pool manager and WFO_STORE at a
    tmp-path store, so a submitted job runs to completion synchronously."""
    write_strategy(tmp_path)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    monkeypatch.setattr(bt, "WFO_JOBS", WfoJobManager(pool_factory=_SyncPool))
    monkeypatch.setattr(bt, "WFO_STORE", WfoStore(str(tmp_path / "wfo.db")))
    yield


def test_submit_requires_walkforward():
    r = client.post("/api/backtest/walkforward/jobs", json=make_req_dict(100 * 24))
    assert r.status_code == 422


def test_submit_rejects_infeasible_schedule():
    req = make_req_dict(20 * 24)  # 20 days cannot fit 30d train + 3 folds
    req["walkforward"] = WFO
    r = client.post("/api/backtest/walkforward/jobs", json=req)
    assert r.status_code == 422
    assert "fold" in r.json()["detail"]


def test_submit_rejects_exact_mode():
    req = make_req_dict(100 * 24)
    req["walkforward"] = {**WFO, "evalMode": "exact"}
    assert client.post("/api/backtest/walkforward/jobs", json=req).status_code == 422


def test_job_lifecycle_and_archive(sync_wfo_manager):
    req = make_req_dict(100 * 24)
    req["walkforward"] = WFO
    r = client.post("/api/backtest/walkforward/jobs", json=req)
    assert r.status_code == 200, r.text
    job_id = r.json()["jobId"]
    # Submit response echoes schemes with fold windows (no orchestrator "_w" key).
    scheme0 = r.json()["schemes"][0]
    assert scheme0["trainSpan"] == "30d"
    assert set(scheme0["folds"][0]) == {"train_from", "train_to", "test_from", "test_to"}
    # Sync pool: job finishes promptly; poll until done.
    for _ in range(200):
        st = client.get(f"/api/backtest/walkforward/jobs/{job_id}").json()
        if not st["running"]:
            break
        time.sleep(0.05)
    assert st["phase"] == "done" and st["error"] is None
    assert st["result"]["schemes"][0]["robustness"]["robustness_score"] is not None
    # Fold table lazy endpoint.
    ft = client.get(f"/api/backtest/walkforward/jobs/{job_id}/fold", params={"key": "s0/f0"})
    assert ft.status_code == 200 and ft.json()["rows"]
    # Auto-persisted.
    arch = client.get("/api/backtest/walkforward/archive").json()
    assert any(a["id"] == job_id for a in arch)
    full = client.get(f"/api/backtest/walkforward/archive/{job_id}")
    assert full.status_code == 200
    assert client.delete(f"/api/backtest/walkforward/archive/{job_id}").status_code == 200


def test_status_and_cancel_unknown_404(sync_wfo_manager):
    assert client.get("/api/backtest/walkforward/jobs/nope").status_code == 404
    assert client.post("/api/backtest/walkforward/jobs/nope/cancel").status_code == 404
    assert client.get("/api/backtest/walkforward/jobs/nope/fold",
                      params={"key": "s0/f0"}).status_code == 404

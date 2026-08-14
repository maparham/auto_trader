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


def test_submit_accepts_exact_mode(sync_wfo_manager):
    req = make_req_dict(100 * 24)
    req["walkforward"] = {**WFO, "evalMode": "exact"}
    assert client.post("/api/backtest/walkforward/jobs", json=req).status_code == 200


def test_submit_rejects_range_axis_without_values(sync_wfo_manager):
    req = make_req_dict(100 * 24)
    req["walkforward"] = {
        **WFO,
        "axes": [{"kind": "range", "targets": ["param:fast"], "values": []}],
    }
    r = client.post("/api/backtest/walkforward/jobs", json=req)
    assert r.status_code == 422
    assert "ordered values" in r.json()["detail"]


def test_submit_rejects_period_combo(sync_wfo_manager):
    req = make_req_dict(100 * 24)
    req["walkforward"] = {
        **WFO,
        "combos": [{"param:fast": 3, "period:from": 123}],
    }
    r = client.post("/api/backtest/walkforward/jobs", json=req)
    assert r.status_code == 422
    assert "period" in r.json()["detail"]


def test_coded_wfo_baselines_per_fold(sync_wfo_manager):
    # Baselines were expr-only; a coded job must run them too (converted to the
    # same expr null/hold requests the coded single-run path synthesizes).
    req = make_req_dict(100 * 24)
    req["walkforward"] = {**WFO, "baselines": ["null", "hold"]}
    sub = client.post("/api/backtest/walkforward/jobs", json=req)
    assert sub.status_code == 200, sub.text
    body = sub.json()
    n_folds = len(body["schemes"][0]["folds"])
    # Progress accounting: one test run + one run per baseline kind, per fold.
    assert body["total"] == len(WFO["combos"]) + n_folds * (1 + 2)
    for _ in range(200):
        st = client.get(f"/api/backtest/walkforward/jobs/{body['jobId']}").json()
        if not st["running"]:
            break
        time.sleep(0.05)
    assert st["phase"] == "done" and st["error"] is None
    folds = st["result"]["schemes"][0]["folds"]
    # Folds whose winner actually traded get baselines; the strategy is
    # long-only, so its null baseline is long-only too (not a both-sides hedge).
    scored = [f for f in folds
              if f["oos_metrics"] is not None and f["oos_metrics"]["n_trades"] > 0]
    assert scored, "no scored folds with trades"
    for f in scored:
        # The fixture strategy is long-only: only long-side baselines run.
        assert f["null_long_metrics"] is not None
        assert f["hold_long_metrics"] is not None
        assert f["null_short_metrics"] is None and f["hold_short_metrics"] is None
        assert f["excess_return_pct"] == round(
            f["oos_metrics"]["return_pct"] - f["null_long_metrics"]["return_pct"], 4)
    rb = st["result"]["schemes"][0]["robustness"]
    assert rb["pct_folds_beating_null"] is not None
    assert rb["median_fold_excess_pct"] is not None


def test_coded_wfo_reversed_baseline_per_fold(sync_wfo_manager):
    # Reversed can't be synthesized as an expr request (the signals live in the
    # coded module): the worker re-runs the coded engine with the request's
    # internal reverse flag instead.
    req = make_req_dict(100 * 24)
    req["walkforward"] = {**WFO, "baselines": ["reversed"]}
    sub = client.post("/api/backtest/walkforward/jobs", json=req)
    assert sub.status_code == 200, sub.text
    body = sub.json()
    n_folds = len(body["schemes"][0]["folds"])
    assert body["total"] == len(WFO["combos"]) + n_folds * (1 + 1)
    for _ in range(200):
        st = client.get(f"/api/backtest/walkforward/jobs/{body['jobId']}").json()
        if not st["running"]:
            break
        time.sleep(0.05)
    assert st["phase"] == "done" and st["error"] is None
    folds = st["result"]["schemes"][0]["folds"]
    scored = [f for f in folds
              if f["oos_metrics"] is not None and f["oos_metrics"]["n_trades"] > 0]
    assert scored, "no scored folds with trades"
    for f in scored:
        assert f["reversed_metrics"] is not None
        assert f["null_long_metrics"] is None and f["hold_long_metrics"] is None
    # A reversed run that silently ran unflipped would reproduce the base
    # strategy; the mirror must actually differ somewhere.
    assert any(f["reversed_metrics"] != f["oos_metrics"] for f in scored)


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

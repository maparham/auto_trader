"""POST /api/expr/walkforward/jobs: walk-forward over expression lit: combos.

Submits an expr WFO job over the real process pool and polls the SHARED
GET /api/backtest/walkforward/jobs/{id} route (WFO_JOBS is one singleton), the
same way test_expr_sweep_run.py drives the expr sweep surface. WFO_STORE is
redirected to a tmp store so the auto-persist on completion never touches the
real archive db.
"""

import time

import pytest
from fastapi.testclient import TestClient

import auto_trader.api.routers.backtest as bt
from auto_trader.api.app import app
from auto_trader.core.wfo_store import WfoStore

client = TestClient(app)


def _candles(closes):
    return [{"time": 3600 * k, "open": c, "high": c, "low": c, "close": c, "volume": 100.0}
            for k, c in enumerate(closes)]


# A repeating rise-then-fall wave, long enough for several folds, so an EMA-based
# entry opens and closes longs across the range.
_WAVE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1] * 8  # 160 bars

# Bar-token spans keep the candle count small: 30b train + 10b test, 10b step.
_WFO = {
    "combos": [{"lit:long.entry.0.0": 5}, {"lit:long.entry.0.0": 9},
               {"lit:long.entry.0.0": 20}],
    "axes": [{"kind": "range", "targets": ["lit:long.entry.0.0"], "values": [5, 9, 20]}],
    # min trades zeroed so a winner is always eligible: this exercises the wiring,
    # not the selection filter (mirrors the structured WFO test).
    "schedule": {"trainSpan": "30b", "testSpan": "10b", "step": "10b",
                 "minTrainTrades": 0, "minTestTrades": 0},
}


def _base_req(**over):
    req = {
        "epic": "TEST", "resolution": "HOUR", "candles": _candles(_WAVE),
        "htfCandles": None,
        "longEntry": [{"expr": "EMA(9) > 0"}],
        "longExit": [{"expr": "candle.close < entry"}],
        "shortEntry": [], "shortExit": [],
        "longEnabled": True, "shortEnabled": True,
        "longRisk": None, "shortRisk": None, "longScaling": None, "shortScaling": None,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0, "mask": None, "inspect": False,
    }
    req.update(over)
    return req


@pytest.fixture
def tmp_wfo_store(tmp_path, monkeypatch):
    """Redirect the archive store so a completed job's auto-persist writes to a
    throwaway db, not the real one. _persist_wfo's closure resolves WFO_STORE in
    the backtest module namespace, so patch it there."""
    monkeypatch.setattr(bt, "WFO_STORE", WfoStore(str(tmp_path / "wfo.db")))
    yield


def _poll_to_done(job_id, timeout=60):
    st, t0 = None, time.time()
    while time.time() - t0 < timeout:
        st = client.get(f"/api/backtest/walkforward/jobs/{job_id}").json()
        if not st["running"]:
            break
        time.sleep(0.05)
    assert st is not None and not st["running"], "job did not finish in time"
    return st


def test_expr_wfo_runs_and_completes(tmp_wfo_store):
    req = _base_req(walkforward=_WFO)
    sub = client.post("/api/expr/walkforward/jobs", json=req)
    assert sub.status_code == 200, sub.text
    body = sub.json()
    # Submit response echoes schemes with fold windows (no orchestrator "_w" key).
    scheme0 = body["schemes"][0]
    assert scheme0["trainSpan"] == "30b"
    assert set(scheme0["folds"][0]) == {"train_from", "train_to", "test_from", "test_to"}
    st = _poll_to_done(body["jobId"])
    assert st["phase"] == "done" and st["error"] is None
    result = st["result"]
    assert result["grid_errors"]["failed"] == 0, result["grid_errors"]
    assert result["schemes"] and result["schemes"][0]["folds"]
    # Auto-persisted: _persist_wfo swallows store errors (job stays error=None), so
    # assert the slim ExprBacktestRequest dump actually reached the archive.
    arch = client.get("/api/backtest/walkforward/archive").json()
    assert any(a["id"] == body["jobId"] for a in arch)


def test_expr_wfo_requires_combos():
    # No walkforward block at all -> 422.
    r = client.post("/api/expr/walkforward/jobs", json=_base_req())
    assert r.status_code == 422


def test_expr_wfo_rejects_period_target_in_combo():
    wfo = {**_WFO, "combos": [{"lit:long.entry.0.0": 9, "period:from": 123}]}
    r = client.post("/api/expr/walkforward/jobs", json=_base_req(walkforward=wfo))
    assert r.status_code == 422
    assert "period" in r.json()["detail"]


def test_expr_wfo_blank_rows_do_not_break(tmp_wfo_store):
    # An empty placeholder short-entry row (what the UI ships for an unauthored
    # side) is not a rule: the job still submits and completes.
    req = _base_req(walkforward=_WFO, shortEntry=[{"expr": "", "enabled": True}])
    sub = client.post("/api/expr/walkforward/jobs", json=req)
    assert sub.status_code == 200, sub.text
    st = _poll_to_done(sub.json()["jobId"])
    assert st["phase"] == "done" and st["error"] is None

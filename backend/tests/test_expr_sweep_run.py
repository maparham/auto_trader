"""POST /api/expr/sweep/jobs: expression sweep execution over the job/pool path.

Submits a lit:/risk: sweep over expression rules and polls the SHARED
GET /api/backtest/sweep/jobs/{job_id} route (JOBS is one singleton) to
completion. Exercises the real process pool, so polls allow a few hundred ms.
"""

import time

from fastapi.testclient import TestClient

from auto_trader.api.app import app

client = TestClient(app)


def _candles(closes):
    return [{"time": 3600 * k, "open": c, "high": c, "low": c, "close": c, "volume": 100.0}
            for k, c in enumerate(closes)]


# A rise-then-fall wave so an EMA-based entry opens a long that later exits.
_WAVE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1]


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


def run_expr_sweep_via_jobs(req, timeout=60):
    """Submit an expr sweep job and poll to completion; rows in combo order."""
    sub = client.post("/api/expr/sweep/jobs", json=req)
    assert sub.status_code == 200, sub.text
    job_id, total = sub.json()["jobId"], sub.json()["total"]
    rows, t0 = [], time.time()
    while time.time() - t0 < timeout:
        st = client.get(f"/api/backtest/sweep/jobs/{job_id}", params={"cursor": len(rows)}).json()
        rows += st["rows"]
        if not st["running"]:
            assert st["error"] is None, st["error"]
            break
        time.sleep(0.05)
    assert len(rows) == total
    order = {str(c): i for i, c in enumerate(req["sweep"]["combos"])}
    return sorted(rows, key=lambda r: order[str(r["combo"])])


def test_expr_sweep_job_runs_and_returns_rows():
    # Sweep the EMA length literal (ordinal 0) of "EMA(9) > 0" to 5 and 20.
    combos = [{"lit:long.entry.0.0": 5}, {"lit:long.entry.0.0": 20}]
    rows = run_expr_sweep_via_jobs(_base_req(sweep={"combos": combos}))
    assert len(rows) == 2
    for row in rows:
        assert row["error"] is None, row["error"]
        assert row["metrics"] is not None
        assert "net_pnl" in row["metrics"]
        assert "n_trades" in row["metrics"]


def test_expr_sweep_lit_reaches_worker():
    # The substituted literal must reach the worker: assert the two rows carry the
    # two distinct combo dicts (metrics may be identical on synthetic candles).
    combos = [{"lit:long.entry.0.0": 5}, {"lit:long.entry.0.0": 20}]
    rows = run_expr_sweep_via_jobs(_base_req(sweep={"combos": combos}))
    seen = {str(r["combo"]) for r in rows}
    assert seen == {str(c) for c in combos}


def test_expr_sweep_bad_lit_target_422():
    # Row index 9 is out of range (only one long-entry row), so submit 422s.
    combos = [{"lit:long.entry.9.0": 5}]
    sub = client.post("/api/expr/sweep/jobs", json=_base_req(sweep={"combos": combos}))
    assert sub.status_code == 422


def test_expr_sweep_risk_target():
    # A risk: target patches the configured longRisk stop; the combo runs cleanly.
    pct_risk = {"stop": {"kind": "pct", "value": 5.0}, "target": {"kind": "none"}}
    combos = [{"risk:long.stop.value": 3.0}, {"risk:long.stop.value": 8.0}]
    rows = run_expr_sweep_via_jobs(_base_req(longRisk=pct_risk, sweep={"combos": combos}))
    assert len(rows) == 2
    for row in rows:
        assert row["error"] is None, row["error"]
        assert row["metrics"] is not None

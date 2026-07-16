"""POST /api/backtest/sweep/jobs: sweep job API. One engine run per combo,
row-isolated errors, shared HTF fetch cache across a job's combos."""

import logging
import time

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

from test_api_backtest_coded import base_request, make_candles

client = TestClient(app)


def run_sweep_via_jobs(client, req, timeout=60):
    """Submit a sweep job and poll it to completion; returns rows in combo order."""
    sub = client.post("/api/backtest/sweep/jobs", json=req)
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


SWEEP_STRAT = '''
meta = {"params": [{"name": "n", "type": "int", "default": 3, "min": 1, "max": 50}]}
def on_bar(ctx):
    if ctx.param("n") == 13:
        raise RuntimeError("unlucky combo")
    if ctx.position.is_flat and len(ctx.closes) >= ctx.param("n"):
        return [ctx.buy(sl=ctx.close * 0.99, reason="go")]
    return []
'''


@pytest.fixture
def strategies(tmp_path, monkeypatch):
    (tmp_path / "sweep.py").write_text(SWEEP_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


def sweep_request(candles, combos):
    req = base_request("sweep.py", candles)
    req["sweep"] = {"combos": combos}
    return req


def test_sweep_rows_one_per_combo_with_metrics(strategies):
    candles = make_candles(20)
    rows = run_sweep_via_jobs(client, sweep_request(
        candles, [{"param:n": 3}, {"param:n": 20}],
    ))
    assert len(rows) == 2
    assert rows[0]["combo"] == {"param:n": 3}
    assert rows[0]["error"] is None
    m = rows[0]["metrics"]
    assert set(m) == {"net_pnl", "n_trades", "win_rate", "max_drawdown",
                      "profit_factor", "avg_win_loss_ratio", "return_pct",
                      "sharpe", "sqn"}
    assert "sharpe" in rows[0]["metrics"] and "sqn" in rows[0]["metrics"]
    # Different n => different trade counts.
    assert rows[0]["metrics"]["n_trades"] != rows[1]["metrics"]["n_trades"]


def test_sweep_risk_target_patches_risk(strategies):
    candles = make_candles(40)
    req = sweep_request(candles, [{"risk:long.stop.value": 0.1},
                                  {"risk:long.stop.value": 10.0}])
    req["longRisk"] = {"stop": {"kind": "pct", "value": 2}, "target": {"kind": "none"}}
    rows = run_sweep_via_jobs(client, req)
    # A 0.1% stop churns out more (stopped) trades than a 10% stop.
    assert rows[0]["metrics"]["n_trades"] > rows[1]["metrics"]["n_trades"]


def test_sweep_job_logs_submit_and_done(strategies, caplog):
    """One submit line (router logger) and one completion line (sweep_jobs
    logger, emitted by the job thread) per job."""
    candles = make_candles(20)
    req = sweep_request(candles, [{"param:n": 3}, {"param:n": 5}])
    with caplog.at_level(logging.INFO):
        run_sweep_via_jobs(client, req)
    msgs = [r.getMessage() for r in caplog.records]
    assert any("sweep TEST HOUR: 2 combos (coded mode)" in m for m in msgs)
    assert any("sweep job done in" in m and "2 ok, 0 failed" in m for m in msgs)


def test_sweep_log_counts_failed_rows(strategies, caplog):
    candles = make_candles(20)
    with caplog.at_level(logging.INFO):
        run_sweep_via_jobs(client, sweep_request(
            candles, [{"param:n": 13}, {"param:n": 3}]))
    msgs = [r.getMessage() for r in caplog.records]
    assert any("1 ok, 1 failed" in m for m in msgs)


def test_sweep_error_isolated_per_combo(strategies):
    rows = run_sweep_via_jobs(client, sweep_request(
        make_candles(40), [{"param:n": 13}, {"param:n": 3}],
    ))
    assert rows[0]["metrics"] is None and "unlucky" in rows[0]["error"]
    assert rows[1]["error"] is None and rows[1]["metrics"]["n_trades"] > 0


def test_sweep_bad_combo_value_isolated_per_combo(strategies):
    """A combo value that resolve_params rejects (out of [min, max]) isolates
    to that row's error, unlike a malformed target KEY which 422s the submit."""
    rows = run_sweep_via_jobs(client, sweep_request(
        make_candles(40), [{"param:n": 999}, {"param:n": 3}],
    ))
    assert rows[0]["metrics"] is None and rows[0]["error"]
    assert rows[1]["error"] is None and rows[1]["metrics"]["n_trades"] > 0


def test_sweep_bad_target_422(strategies):
    resp = client.post("/api/backtest/sweep/jobs", json=sweep_request(
        make_candles(10), [{"bogus:thing": 1}],
    ))
    assert resp.status_code == 422


def test_sweep_bad_target_anywhere_422s_submit(strategies):
    """A malformed target on ANY combo (not just the probe) fails the submit
    synchronously, matching the old whole-chunk 422 behavior."""
    resp = client.post("/api/backtest/sweep/jobs", json=sweep_request(
        make_candles(10), [{"param:n": 3}, {"bogus:thing": 1}],
    ))
    assert resp.status_code == 422


def test_sweep_undeclared_param_target_422(strategies):
    """resolve_params drops unknown keys by design (stale baseline params are
    tolerated), but a sweep TARGET over an undeclared param would silently
    return N identical default-valued rows: it must 422 instead."""
    resp = client.post("/api/backtest/sweep/jobs", json=sweep_request(
        make_candles(10), [{"param:renamed_away": 3}],
    ))
    assert resp.status_code == 422
    assert "does not declare" in resp.json()["detail"]


def test_sweep_with_exit_rules_missing_series_422(strategies):
    """The missing-series 422 guard from the single-run endpoint must also
    cover a sweep request whose exit rule groups reference a series that
    wasn't posted: otherwise RuleStrategy silently reads None past the
    array end for every combo instead of 422ing the submit."""
    candles = make_candles(20)
    req = sweep_request(candles, [{"param:n": 3}])
    req["longExit"] = {"combine": "AND", "rules": [{
        "left": {"kind": "series", "seriesKey": "SIG"},
        "op": "gt",
        "right": {"kind": "const", "value": 0.0},
    }]}
    resp = client.post("/api/backtest/sweep/jobs", json=req)
    assert resp.status_code == 422
    assert "missing series 'SIG'" in resp.json()["detail"]


def test_sweep_with_exit_rules_wrong_length_series_422(strategies):
    """Same as above but for a posted series shorter than the candles."""
    candles = make_candles(20)
    req = sweep_request(candles, [{"param:n": 3}])
    req["series"] = {"SIG": [1.0] * (len(candles) - 1)}
    req["longExit"] = {"combine": "AND", "rules": [{
        "left": {"kind": "series", "seriesKey": "SIG"},
        "op": "gt",
        "right": {"kind": "const", "value": 0.0},
    }]}
    resp = client.post("/api/backtest/sweep/jobs", json=req)
    assert resp.status_code == 422
    assert "series 'SIG' length" in resp.json()["detail"]


def test_sweep_atr_risk_missing_series_422(strategies):
    """I4: an ATR-kind panel risk with no exit rules at all must still 422 a
    sweep request missing the referenced ATR series (previously this guard
    only ran when exit rules were present)."""
    candles = make_candles(20)
    req = sweep_request(candles, [{"param:n": 3}])
    req["longRisk"] = {
        "stop": {"kind": "atr", "mult": 2.0, "length": 14},
        "target": {"kind": "none"},
    }
    resp = client.post("/api/backtest/sweep/jobs", json=req)
    assert resp.status_code == 422
    assert "ATR_14" in resp.json()["detail"]


# --- sub-window robustness metrics -------------------------------------------

_AGG_KEYS = {"worst_window_pnl", "median_window_pnl",
             "pct_windows_profitable", "mean_window_pnl_minus_std"}


def test_sweep_windows_attach_per_window_rows_and_aggregates(strategies):
    candles = make_candles(20)
    req = sweep_request(candles, [{"param:n": 3}])
    t0 = candles[0]["time"]
    t_end = candles[-1]["time"]
    mid = (t0 + t_end) // 2
    req["sweep"]["windows"] = [t0, mid, t_end + 1]
    rows = run_sweep_via_jobs(client, req)
    row = rows[0]
    assert row["error"] is None
    assert len(row["windows"]) == 2
    assert {"from", "to", "pnl", "trades"} <= set(row["windows"][0])
    assert _AGG_KEYS <= set(row["metrics"])
    # Window trade counts sum to the run's total.
    assert sum(w["trades"] for w in row["windows"]) == row["metrics"]["n_trades"]


def test_sweep_without_windows_unchanged(strategies):
    candles = make_candles(20)
    rows = run_sweep_via_jobs(client, sweep_request(
        candles, [{"param:n": 3}],
    ))
    assert rows[0]["windows"] is None
    assert _AGG_KEYS.isdisjoint(rows[0]["metrics"])


def test_sweep_period_combo_skips_window_metrics(strategies):
    candles = make_candles(20)
    t0, t_end = candles[0]["time"], candles[-1]["time"]
    combo = {"param:n": 3, "period:from": t0, "period:to": t_end}
    req = sweep_request(candles, [combo])
    req["sweep"]["windows"] = [t0, (t0 + t_end) // 2, t_end + 1]
    rows = run_sweep_via_jobs(client, req)
    assert rows[0]["error"] is None
    assert rows[0]["windows"] is None
    assert _AGG_KEYS.isdisjoint(rows[0]["metrics"])


def test_sweep_bad_windows_422(strategies):
    candles = make_candles(20)
    for bad in ([123], [200, 100]):
        req = sweep_request(candles, [{"param:n": 3}])
        req["sweep"]["windows"] = bad
        assert client.post("/api/backtest/sweep/jobs", json=req).status_code == 422


# --- job API surface: poll cursor, cancel, list, unknown job ------------------


def test_sweep_job_status_cursor_and_list(strategies):
    candles = make_candles(20)
    req = sweep_request(candles, [{"param:n": 3}, {"param:n": 5}])
    sub = client.post("/api/backtest/sweep/jobs", json=req)
    assert sub.status_code == 200, sub.text
    job_id, total = sub.json()["jobId"], sub.json()["total"]
    assert total == 2
    deadline = time.time() + 60
    while time.time() < deadline:
        st = client.get(f"/api/backtest/sweep/jobs/{job_id}").json()
        if not st["running"]:
            break
        time.sleep(0.05)
    assert st["done"] == 2 and st["total"] == 2
    assert st["cancelled"] is False and st["error"] is None
    assert "etaSeconds" in st
    assert len(st["rows"]) == 2
    # Cursor slices already-seen rows; past-the-end and negative clamp sanely.
    assert len(client.get(f"/api/backtest/sweep/jobs/{job_id}",
                          params={"cursor": 1}).json()["rows"]) == 1
    assert client.get(f"/api/backtest/sweep/jobs/{job_id}",
                      params={"cursor": 5}).json()["rows"] == []
    assert len(client.get(f"/api/backtest/sweep/jobs/{job_id}",
                          params={"cursor": -3}).json()["rows"]) == 2
    # The job shows up in the list with camelCase fields.
    jobs = client.get("/api/backtest/sweep/jobs").json()
    mine = [j for j in jobs if j["jobId"] == job_id]
    assert len(mine) == 1
    assert mine[0]["epic"] == "TEST" and mine[0]["timeframe"] == "HOUR"
    assert mine[0]["done"] == 2 and mine[0]["total"] == 2
    assert mine[0]["running"] is False and "createdAt" in mine[0]


def test_sweep_job_cancel_and_unknown_404(strategies):
    candles = make_candles(20)
    req = sweep_request(candles, [{"param:n": n} for n in range(3, 9)])
    sub = client.post("/api/backtest/sweep/jobs", json=req)
    assert sub.status_code == 200, sub.text
    job_id = sub.json()["jobId"]
    r = client.post(f"/api/backtest/sweep/jobs/{job_id}/cancel")
    assert r.status_code == 200 and r.json() == {"ok": True}
    deadline = time.time() + 60
    while time.time() < deadline:
        st = client.get(f"/api/backtest/sweep/jobs/{job_id}").json()
        if not st["running"]:
            break
        time.sleep(0.05)
    assert st["cancelled"] is True
    # Unknown job ids 404 on every job route.
    assert client.get("/api/backtest/sweep/jobs/nope").status_code == 404
    assert client.post("/api/backtest/sweep/jobs/nope/cancel").status_code == 404

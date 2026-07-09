"""POST /api/backtest/sweep: one coded-engine run per combo, chunk-isolated
errors, shared HTF fetch cache across combos in a chunk."""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

from test_api_backtest_coded import base_request, make_candles

client = TestClient(app)

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
    rows = client.post("/api/backtest/sweep", json=sweep_request(
        candles, [{"param:n": 3}, {"param:n": 20}],
    )).json()["rows"]
    assert len(rows) == 2
    assert rows[0]["combo"] == {"param:n": 3}
    assert rows[0]["error"] is None
    m = rows[0]["metrics"]
    assert set(m) == {"net_pnl", "n_trades", "win_rate", "max_drawdown",
                      "profit_factor", "return_pct"}
    # Different n => different trade counts.
    assert rows[0]["metrics"]["n_trades"] != rows[1]["metrics"]["n_trades"]


def test_sweep_risk_target_patches_risk(strategies):
    candles = make_candles(40)
    req = sweep_request(candles, [{"risk:long.stop.value": 0.1},
                                  {"risk:long.stop.value": 10.0}])
    req["longRisk"] = {"stop": {"kind": "pct", "value": 2}, "target": {"kind": "none"}}
    rows = client.post("/api/backtest/sweep", json=req).json()["rows"]
    # A 0.1% stop churns out more (stopped) trades than a 10% stop.
    assert rows[0]["metrics"]["n_trades"] > rows[1]["metrics"]["n_trades"]


def test_sweep_error_isolated_per_combo(strategies):
    rows = client.post("/api/backtest/sweep", json=sweep_request(
        make_candles(40), [{"param:n": 13}, {"param:n": 3}],
    )).json()["rows"]
    assert rows[0]["metrics"] is None and "unlucky" in rows[0]["error"]
    assert rows[1]["error"] is None and rows[1]["metrics"]["n_trades"] > 0


def test_sweep_bad_combo_value_isolated_per_combo(strategies):
    """A combo value that resolve_params rejects (out of [min, max]) isolates
    to that row's error, unlike a malformed target KEY which 422s the chunk."""
    rows = client.post("/api/backtest/sweep", json=sweep_request(
        make_candles(40), [{"param:n": 999}, {"param:n": 3}],
    )).json()["rows"]
    assert rows[0]["metrics"] is None and rows[0]["error"]
    assert rows[1]["error"] is None and rows[1]["metrics"]["n_trades"] > 0


def test_sweep_caps_combos(strategies):
    resp = client.post("/api/backtest/sweep", json=sweep_request(
        make_candles(10), [{"param:n": i} for i in range(1, 52)],
    ))
    assert resp.status_code == 422


def test_sweep_bad_target_422(strategies):
    resp = client.post("/api/backtest/sweep", json=sweep_request(
        make_candles(10), [{"bogus:thing": 1}],
    ))
    assert resp.status_code == 422


def test_sweep_undeclared_param_target_422(strategies):
    """resolve_params drops unknown keys by design (stale baseline params are
    tolerated), but a sweep TARGET over an undeclared param would silently
    return N identical default-valued rows — it must 422 instead."""
    resp = client.post("/api/backtest/sweep", json=sweep_request(
        make_candles(10), [{"param:renamed_away": 3}],
    ))
    assert resp.status_code == 422
    assert "does not declare" in resp.json()["detail"]


def test_sweep_with_exit_rules_missing_series_422(strategies):
    """The missing-series 422 guard from the single-run endpoint must also
    cover a sweep request whose exit rule groups reference a series that
    wasn't posted — otherwise RuleStrategy silently reads None past the
    array end for every combo instead of 422ing the whole chunk."""
    candles = make_candles(20)
    req = sweep_request(candles, [{"param:n": 3}])
    req["longExit"] = {"combine": "AND", "rules": [{
        "left": {"kind": "series", "seriesKey": "SIG"},
        "op": "gt",
        "right": {"kind": "const", "value": 0.0},
    }]}
    resp = client.post("/api/backtest/sweep", json=req)
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
    resp = client.post("/api/backtest/sweep", json=req)
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
    resp = client.post("/api/backtest/sweep", json=req)
    assert resp.status_code == 422
    assert "ATR_14" in resp.json()["detail"]

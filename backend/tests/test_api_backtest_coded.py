"""POST /api/backtest with codedStrategy: runs the .py file through the engine,
skips rule/series validation, surfaces load/runtime errors as structured 422s."""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

client = TestClient(app)

STRAT = '''"""Test strat."""
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) % 10 == 0:
        return [ctx.buy(sl=ctx.close * 0.9, tp=ctx.close * 1.2, reason="in", note={"c": ctx.close})]
    if ctx.position.is_long and ctx.bars_since_entry >= 3:
        return [ctx.close_long(reason="out")]
    return []
'''

RAISING = 'def on_bar(ctx):\n    raise RuntimeError("kaboom")\n'

PARAMS_API_STRAT = '''
meta = {"params": [{"name": "n", "type": "int", "default": 3, "min": 1, "max": 50}]}
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) >= ctx.param("n"):
        return [ctx.buy(reason="go")]
    return []
'''

BRACKET_STRAT = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(sl=ctx.close * 0.99, tp=ctx.close * 1.01, reason="in")]
    return []
'''


def make_candles(n=60):
    t0 = 1_700_000_000
    out = []
    px = 100.0
    for i in range(n):
        px += 0.5 if i % 3 else -0.5
        out.append({
            "time": t0 + i * 3600, "open": px, "high": px + 1,
            "low": px - 1, "close": px + 0.3, "volume": 10,
        })
    return out


def base_request(strategy: str, candles):
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "TEST", "resolution": "HOUR", "candles": candles, "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": 0, "startingCash": 10000},
        "tradeFromTime": candles[0]["time"],
        "codedStrategy": strategy,
    }


@pytest.fixture
def strategies(tmp_path, monkeypatch):
    (tmp_path / "test.py").write_text(STRAT)
    (tmp_path / "raising.py").write_text(RAISING)
    (tmp_path / "params_api.py").write_text(PARAMS_API_STRAT)
    (tmp_path / "bracket.py").write_text(BRACKET_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


def test_coded_backtest_produces_trades(strategies):
    res = client.post("/api/backtest", json=base_request("test.py", make_candles()))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["summary"]["n_trades"] >= 1
    entries = [m for m in body["markers"] if m["reason"] == "in"]
    assert entries, "entry markers present"
    # The note dict rides the terms channel for the signal popover.
    assert entries[0]["terms"] and entries[0]["terms"][0]["left"] == "c"
    # Brackets landed: some exit must be a stop or target OR the rule exit fired.
    assert all(t["reason"] in ("out", "stop", "target", "range end") for t in body["trades"])


def test_unknown_strategy_422(strategies):
    res = client.post("/api/backtest", json=base_request("missing.py", make_candles()))
    assert res.status_code == 422
    assert "missing.py" in res.json()["detail"]


def test_runtime_error_422_with_bar_info(strategies):
    res = client.post("/api/backtest", json=base_request("raising.py", make_candles()))
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "kaboom" in detail and "bar" in detail


def test_rule_path_unaffected(strategies):
    """Without codedStrategy the request behaves exactly as before (series/rule
    validation still runs)."""
    req = base_request(None, make_candles())
    del req["codedStrategy"]
    req["longEntry"] = {"combine": "AND", "rules": [{
        "left": {"kind": "indicator", "indicator": "EMA", "length": 9},
        "op": "gt",
        "right": {"kind": "price", "field": "close"},
    }]}
    res = client.post("/api/backtest", json=req)
    assert res.status_code == 422
    assert "missing series 'EMA_9'" in res.json()["detail"]


def test_backtest_coded_params_change_behavior(strategies):
    candles = make_candles(30)
    req = base_request("params_api.py", candles)
    r1 = client.post("/api/backtest", json=req).json()
    req["codedParams"] = {"n": 20}
    r2 = client.post("/api/backtest", json=req).json()
    assert r2["markers"][0]["time"] > r1["markers"][0]["time"]


def test_backtest_coded_params_bad_value_422(strategies):
    req = base_request("params_api.py", make_candles(10))
    req["codedParams"] = {"n": "lots"}
    resp = client.post("/api/backtest", json=req)
    assert resp.status_code == 422
    assert "n" in resp.json()["detail"]


def test_backtest_response_flags_bracket_override(strategies):
    req = base_request("bracket.py", make_candles(40))
    assert client.post("/api/backtest", json=req).json()["fileBracketsOverridden"] is False
    req["longRisk"] = {"stop": {"kind": "pct", "value": 5}, "target": {"kind": "none"}}
    assert client.post("/api/backtest", json=req).json()["fileBracketsOverridden"] is True


def test_backtest_none_none_risk_keeps_file_brackets(strategies):
    """C1 (critical): a panel risk config that is none/none (RiskSection touched
    then reset) must NOT strip the file's own sl=/tp= brackets — it's
    indistinguishable in intent from no panel risk at all. Posting longRisk
    with both legs "none" must behave exactly like omitting longRisk."""
    req = base_request("bracket.py", make_candles(40))
    req["longRisk"] = {"stop": {"kind": "none"}, "target": {"kind": "none"}}
    body = client.post("/api/backtest", json=req).json()
    assert body["fileBracketsOverridden"] is False
    t = body["trades"][0]
    assert abs(t["stop_initial"] / t["entry_price"] - 0.99) < 0.005


ATR_RISK_STRAT = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="in")]
    return []
'''


def test_coded_atr_risk_missing_series_422(strategies, tmp_path, monkeypatch):
    """I4: ATR-kind panel risk on a coded run needs the same missing-series 422
    guard rule mode gets — otherwise a missing ATR series silently yields a
    stop-less trade instead of a 422."""
    (tmp_path / "atr_risk.py").write_text(ATR_RISK_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    req = base_request("atr_risk.py", make_candles(40))
    req["longRisk"] = {
        "stop": {"kind": "atr", "mult": 2.0, "length": 14},
        "target": {"kind": "none"},
    }
    res = client.post("/api/backtest", json=req)
    assert res.status_code == 422
    assert "ATR_14" in res.json()["detail"]


def test_coded_atr_risk_with_series_200(strategies, tmp_path, monkeypatch):
    (tmp_path / "atr_risk.py").write_text(ATR_RISK_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    candles = make_candles(40)
    req = base_request("atr_risk.py", candles)
    req["series"] = {"ATR_14": [1.0] * len(candles)}
    req["longRisk"] = {
        "stop": {"kind": "atr", "mult": 2.0, "length": 14},
        "target": {"kind": "none"},
    }
    res = client.post("/api/backtest", json=req)
    assert res.status_code == 200, res.text


HOLD_FOREVER_STRAT = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="in")]
    return []
'''


def test_coded_run_with_panel_exit_rule_closes_via_rule(strategies, tmp_path, monkeypatch):
    """A coded strategy that only enters (never exits itself) gets closed by a
    panel-authored longExit rule group riding along on the coded run."""
    (tmp_path / "hold_forever.py").write_text(HOLD_FOREVER_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)

    candles = make_candles(20)
    series = {"SIG": [(-1.0 if i < 10 else 1.0) for i in range(len(candles))]}
    req = base_request("hold_forever.py", candles)
    req["series"] = series
    req["longExit"] = {"combine": "AND", "rules": [{
        "left": {"kind": "series", "seriesKey": "SIG"},
        "op": "gt",
        "right": {"kind": "const", "value": 0.0},
    }]}
    res = client.post("/api/backtest", json=req)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["trades"], "rule exit should have closed the coded entry"
    rule_exits = [t for t in body["trades"] if t["reason"] == "SIG gt 0.0"]
    assert rule_exits, f"expected a trade closed by the rule exit, got: {body['trades']}"


def test_coded_with_exit_rules_missing_series_422(strategies):
    """The missing-series 422 guard must also cover a coded request whose exit
    rule groups reference a series that wasn't posted."""
    req = base_request("test.py", make_candles())
    req["longExit"] = {"combine": "AND", "rules": [{
        "left": {"kind": "series", "seriesKey": "SIG"},
        "op": "gt",
        "right": {"kind": "const", "value": 0.0},
    }]}
    res = client.post("/api/backtest", json=req)
    assert res.status_code == 422
    assert "missing series 'SIG'" in res.json()["detail"]


def test_coded_with_exit_rules_wrong_length_series_422(strategies):
    """The series-length 422 guard must also cover a coded request whose exit
    rule groups ride along with a posted series shorter than the candles —
    otherwise RuleStrategy silently reads None past the array end."""
    candles = make_candles(20)
    req = base_request("test.py", candles)
    req["series"] = {"SIG": [1.0] * (len(candles) - 1)}
    req["longExit"] = {"combine": "AND", "rules": [{
        "left": {"kind": "series", "seriesKey": "SIG"},
        "op": "gt",
        "right": {"kind": "const", "value": 0.0},
    }]}
    res = client.post("/api/backtest", json=req)
    assert res.status_code == 422
    assert "series 'SIG' length" in res.json()["detail"]

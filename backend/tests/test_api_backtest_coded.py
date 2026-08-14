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
    return {
        "epic": "TEST", "resolution": "HOUR", "candles": candles, "series": {},
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": {"kind": "fixed", "value": 0}, "startingCash": 10000},
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


def _flat_candles(closes):
    t0 = 1_700_000_000
    return [{"time": t0 + i * 3600, "open": c, "high": c, "low": c, "close": c, "volume": 10}
            for i, c in enumerate(closes)]


def test_coded_run_with_expr_exit_closes_and_reenters(strategies, tmp_path, monkeypatch):
    """A coded strategy that only enters (never exits itself) gets closed by a
    panel-authored EXPRESSION exit riding along on the coded run. The expr exit
    reason is empty, so the reliable proof it fired is re-entry: HOLD_FOREVER
    re-buys the next flat bar, yielding more than one trade."""
    (tmp_path / "hold_forever.py").write_text(HOLD_FOREVER_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)

    # Rise, then a drop at bar 5 pushes close under EMA(2); the drop is NOT the
    # last bar, so an exit there re-enters and the final position closes at range end.
    candles = _flat_candles([100, 101, 102, 103, 104, 90, 90, 90])
    req = base_request("hold_forever.py", candles)
    req["exprLongExit"] = [{"expr": "candle.close < EMA(2)", "enabled": True}]
    req["exprShortExit"] = []
    res = client.post("/api/backtest", json=req)
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["trades"]) >= 2, (
        f"expr exit should have closed the coded entry then re-entered, got: {body['trades']}")
    assert any(t["reason"] != "range end" for t in body["trades"]), (
        f"at least one trade should close on the expr exit, got: {body['trades']}")


def test_coded_with_exit_rules_wrong_length_series_422(strategies):
    """The series-length 422 guard must cover a coded request whose posted series
    is shorter than the candles, otherwise the engine silently reads None past
    the array end."""
    candles = make_candles(20)
    req = base_request("test.py", candles)
    req["series"] = {"SIG": [1.0] * (len(candles) - 1)}
    res = client.post("/api/backtest", json=req)
    assert res.status_code == 422
    assert "series 'SIG' length" in res.json()["detail"]


ZONE_STRAT = '''
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) >= 12 and len(ctx.closes) % 10 == 0:
        i = len(ctx.closes) - 1
        z = ctx.zone(i - 5, i, top=ctx.close + 2, bottom=ctx.close - 2, label="range")
        return [ctx.buy(sl=ctx.close * 0.9, tp=ctx.close * 1.1, reason="in", zones=[z])]
    if ctx.position.is_long and ctx.bars_since_entry >= 3:
        return [ctx.close_long(reason="out")]
    return []
'''


def test_coded_trade_zones_serialized(strategies, tmp_path, monkeypatch):
    # A strategy-attached zone rides the trade onto the wire: unix-second
    # times spanning the declared bars, top/bottom/label verbatim.
    (tmp_path / "zoned.py").write_text(ZONE_STRAT)
    candles = make_candles(40)
    res = client.post("/api/backtest", json=base_request("zoned.py", candles))
    assert res.status_code == 200
    trades = res.json()["trades"]
    assert trades, "expected at least one round-trip"
    z = trades[0]["zones"][0]
    assert z["label"] == "range"
    assert z["top"] > z["bottom"]
    assert isinstance(z["from_time"], int) and isinstance(z["to_time"], int)
    assert z["to_time"] - z["from_time"] == 5 * 3600  # 5 bars of HOUR data
    # Plain strategies keep an empty list (field present, no zones).
    res2 = client.post("/api/backtest", json=base_request("test.py", candles))
    assert res2.status_code == 200
    assert all(t["zones"] == [] for t in res2.json()["trades"])


REGIONS_STRAT = '''
def on_bar(ctx):
    return []

def chart_regions(candles, params):
    return [{
        "from_time": candles[0].time.timestamp(),
        "to_time": candles[5].time.timestamp(),
        "top": 111.0, "bottom": 99.0, "label": "squeeze",
    }]
'''

BROKEN_REGIONS_STRAT = '''
def on_bar(ctx):
    return []

def chart_regions(candles, params):
    raise RuntimeError("viz exploded")
'''


def test_coded_chart_regions_serialized(strategies, tmp_path, monkeypatch):
    (tmp_path / "regions.py").write_text(REGIONS_STRAT)
    candles = make_candles(30)
    res = client.post("/api/backtest", json=base_request("regions.py", candles))
    assert res.status_code == 200
    regions = res.json()["regions"]
    assert regions == [{
        "from_time": candles[0]["time"], "to_time": candles[5]["time"],
        "top": 111.0, "bottom": 99.0, "label": "squeeze",
    }]
    # Strategies without the hook report an empty list.
    res2 = client.post("/api/backtest", json=base_request("test.py", candles))
    assert res2.status_code == 200
    assert res2.json()["regions"] == []


def test_coded_broken_chart_regions_does_not_kill_the_run(strategies, tmp_path, monkeypatch):
    (tmp_path / "brokenviz.py").write_text(BROKEN_REGIONS_STRAT)
    res = client.post("/api/backtest", json=base_request("brokenviz.py", make_candles(30)))
    assert res.status_code == 200  # viz is decoration; the run must survive
    assert res.json()["regions"] == []

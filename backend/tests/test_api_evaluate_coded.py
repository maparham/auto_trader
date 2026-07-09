"""POST /api/strategy/evaluate with codedStrategy: same file as backtest drives
the one-bar live decision; hedged strategies are refused; per-signal brackets
land on the ActionDTO."""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

client = TestClient(app)

ALWAYS_IN = '''def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(sl=ctx.close * 0.98, tp=ctx.close * 1.04, reason="go")]
    return [ctx.close_long(reason="bail")]
'''

HEDGED = 'meta = {"hedged": True}\ndef on_bar(ctx):\n    return []\n'

EXPLICIT_QTY = '''def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(qty=0.5, reason="go")]
    return []
'''

RAISES = '''def on_bar(ctx):
    raise ValueError("boom")
'''

BAD_RETURN = '''def on_bar(ctx):
    return "not an action"
'''

PARAMS_STRAT = '''
meta = {"params": [{"name": "n", "type": "int", "default": 3, "min": 1, "max": 50}]}
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) >= ctx.param("n"):
        return [ctx.buy(reason="go")]
    return []
'''


def make_candles(n=30):
    t0 = 1_700_000_000
    return [
        {"time": t0 + i * 3600, "open": 100 + i, "high": 101 + i,
         "low": 99 + i, "close": 100.5 + i, "volume": 10}
        for i in range(n)
    ]


def base_request(strategy, position=None):
    empty = {"combine": "AND", "rules": []}
    req = {
        "epic": "TEST", "resolution": "HOUR", "candles": make_candles(), "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "codedStrategy": strategy,
    }
    if position:
        req["position"] = position
    return req


@pytest.fixture
def strategies(tmp_path, monkeypatch):
    (tmp_path / "always_in.py").write_text(ALWAYS_IN)
    (tmp_path / "hedged.py").write_text(HEDGED)
    (tmp_path / "explicit_qty.py").write_text(EXPLICIT_QTY)
    (tmp_path / "raises.py").write_text(RAISES)
    (tmp_path / "bad_return.py").write_text(BAD_RETURN)
    (tmp_path / "params.py").write_text(PARAMS_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


def test_flat_opens_with_signal_bracket(strategies):
    res = client.post("/api/strategy/evaluate", json=base_request("always_in.py"))
    assert res.status_code == 200, res.text
    actions = res.json()["actions"]
    assert len(actions) == 1
    a = actions[0]
    assert a["kind"] == "open" and a["leg"] == "long" and a["side"] == "buy"
    last_close = make_candles()[-1]["close"]
    assert a["stop_level"] == pytest.approx(last_close * 0.98)
    assert a["take_profit_level"] == pytest.approx(last_close * 1.04)


def test_panel_risk_overrides_file_brackets(strategies):
    """When the panel configures longRisk, the file's sl=/tp= on the long leg
    are stripped before the engine, so the panel's stop/target land on the
    ActionDTO instead of the file's."""
    req = base_request("always_in.py")
    req["longRisk"] = {"stop": {"kind": "pct", "value": 5}, "target": {"kind": "none"}}
    res = client.post("/api/strategy/evaluate", json=req)
    assert res.status_code == 200, res.text
    a = res.json()["actions"][0]
    last_close = make_candles()[-1]["close"]
    assert a["stop_level"] == pytest.approx(last_close * 0.95)
    assert a["take_profit_level"] is None


def test_held_closes(strategies):
    pos = {"side": "buy", "quantity": 1, "open_level": 100,
           "open_time": make_candles()[5]["time"]}
    res = client.post("/api/strategy/evaluate", json=base_request("always_in.py", pos))
    actions = res.json()["actions"]
    assert len(actions) == 1
    assert actions[0]["kind"] == "close" and actions[0]["reason"] == "bail"


def test_hedged_refused(strategies):
    res = client.post("/api/strategy/evaluate", json=base_request("hedged.py"))
    assert res.status_code == 422
    assert "backtest-only" in res.json()["detail"]


def test_unknown_strategy_422(strategies):
    res = client.post("/api/strategy/evaluate", json=base_request("missing.py"))
    assert res.status_code == 422


def test_explicit_qty_forwarded(strategies):
    """ctx.buy(qty=0.5) sets action.quantity — the live route must forward
    author-specified sizing rather than silently using the panel's default."""
    res = client.post("/api/strategy/evaluate", json=base_request("explicit_qty.py"))
    assert res.status_code == 200, res.text
    actions = res.json()["actions"]
    assert len(actions) == 1
    assert actions[0]["quantity"] == pytest.approx(0.5)


def test_default_qty_not_forwarded(strategies):
    """always_in.py never passes qty= — action.quantity must stay None so the
    live route falls back to the panel's configured quantity."""
    res = client.post("/api/strategy/evaluate", json=base_request("always_in.py"))
    actions = res.json()["actions"]
    assert len(actions) == 1
    assert actions[0]["quantity"] is None


def test_strategy_raises_422(strategies):
    res = client.post("/api/strategy/evaluate", json=base_request("raises.py"))
    assert res.status_code == 422
    assert "boom" in res.json()["detail"]


def test_strategy_bad_return_422(strategies):
    res = client.post("/api/strategy/evaluate", json=base_request("bad_return.py"))
    assert res.status_code == 422


def test_evaluate_coded_params_change_behavior(strategies):
    req = base_request("params.py")
    r1 = client.post("/api/strategy/evaluate", json=req).json()
    assert len(r1["actions"]) == 1  # default n=3, 30 candles -> fires
    req["codedParams"] = {"n": 50}
    r2 = client.post("/api/strategy/evaluate", json=req).json()
    assert len(r2["actions"]) == 0  # n=50 > 30 candles -> no action


def test_evaluate_coded_params_bad_value_422(strategies):
    req = base_request("params.py")
    req["codedParams"] = {"n": "lots"}
    resp = client.post("/api/strategy/evaluate", json=req)
    assert resp.status_code == 422
    assert "n" in resp.json()["detail"]


HOLD_ONLY = '''def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="in")]
    return []
'''


def test_panel_exit_rule_closes_coded_position(strategies, tmp_path, monkeypatch):
    """A held position + a panel-authored longExit rule that's TRUE now must
    close through CodedWithRuleExits even though the coded file never exits
    itself."""
    (tmp_path / "hold_only.py").write_text(HOLD_ONLY)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)

    candles = make_candles()
    series = {"SIG": [1.0] * len(candles)}
    pos = {"side": "buy", "quantity": 1, "open_level": 100,
           "open_time": candles[0]["time"]}
    req = base_request("hold_only.py", pos)
    req["series"] = series
    req["longExit"] = {"combine": "AND", "rules": [{
        "left": {"kind": "series", "seriesKey": "SIG"},
        "op": "gt",
        "right": {"kind": "const", "value": 0.0},
    }]}
    res = client.post("/api/strategy/evaluate", json=req)
    assert res.status_code == 200, res.text
    actions = res.json()["actions"]
    assert len(actions) == 1
    assert actions[0]["kind"] == "close"
    assert actions[0]["reason"] == "SIG gt 0.0"


def test_evaluate_none_none_risk_keeps_file_brackets(strategies):
    """C1 (critical): a none/none longRisk posted from the live evaluate path
    must NOT strip the file's own sl=/tp= — same rule as backtest."""
    req = base_request("always_in.py")
    req["longRisk"] = {"stop": {"kind": "none"}, "target": {"kind": "none"}}
    res = client.post("/api/strategy/evaluate", json=req)
    assert res.status_code == 200, res.text
    a = res.json()["actions"][0]
    last_close = make_candles()[-1]["close"]
    assert a["stop_level"] == pytest.approx(last_close * 0.98)
    assert a["take_profit_level"] == pytest.approx(last_close * 1.04)


ATR_RISK_STRAT = '''def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="in")]
    return []
'''


def test_evaluate_coded_atr_risk_missing_series_422(strategies, tmp_path, monkeypatch):
    """I4: ATR-kind panel risk on a coded evaluate cycle needs the same
    missing-series 422 guard rule mode gets."""
    (tmp_path / "atr_risk.py").write_text(ATR_RISK_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    req = base_request("atr_risk.py")
    req["longRisk"] = {
        "stop": {"kind": "atr", "mult": 2.0, "length": 14},
        "target": {"kind": "none"},
    }
    res = client.post("/api/strategy/evaluate", json=req)
    assert res.status_code == 422
    assert "ATR_14" in res.json()["detail"]


def test_evaluate_coded_atr_risk_with_series_200(strategies, tmp_path, monkeypatch):
    (tmp_path / "atr_risk.py").write_text(ATR_RISK_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    req = base_request("atr_risk.py")
    req["series"] = {"ATR_14": [1.0] * len(make_candles())}
    req["longRisk"] = {
        "stop": {"kind": "atr", "mult": 2.0, "length": 14},
        "target": {"kind": "none"},
    }
    res = client.post("/api/strategy/evaluate", json=req)
    assert res.status_code == 200, res.text


def test_evaluate_coded_with_exit_rules_missing_series_422(strategies):
    """The missing-series 422 guard must also cover a coded request whose exit
    rule groups reference a series that wasn't posted."""
    req = base_request("always_in.py")
    req["longExit"] = {"combine": "AND", "rules": [{
        "left": {"kind": "series", "seriesKey": "SIG"},
        "op": "gt",
        "right": {"kind": "const", "value": 0.0},
    }]}
    res = client.post("/api/strategy/evaluate", json=req)
    assert res.status_code == 422
    assert "missing series 'SIG'" in res.json()["detail"]

"""API tests for expression mode in /api/strategy/evaluate.

Parallel to test_api_strategy_evaluate.py (structured) and test_api_expr.py
(expr backtest): exercises the exprMode branch end to end (parse/validate ->
compile -> ExprRuleStrategy.on_bar -> shared netting/action layer). The
structured and coded branches are untouched.
"""

from fastapi.testclient import TestClient

from auto_trader.api.app import app

client = TestClient(app)

# Empty structured groups: exprMode ignores them, but they are required fields.
_EMPTY = {"combine": "AND", "rules": []}


def _candles(bars):
    """bars: list of (open, close). high/low bracket both so any expr is valid."""
    out = []
    for k, (o, c) in enumerate(bars):
        out.append({
            "time": 3600 * k, "open": o, "high": max(o, c),
            "low": min(o, c), "close": c, "volume": 100.0,
        })
    return out


def _base(**over):
    req = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": _candles([(1, 1), (2, 2), (2, 3)]),  # last bar close(3) > open(2)
        "longEntry": _EMPTY, "longExit": _EMPTY,
        "shortEntry": _EMPTY, "shortExit": _EMPTY,
        "exprMode": True,
        "exprLongEntry": [{"expr": "candle.close > candle.open"}],
        "exprLongExit": [], "exprShortEntry": [], "exprShortExit": [],
        "position": None,
    }
    req.update(over)
    return req


def test_expr_evaluate_opens_on_entry():
    r = client.post("/api/strategy/evaluate", json=_base())
    assert r.status_code == 200
    actions = r.json()["actions"]
    assert len(actions) == 1
    assert actions[0]["kind"] == "open"
    assert actions[0]["leg"] == "long" and actions[0]["side"] == "buy"


def test_expr_evaluate_no_scale_in_when_held():
    # Already long; entry fires but netting suppresses a scale-in. Exit is crafted
    # not to fire (close 3 is not < entry 1), so no action at all.
    r = client.post("/api/strategy/evaluate", json=_base(
        exprLongExit=[{"expr": "candle.close < entry"}],
        position={"side": "buy", "quantity": 1.0, "open_level": 1.0},
    ))
    assert r.status_code == 200
    assert r.json()["actions"] == []


def test_expr_evaluate_closes_on_exit():
    # Hold long; exit fires on the last bar (close 3 < entry 1e9) -> one close.
    r = client.post("/api/strategy/evaluate", json=_base(
        exprLongEntry=[],
        exprLongExit=[{"expr": "candle.close < entry"}],
        position={"side": "buy", "quantity": 1.0, "open_level": 1e9},
    ))
    assert r.status_code == 200
    actions = r.json()["actions"]
    assert len(actions) == 1
    assert actions[0]["kind"] == "close" and actions[0]["leg"] == "long"


def test_expr_evaluate_bad_expr_422():
    r = client.post("/api/strategy/evaluate", json=_base(
        exprLongEntry=[{"expr": "FOO(9) > 0"}],
    ))
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["code"] == "unknown_name"
    assert d["group"] == "longEntry" and d["row"] == 0


def test_expr_evaluate_atr_risk_422():
    atr_risk = {"stop": {"kind": "atr", "mult": 2.0, "length": 14},
                "target": {"kind": "none"}}
    r = client.post("/api/strategy/evaluate", json=_base(longRisk=atr_risk))
    assert r.status_code == 422
    assert "ATR-based risk stops" in r.json()["detail"]


def test_expr_evaluate_with_coded_is_422():
    # exprMode and codedStrategy together is rejected (would otherwise leave the
    # coded module unbuilt when the signals branch tests codedStrategy).
    r = client.post("/api/strategy/evaluate", json=_base(codedStrategy="anything.py"))
    assert r.status_code == 422
    assert "mutually exclusive" in r.json()["detail"]


def test_expr_evaluate_warns_when_bars_since_entry_has_no_entry_time(caplog):
    # Held long, exit rule uses barsSinceEntry, but the position carries no
    # open_time (older caller, or broker gave none) -> the exit can never fire
    # since every bar reads as "before entry". Must warn, naming the epic, rather
    # than fail silently.
    import logging
    with caplog.at_level(logging.WARNING, logger="auto_trader.api.routers.strategy"):
        r = client.post("/api/strategy/evaluate", json=_base(
            exprLongEntry=[],
            exprLongExit=[{"expr": "count(bearish(candle), barsSinceEntry) >= 3"}],
            position={"side": "buy", "quantity": 1.0, "open_level": 1.0},  # no open_time
        ))
    assert r.status_code == 200
    assert any(
        "barsSinceEntry" in rec.message and "TEST" in rec.message
        for rec in caplog.records
    )


def test_expr_evaluate_no_warning_when_entry_time_present(caplog):
    # Same shape, but open_time is a valid bar within history -> no warning.
    import logging
    with caplog.at_level(logging.WARNING, logger="auto_trader.api.routers.strategy"):
        r = client.post("/api/strategy/evaluate", json=_base(
            exprLongEntry=[],
            exprLongExit=[{"expr": "count(bearish(candle), barsSinceEntry) >= 3"}],
            position={"side": "buy", "quantity": 1.0, "open_level": 1.0, "open_time": 0},
        ))
    assert r.status_code == 200
    assert not any("barsSinceEntry" in rec.message for rec in caplog.records)


def test_expr_evaluate_disabled_row_skipped():
    # A disabled (garbage) entry row is dropped before parse; enabled true-row fires.
    r = client.post("/api/strategy/evaluate", json=_base(
        exprLongEntry=[{"expr": "$$$ nope", "enabled": False},
                       {"expr": "candle.close > candle.open"}],
    ))
    assert r.status_code == 200
    assert r.json()["actions"][0]["kind"] == "open"

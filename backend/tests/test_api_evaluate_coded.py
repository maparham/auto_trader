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

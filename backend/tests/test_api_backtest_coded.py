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

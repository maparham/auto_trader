"""Oracle baseline over the API: `oracle_entries` (the strategy's entries with
direction and exit corrected by hindsight) is a single companion run — not a
per-side pair — planned by engine/oracle.py and replayed through the real
engine, so its blob carries the same metrics keys as every other baseline.
Coded-route fixtures mirror tests/test_api_backtest_baselines.py."""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

client = TestClient(app)

STRAT = '''"""Test strat."""
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) % 10 == 0:
        return [ctx.buy(reason="in")]
    if ctx.position.is_long and ctx.bars_since_entry >= 3:
        return [ctx.close_long(reason="out")]
    return []
'''

NOTRADE = '''"""Never trades."""
def on_bar(ctx):
    return []
'''


def zigzag_candles(n=60):
    t0 = 1_700_000_000
    out, px = [], 100.0
    for i in range(n):
        px += 0.5 if i % 3 else -0.5
        out.append({"time": t0 + i * 3600, "open": px, "high": px + 1,
                    "low": px - 1, "close": px + 0.3, "volume": 10})
    return out


def expr_req(candles, **over):
    req = {
        "epic": "TEST", "resolution": "HOUR", "candles": candles,
        "longEntry": [{"expr": "EMA(3) x> EMA(5)"}],
        "longExit": [], "shortEntry": [], "shortExit": [],
        "longEnabled": True, "shortEnabled": False,
        "longRisk": None, "shortRisk": None,
        "longScaling": None, "shortScaling": None,
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0},
                  "spread": 0, "startingCash": 10000},
        "tradeFromTime": 0, "mask": None,
    }
    req.update(over)
    return req


def coded_req(candles, **over):
    req = {
        "epic": "TEST", "resolution": "HOUR", "candles": candles, "series": {},
        "costs": {"quantity": 1, "commissionPerSide": 0,
                  "slippage": {"kind": "fixed", "value": 0}, "startingCash": 10000},
        "tradeFromTime": candles[0]["time"],
        "codedStrategy": "test.py",
        "longEnabled": True, "shortEnabled": False,
    }
    req.update(over)
    return req


@pytest.fixture
def strategies(tmp_path, monkeypatch):
    (tmp_path / "test.py").write_text(STRAT)
    (tmp_path / "notrade.py").write_text(NOTRADE)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    yield


def test_expr_oracle_entries_returned_with_full_metrics():
    r = client.post("/api/expr/backtest", json=expr_req(
        zigzag_candles(), baselines=["oracle_entries"]))
    assert r.status_code == 200, r.text
    body = r.json()
    m = body["baselines"]["oracle_entries"]
    assert m is not None
    assert "net_pnl" in m and "return_pct" in m and "sharpe" in m
    # The run's own trades are one admissible plan, so hindsight correction
    # can only help (same cost model, exits never later than the originals).
    assert m["net_pnl"] >= 0
    # Unrequested kinds keep their None slots.
    assert body["baselines"]["null_long"] is None
    assert body["baselines"]["hold_long"] is None


def test_coded_oracle_entries(strategies):
    r = client.post("/api/backtest", json=coded_req(
        zigzag_candles(), baselines=["oracle_entries"]))
    assert r.status_code == 200, r.text
    body = r.json()
    m = body["baselines"]["oracle_entries"]
    assert m is not None
    assert m["net_pnl"] >= 0


def test_coded_oracle_entries_absent_when_strategy_never_traded(strategies):
    r = client.post("/api/backtest", json=coded_req(
        zigzag_candles(), codedStrategy="notrade.py",
        baselines=["oracle_entries"]))
    assert r.status_code == 200, r.text
    assert r.json()["baselines"]["oracle_entries"] is None

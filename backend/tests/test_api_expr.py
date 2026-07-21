"""API tests for the expression surface: /api/expr/backtest, /series, /literals.

The structured /api/backtest is untouched; this exercises the parallel expr
surface end to end (parse/validate -> compile -> engine run -> shared serializer).
"""

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from auto_trader.api import deps
from auto_trader.api.app import app
from auto_trader.core.models import Candle

client = TestClient(app)


def _candles(closes):
    return [{"time": 3600 * k, "open": c, "high": c, "low": c, "close": c, "volume": 100.0}
            for k, c in enumerate(closes)]


def _base_req(**over):
    req = {
        "epic": "TEST", "resolution": "HOUR", "candles": _candles([1, 2, 3, 2, 1]),
        "htfCandles": None,
        "longEntry": [{"expr": "crossAbove(candle.close, 2)"}],
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


def test_expr_backtest_runs():
    r = client.post("/api/expr/backtest", json=_base_req())
    assert r.status_code == 200
    body = r.json()
    assert "trades" in body
    assert "equity" in body and "summary" in body and "by_leg" in body


def test_expr_backtest_parse_error_carries_span_and_location():
    r = client.post("/api/expr/backtest", json=_base_req(longEntry=[{"expr": "EMA(9) EMA(21)"}]))
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["code"] == "expected_operator"
    assert d["group"] == "longEntry" and d["row"] == 0
    assert isinstance(d["start"], int) and isinstance(d["end"], int)


def test_expr_backtest_entry_in_entry_rule_rejected():
    r = client.post("/api/expr/backtest", json=_base_req(longEntry=[{"expr": "entry > candle.close"}]))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "entry_in_entry_rule"


def test_expr_backtest_disabled_row_is_skipped():
    # A disabled entry row is dropped before parse, so even garbage passes.
    r = client.post("/api/expr/backtest", json=_base_req(
        longEntry=[{"expr": "$$$ not parseable", "enabled": False}]))
    assert r.status_code == 200


def test_expr_backtest_blank_enabled_row_is_skipped():
    # An empty placeholder row (what the UI ships for an unauthored side) is not
    # a rule: it must not 422 on an empty parse. shortEntry stays blank here.
    r = client.post("/api/expr/backtest", json=_base_req(
        shortEntry=[{"expr": "", "enabled": True}],
        shortExit=[{"expr": "   ", "enabled": True}]))
    assert r.status_code == 200


def test_expr_backtest_atr_risk_rejected():
    # An ATR-kind stop has no series on the expr surface (series={}); running it
    # would yield a silent stop-less trade, so the handler 422s instead.
    atr_risk = {"stop": {"kind": "atr", "mult": 2.0, "length": 14},
                "target": {"kind": "none"}}
    r = client.post("/api/expr/backtest", json=_base_req(longRisk=atr_risk))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "atr_risk_unsupported"


def test_expr_backtest_fixed_risk_still_runs():
    # Non-ATR (points/pct) risk carries no ATR series requirement, so it runs.
    pct_risk = {"stop": {"kind": "pct", "value": 5.0}, "target": {"kind": "none"}}
    r = client.post("/api/expr/backtest", json=_base_req(longRisk=pct_risk))
    assert r.status_code == 200


def test_expr_literals_endpoint():
    r = client.post("/api/expr/literals", json={"expr": "EMA(50) > 30"})
    assert r.status_code == 200
    body = r.json()
    assert body["error"] is None
    lits = body["literals"]
    assert [(x["ordinal"], x["value"], x["label"]) for x in lits] == [
        (0, 50.0, "EMA length"), (1, 30.0, "threshold")]
    # spans are reported for the editor underline
    assert all("start" in x and "end" in x for x in lits)


def test_expr_literals_parse_error_returns_error_body():
    r = client.post("/api/expr/literals", json={"expr": "EMA(9) EMA(21)"})
    assert r.status_code == 200
    body = r.json()
    assert body["literals"] == []
    assert body["error"]["code"] == "expected_operator"


def test_expr_series_overlay(monkeypatch):
    # /api/expr/series fetches its own candles; patch the (async) fetch helper on
    # the deps module (the router calls it module-qualified, so this reaches it).
    closes = [1.0, 2.0, 3.0, 4.0]

    async def _fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        return [
            Candle(time=datetime.fromtimestamp(3600 * k, tz=timezone.utc),
                   open=c, high=c, low=c, close=c, volume=100.0)
            for k, c in enumerate(closes)
        ]

    monkeypatch.setattr(deps, "_fetch_symbol_candles", _fake_fetch)
    r = client.post("/api/expr/series", json={
        "epic": "TEST", "resolution": "HOUR", "expr": "candle.close > 2",
        "fromTime": 0, "toTime": 3600 * 3,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["times"] == [0, 3600, 7200, 10800]
    assert body["values"] == closes  # left side of the comparison is candle.close
    assert isinstance(body["warmup"], int)


def test_expr_series_parse_error():
    r = client.post("/api/expr/series", json={
        "epic": "TEST", "resolution": "HOUR", "expr": "EMA(9) EMA(21)",
        "fromTime": 0, "toTime": 3600,
    })
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "expected_operator"

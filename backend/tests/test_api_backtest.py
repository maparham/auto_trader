"""POST /api/backtest — rule-driven backtest endpoint.

No broker calls (D1/D6): the request carries the candles the series were
computed on, so the handler is exercised by calling it directly, same pattern
as test_broker_isolation.py's `app_module.backtest(...)` calls.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from auto_trader.api import app as app_module
from auto_trader.api.app import app

client = TestClient(app)


def _candles(closes: list[float]) -> list[dict]:
    return [
        {"time": 1_700_000_000 + i * 60, "open": c, "high": c, "low": c, "close": c, "volume": 0.0}
        for i, c in enumerate(closes)
    ]


def _ind(name: str, length: int | None = None, anchor: int | None = None) -> dict:
    return {"kind": "indicator", "indicator": name, "length": length, "anchor": anchor}


def _costs() -> dict:
    return {"quantity": 1.0, "commissionPerSide": 0.0, "slippage": 0.0, "startingCash": 10_000.0}


def _groups(long_entry=None, long_exit=None, short_entry=None, short_exit=None):
    empty = {"combine": "AND", "rules": []}
    return {
        "longEntry": long_entry or empty,
        "longExit": long_exit or empty,
        "shortEntry": short_entry or empty,
        "shortExit": short_exit or empty,
    }


def _run(body: dict):
    async def scenario():
        return await app_module.backtest(app_module.BacktestRequest(**body))

    return asyncio.run(scenario())


def test_post_backtest_returns_markers_for_a_simple_cross():
    candles = _candles([10, 10, 10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {
            "EMA_5": [1.0, 1.0, 3.0, 3.0, 3.0],
            "EMA_9": [2.0, 2.0, 2.0, 2.0, 2.0],
        },
        **_groups(
            long_entry={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesAbove", "right": _ind("EMA", 9)}]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    result = _run(body)
    assert result.epic == "EURUSD"
    assert len(result.markers) == 1
    assert result.markers[0].side == "buy"
    assert result.markers[0].leg == "long"
    assert len(result.candles) == len(candles)


def test_post_backtest_avwap_anchor_uses_keyed_series():
    candles = _candles([10, 10, 10, 10, 10])
    anchor_ms = candles[0]["time"] * 1000
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {"AVWAP_%d" % anchor_ms: [9.0, 9.0, 9.0, 9.0, 9.0]},
        **_groups(
            long_entry={"combine": "AND", "rules": [
                {"left": {"kind": "price", "field": "close"}, "op": "gt",
                 "right": _ind("AVWAP", anchor=anchor_ms)}
            ]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    # D4 validation passes (keyed series present) and the rule fires (close 10 > 9).
    result = _run(body)
    assert len(result.markers) >= 1


def test_post_backtest_422_when_avwap_keyed_series_missing():
    candles = _candles([10, 10, 10])
    anchor_ms = candles[0]["time"] * 1000
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},  # AVWAP_<anchor> referenced but not provided
        **_groups(
            long_entry={"combine": "AND", "rules": [
                {"left": {"kind": "price", "field": "close"}, "op": "gt",
                 "right": _ind("AVWAP", anchor=anchor_ms)}
            ]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(HTTPException) as e:
        _run(body)
    assert e.value.status_code == 422


def test_post_backtest_short_config_produces_short_trades_with_leg():
    candles = _candles([10, 10, 10, 10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {"EMA_5": [1.0, 1.0, 3.0, 3.0, 1.0, 1.0], "EMA_9": [2.0] * 6},
        **_groups(
            short_entry={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesBelow", "right": _ind("EMA", 9)}]},
            short_exit={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesAbove", "right": _ind("EMA", 9)}]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    result = _run(body)
    assert result.markers
    assert all(m.leg in ("long", "short") for m in result.markers)
    assert any(m.leg == "short" for m in result.markers)


def _both_sides_cross_body():
    """A config where BOTH a long entry and a short entry fire (EMA_5 crosses
    above EMA_9 at i=2, below at i=4), used to test the per-side enable flags."""
    candles = _candles([10, 10, 10, 10, 10, 10, 10])
    return {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {"EMA_5": [1.0, 1.0, 3.0, 3.0, 1.0, 1.0, 1.0], "EMA_9": [2.0] * 7},
        **_groups(
            long_entry={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesAbove", "right": _ind("EMA", 9)}]},
            short_entry={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "crossesBelow", "right": _ind("EMA", 9)}]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }


def test_post_backtest_disabled_long_side_produces_no_long_markers():
    body = {**_both_sides_cross_body(), "longEnabled": False}
    legs = {m.leg for m in _run(body).markers}
    assert "long" not in legs
    assert "short" in legs  # the enabled side still trades


def test_post_backtest_disabled_short_side_produces_no_short_markers():
    body = {**_both_sides_cross_body(), "shortEnabled": False}
    legs = {m.leg for m in _run(body).markers}
    assert "short" not in legs
    assert "long" in legs


def test_post_backtest_enable_flags_default_to_trading_when_omitted():
    # Omitting longEnabled/shortEnabled must trade BOTH sides (DTO default True),
    # guarding against a flipped default or dropped kwargs in the handler wiring.
    legs = {m.leg for m in _run(_both_sides_cross_body()).markers}
    assert legs == {"long", "short"}


def test_post_backtest_422_on_empty_candles():
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": [],
        "series": {},
        **_groups(),
        "costs": _costs(),
        "tradeFromTime": 0,
    }
    with pytest.raises(HTTPException) as e:
        _run(body)
    assert e.value.status_code == 422


def test_post_backtest_422_on_series_length_mismatch():
    candles = _candles([10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {"EMA_5": [1.0, 2.0]},  # too short
        **_groups(
            long_entry={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "gt", "right": {"kind": "const", "value": 0}}]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(HTTPException) as e:
        _run(body)
    assert e.value.status_code == 422


def test_post_backtest_422_on_missing_series_name():
    candles = _candles([10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},  # EMA_5 referenced by the rule but not provided
        **_groups(
            long_entry={"combine": "AND", "rules": [{"left": _ind("EMA", 5), "op": "gt", "right": {"kind": "const", "value": 0}}]},
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(HTTPException) as e:
        _run(body)
    assert e.value.status_code == 422


def test_post_backtest_trims_response_to_trade_from_time():
    # Two extra warm-up bars before the window; the window itself starts at index 2.
    candles = _candles([10, 10, 10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(),
        "costs": _costs(),
        "tradeFromTime": candles[2]["time"],
    }
    result = _run(body)
    assert [c.time for c in result.candles] == [c["time"] for c in candles[2:]]


@pytest.mark.parametrize(
    "patch",
    [
        {"quantity": 0},
        {"quantity": -1},
        {"commissionPerSide": -0.1},
        {"slippage": -0.1},
        {"startingCash": 0},
    ],
)
def test_post_backtest_422_on_invalid_costs(patch):
    candles = _candles([10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(),
        "costs": {**_costs(), **patch},
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(ValidationError):
        _run(body)


def test_post_backtest_422_on_price_operand_missing_field():
    candles = _candles([10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(
            long_entry={
                "combine": "AND",
                "rules": [{"left": {"kind": "price"}, "op": "gt", "right": {"kind": "const", "value": 0}}],
            },
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(ValidationError):
        _run(body)


def test_post_backtest_422_on_indicator_operand_missing_indicator():
    candles = _candles([10, 10, 10])
    body = {
        "epic": "EURUSD",
        "resolution": "MINUTE_5",
        "candles": candles,
        "series": {},
        **_groups(
            long_entry={
                "combine": "AND",
                "rules": [{"left": {"kind": "indicator"}, "op": "gt", "right": {"kind": "const", "value": 0}}],
            },
        ),
        "costs": _costs(),
        "tradeFromTime": candles[0]["time"],
    }
    with pytest.raises(ValidationError):
        _run(body)


def _min_body():
    # 4 flat candles, no rules -> no trades; a valid minimal request body.
    candles = [{"time": i * 60, "open": 100, "high": 101, "low": 99, "close": 100, "volume": 0}
               for i in range(4)]
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "X", "resolution": "MINUTE", "candles": candles, "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": 0, "startingCash": 10000},
        "tradeFromTime": 0,
    }


def test_atr_risk_without_series_is_rejected():
    body = _min_body()
    body["longRisk"] = {"stop": {"kind": "atr", "mult": 2, "length": 14},
                        "target": {"kind": "none"}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 422
    assert "ATR_14" in r.json()["detail"]


def test_pct_risk_needs_no_series_and_runs():
    body = _min_body()
    body["longRisk"] = {"stop": {"kind": "pct", "value": 2}, "target": {"kind": "none"}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200


def test_atr_risk_with_series_runs():
    body = _min_body()
    body["series"] = {"ATR_14": [1, 2, 4, 4]}
    body["longRisk"] = {"stop": {"kind": "atr", "mult": 2, "length": 14},
                        "target": {"kind": "none"}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200


def test_scaling_atr_spacing_without_series_is_rejected():
    body = _min_body()
    body["longScaling"] = {"maxConcurrent": 3, "spacing": {"kind": "atr", "mult": 2, "length": 14}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 422
    assert "ATR_14" in r.json()["detail"]


def test_scaling_pct_spacing_runs():
    body = _min_body()
    body["longScaling"] = {"maxConcurrent": 3, "spacing": {"kind": "pct", "value": 1.0}}
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200


def test_response_has_metrics_and_trade_reason():
    body = _min_body()
    # a trivial always-open then stop so at least one trade closes with a reason
    body["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gt",
         "right": {"kind": "const", "value": 0}}]}
    body["longRisk"] = {"stop": {"kind": "pct", "value": 1}, "target": {"kind": "none"}}
    # give it a down-bar so the stop triggers and books a trade
    body["candles"] = [
        {"time": 0, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 60, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 120, "open": 100, "high": 100, "low": 98, "close": 98, "volume": 0},
    ]
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200
    data = r.json()
    assert "metrics" in data
    assert "profit_factor" in data["metrics"] and "max_consec_losses" in data["metrics"]
    assert data["trades"], "expected at least one closed trade"
    assert "reason" in data["trades"][0]  # e.g. "stop"


def test_trade_dto_carries_stop_target_levels():
    body = _min_body()
    body["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "price", "field": "close"}, "op": "gt",
         "right": {"kind": "const", "value": 0}}]}
    body["longRisk"] = {"stop": {"kind": "pct", "value": 2}, "target": {"kind": "pct", "value": 4}}
    body["candles"] = [
        {"time": 0, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 60, "open": 100, "high": 100, "low": 100, "close": 100, "volume": 0},
        {"time": 120, "open": 100, "high": 101, "low": 97, "close": 98, "volume": 0},
    ]
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200
    t = r.json()["trades"][0]
    assert t["stop_initial"] == 98.0 and t["target"] == 104.0
    assert "stop_final" in t

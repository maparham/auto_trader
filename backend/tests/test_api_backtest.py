"""POST /api/backtest — rule-driven backtest endpoint.

No broker calls (D1/D6): the request carries the candles the series were
computed on, so the handler is exercised by calling it directly, same pattern
as test_broker_isolation.py's `app_module.backtest(...)` calls.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from auto_trader.api import app as app_module


def _candles(closes: list[float]) -> list[dict]:
    return [
        {"time": 1_700_000_000 + i * 60, "open": c, "high": c, "low": c, "close": c, "volume": 0.0}
        for i, c in enumerate(closes)
    ]


def _ind(name: str, length: int | None = None) -> dict:
    return {"kind": "indicator", "indicator": name, "length": length}


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

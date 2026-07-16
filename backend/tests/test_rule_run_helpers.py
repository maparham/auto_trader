"""Direct unit tests for the helpers that recompute rule series server-side
(`assemble_rule_series_sync`) and run a rule backtest from them (`_run_rule`).
These do NOT hit the /api/backtest route: the route's existing inline rule
branch and validation are untouched.
"""

from __future__ import annotations

import asyncio

import pytest

from auto_trader.api import deps
from auto_trader.api.routers.backtest import _run_rule
from auto_trader.api.sweep_apply import assemble_rule_series_sync, candle_from_dto
from auto_trader.api.schemas import BacktestRequest
from auto_trader.engine.backtest import BacktestResult
from auto_trader.indicators.core import ema_series


@pytest.fixture(autouse=True)
def _no_htf_fetch(monkeypatch):
    """Every test here uses a base-timeframe-only config (no per-operand
    `timeframe`), so `_assemble_rule_series` must never reach for an HTF
    fetch. Fail loudly if a config accidentally introduces an HTF operand."""
    async def _boom(*args, **kwargs):
        raise AssertionError("deps._fetch_symbol_candles must not be called (HTF operand present)")

    monkeypatch.setattr(deps, "_fetch_symbol_candles", _boom)
    yield


def _candles(closes: list[float]) -> list[dict]:
    return [
        {"time": 1_700_000_000 + i * 3600, "open": c, "high": c, "low": c, "close": c, "volume": 0.0}
        for i, c in enumerate(closes)
    ]


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


def _req(**overrides) -> BacktestRequest:
    body = {
        "epic": "EURUSD",
        "resolution": "HOUR",
        "candles": _candles([10, 10, 10, 10, 10]),
        "series": {},
        **_groups(),
        "costs": _costs(),
        "tradeFromTime": 1_700_000_000,
    }
    body.update(overrides)
    return BacktestRequest(**body)


def test_assemble_recomputes_native_ema():
    """A rule referencing a native EMA operand recomputes server-side even
    when `series` ships nothing for it."""
    req = _req(
        candles=_candles([10, 11, 12, 13, 14, 15, 16, 17]),
        series={},
        **_groups(
            long_entry={
                "combine": "AND",
                "rules": [
                    {"left": {"kind": "indicator", "indicator": "EMA", "length": 3},
                     "op": "gt", "right": {"kind": "price", "field": "close"}},
                ],
            },
        ),
    )
    candles = [candle_from_dto(c) for c in req.candles]

    out = assemble_rule_series_sync(req, candles, {})

    assert "EMA_3" in out
    assert out["EMA_3"] == ema_series([c.close for c in candles], 3)


def test_assemble_keeps_chart_operand_series():
    """A `kind='series'` (chart operand/drawing) is browser-supplied and is
    NOT recomputed — the shipped array is returned verbatim."""
    candles_dto = _candles([10, 11, 12, 13, 14])
    shipped = [1.0, 2.0, 3.0, 4.0, 5.0]
    req = _req(
        candles=candles_dto,
        series={"CHART_x": shipped},
        **_groups(
            long_entry={
                "combine": "AND",
                "rules": [
                    {"left": {"kind": "series", "seriesKey": "CHART_x", "label": "foo"},
                     "op": "gt", "right": {"kind": "const", "value": 0}},
                ],
            },
        ),
    )
    candles = [candle_from_dto(c) for c in req.candles]

    out = assemble_rule_series_sync(req, candles, {})

    assert out["CHART_x"] == shipped


def test_run_rule_returns_result_from_recomputed_series():
    """A rule that fires on the REAL recomputed EMA (not a shipped array)
    produces a BacktestResult with at least one entry."""
    closes = [10 + i for i in range(15)]  # steadily rising: close > EMA(3) throughout the rise
    req = _req(
        candles=_candles(closes),
        series={},
        **_groups(
            long_entry={
                "combine": "AND",
                "rules": [
                    {"left": {"kind": "price", "field": "close"}, "op": "gt",
                     "right": {"kind": "indicator", "indicator": "EMA", "length": 3}},
                ],
            },
        ),
    )
    candles = [candle_from_dto(c) for c in req.candles]

    result = asyncio.run(_run_rule(req, candles))

    assert isinstance(result, BacktestResult)
    assert len(result.fills) > 0
    assert result.n_trades > 0 or len(result.trades) > 0

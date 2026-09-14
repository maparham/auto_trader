"""Named indicator series seam: 'RSI(14) on these candles' without composing
expression syntax. Covers the two paths compute_indicator_series dispatches
to: the simple core series (EMA/SMA/RSI/ATR) and the SERIES_INDICATORS
registry (e.g. SR_LEVELS)."""

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from auto_trader.api import deps
from auto_trader.api.routers import charts as charts_router
from auto_trader.core.models import Candle
from auto_trader.indicators.series_api import compute_indicator_series, valid_indicator_names


def mk_candles(n=50, start=1_700_000_000):
    out = []
    for i in range(n):
        px = 100 + (i % 7)
        out.append(Candle(
            time=datetime.fromtimestamp(start + i * 3600, tz=timezone.utc),
            open=px, high=px + 1, low=px - 1, close=px + 0.5, volume=1000,
        ))
    return out


def test_rsi_series_shape():
    res = compute_indicator_series(mk_candles(), "RSI", {"length": 14}, "HOUR")
    assert res["indicator"] == "RSI"
    assert len(res["timestamps"]) == 50
    vals = res["outputs"]["rsi"]
    assert len(vals) == 50
    assert vals[0] is None            # warm-up
    assert vals[-1] is not None
    assert 0 <= vals[-1] <= 100


def test_atr_uses_registry_or_core():
    res = compute_indicator_series(mk_candles(), "ATR", {"length": 14}, "HOUR")
    assert any(v is not None for v in next(iter(res["outputs"].values())))


def test_unknown_indicator_lists_valid_names():
    with pytest.raises(ValueError) as e:
        compute_indicator_series(mk_candles(), "WOMBAT", {}, "HOUR")
    assert "RSI" in str(e.value)


def test_valid_names_cover_registry():
    names = valid_indicator_names()
    assert "ATR" in names and "SR_LEVELS" in names and "EMA" in names


def test_registry_indicator_series_shape():
    # Exercises the SERIES_INDICATORS branch (parse_config/outputs/series),
    # which the SIMPLE-only tests above never reach (ATR is in SIMPLE).
    res = compute_indicator_series(mk_candles(), "SR_LEVELS", {}, "HOUR")
    assert res["indicator"] == "SR_LEVELS"
    assert res["outputs"]
    assert all(len(v) == 50 for v in res["outputs"].values())


def _run_route(**overrides):
    kwargs = {
        "epic": "EURUSD",
        "resolution": "HOUR",
        "indicator": "RSI",
        "length": 14,
        "bars": 500,
        "from_ts": None,
        "to_ts": None,
        "broker_id": "capital",
    }
    kwargs.update(overrides)

    async def scenario():
        return await charts_router.indicator_series(**kwargs)

    return asyncio.run(scenario())


def test_route_returns_series(monkeypatch):
    async def fake_fetch(
        broker_id, epic, resolution, bars, from_ts, to_ts, price_side,
        degraded=None, budget_s=None, partial=None, max_fill_chunks=None,
    ):
        return mk_candles()

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    result = _run_route()
    assert result["epic"] == "EURUSD"
    assert result["resolution"] == "HOUR"
    assert result["indicator"] == "RSI"
    assert len(result["timestamps"]) == 50
    assert len(result["outputs"]["rsi"]) == 50


def test_route_unknown_indicator_422(monkeypatch):
    async def fake_fetch(
        broker_id, epic, resolution, bars, from_ts, to_ts, price_side,
        degraded=None, budget_s=None, partial=None, max_fill_chunks=None,
    ):
        return mk_candles()

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    with pytest.raises(HTTPException) as exc:
        _run_route(indicator="WOMBAT")
    assert exc.value.status_code == 422


def test_route_no_data_404(monkeypatch):
    async def fake_fetch(
        broker_id, epic, resolution, bars, from_ts, to_ts, price_side,
        degraded=None, budget_s=None, partial=None, max_fill_chunks=None,
    ):
        return []

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    with pytest.raises(HTTPException) as exc:
        _run_route()
    assert exc.value.status_code == 404

"""GET /api/candles/synthetic — stateless arithmetic-combination endpoint.

No broker calls: `_fetch_leg_candles` is monkeypatched, so the handler is
exercised by calling it directly, same pattern as test_api_backtest.py's
`app_module.backtest(...)` calls (this repo has no pytest-asyncio, so async
handlers are driven via `asyncio.run`, not an ASGI test client).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

import auto_trader.api.app as app_module
from auto_trader.core.models import Candle


def _c(ts: int, v: float) -> Candle:
    return Candle(datetime.fromtimestamp(ts, tz=timezone.utc), v, v, v, v, 0.0)


def _run(**overrides):
    # candles_synthetic's parameters are `= Query(...)` defaults: when the
    # coroutine is called directly (bypassing FastAPI's DI), an omitted kwarg
    # binds to the raw `Query` sentinel object, NOT its resolved default value.
    # `from_ts is None` and similar checks in the handler body would then break,
    # so every param the body actually reads must be passed explicitly here.
    kwargs = {
        "resolution": "MINUTE",
        "bars": 500,
        "from_ts": None,
        "to_ts": None,
        "price_side": "mid",
        "broker_id": "capital",
    }
    kwargs.update(overrides)

    async def scenario():
        return await app_module.candles_synthetic(**kwargs)

    return asyncio.run(scenario())


def test_synthetic_ratio_combines_legs(monkeypatch):
    async def fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        if epic == "A":
            return [_c(60, 10), _c(120, 20)]
        if epic == "B":
            return [_c(60, 2), _c(120, 4)]
        return []

    monkeypatch.setattr(app_module, "_fetch_leg_candles", fake_fetch)
    result = _run(expr="A / B")
    assert [dto.close for dto in result] == [5.0, 5.0]


def test_synthetic_bad_expr_422():
    with pytest.raises(HTTPException) as exc:
        _run(expr="A % B")
    assert exc.value.status_code == 422


def test_synthetic_no_overlap_404(monkeypatch):
    async def fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        return []

    monkeypatch.setattr(app_module, "_fetch_leg_candles", fake_fetch)
    with pytest.raises(HTTPException) as exc:
        _run(expr="A / B")
    assert exc.value.status_code == 404

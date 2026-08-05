import pytest
from httpx import ASGITransport, AsyncClient

from auto_trader.api.app import app


@pytest.mark.anyio
async def test_closeness_endpoint_returns_values(monkeypatch):
    from datetime import datetime, timezone
    from auto_trader.core.models import Candle
    from auto_trader.api import deps

    def _mk(i, close):
        t = datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() + i * 60
        return Candle(time=datetime.fromtimestamp(t, tz=timezone.utc),
                      open=close, high=close + 1, low=close - 1, close=close, volume=100)

    candles = [_mk(i, 90 + i) for i in range(30)]

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, price_side):
        return candles

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    body = {
        "broker": "capital", "epic": "X", "priceSide": "mid",
        "rows": ["candle.close > 100"], "combine": "AND",
        "baseResolution": "MINUTE", "displayResolution": "MINUTE",
        "fromTime": int(candles[0].time.timestamp()),
        "toTime": int(candles[-1].time.timestamp()),
        "norm": {"basis": "volatility", "width": 2.0, "window": 5, "atrLength": 14},
        "agg": "max",
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.post("/api/expr/closeness", json=body)
    assert r.status_code == 200
    data = r.json()
    assert len(data["times"]) == len(data["values"])
    # later bars where close > 100 must be fully close
    assert data["values"][-1] == 1.0


@pytest.mark.anyio
async def test_closeness_endpoint_handles_a_chained_rule(monkeypatch):
    # The original failing rule: chained comparison (stacked-EMA idiom). It must
    # parse, validate, and return closeness values end-to-end, not a 422.
    from datetime import datetime, timezone
    from auto_trader.core.models import Candle
    from auto_trader.api import deps

    def _mk(i, close):
        t = datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() + i * 60
        return Candle(time=datetime.fromtimestamp(t, tz=timezone.utc),
                      open=close, high=close + 1, low=close - 1, close=close, volume=100)

    candles = [_mk(i, 100 + i) for i in range(80)]  # steadily rising -> EMAs stack up

    async def fake_fetch(broker, epic, resolution, bars, from_ts, to_ts, price_side):
        return candles

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    body = {
        "broker": "capital", "epic": "X", "priceSide": "mid",
        "rows": ["candle.close > EMA(9) > EMA(50)"], "combine": "AND",
        "baseResolution": "MINUTE", "displayResolution": "MINUTE",
        "fromTime": int(candles[0].time.timestamp()),
        "toTime": int(candles[-1].time.timestamp()),
        "norm": {"basis": "volatility", "width": 2.0, "window": 5, "atrLength": 14},
        "agg": "max",
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.post("/api/expr/closeness", json=body)
    assert r.status_code == 200
    data = r.json()
    assert len(data["times"]) == len(data["values"])
    # a steadily rising series ends with close above both EMAs, fully close
    assert data["values"][-1] == 1.0


@pytest.mark.anyio
async def test_closeness_endpoint_422_on_bad_expr(monkeypatch):
    from auto_trader.api import deps

    async def fake_fetch(*a, **k):
        return []

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    body = {
        "broker": "capital", "epic": "X", "priceSide": "mid",
        "rows": ["candle.close >>> 100"], "combine": "AND",
        "baseResolution": "MINUTE", "displayResolution": "MINUTE",
        "fromTime": 0, "toTime": 60,
        "norm": {"basis": "volatility", "width": 2.0, "window": 5, "atrLength": 14},
        "agg": "max",
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.post("/api/expr/closeness", json=body)
    assert r.status_code == 422


@pytest.mark.anyio
async def test_closeness_endpoint_422_on_bars_since_entry_in_non_exit_row(monkeypatch):
    # /api/expr/closeness always validates rows as non-exit (is_exit=False), so a
    # count(...) predicate keyed on barsSinceEntry must be rejected at validate()
    # before it ever reaches series_of/group_closeness -- which raises a bare
    # ValueError for barsSinceEntry and would otherwise 500 instead of 422.
    from auto_trader.api import deps

    async def fake_fetch(*a, **k):
        return []

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)
    body = {
        "broker": "capital", "epic": "X", "priceSide": "mid",
        "rows": ["count(bearish(candle), barsSinceEntry) >= 3"], "combine": "AND",
        "baseResolution": "MINUTE", "displayResolution": "MINUTE",
        "fromTime": 0, "toTime": 60,
        "norm": {"basis": "volatility", "width": 2.0, "window": 5, "atrLength": 14},
        "agg": "max",
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.post("/api/expr/closeness", json=body)
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "entry_in_entry_rule"

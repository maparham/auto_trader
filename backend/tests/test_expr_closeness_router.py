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

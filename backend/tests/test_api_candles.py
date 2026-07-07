"""GET /api/candles — seconds-branch regression.

Guards the `_fetch_symbol_candles` extraction (task 2, synthetic charts): the
seconds (tick-store) branch must keep returning an empty 200 for an epic with
no tick history yet (not currently streamed), never a 404 — only the
native/derived branches 404 on "no data at all". Direct-call convention per
test_api_backtest.py (no pytest-asyncio in this repo).
"""

from __future__ import annotations

import asyncio

import auto_trader.api.app as app_module


def test_seconds_resolution_empty_tick_store_returns_empty_not_404(monkeypatch):
    async def fake_bars(broker, epic, bucket_seconds, count):
        return []

    monkeypatch.setattr(app_module.TICK_STORE, "bars", fake_bars)

    async def scenario():
        return await app_module.candles(
            epic="UNSTREAMED",
            resolution="SECOND_5",
            bars=500,
            from_ts=None,
            to_ts=None,
            price_side="mid",
            broker_id="capital",
        )

    result = asyncio.run(scenario())
    assert result == []

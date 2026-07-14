"""Prefill CLI: drives cache.recent + backfill_below with a fake broker over a
temp cache db, so no network and no real dukascopy import is needed."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from auto_trader.core.candle_cache import CandleCache
from auto_trader.core.models import Candle, Resolution
from scripts.dukascopy_import import prefill


class FakeBroker:
    """Returns 1-minute bars for any requested [start, end], newest-inclusive."""

    async def get_recent_candles(self, epic, resolution, count, price_side="mid"):
        now = int(datetime.now(timezone.utc).timestamp()) // 60 * 60
        return [
            Candle(
                time=datetime.fromtimestamp(now - 60 * (count - 1 - i), tz=timezone.utc),
                open=1.0,
                high=1.0,
                low=1.0,
                close=1.0,
                volume=1.0,
            )
            for i in range(count)
        ]

    async def get_candles(self, epic, resolution, start, end, price_side="mid"):
        s = int(start.timestamp()) // 60 * 60
        e = int(end.timestamp()) // 60 * 60
        out = []
        t = s
        while t <= e:
            out.append(
                Candle(
                    time=datetime.fromtimestamp(t, tz=timezone.utc),
                    open=1.0,
                    high=1.0,
                    low=1.0,
                    close=1.0,
                    volume=1.0,
                )
            )
            t += 60
        return out


def test_prefill_fills_down_to_target(tmp_path):
    cache = CandleCache(str(tmp_path / "cache.db"))
    broker = FakeBroker()
    now = int(datetime.now(timezone.utc).timestamp())
    target = (now // 60 * 60) - 60 * 500  # 500 minutes back

    status = asyncio.run(
        prefill(cache, broker, "EURUSD", Resolution.MINUTE, "mid", target, seed_count=50)
    )

    assert status in ("target", "floor")
    key = ("dukascopy", "EURUSD", "MINUTE", "mid")
    cov = cache._coverage(key)
    assert cov is not None
    assert cov[0] <= target + 60  # reached (within one bar of) the target

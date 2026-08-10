"""Unit tests for the Nobitex data-only broker. All network calls are mocked."""

import asyncio
from datetime import datetime, timezone

import httpx
import pytest

from auto_trader.core.models import Resolution


def _udf(ts, closes=None, s="ok"):
    """Minimal UDF payload: toman prices, per-bar volume 7.5."""
    n = len(ts)
    closes = closes or [186000.0 + i for i in range(n)]
    return {
        "s": s,
        "t": list(ts),
        "o": [c - 100 for c in closes],
        "h": [c + 200 for c in closes],
        "l": [c - 300 for c in closes],
        "c": list(closes),
        "v": [7.5] * n,
    }


def test_udf_no_data_is_empty():
    from auto_trader.brokers.nobitex import _udf_to_candles

    assert _udf_to_candles({"s": "no_data"}, Resolution.HOUR) == []


def test_udf_scales_toman_to_rial_not_volume():
    from auto_trader.brokers.nobitex import _udf_to_candles

    now = datetime(2026, 8, 10, tzinfo=timezone.utc)
    ts = [int(datetime(2026, 8, 9, 10, 0, tzinfo=timezone.utc).timestamp())]
    candles = _udf_to_candles(_udf(ts, closes=[186065.0]), Resolution.HOUR, now=now)
    assert len(candles) == 1
    c = candles[0]
    assert c.close == 1860650.0        # x10: toman -> rial
    assert c.open == 1859650.0
    assert c.volume == 7.5             # volume unscaled (base-asset units)
    assert c.time == datetime(2026, 8, 9, 10, 0, tzinfo=timezone.utc)


def test_udf_drops_forming_bar():
    from auto_trader.brokers.nobitex import _udf_to_candles

    now = datetime(2026, 8, 9, 10, 30, tzinfo=timezone.utc)
    ts = [
        int(datetime(2026, 8, 9, 9, 0, tzinfo=timezone.utc).timestamp()),
        int(datetime(2026, 8, 9, 10, 0, tzinfo=timezone.utc).timestamp()),  # forming
    ]
    candles = _udf_to_candles(_udf(ts), Resolution.HOUR, now=now)
    assert [c.time.hour for c in candles] == [9]


def test_udf_daily_restamped_to_utc_midnight_of_tehran_date():
    from auto_trader.brokers.nobitex import _udf_to_candles

    now = datetime(2026, 8, 12, tzinfo=timezone.utc)
    # Nobitex daily bar for Tehran-date 2026-08-10 opens 2026-08-09 20:30 UTC
    ts = [int(datetime(2026, 8, 9, 20, 30, tzinfo=timezone.utc).timestamp())]
    candles = _udf_to_candles(_udf(ts), Resolution.DAY, now=now)
    assert candles[0].time == datetime(2026, 8, 10, tzinfo=timezone.utc)


def test_chunks_cover_range_without_oversized_requests():
    from auto_trader.brokers.nobitex import _chunks

    spans = list(_chunks(0, 1000 * 60, 60, max_bars=450))
    assert spans[0][0] == 0 and spans[-1][1] == 60000
    # contiguous, no gaps/overlap
    assert all(a[1] == b[0] for a, b in zip(spans, spans[1:]))
    assert all((e - s) // 60 <= 450 for s, e in spans)

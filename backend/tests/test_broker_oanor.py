"""Unit tests for the oanor IRR data-only broker. All network calls are mocked."""

import asyncio
from datetime import datetime, timezone

import httpx
import pytest

from auto_trader.core.models import Resolution


def test_oanor_settings_gate():
    from auto_trader.config import OanorSettings

    assert OanorSettings(api_key="", _env_file=None).has() is False
    s = OanorSettings(api_key="oanor_live_xyz", _env_file=None)
    assert s.has() is True
    assert s.base_url == "https://api.oanor.com/irr-api"


def _row(date, o=1785100, h=1785200, low=1757800, c=1758050):
    return {"date": date, "open": o, "high": h, "low": low, "close": c,
            "date_jalali": "1405/03/20"}


def test_parse_date_gregorian_slash_format():
    from auto_trader.brokers.oanor import _parse_date

    assert _parse_date("2026/06/10") == datetime(2026, 6, 10, tzinfo=timezone.utc)
    with pytest.raises(ValueError):
        _parse_date("1405/13/40")


def test_rows_to_candles_ascending_closed_only():
    from auto_trader.brokers.oanor import _rows_to_candles

    now = datetime(2026, 6, 10, 12, 0, tzinfo=timezone.utc)
    rows = [_row("2026/06/10"), _row("2026/06/09"), _row("2026/06/08")]  # newest-first
    candles = _rows_to_candles(rows, now=now)
    # 06-10 is still forming at noon UTC → dropped; remainder ascending
    assert [c.time.day for c in candles] == [8, 9]
    c = candles[-1]
    assert (c.open, c.high, c.low, c.close, c.volume) == (
        1785100.0, 1785200.0, 1757800.0, 1758050.0, 0.0)


def test_rows_to_candles_drops_zero_and_missing_ohlc():
    from auto_trader.brokers.oanor import _rows_to_candles

    now = datetime(2026, 6, 20, tzinfo=timezone.utc)
    rows = [
        _row("2026/06/09", o=0),                      # zero open → dropped
        {"date": "2026/06/08", "open": 1, "high": 2},  # missing low/close → dropped
        _row("2026/06/07"),
    ]
    candles = _rows_to_candles(rows, now=now)
    assert [c.time.day for c in candles] == [7]

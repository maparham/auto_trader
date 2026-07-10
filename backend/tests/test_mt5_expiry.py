"""MT5/MetaApi expiration options: ORDER_TIME_SPECIFIED + a tz-aware datetime
passed through untouched (the SDK serializes it). None = no options (GTC)."""

from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.brokers.mt5 import _mt5_expiration


def test_none_gives_no_options() -> None:
    assert _mt5_expiration(None) is None


def test_datetime_builds_specified_option() -> None:
    when = datetime(2026, 7, 11, 16, 0, tzinfo=timezone.utc)
    opts = _mt5_expiration(when)
    assert opts == {"expiration": {"type": "ORDER_TIME_SPECIFIED", "time": when}}

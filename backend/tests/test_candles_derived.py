"""Integration tests for the /api/candles derived-timeframe path.

These exercise the real cache + snap + fold pipeline the handler runs (without
the HTTP/broker layer), mirroring the fake-fetcher pattern in test_candle_cache.
"""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone

from auto_trader.core.candle_aggregate import DERIVED, bucket_end, bucket_open, fold
from auto_trader.core.candle_cache import CandleCache
from auto_trader.core.models import Candle

DAY = 86400


def _day(y, m, d, o, h, l, c, v=1.0):
    return Candle(datetime(y, m, d, tzinfo=timezone.utc), o, h, l, c, v)


def _ts(y, m, d):
    return int(datetime(y, m, d, tzinfo=timezone.utc).timestamp())


def test_fold_matches_handler_contract():
    # The recent() branch returns exactly fold(base_bars, rule); anchor that.
    days = [_day(2026, 3, i, 10 + i, 20, 5, 10 + i) for i in range(1, 6)]
    out = fold(days, DERIVED["MONTH"])
    assert len(out) == 1
    assert out[0].open == 11 and out[0].high == 20 and out[0].low == 5


def _all_feb_days():
    # February 2026 has 28 days; give day 14 the extreme high/low so a partial
    # window that excludes it would produce a WRONG month bar.
    bars = []
    for d in range(1, 29):
        hi = 99 if d != 14 else 200
        lo = 50 if d != 14 else 1
        bars.append(_day(2026, 2, d, 60, hi, lo, 70))
    return bars


class _Fetcher:
    def __init__(self, bars):
        self._bars = sorted(bars, key=lambda b: b.time)
        self.range_calls = []

    async def range(self, start, end):
        s, e = int(start.timestamp()), int(end.timestamp())
        self.range_calls.append((s, e))
        return [b for b in self._bars if s <= int(b.time.timestamp()) <= e]


def _window_like_handler(cache, key, rule, from_ts, to_ts, fetcher, now):
    # Mirror the handler's snap: outward to whole bucket boundaries.
    start = datetime.fromtimestamp(bucket_open(from_ts, rule), tz=timezone.utc)
    end = datetime.fromtimestamp(bucket_end(to_ts, rule) - 1, tz=timezone.utc)
    base = asyncio.run(
        cache.window(key, DERIVED["MONTH"].base.seconds, start, end, fetcher.range, now=now)
    )
    return fold(base, rule)


def test_window_cutting_mid_month_returns_complete_month(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    key = ("capital", "EURUSD", "DAY", "mid")
    fetcher = _Fetcher(_all_feb_days())
    rule = DERIVED["MONTH"]
    now = _ts(2026, 4, 1)  # all Feb bars are closed

    # Request a window that starts mid-February (day 20) — would truncate Feb
    # without the snap. The snap pulls the whole month.
    out = _window_like_handler(cache, key, rule, _ts(2026, 2, 20), _ts(2026, 2, 25), fetcher, now)

    assert len(out) == 1
    feb = out[0]
    assert feb.time == datetime(2026, 2, 1, tzinfo=timezone.utc)
    # Full-month extremes (day 14) present -> snap worked.
    assert feb.high == 200 and feb.low == 1
    assert feb.open == 60 and feb.close == 70
    assert feb.volume == 28  # every day folded


def test_derived_window_caches_only_base_series(tmp_path):
    db = str(tmp_path / "c.db")
    cache = CandleCache(db)
    key = ("capital", "EURUSD", "DAY", "mid")
    fetcher = _Fetcher(_all_feb_days())
    _window_like_handler(
        cache, key, DERIVED["MONTH"], _ts(2026, 2, 20), _ts(2026, 2, 25), fetcher, _ts(2026, 4, 1)
    )
    conn = sqlite3.connect(db)
    try:
        resolutions = {r[0] for r in conn.execute("SELECT DISTINCT resolution FROM bars")}
        cov = {r[0] for r in conn.execute("SELECT DISTINCT resolution FROM coverage")}
    finally:
        conn.close()
    # Only the native DAY base was ever written — no MONTH/derived rows.
    assert resolutions == {"DAY"}
    assert cov == {"DAY"}

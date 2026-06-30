# backend/tests/test_candle_cache.py
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from auto_trader.core.candle_cache import CandleCache
from auto_trader.core.models import Candle


def _c(ts: int, close: float) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(ts, tz=timezone.utc),
        open=close, high=close, low=close, close=close, volume=0.0,
    )


KEY = ("capital", "EURUSD", "MINUTE", "mid")


def test_store_closed_filters_forming_and_sets_coverage(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    bars = [_c(100, 1.0), _c(160, 2.0), _c(220, 3.0)]  # ts 100,160,220
    cache._store_closed(KEY, bars, cutoff_ts=220)  # 220 is forming -> excluded
    assert cache._coverage(KEY) == (100, 160)
    assert cache._cached_count(KEY) == 2
    got = cache._read_window(KEY, 0, 1000)
    assert [int(c.time.timestamp()) for c in got] == [100, 160]
    assert got[1].close == 2.0


def test_read_back_returns_most_recent_n_ascending(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(t, float(t)) for t in (100, 160, 220, 280)], cutoff_ts=10_000)
    back = cache._read_back(KEY, n=2, before_ts=10_000)
    assert [int(c.time.timestamp()) for c in back] == [220, 280]


def test_extend_coverage_unions_range(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(200, 1.0)], cutoff_ts=10_000)  # coverage (200,200)
    cache._extend_coverage(KEY, 50, 200)  # backfilled an empty gap down to 50
    assert cache._coverage(KEY) == (50, 200)


def test_coverage_none_on_empty_cache(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    assert cache._coverage(KEY) is None


def test_read_back_zero_is_empty(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    assert cache._read_back(KEY, n=0, before_ts=10_000) == []


class FakeFetcher:
    """Records calls; returns canned candles. Stand-in for the broker."""

    def __init__(self, bars: list[Candle] | None = None, error: Exception | None = None):
        self._bars = bars or []
        self._error = error
        self.range_calls: list[tuple[int, int]] = []
        self.recent_calls: list[int] = []

    async def range(self, start: datetime, end: datetime) -> list[Candle]:
        self.range_calls.append((int(start.timestamp()), int(end.timestamp())))
        if self._error:
            raise self._error
        s, e = int(start.timestamp()), int(end.timestamp())
        return [b for b in self._bars if s <= int(b.time.timestamp()) <= e]

    async def recent(self, count: int) -> list[Candle]:
        self.recent_calls.append(count)
        if self._error:
            raise self._error
        return self._bars[-count:]


def _dt(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def test_window_cold_fetches_and_stores(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.window(KEY, 60, _dt(100), _dt(280), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in out] == [100, 160, 220, 280]
    assert len(f.range_calls) == 1  # cold miss -> one fetch


def test_window_warm_hit_makes_zero_calls(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    f = FakeFetcher(src)
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(280), f.range, now=10_000))
    f.range_calls.clear()
    again = asyncio.run(cache.window(KEY, 60, _dt(160), _dt(220), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in again] == [160, 220]
    assert f.range_calls == []  # fully covered -> no fetch


def test_window_replay_backfill_fills_gap_below_oldest(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    # Warm coverage to [220, 280].
    f0 = FakeFetcher([_c(t, float(t)) for t in (220, 280)])
    asyncio.run(cache.window(KEY, 60, _dt(220), _dt(280), f0.range, now=10_000))
    # Replay jump to ts=40: must backfill the whole gap [40, 220].
    src = [_c(t, float(t)) for t in (40, 100, 160, 220, 280)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.window(KEY, 60, _dt(40), _dt(120), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in out] == [40, 100]
    # Backfill fetched down to oldest (220), not just the tiny [40,120] window.
    assert f.range_calls == [(40, 220)]
    assert cache._coverage(KEY) == (40, 280)


def test_window_empty_gap_advances_oldest_no_refetch(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    f = FakeFetcher([])  # broker has nothing in this range (closed market)
    asyncio.run(cache.window(KEY, 60, _dt(40), _dt(100), f.range, now=10_000))
    assert cache._coverage(KEY) == (40, 100)  # recorded as covered (empty)
    asyncio.run(cache.window(KEY, 60, _dt(40), _dt(100), f.range, now=10_000))
    assert len(f.range_calls) == 1  # second call served from cache, no refetch


def test_window_serves_cache_when_fetch_errors(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    # Seed bars + coverage directly: coverage becomes (100, 220).
    cache._store_closed(KEY, [_c(t, float(t)) for t in (100, 160, 220)], cutoff_ts=10_000)
    # Request [40, 160]: from_ts=40 < oldest=100 -> MISS -> fetch_range(40,100) is called and throws.
    boom = FakeFetcher(error=RuntimeError("breaker open"))
    out = asyncio.run(cache.window(KEY, 60, _dt(40), _dt(160), boom.range, now=10_000))
    assert boom.range_calls == [(40, 100)]          # the fetch WAS attempted (error path entered)
    assert [int(c.time.timestamp()) for c in out] == [100, 160]  # cache served despite the error


def test_window_reraises_when_cache_empty_and_fetch_errors(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    boom = FakeFetcher(error=RuntimeError("breaker open"))
    try:
        asyncio.run(cache.window(KEY, 60, _dt(100), _dt(160), boom.range, now=10_000))
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert str(e) == "breaker open"

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


def test_stats_empty_series_has_none_watermarks_and_zero_counts(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    stats = cache.stats(KEY)
    assert stats == {
        "oldest_ts": None,
        "newest_ts": None,
        "cached_bar_count": 0,
        "hits": 0,
        "misses": 0,
        "last_fetch_ts": None,
    }


def test_stats_reflects_coverage_and_count(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(100, 1.0), _c(160, 2.0)], cutoff_ts=10_000)
    stats = cache.stats(KEY)
    assert stats["oldest_ts"] == 100
    assert stats["newest_ts"] == 160
    assert stats["cached_bar_count"] == 2


def test_global_stats_sums_across_series(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    other_key = ("capital", "GBPUSD", "MINUTE", "mid")
    cache._store_closed(KEY, [_c(100, 1.0)], cutoff_ts=10_000)
    cache._store_closed(other_key, [_c(100, 1.0), _c(160, 2.0)], cutoff_ts=10_000)
    cache._record_hit(KEY)
    cache._record_hit(other_key)
    cache._record_miss(other_key)
    gstats = cache.global_stats()
    assert gstats["total_hits"] == 2
    assert gstats["total_misses"] == 1
    assert gstats["db_size_bytes"] > 0


def test_global_stats_scans_no_table(tmp_path, monkeypatch):
    """The popover's 6s budget only holds because global_stats() never queries.
    A row-scan here (e.g. a reinstated `SELECT COUNT(*) FROM bars`) took ~14s on a
    real ~750MB db, which zeroed every field in the UI. Guard the O(1) property."""
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(100, 1.0)], cutoff_ts=10_000)

    def _boom():
        raise AssertionError("global_stats() must not open a db connection")

    monkeypatch.setattr(cache, "_connect", _boom)
    assert cache.global_stats()["db_size_bytes"] > 0


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


class ChunkRecordingFetcher:
    """Serves canned bars, but fails after `fail_after` successful range calls.
    Records every requested span so a test can assert per-call sizes."""

    def __init__(self, bars: list[Candle], fail_after: int | None = None):
        self._bars = bars
        self._fail_after = fail_after
        self.range_calls: list[tuple[int, int]] = []

    async def range(self, start: datetime, end: datetime) -> list[Candle]:
        s, e = int(start.timestamp()), int(end.timestamp())
        self.range_calls.append((s, e))
        if self._fail_after is not None and len(self.range_calls) > self._fail_after:
            raise RuntimeError("dukascopy timed out")
        return [b for b in self._bars if s <= int(b.time.timestamp()) <= e]


def test_window_chunks_large_backfill_no_call_exceeds_cap(tmp_path):
    """A months-long backfill must be split into bounded broker calls so an
    erratically-slow source can't blow the breaker's per-call timeout on one giant
    fetch. Every call stays within the chunk cap, and the final result + coverage
    are identical to the single-fetch behavior."""
    cache = CandleCache(str(tmp_path / "c.db"))
    # res=100s, chunk cap = 3 bars -> 300s per call. Gap [1000, 3000] = 2000s needs
    # multiple chunks (2000 / 300 ~= 7 calls).
    src = [_c(t, float(t)) for t in range(1000, 3100, 100)]  # bars 1000..3000
    f = ChunkRecordingFetcher(src)
    out = asyncio.run(
        cache.window(KEY, 100, _dt(1000), _dt(3000), f.range, now=10_000, chunk_bars=3)
    )
    assert [int(c.time.timestamp()) for c in out] == list(range(1000, 3001, 100))
    assert len(f.range_calls) > 1, "large gap should be chunked, not one fetch"
    assert all((e - s) <= 3 * 100 for s, e in f.range_calls), f.range_calls
    # Contiguous single segment covering the whole requested span.
    assert cache._coverage(KEY) == (1000, 3000)


def test_window_chunk_failure_keeps_coverage_contiguous_no_hole(tmp_path):
    """If a chunk fails mid-gap, coverage must extend only down to the last
    successful (contiguous-with-oldest) chunk, never leaving a hole marked
    covered. A re-request then resumes from there and closes the gap."""
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in range(1000, 3100, 100)]  # bars 1000..3000
    # Warm coverage to [2500, 3000] so backfill walks DOWN from oldest=2500.
    warm = ChunkRecordingFetcher(src)
    asyncio.run(cache.window(KEY, 100, _dt(2500), _dt(3000), warm.range, now=10_000))
    assert cache._coverage(KEY) == (2500, 3000)

    # Succeed on the first 2 chunks (top of the gap), then fail. chunk cap 3 bars.
    f = ChunkRecordingFetcher(src, fail_after=2)
    asyncio.run(
        cache.window(KEY, 100, _dt(1000), _dt(2500), f.range, now=10_000, chunk_bars=3)
    )
    cov = cache._coverage(KEY)
    # Top stays 3000; oldest moved DOWN but only as far as the successful chunks
    # reached (not to 1000), and it is still one contiguous segment (no hole).
    assert cov is not None and cov[1] == 3000
    assert 1000 < cov[0] < 2500, cov
    reached = cov[0]
    # Every bar from the new oldest up to 3000 is actually present (contiguous).
    got = cache._read_window(KEY, reached, 3000)
    assert [int(c.time.timestamp()) for c in got] == list(range(reached, 3001, 100))

    # Retry with a healthy fetcher: it resumes from `reached` and closes the gap.
    ok = ChunkRecordingFetcher(src)
    asyncio.run(
        cache.window(KEY, 100, _dt(1000), _dt(2500), ok.range, now=10_000, chunk_bars=3)
    )
    assert cache._coverage(KEY) == (1000, 3000)
    assert all(s >= 1000 and e <= reached for s, e in ok.range_calls), ok.range_calls


def test_window_raises_when_partial_backfill_does_not_reach_window(tmp_path):
    """Scroll-back requests a window at the BOTTOM of the gap while chunks fill
    top-down. If the backfill errors before reaching that window, the call must
    RAISE (5xx) — not return an empty 200 that the frontend can't tell apart from
    end-of-history and would latch on. Progress (the landed top chunks) still
    persists so the retry resumes deeper."""
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in range(1000, 3100, 100)]
    # Warm coverage to [2500, 3000]; backfill walks DOWN from oldest=2500.
    asyncio.run(cache.window(KEY, 100, _dt(2500), _dt(3000), ChunkRecordingFetcher(src).range, now=10_000))
    # Request a window far below coverage; only the first (top) chunk succeeds.
    f = ChunkRecordingFetcher(src, fail_after=1)
    try:
        asyncio.run(
            cache.window(KEY, 100, _dt(1000), _dt(1300), f.range, now=10_000, chunk_bars=3)
        )
        assert False, "expected the unreached-window error to propagate, not an empty 200"
    except RuntimeError as e:
        assert str(e) == "dukascopy timed out"
    # The one chunk that landed is persisted + covered (progress survives for retry).
    cov = cache._coverage(KEY)
    assert cov is not None and 1300 < cov[0] < 2500 and cov[1] == 3000, cov


def test_window_fills_gap_above_newest(tmp_path):
    """A window ABOVE the newest watermark (an API client walking history
    forward) must fetch the forward gap, not silently return whatever's cached
    (historically: nothing — an empty 200 indistinguishable from no-data)."""
    cache = CandleCache(str(tmp_path / "c.db"))
    f0 = FakeFetcher([_c(t, float(t)) for t in (100, 160)])
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(160), f0.range, now=10_000))
    assert cache._coverage(KEY) == (100, 160)
    src = [_c(t, float(t)) for t in (100, 160, 220, 280, 340)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.window(KEY, 60, _dt(220), _dt(340), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in out] == [220, 280, 340]
    # One contiguous segment grown upward through the gap — no hole.
    assert cache._coverage(KEY) == (100, 340)
    # And a re-request is a pure cache hit.
    f.range_calls.clear()
    again = asyncio.run(cache.window(KEY, 60, _dt(220), _dt(340), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in again] == [220, 280, 340]
    assert f.range_calls == []


def test_window_straddling_both_gaps_fills_below_and_above(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    f0 = FakeFetcher([_c(t, float(t)) for t in (160, 220)])
    asyncio.run(cache.window(KEY, 60, _dt(160), _dt(220), f0.range, now=10_000))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.window(KEY, 60, _dt(100), _dt(280), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in out] == [100, 160, 220, 280]
    assert cache._coverage(KEY) == (100, 280)


def test_window_above_gap_never_extends_past_cutoff(tmp_path):
    """The forward fill must not push the newest watermark past the closed-bar
    cutoff: the forming bar stays re-fetchable (same rule as a cold fill)."""
    cache = CandleCache(str(tmp_path / "c.db"))
    f0 = FakeFetcher([_c(t, float(t)) for t in (100, 160)])
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(160), f0.range, now=10_000))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    f = FakeFetcher(src)
    # now=300 -> cutoff=bucket_start(300, 60)=300; request reaches past it.
    asyncio.run(cache.window(KEY, 60, _dt(220), _dt(400), f.range, now=300))
    cov = cache._coverage(KEY)
    assert cov is not None and cov[1] <= 300, cov


def test_window_above_gap_chunk_failure_keeps_coverage_contiguous(tmp_path):
    """A mid-gap failure while filling UPWARD must leave coverage claiming only
    what actually landed (contiguous with the old newest), so the retry resumes
    instead of a hole being marked covered."""
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in range(1000, 3100, 100)]
    asyncio.run(cache.window(KEY, 100, _dt(1000), _dt(1500), ChunkRecordingFetcher(src).range, now=10_000))
    assert cache._coverage(KEY) == (1000, 1500)
    # Forward gap [1500, 3000]; only the first 2 bottom chunks (3 bars each) land.
    f = ChunkRecordingFetcher(src, fail_after=2)
    asyncio.run(cache.window(KEY, 100, _dt(1600), _dt(3000), f.range, now=10_000, chunk_bars=3))
    cov = cache._coverage(KEY)
    assert cov is not None and cov[0] == 1000 and 1500 < cov[1] < 3000, cov
    got = cache._read_window(KEY, 1000, cov[1])
    assert [int(c.time.timestamp()) for c in got] == list(range(1000, cov[1] + 1, 100))
    # Retry with a healthy fetcher resumes from the new newest and completes.
    ok = ChunkRecordingFetcher(src)
    asyncio.run(cache.window(KEY, 100, _dt(1600), _dt(3000), ok.range, now=10_000, chunk_bars=3))
    assert cache._coverage(KEY) == (1000, 3000)
    assert all(s >= cov[1] for s, _e in ok.range_calls), ok.range_calls


class OutageAboveFetcher:
    """Broker whose forward (at-or-above `down_from_ts`) calls fail — e.g. the live
    edge is unreachable — while historical (below) ranges still serve. Models the
    common outage shape where cached history exists but the tail can't be topped up
    (here the 'history' still comes from the fetcher: a real outage fails both, but
    a single fetcher can't show the downward walk ran unless it serves it)."""

    def __init__(self, bars: list[Candle], down_from_ts: int):
        self._bars = bars
        self._down_from = down_from_ts
        self.range_calls: list[tuple[int, int]] = []

    async def range(self, start: datetime, end: datetime) -> list[Candle]:
        s, e = int(start.timestamp()), int(end.timestamp())
        self.range_calls.append((s, e))
        if s >= self._down_from:
            raise RuntimeError("broker offline")
        return [b for b in self._bars if s <= int(b.time.timestamp()) <= e]


def test_window_forward_topup_failure_still_backfills_below(tmp_path):
    """A failed forward top-up (live edge unreachable) must not abort the downward
    backfill: a window straddling both gaps still gets its below-oldest history,
    instead of a silently truncated read of just the old coverage."""
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in range(1000, 2600, 100)]
    # Warm coverage to [2000, 2500].
    asyncio.run(cache.window(KEY, 100, _dt(2000), _dt(2500), FakeFetcher(src).range, now=10_000))
    assert cache._coverage(KEY) == (2000, 2500)
    # Request [1000, 2800]: forward fill (>=2500) fails, downward (<2000) serves.
    f = OutageAboveFetcher(src, down_from_ts=2500)
    out = asyncio.run(cache.window(KEY, 100, _dt(1000), _dt(2800), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in out] == list(range(1000, 2501, 100))
    assert cache._coverage(KEY) == (1000, 2500)


def test_window_degraded_set_when_fetch_fails_and_cache_serves(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(t, float(t)) for t in (100, 160, 220)], cutoff_ts=10_000)
    boom = FakeFetcher(error=RuntimeError("breaker open"))
    degraded: dict = {}
    out = asyncio.run(
        cache.window(KEY, 60, _dt(40), _dt(160), boom.range, now=10_000, degraded=degraded)
    )
    assert [int(c.time.timestamp()) for c in out] == [100, 160]
    assert degraded.get("reason") == "breaker open"


def test_window_degraded_unset_on_hit_and_on_successful_fetch(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    degraded: dict = {}
    # Cold fill (successful fetch): not degraded.
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(280), FakeFetcher(src).range, now=10_000, degraded=degraded))
    assert degraded == {}
    # Pure cache hit: not degraded.
    asyncio.run(cache.window(KEY, 60, _dt(160), _dt(220), FakeFetcher(src).range, now=10_000, degraded=degraded))
    assert degraded == {}


def test_window_not_degraded_when_only_forming_bar_unreachable(tmp_path):
    """Every closed bar of the window is cached; the failed forward fetch could
    only have supplied the forming bar (never cached anyway). The payload is
    complete, so it must NOT be marked degraded — a false mark here puts the
    outage pill + retry loop on every to_ts=now request during an outage."""
    cache = CandleCache(str(tmp_path / "c.db"))
    # res=60, now=2000 -> cutoff=1980, last closed bar ts=1920. Cache all of it.
    cache._store_closed(KEY, [_c(t, float(t)) for t in range(960, 1921, 60)], cutoff_ts=1980)
    assert cache._coverage(KEY) == (960, 1920)
    boom = FakeFetcher(error=RuntimeError("broker offline"))
    degraded: dict = {}
    out = asyncio.run(
        cache.window(KEY, 60, _dt(960), _dt(2000), boom.range, now=2000, degraded=degraded)
    )
    assert len(boom.range_calls) == 1  # the forward top-up WAS attempted and failed
    assert [int(c.time.timestamp()) for c in out] == list(range(960, 1921, 60))
    assert degraded == {}


def test_window_degraded_when_closed_tail_missing(tmp_path):
    """Same shape, but the cached tail is genuinely short (stale cache): the
    failed forward fetch left real closed bars unserved -> degraded."""
    cache = CandleCache(str(tmp_path / "c.db"))
    # Cache stops at 1500; closed bars 1560..1920 exist upstream but are unreachable.
    cache._store_closed(KEY, [_c(t, float(t)) for t in range(960, 1501, 60)], cutoff_ts=1980)
    boom = FakeFetcher(error=RuntimeError("broker offline"))
    degraded: dict = {}
    out = asyncio.run(
        cache.window(KEY, 60, _dt(960), _dt(2000), boom.range, now=2000, degraded=degraded)
    )
    assert [int(c.time.timestamp()) for c in out] == list(range(960, 1501, 60))
    assert degraded.get("reason") == "broker offline"


def test_recent_degraded_set_when_fetch_fails_and_cache_serves(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    asyncio.run(cache.recent(KEY, 60, 4, FakeFetcher(src).recent, tail=3, now=280))
    boom = FakeFetcher(error=RuntimeError("offline"))
    degraded: dict = {}
    out = asyncio.run(cache.recent(KEY, 60, 3, boom.recent, tail=3, now=340, degraded=degraded))
    assert [int(c.time.timestamp()) for c in out] == [100, 160, 220]
    assert degraded.get("reason") == "offline"


def test_recent_degraded_unset_on_successful_fetch(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    degraded: dict = {}
    asyncio.run(cache.recent(KEY, 60, 4, FakeFetcher(src).recent, tail=3, now=280, degraded=degraded))
    assert degraded == {}


def test_recent_cold_fetches_full_and_returns_with_forming(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    # ts 280 is the forming bar (>= cutoff 240); 100/160/220 are closed.
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    f = FakeFetcher(src)
    out = asyncio.run(cache.recent(KEY, 60, 4, f.recent, tail=3, now=280))
    assert [int(c.time.timestamp()) for c in out] == [100, 160, 220, 280]  # forming kept
    assert f.recent_calls == [4]  # cold -> one full fetch
    assert cache._cached_count(KEY) == 3  # only the 3 closed bars stored


def test_recent_warm_makes_one_tail_call_and_appends_forming(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    asyncio.run(cache.recent(KEY, 60, 4, FakeFetcher(src).recent, tail=3, now=280))
    # Warm: forming bar now at 340 (>= cutoff 300); 280 is closed and newly fetched.
    tail_src = [_c(t, float(t)) for t in (220, 280, 340)]
    f = FakeFetcher(tail_src)
    out = asyncio.run(cache.recent(KEY, 60, 4, f.recent, tail=3, now=340))
    assert f.recent_calls == [3]  # only the small tail, not a full 4
    assert [int(c.time.timestamp()) for c in out] == [160, 220, 280, 340]  # closed+forming
    assert cache._cached_count(KEY) == 4  # 280 now stored as closed


def test_recent_serves_cache_when_fetch_errors(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    asyncio.run(cache.recent(KEY, 60, 4, FakeFetcher(src).recent, tail=3, now=280))
    boom = FakeFetcher(error=RuntimeError("offline"))
    out = asyncio.run(cache.recent(KEY, 60, 3, boom.recent, tail=3, now=340))
    assert [int(c.time.timestamp()) for c in out] == [100, 160, 220]  # cache served


def test_recent_serves_cache_when_fetch_is_slow_then_absorbs(tmp_path):
    """A tail fetch that blows the budget must not block the response: serve the
    cached bars immediately, then absorb the late result into the cache when it
    lands (coverage advances)."""
    cache = CandleCache(str(tmp_path / "c.db"), tail_fetch_budget=0.05)
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    asyncio.run(cache.recent(KEY, 60, 4, FakeFetcher(src).recent, tail=3, now=340))
    release = asyncio.Event()

    async def slow_recent(n: int) -> list[Candle]:
        await release.wait()
        return [_c(340, 340.0)]

    async def run():
        out = await cache.recent(KEY, 60, 3, slow_recent, tail=3, now=400)
        # Budget expired -> cached bars served, not the in-flight fetch.
        assert [int(c.time.timestamp()) for c in out] == [160, 220, 280]
        # Serving from cache is a hit; the stats endpoint must not show a
        # persistently slow series as having zero activity.
        assert cache.stats(KEY)["hits"] == 1
        release.set()
        for _ in range(200):  # background absorb is async; poll briefly
            if (cache._coverage(KEY) or (0, 0))[1] >= 340:
                break
            await asyncio.sleep(0.01)
        assert cache._coverage(KEY) == (100, 340)

    asyncio.run(run())


def test_absorb_late_stores_bars_closed_after_request_cutoff(tmp_path):
    """A late tail fetch can land after the bar that was forming at request time
    has closed. The absorb must evaluate closed-ness at ABSORB time, not with the
    request's cutoff, or those bars are dropped as 'forming' and coverage never
    advances (the series would never converge)."""
    cache = CandleCache(str(tmp_path / "c.db"), tail_fetch_budget=0.05)
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    asyncio.run(cache.recent(KEY, 60, 4, FakeFetcher(src).recent, tail=3, now=340))
    release = asyncio.Event()

    async def slow_recent(n: int) -> list[Candle]:
        await release.wait()
        # 400 closed after the request's cutoff (360) but before the absorb runs.
        return [_c(340, 340.0), _c(400, 400.0)]

    async def run():
        out = await cache.recent(KEY, 60, 3, slow_recent, tail=3, now=400)
        assert [int(c.time.timestamp()) for c in out] == [160, 220, 280]
        release.set()
        for _ in range(200):
            if (cache._coverage(KEY) or (0, 0))[1] >= 400:
                break
            await asyncio.sleep(0.01)
        assert cache._coverage(KEY) == (100, 400)

    asyncio.run(run())


def test_recent_fetch_own_timeout_error_takes_error_path(tmp_path, caplog):
    """A fetch that FAILS with a TimeoutError (broker read timeout) is not a
    budget expiry: it must take the fetch-error path (serve cache, no background
    absorb of the already-failed task)."""
    import logging

    cache = CandleCache(str(tmp_path / "c.db"), tail_fetch_budget=5.0)
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    asyncio.run(cache.recent(KEY, 60, 4, FakeFetcher(src).recent, tail=3, now=340))
    boom = FakeFetcher(error=TimeoutError("broker read timeout"))

    async def run():
        out = await cache.recent(KEY, 60, 3, boom.recent, tail=3, now=400)
        assert [int(c.time.timestamp()) for c in out] == [160, 220, 280]
        await asyncio.sleep(0.02)  # let a (wrongly) spawned absorb task run

    with caplog.at_level(logging.WARNING):
        asyncio.run(run())
    assert "late tail fetch" not in caplog.text


def test_recent_skips_refetch_while_absorb_in_flight(tmp_path):
    """While a late absorb for the key is still running, new recent() calls must
    not launch further broker fetches for the same data (thundering herd): serve
    the cache directly until the absorb lands."""
    cache = CandleCache(str(tmp_path / "c.db"), tail_fetch_budget=0.05)
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    asyncio.run(cache.recent(KEY, 60, 4, FakeFetcher(src).recent, tail=3, now=340))
    release = asyncio.Event()
    calls = 0

    async def slow_recent(n: int) -> list[Candle]:
        nonlocal calls
        calls += 1
        await release.wait()
        return [_c(340, 340.0)]

    async def run():
        await cache.recent(KEY, 60, 3, slow_recent, tail=3, now=400)
        assert calls == 1
        out = await cache.recent(KEY, 60, 3, slow_recent, tail=3, now=400)
        assert calls == 1  # no second fetch while the first absorb is in flight
        assert [int(c.time.timestamp()) for c in out] == [160, 220, 280]
        release.set()
        for _ in range(200):
            if (cache._coverage(KEY) or (0, 0))[1] >= 340:
                break
            await asyncio.sleep(0.01)

    asyncio.run(run())


def test_recent_waits_out_slow_fetch_when_cache_empty(tmp_path):
    """No cached bars to fall back on -> keep waiting for the slow fetch instead
    of failing at the budget."""
    cache = CandleCache(str(tmp_path / "c.db"), tail_fetch_budget=0.05)

    async def slow_recent(n: int) -> list[Candle]:
        await asyncio.sleep(0.15)  # well past the budget
        return [_c(100, 1.0), _c(160, 2.0)]

    out = asyncio.run(cache.recent(KEY, 60, 2, slow_recent, tail=3, now=220))
    assert [int(c.time.timestamp()) for c in out] == [100, 160]


def test_recent_cancelled_request_still_absorbs_fetch(tmp_path):
    """Client gave up (request task cancelled) while a slow cold fetch was in
    flight: the fetch must still land in the cache, or a series that always
    fetches slower than the client timeout can never converge (endless retry)."""
    cache = CandleCache(str(tmp_path / "c.db"), tail_fetch_budget=0.05)
    release = asyncio.Event()

    async def slow_recent(n: int) -> list[Candle]:
        await release.wait()
        return [_c(100, 1.0), _c(160, 2.0)]

    async def run():
        req = asyncio.create_task(cache.recent(KEY, 60, 2, slow_recent, tail=3, now=220))
        await asyncio.sleep(0.1)  # past the budget, in the empty-cache wait
        req.cancel()
        try:
            await req
        except asyncio.CancelledError:
            pass
        release.set()
        for _ in range(200):
            if cache._coverage(KEY) is not None:
                break
            await asyncio.sleep(0.01)
        assert cache._coverage(KEY) == (100, 160)

    asyncio.run(run())


def test_recent_reraises_when_cache_empty_and_fetch_errors(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    boom = FakeFetcher(error=RuntimeError("offline"))
    try:
        asyncio.run(cache.recent(KEY, 60, 4, boom.recent, tail=3, now=280))
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert str(e) == "offline"


def test_recent_warm_bridges_gap_contiguous(tmp_path):
    # Warm path must fetch enough to BRIDGE from the cached newest bar up to now, not
    # a fixed `tail`. If `now` has advanced more than `tail` bars past newest (e.g.
    # after a restart), a fixed 3-bar tail would leave a hole. Here the gap fits in
    # `count`, so the fetched block connects and coverage stays one contiguous range.
    cache = CandleCache(str(tmp_path / "c.db"))
    seed = [_c(t, float(t)) for t in range(100, 341, 60)]  # 100,160,220,280,340
    asyncio.run(cache.recent(KEY, 60, 5, FakeFetcher(seed).recent, tail=3, now=340))
    # cold: stores 100,160,220,280 (340 forming, cutoff 300); coverage (100,280); cached_n=4.
    full = [_c(t, float(t)) for t in range(100, 521, 60)]  # 100..520 contiguous
    f = FakeFetcher(full)
    out = asyncio.run(cache.recent(KEY, 60, 5, f.recent, tail=3, now=520))  # cutoff 480
    ts = [int(c.time.timestamp()) for c in out]
    assert ts == [280, 340, 400, 460, 520]  # contiguous, no hole
    assert all(ts[i + 1] - ts[i] == 60 for i in range(len(ts) - 1))
    assert f.recent_calls == [4]  # bridged to 4 bars (not a fixed tail of 3)
    assert cache._coverage(KEY) == (100, 460)  # single contiguous range, no phantom gap


def test_recent_warm_huge_gap_resets_coverage(tmp_path):
    # When the cache is so stale that `count` bars can't bridge to the cached newest
    # (e.g. days-old cache after a restart), the fresh block is genuinely disjoint.
    # Coverage must RESET to the fresh block — never union across the gap (which would
    # falsely mark thousands of unfetched bars covered and serve scroll-back holes).
    cache = CandleCache(str(tmp_path / "c.db"))
    seed = [_c(t, float(t)) for t in range(100, 341, 60)]  # 100..340
    asyncio.run(cache.recent(KEY, 60, 5, FakeFetcher(seed).recent, tail=3, now=340))
    # cache {100,160,220,280}, coverage (100,280), cached_n=4.
    recent_block = [_c(t, float(t)) for t in range(9700, 10001, 60)]  # 9700..10000
    f = FakeFetcher(recent_block)
    out = asyncio.run(cache.recent(KEY, 60, 5, f.recent, tail=3, now=10_000))  # cutoff 9960
    ts = [int(c.time.timestamp()) for c in out]
    assert ts == [9760, 9820, 9880, 9940, 10000]  # hole-free fresh block, no gap pulled in
    assert cache._coverage(KEY) == (9760, 9940)  # reset to fresh block, NOT (100, 9940)


def test_recent_warm_thin_fetch_no_orphan_splice(tmp_path):
    # A stale cache plus a THIN bridging fetch (fewer than count-1 fresh closed bars)
    # must not splice orphaned pre-gap bars into the response. After the disjoint
    # reset, reads are floored at coverage.oldest_ts, so the stranded rows are invisible.
    cache = CandleCache(str(tmp_path / "c.db"))
    seed = [_c(t, float(t)) for t in (100, 160, 220, 280)]
    asyncio.run(cache.recent(KEY, 60, 5, FakeFetcher(seed).recent, tail=3, now=340))
    # cache {100,160,220,280}, coverage (100,280), cached_n=4 -> next call is warm.
    thin = [_c(t, float(t)) for t in (9880, 9940, 10000)]  # broker returns only a thin block
    out = asyncio.run(cache.recent(KEY, 60, 5, FakeFetcher(thin).recent, tail=3, now=10_000))
    ts = [int(c.time.timestamp()) for c in out]
    assert ts == [9880, 9940, 10000]  # fresh block only; no orphaned (220, 280) spliced in
    assert cache._coverage(KEY) == (9880, 9940)


def test_same_key_calls_are_serialized(tmp_path):
    # Concurrent calls on the SAME key must not overlap their fetch+coverage critical
    # section (else a disjoint reset can race a union and silently claim an unfetched
    # gap). The per-key lock serializes them; a fetch that yields proves it.
    cache = CandleCache(str(tmp_path / "c.db"))
    active = {"n": 0, "max": 0}

    async def slow_recent(count):
        active["n"] += 1
        active["max"] = max(active["max"], active["n"])
        await asyncio.sleep(0)  # yield: an unlocked sibling would interleave here
        active["n"] -= 1
        return [_c(t, float(t)) for t in (100, 160, 220, 280)]

    async def run():
        await asyncio.gather(
            cache.recent(KEY, 60, 4, slow_recent, now=280),
            cache.recent(KEY, 60, 4, slow_recent, now=280),
        )

    asyncio.run(run())
    assert active["max"] == 1  # never two same-key fetches in flight at once


def test_different_keys_run_concurrently(tmp_path):
    # Different series must NOT serialize against each other — the lock is per-key.
    # Both fetches must be in flight at once; a barrier each waits on proves it (and a
    # 1s timeout fails the test if the lock wrongly blocked the second).
    cache = CandleCache(str(tmp_path / "c.db"))
    k2 = ("capital", "GBPUSD", "MINUTE", "mid")

    async def run():
        both_in = asyncio.Event()
        inside = {"n": 0}

        async def slow_recent(count):
            inside["n"] += 1
            if inside["n"] >= 2:
                both_in.set()  # both fetches are concurrently active
            await asyncio.wait_for(both_in.wait(), timeout=1.0)
            return [_c(t, float(t)) for t in (100, 160, 220, 280)]

        await asyncio.gather(
            cache.recent(KEY, 60, 4, slow_recent, now=280),
            cache.recent(k2, 60, 4, slow_recent, now=280),
        )

    asyncio.run(run())  # completes only if both fetches overlapped (else wait_for times out)


def test_route_window_short_circuits_repeat(tmp_path, monkeypatch):
    """The /api/candles window path serves a repeated window from cache (no 2nd
    broker call). Uses the cache directly with a counting fetcher to prove the
    short-circuit the route relies on."""
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220)]
    f = FakeFetcher(src)
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(220), f.range, now=10_000))
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(220), f.range, now=10_000))
    assert len(f.range_calls) == 1  # second window served from cache


def test_window_does_not_cover_forming_region(tmp_path):
    # A cold window whose end reaches the forming region must NOT mark that region
    # covered — else the bar forming now would be served as a permanent hole once it
    # closes. The newest watermark is capped at the closed cutoff.
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in (100, 160, 220, 280)]  # 280 is forming at now=280
    f = FakeFetcher(src)
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(280), f.range, now=280))  # cutoff=240
    assert cache._coverage(KEY)[1] <= 240  # newest capped at cutoff, not 280
    stored = [int(c.time.timestamp()) for c in cache._read_window(KEY, 0, 10_000)]
    assert 280 not in stored  # forming bar never persisted


def test_window_future_window_no_inverted_coverage(tmp_path):
    # An entirely-future window (from_ts > now) has no closed bars to store and must
    # not write an inverted (oldest > newest) coverage row.
    cache = CandleCache(str(tmp_path / "c.db"))
    f = FakeFetcher([])
    asyncio.run(cache.window(KEY, 60, _dt(300), _dt(400), f.range, now=280))  # cutoff=240
    cov = cache._coverage(KEY)
    assert cov is None or cov[0] <= cov[1]  # never inverted


def test_window_hit_increments_hits_not_misses(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(t, float(t)) for t in (100, 160, 220)], cutoff_ts=10_000)
    fetcher = FakeFetcher()
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(220), fetcher.range, now=10_000))
    stats = cache.stats(KEY)
    assert stats["hits"] == 1
    assert stats["misses"] == 0
    assert stats["last_fetch_ts"] is None  # fully served from cache, no broker call


def test_window_miss_increments_misses_and_records_last_fetch(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    fetcher = FakeFetcher(bars=[_c(t, float(t)) for t in (100, 160, 220)])
    asyncio.run(cache.window(KEY, 60, _dt(100), _dt(220), fetcher.range, now=10_000))
    stats = cache.stats(KEY)
    assert stats["misses"] == 1
    assert stats["hits"] == 0
    assert stats["last_fetch_ts"] == 10_000


def test_recent_cold_counts_as_miss(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    fetcher = FakeFetcher(bars=[_c(t, float(t)) for t in (100, 160, 220)])
    asyncio.run(cache.recent(KEY, 60, 3, fetcher.recent, now=220))
    stats = cache.stats(KEY)
    assert stats["misses"] == 1
    assert stats["hits"] == 0
    assert stats["last_fetch_ts"] == 220


def test_recent_warm_counts_as_hit(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(t, float(t)) for t in (100, 160, 220, 280)], cutoff_ts=10_000)
    fetcher = FakeFetcher(bars=[_c(340, 340.0)])
    asyncio.run(cache.recent(KEY, 60, 3, fetcher.recent, now=340, tail=1))
    stats = cache.stats(KEY)
    assert stats["hits"] == 1
    assert stats["misses"] == 0
    assert stats["last_fetch_ts"] == 340


def test_backfill_floor_defaults_false(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    assert cache._backfill_reached_floor(KEY) is False


def test_set_backfill_floor_persists_true(tmp_path):
    path = str(tmp_path / "c.db")
    cache = CandleCache(path)
    cache._set_backfill_floor(KEY)
    assert cache._backfill_reached_floor(KEY) is True
    # Survives a fresh connection (new cache instance, same file).
    assert CandleCache(path)._backfill_reached_floor(KEY) is True


def test_backfill_floor_is_per_key(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._set_backfill_floor(KEY)
    other = ("capital", "GBPUSD", "MINUTE", "mid")
    assert cache._backfill_reached_floor(other) is False


class _RangeSource:
    """Fetcher returning only bars that actually exist in `_have` within [start,end].
    Models a broker whose history has a hard floor and interior (weekend) gaps."""

    def __init__(self, have_ts: list[int], close: float = 1.0, error: Exception | None = None):
        self._have = sorted(have_ts)
        self._close = close
        self._error = error
        self.range_calls: list[tuple[int, int]] = []

    async def range(self, start, end):
        s, e = int(start.timestamp()), int(end.timestamp())
        self.range_calls.append((s, e))
        if self._error:
            raise self._error
        return [_c(t, self._close) for t in self._have if s <= t <= e]


class _OneThenError:
    """Returns a fixed block on the first range call, raises on the second. Used to
    freeze the walk after exactly one productive step so coverage can be inspected."""

    def __init__(self, bars):
        self._bars = bars
        self.calls = 0

    async def range(self, start, end):
        self.calls += 1
        if self.calls == 1:
            return list(self._bars)
        raise RuntimeError("stop after one step")


def test_backfill_cold_returns_cold_no_fetch(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    src = _RangeSource(have_ts=[100, 160])
    status = asyncio.run(
        cache.backfill_below(KEY, 60, src.range, target_oldest_ts=0, now=10_000)
    )
    assert status == "cold"
    assert src.range_calls == []  # no coverage to anchor below


def test_backfill_reaches_floor_and_sets_marker(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    # Seed a forward block so coverage.oldest = 400.
    cache._store_closed(KEY, [_c(400, 1.0), _c(460, 1.0)], cutoff_ts=10_000)
    # Broker has bars 100..400 (step 60), nothing below 100.
    src = _RangeSource(have_ts=list(range(100, 460, 60)))
    status = asyncio.run(
        cache.backfill_below(
            KEY, 60, src.range,
            target_oldest_ts=0, max_bars_per_step=2, max_empty_gap_seconds=100, now=10_000,
        )
    )
    assert status == "floor"
    assert cache._coverage(KEY)[0] == 100          # oldest stays at the deepest real bar
    assert cache._backfill_reached_floor(KEY) is True


def test_backfill_extends_only_to_returned_min_not_step_start(tmp_path):
    # Regression for the MT5 page-cap silent-hole: a step whose returned bars have a
    # min ABOVE the requested step_start must lower coverage only to that min, never
    # to step_start. Freeze after one step to inspect.
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(1000, 1.0)], cutoff_ts=100_000)  # oldest = 1000
    src = _OneThenError([_c(880, 1.0), _c(940, 1.0)])  # min 880, step_start will be 400
    status = asyncio.run(
        cache.backfill_below(
            KEY, 60, src.range,
            target_oldest_ts=0, max_bars_per_step=10, now=100_000,
        )
    )
    assert status == "error"                 # second step raised, ending the walk
    assert cache._coverage(KEY)[0] == 880    # only the deepest returned bar, NOT 400


def test_backfill_skips_interior_gap_without_false_floor(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(1200, 1.0)], cutoff_ts=100_000)  # oldest = 1200
    # Top block 1000..1120, interior 120s empty gap, bottom block 700..820; floor 700.
    have = [700, 760, 820, 1000, 1060, 1120]
    src = _RangeSource(have_ts=have)
    status = asyncio.run(
        cache.backfill_below(
            KEY, 60, src.range,
            target_oldest_ts=0, max_bars_per_step=2,
            max_empty_gap_seconds=600,  # > the 120s interior gap, < the empty run below 700
            now=100_000,
        )
    )
    assert status == "floor"
    assert cache._coverage(KEY)[0] == 700  # crossed the interior gap, reached the real floor


def test_backfill_stops_at_target_without_floor(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(1000, 1.0)], cutoff_ts=100_000)  # oldest = 1000
    src = _RangeSource(have_ts=list(range(100, 1000, 60)))  # bars all the way down
    status = asyncio.run(
        cache.backfill_below(
            KEY, 60, src.range,
            target_oldest_ts=700, max_bars_per_step=2, now=100_000,
        )
    )
    assert status == "target"
    assert cache._coverage(KEY)[0] == 700
    assert cache._backfill_reached_floor(KEY) is False  # target, not floor


def test_backfill_noop_after_floor(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(400, 1.0)], cutoff_ts=10_000)
    cache._set_backfill_floor(KEY)
    src = _RangeSource(have_ts=[100, 160, 220])
    status = asyncio.run(
        cache.backfill_below(KEY, 60, src.range, target_oldest_ts=0, now=10_000)
    )
    assert status == "floor"
    assert src.range_calls == []  # already at floor -> zero broker calls


def test_backfill_error_does_not_set_floor(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(400, 1.0)], cutoff_ts=10_000)
    src = _RangeSource(have_ts=[], error=RuntimeError("breaker open"))
    status = asyncio.run(
        cache.backfill_below(KEY, 60, src.range, target_oldest_ts=0, now=10_000)
    )
    assert status == "error"
    assert cache._backfill_reached_floor(KEY) is False  # resumes next session


# --- Active-backfill registry -------------------------------------------------
# The module-level registry window() publishes to while a multi-chunk walk runs;
# it's what the progress endpoint reads so a minutes-long download is visible
# while it happens (uvicorn only logs the request once it finishes).


def test_active_backfills_empty_when_idle(tmp_path):
    from auto_trader.core import candle_cache as cc
    assert cc.active_backfills() == []


def test_window_multi_chunk_publishes_and_clears_progress(tmp_path):
    from auto_trader.core import candle_cache as cc

    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in range(0, 601, 60)]
    seen: list[list[dict]] = []

    async def spying_fetch(from_dt, to_dt):
        # Snapshot the registry mid-walk: entry present with sane fields.
        seen.append(cc.active_backfills())
        s, e = int(from_dt.timestamp()), int(to_dt.timestamp())
        return [b for b in src if s <= int(b.time.timestamp()) <= e]

    # chunk_bars small enough that the window needs >1 chunk
    asyncio.run(cache.window(KEY, 60, _dt(0), _dt(600), spying_fetch,
                             now=10_000, chunk_bars=3))
    mid = [s for s in seen if s]
    assert mid, "registry never showed an active backfill"
    entry = mid[0][0]
    assert entry["total_chunks"] > 1
    assert entry["label"]  # _key_label(KEY)
    assert 0 <= entry["done_chunks"] <= entry["total_chunks"]
    # cleared after the walk finishes
    assert cc.active_backfills() == []


def test_window_failed_fetch_clears_progress(tmp_path):
    from auto_trader.core import candle_cache as cc

    cache = CandleCache(str(tmp_path / "c.db"))

    async def failing_fetch(from_dt, to_dt):
        raise RuntimeError("broker down")

    try:
        asyncio.run(cache.window(KEY, 60, _dt(0), _dt(600), failing_fetch,
                                 now=10_000, chunk_bars=3))
    except RuntimeError:
        pass
    assert cc.active_backfills() == []


def test_active_backfills_drops_stale_entries(tmp_path):
    from auto_trader.core import candle_cache as cc
    cc._ACTIVE_BACKFILLS["stale-key"] = {
        "label": "x", "done_chunks": 1, "total_chunks": 5, "bars": 10,
        "elapsed_s": 1.0, "eta_s": 4.0, "at": "", "updated_at": 100.0,
    }
    try:
        assert cc.active_backfills(now=200.0) == []          # >60s old: dropped
        assert len(cc.active_backfills(now=120.0)) == 1      # fresh enough
    finally:
        cc._ACTIVE_BACKFILLS.clear()


# --- archive fallback: stored bars below coverage serve without the broker ---
# The bars table can hold history the coverage row does not claim (a coverage
# reset, an import, bars recorded before the row was rebuilt). Those spans are
# usually beyond the broker's retention, so walking the broker over them is
# slow and fruitless; the walk absorbs them from the store instead.


def _seed_archive_below_coverage(cache, stored_ts, covered_ts, cutoff=10_000):
    """Bars at `stored_ts` in the table but NOT in coverage; coverage claims
    only `covered_ts`. Mirrors the real failure: 17 months of bars on disk,
    a coverage row that starts much later."""
    cache._store_closed(KEY, [_c(t, float(t)) for t in stored_ts + covered_ts], cutoff)
    cache._set_coverage(KEY, min(covered_ts), max(covered_ts))


def test_window_below_coverage_serves_stored_bars_without_broker(tmp_path):
    cache = CandleCache(str(tmp_path / "c.db"))
    _seed_archive_below_coverage(cache, stored_ts=[40, 100, 160], covered_ts=[220, 280])
    f = FakeFetcher([])  # any call would find nothing; there should be none
    out = asyncio.run(cache.window(KEY, 60, _dt(40), _dt(120), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in out] == [40, 100]
    assert f.range_calls == []  # the archive served; the broker was never asked
    assert cache._coverage(KEY) == (40, 280)  # coverage self-heals downward


def test_window_below_coverage_bare_gap_still_asks_the_broker(tmp_path):
    # Only part of the gap is stored: the stored chunk absorbs, the bare chunk
    # below it still goes to the broker — the short-circuit must not swallow
    # gaps the broker could genuinely fill.
    cache = CandleCache(str(tmp_path / "c.db"))
    _seed_archive_below_coverage(cache, stored_ts=[160], covered_ts=[220, 280])
    f = FakeFetcher([_c(40, 40.0)])
    out = asyncio.run(
        cache.window(KEY, 60, _dt(40), _dt(170), f.range, now=10_000, chunk_bars=2)
    )
    assert [int(c.time.timestamp()) for c in out] == [40, 160]
    # The chunk holding the stored bar was absorbed; deeper bare chunks fetched.
    assert all(to < 160 for _, to in f.range_calls)
    assert len(f.range_calls) >= 1
    assert cache._coverage(KEY) == (40, 280)


def test_window_below_coverage_floor_skips_broker_entirely(tmp_path):
    # Deep backfill already proved the broker has nothing below our oldest:
    # a below-coverage window must not ask again, stored bars or not.
    cache = CandleCache(str(tmp_path / "c.db"))
    _seed_archive_below_coverage(cache, stored_ts=[100], covered_ts=[220, 280])
    cache._set_backfill_floor(KEY)
    f = FakeFetcher([])
    out = asyncio.run(cache.window(KEY, 60, _dt(40), _dt(120), f.range, now=10_000))
    assert [int(c.time.timestamp()) for c in out] == [100]
    assert f.range_calls == []
    assert cache._coverage(KEY) == (40, 280)


def test_window_absorb_only_below_original_coverage(tmp_path):
    # Orphaned rows ABOVE the live edge must not short-circuit a forward fill:
    # the absorb rule applies strictly below the pre-walk oldest watermark.
    cache = CandleCache(str(tmp_path / "c.db"))
    cache._store_closed(KEY, [_c(t, float(t)) for t in (100, 160)], cutoff_ts=10_000)
    # Orphan a newer bar into the table without coverage claiming it.
    cache._store_closed(KEY, [_c(400, 400.0)], cutoff_ts=10_000, extend_coverage=False)
    cache._set_coverage(KEY, 100, 160)
    f = FakeFetcher([_c(280, 280.0), _c(340, 340.0), _c(400, 400.0)])
    out = asyncio.run(cache.window(KEY, 60, _dt(100), _dt(460), f.range, now=10_000))
    # The forward gap above newest was fetched from the broker, not absorbed.
    assert f.range_calls != []
    assert [int(c.time.timestamp()) for c in out] == [100, 160, 280, 340, 400]


class SlowFetcher(ChunkRecordingFetcher):
    """A source that takes real time per chunk, so a fill budget can expire mid-walk."""

    def __init__(self, bars: list[Candle], delay_s: float = 0.02):
        super().__init__(bars)
        self._delay = delay_s

    async def range(self, start: datetime, end: datetime) -> list[Candle]:
        await asyncio.sleep(self._delay)
        return await super().range(start, end)


def test_window_without_a_budget_completes_however_many_chunks_it_takes(tmp_path):
    """The guard on the shared path. _fetch_symbol_candles serves backtests,
    expression evaluation and strategy runs as well as the chart, and those need
    the data to be COMPLETE: a year-long run that silently used the first eight
    seconds of history would report numbers for bars it never saw. No budget must
    stay no budget, however long the walk is."""
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in range(1000, 3100, 100)]
    f = SlowFetcher(src)
    out = asyncio.run(
        cache.window(KEY, 100, _dt(1000), _dt(3000), f.range, now=10_000, chunk_bars=3)
    )
    assert [int(c.time.timestamp()) for c in out] == list(range(1000, 3001, 100))
    assert len(f.range_calls) > 1
    assert cache._coverage(KEY) == (1000, 3000)


def test_window_budget_stops_the_walk_and_says_it_is_still_loading(tmp_path):
    """The hang this exists for: coverage is contiguous, so a window deeper than
    the cache downloads everything in between. On a 1m series a year back that is
    ~175 sequential broker calls with this key's lock held, and the request simply
    never returns. With a budget it serves what landed and says why."""
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in range(1000, 3100, 100)]
    f = SlowFetcher(src)
    partial: dict = {}
    degraded: dict = {}
    asyncio.run(
        cache.window(
            KEY, 100, _dt(1000), _dt(3000), f.range, now=10_000, chunk_bars=3,
            budget_s=0.05, degraded=degraded, partial=partial,
        )
    )
    cov = cache._coverage(KEY)
    assert cov is not None and cov[0] > 1000, "the walk should have stopped short"
    assert partial["reason"].startswith("still loading history")
    assert partial["done_chunks"] < partial["total_chunks"]
    # NOT degraded: nothing is unreachable and nothing is broken. The two carry
    # different words to the user, and "broker unreachable" would be a lie here.
    assert degraded == {}

    # What landed is kept and is contiguous, so asking again resumes deeper
    # rather than starting over. That is what makes stopping early cheap.
    calls_before = len(f.range_calls)
    out = asyncio.run(
        cache.window(KEY, 100, _dt(1000), _dt(3000), f.range, now=10_000, chunk_bars=3)
    )
    assert [int(c.time.timestamp()) for c in out] == list(range(1000, 3001, 100))
    assert all(e <= cov[0] for s, e in f.range_calls[calls_before:]), f.range_calls


def test_window_budget_already_spent_serves_cache_without_fetching(tmp_path):
    """The budget starts before the key lock, so a caller queued behind someone
    else's long backfill is bounded too. By the time it gets in it may have no
    time left at all: it must serve what the cache has rather than start a walk
    the caller has already stopped waiting for."""
    cache = CandleCache(str(tmp_path / "c.db"))
    src = [_c(t, float(t)) for t in range(1000, 3100, 100)]
    asyncio.run(cache.window(KEY, 100, _dt(2500), _dt(3000), ChunkRecordingFetcher(src).range, now=10_000))

    f = ChunkRecordingFetcher(src)
    partial: dict = {}
    out = asyncio.run(
        cache.window(
            KEY, 100, _dt(1000), _dt(3000), f.range, now=10_000, chunk_bars=3,
            budget_s=0.0, partial=partial,
        )
    )
    assert f.range_calls == [], "no time left means no fetch at all"
    assert [int(c.time.timestamp()) for c in out] == list(range(2500, 3001, 100))
    assert partial["done_chunks"] == 0

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

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
    gstats = cache.global_stats()
    assert gstats["total_bars"] == 3
    assert gstats["db_size_bytes"] > 0


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

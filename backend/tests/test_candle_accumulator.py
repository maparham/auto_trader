from __future__ import annotations

import asyncio

from auto_trader.core.candle_accumulator import (
    CandleAccumulator,
    _target_oldest_ts,
)

KEY = ("capital", "EURUSD", "MINUTE", "mid")


def test_target_lookback_shrinks_for_ig():
    now = 1_000_000_000.0
    cap = _target_oldest_ts(60, is_ig=True, now=now)
    wide = _target_oldest_ts(60, is_ig=False, now=now)
    assert cap > wide          # IG reaches back less far (larger target ts = shallower)
    assert wide < now          # target is in the past


class FakeCache:
    """Records backfill/recent calls. `_coverage` returns a warm block by default so no
    cold-seed fetch happens; set `_block_backfill` to hang the backfill for cancel tests."""

    def __init__(self):
        self.backfill_calls = 0
        self.recent_calls = 0
        self._backfill_event = asyncio.Event()
        self._block_backfill = None  # optional asyncio.Event to hang backfill mid-run

    def _coverage(self, key):
        return (100, 200)

    async def backfill_below(self, key, res_seconds, fetch_range, **kw):
        self.backfill_calls += 1
        self._backfill_event.set()
        if self._block_backfill is not None:
            await self._block_backfill.wait()  # hang until released or cancelled
        return "floor"

    async def recent(self, key, res_seconds, count, fetch_recent, **kw):
        self.recent_calls += 1
        return []


class ColdCache(FakeCache):
    def _coverage(self, key):
        return None  # cold: forces a seed fetch


async def _noop_range(s, e):
    return []


async def _noop_recent(n):
    return []


def test_two_starts_run_one_backfill():
    async def run():
        cache = FakeCache()
        acc = CandleAccumulator(cache)
        acc.on_view_start(KEY, 60, _noop_range, _noop_recent)
        acc.on_view_start(KEY, 60, _noop_range, _noop_recent)  # second viewer, same key
        await asyncio.wait_for(cache._backfill_event.wait(), timeout=1.0)
        await asyncio.sleep(0)  # let the one-shot task finish
        acc.on_view_stop(KEY)
        acc.on_view_stop(KEY)
        return cache
    cache = asyncio.run(run())
    assert cache.backfill_calls == 1  # deduped across two viewers


def test_warm_series_skips_seed():
    async def run():
        cache = FakeCache()  # _coverage is non-None -> not cold
        acc = CandleAccumulator(cache)
        acc.on_view_start(KEY, 60, _noop_range, _noop_recent)
        await asyncio.wait_for(cache._backfill_event.wait(), timeout=1.0)
        await asyncio.sleep(0)
        acc.on_view_stop(KEY)
        return cache
    cache = asyncio.run(run())
    assert cache.recent_calls == 0    # warm cache -> no seed fetch
    assert cache.backfill_calls == 1


def test_cold_series_seeds_then_backfills():
    async def run():
        cache = ColdCache()
        acc = CandleAccumulator(cache)
        acc.on_view_start(KEY, 60, _noop_range, _noop_recent)
        await asyncio.wait_for(cache._backfill_event.wait(), timeout=1.0)
        await asyncio.sleep(0)
        acc.on_view_stop(KEY)
        return cache
    cache = asyncio.run(run())
    assert cache.recent_calls == 1    # cold -> exactly one seed fetch
    assert cache.backfill_calls == 1


def test_last_stop_cancels_inflight_backfill():
    async def run():
        cache = FakeCache()
        cache._block_backfill = asyncio.Event()  # backfill hangs until cancelled
        acc = CandleAccumulator(cache)
        acc.on_view_start(KEY, 60, _noop_range, _noop_recent)
        await asyncio.wait_for(cache._backfill_event.wait(), timeout=1.0)  # backfill started
        task = acc._tasks[KEY]
        acc.on_view_stop(KEY)  # last viewer leaves -> cancels the in-flight task
        try:
            await task
        except asyncio.CancelledError:
            pass
        return task
    task = asyncio.run(run())
    assert task.cancelled()


def test_stop_without_start_is_safe():
    acc = CandleAccumulator(FakeCache())
    acc.on_view_stop(KEY)  # must not raise / underflow
    assert acc._refcount.get(KEY, 0) == 0

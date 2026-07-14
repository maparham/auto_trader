"""Drives automatic candle accumulation for series that are being viewed.

The /ws/candles relay calls on_view_start when a chart begins viewing a series and
on_view_stop when it disconnects. The first viewer of a series triggers one one-shot
background task that seeds a forward block if the series is cold, then deep-backfills
history downward toward the broker's floor. There is NO periodic loop: bars that close
while a chart stays open are persisted on the next open's forward bridge (recent()),
so no broker sees continuous background traffic. Reference-counted per series, so N
charts on the same series share ONE task; an in-flight backfill is cancelled when the
last viewer leaves. Broker-agnostic: the relay injects the guarded fetch callables (no
broker imports here).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from auto_trader.core.candle_cache import CANDLE_CACHE, CandleKey, CandleCache
from auto_trader.core.models import Candle

log = logging.getLogger(__name__)


def _fmt_ts(ts: int | None) -> str:
    if ts is None:
        return "none"
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")

FetchRange = Callable[[datetime, datetime], Awaitable[list[Candle]]]
FetchRecent = Callable[[int], Awaitable[list[Candle]]]

# Per-resolution deep-backfill depth (seconds of history to aim for). Bounded so a
# series never pages arbitrarily deep; the broker floor usually stops it sooner.
_DAY = 86_400
_LOOKBACK_SECONDS = [
    (60, 30 * _DAY),      # <= 1m  -> 30 days
    (300, 90 * _DAY),     # <= 5m  -> 90 days
    (900, 180 * _DAY),    # <= 15m -> 180 days
    (3600, 730 * _DAY),   # <= 1h  -> 2 years
]
_LOOKBACK_DEFAULT = 3650 * _DAY  # >= 1h up to DAY/WEEK -> ~10 years
# IG bills /prices against a weekly allowance, so cap its one-time deep backfill to a
# small bar count (about one request page) instead of a time window.
_IG_MAX_BACKFILL_BARS = 1000

_SEED_COUNT = 500     # bars to establish a forward block if the series is cold


def _lookback_seconds(res_seconds: int) -> int:
    for ceiling, seconds in _LOOKBACK_SECONDS:
        if res_seconds <= ceiling:
            return seconds
    return _LOOKBACK_DEFAULT


def _target_oldest_ts(res_seconds: int, is_ig: bool, now: float) -> int:
    lookback = _lookback_seconds(res_seconds)
    if is_ig:
        lookback = min(lookback, _IG_MAX_BACKFILL_BARS * res_seconds)
    return int(now) - lookback


class CandleAccumulator:
    def __init__(
        self,
        cache: CandleCache,
        *,
        target_oldest_fn: Callable[[int, bool, float], int] = _target_oldest_ts,
        seed_count: int = _SEED_COUNT,
    ) -> None:
        self._cache = cache
        self._target_oldest_fn = target_oldest_fn
        self._seed_count = seed_count
        self._refcount: dict[CandleKey, int] = {}
        self._tasks: dict[CandleKey, asyncio.Task] = {}

    def on_view_start(
        self,
        key: CandleKey,
        res_seconds: int,
        fetch_range: FetchRange,
        fetch_recent: FetchRecent,
        *,
        is_ig: bool = False,
    ) -> None:
        n = self._refcount.get(key, 0) + 1
        self._refcount[key] = n
        if n == 1:
            self._tasks[key] = asyncio.create_task(
                self._run(key, res_seconds, fetch_range, fetch_recent, is_ig)
            )

    def on_view_stop(self, key: CandleKey) -> None:
        n = self._refcount.get(key, 0) - 1
        if n > 0:
            self._refcount[key] = n
            return
        self._refcount.pop(key, None)
        task = self._tasks.pop(key, None)
        if task is not None:
            task.cancel()

    async def _run(
        self,
        key: CandleKey,
        res_seconds: int,
        fetch_range: FetchRange,
        fetch_recent: FetchRecent,
        is_ig: bool,
    ) -> None:
        """One-shot: seed a forward block if the series is cold, then deep-backfill
        downward toward the broker floor. Best-effort; any broker/cache error is logged
        and ends the run without crashing. Cancellation (viewer left) propagates."""
        try:
            # 1. Ensure a forward block exists so deep backfill has an anchor.
            cov = await asyncio.to_thread(self._cache._coverage, key)
            if cov is None:
                log.info("accumulate %s res=%ds: cold, seeding forward block", key, res_seconds)
                await self._cache.recent(key, res_seconds, self._seed_count, fetch_recent)
            # 2. Deep backfill toward the broker floor (resumes if not yet reached;
            # short-circuits once the floor marker is set).
            target = self._target_oldest_fn(res_seconds, is_ig, time.time())
            log.debug("accumulate %s res=%ds: backfilling toward %s", key, res_seconds, _fmt_ts(target))
            status = await self._cache.backfill_below(
                key, res_seconds, fetch_range, target_oldest_ts=target
            )
            cov_after = await asyncio.to_thread(self._cache._coverage, key)
            log.info(
                "accumulate %s res=%ds: backfill %s, oldest cached now %s",
                key, res_seconds, status, _fmt_ts(cov_after[0] if cov_after else None),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("accumulator run failed for %s", key)


CANDLE_ACCUMULATOR = CandleAccumulator(CANDLE_CACHE)

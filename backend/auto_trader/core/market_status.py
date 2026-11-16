"""Shared, server-side cache of each market's meta (precision + open/closed).

Open/closed is the same answer for every user, so it is looked up once per
(broker, epic) and served from here to every request, instead of one upstream
call per user, per tab, per reload. How long an answer is kept depends on what
it says:

- closed with a known reopen time: until that time (it cannot change sooner);
- open, or closed with no reopen time: OPEN_TTL, so a close or a holiday
  shows within a few minutes;
- unknown epic (broker answered None): UNKNOWN_TTL.

Failures are never cached. Concurrent lookups of one key share one upstream
call (single flight).
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime
from typing import Awaitable, Callable

OPEN_TTL_S = 300.0
UNKNOWN_TTL_S = 600.0
# A reopen time far ahead (a long holiday, a bad schedule) is still re-checked
# at least this often.
MAX_TTL_S = 6 * 3600.0

Fetch = Callable[[], Awaitable[dict | None]]


def _ttl(meta: dict | None, now_wall: float) -> float:
    if meta is None:
        return UNKNOWN_TTL_S
    if meta.get("closed") is True and isinstance(meta.get("nextOpen"), str):
        try:
            reopen = datetime.fromisoformat(meta["nextOpen"]).timestamp()
        except ValueError:
            return OPEN_TTL_S
        # +1 s so the re-check lands after the open, not on its edge.
        return min(max(reopen - now_wall + 1.0, 1.0), MAX_TTL_S)
    return OPEN_TTL_S


class MarketStatusCache:
    def __init__(
        self,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self._clock = clock
        self._wall = wall
        # key -> (expires_at, fetched_at, meta), both on the monotonic clock.
        self._entries: dict[tuple[str, str], tuple[float, float, dict | None]] = {}
        self._inflight: dict[tuple[str, str], asyncio.Task[dict | None]] = {}

    async def get(
        self, broker_id: str, epic: str, fetch: Fetch, max_age_s: float | None = None
    ) -> dict | None:
        """`max_age_s` makes the caller refuse a cached answer older than that
        (the chart's re-check when its stream goes quiet); the fresh answer
        still goes into the cache for everyone."""
        key = (broker_id, epic)
        hit = self._entries.get(key)
        now = self._clock()
        if (
            hit is not None
            and now < hit[0]
            and (max_age_s is None or now - hit[1] <= max_age_s)
        ):
            return hit[2]
        task = self._inflight.get(key)
        if task is None:
            # The fetch runs in its own task, shared by every caller and shielded
            # from each, so a cancelled request (client gone) neither stops the
            # lookup nor hands its CancelledError to the others.
            task = asyncio.ensure_future(self._fill(key, fetch))
            self._inflight[key] = task
            task.add_done_callback(lambda t: self._drop(key, t))
        return await asyncio.shield(task)

    async def _fill(self, key: tuple[str, str], fetch: Fetch) -> dict | None:
        meta = await fetch()
        now = self._clock()
        self._entries[key] = (now + _ttl(meta, self._wall()), now, meta)
        return meta

    def _drop(self, key: tuple[str, str], task: asyncio.Task) -> None:
        if self._inflight.get(key) is task:
            del self._inflight[key]
        # Mark a failure retrieved, so a lookup whose callers all went away
        # doesn't log "exception was never retrieved".
        if not task.cancelled():
            task.exception()

    def clear(self) -> None:
        self._entries.clear()


MARKET_STATUS = MarketStatusCache()

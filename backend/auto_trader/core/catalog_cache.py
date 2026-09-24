"""Per-broker cache for the full instrument catalogue (/api/markets/all).

Capital's catalogue is ~8000 rows and one upstream call of about two seconds,
and the frontend asks for it on every page load (symbol search, and the
epic -> instrument lookup behind trade-list/alert/position jumps). Rows
change rarely (new listings, a status flip), so the cache serves them
stale-while-revalidate: within TTL_S they are returned as is; past it they are
still returned at once while one background refresh replaces them. Only the
first request after startup (or after the broker instance is rebuilt) waits on
the upstream call, and concurrent misses share that one call. A failed fetch
is never cached; a failed background refresh keeps the old rows.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

log = logging.getLogger(__name__)

TTL_S = 300.0

Fetch = Callable[[], Awaitable[list[dict]]]

# key -> (owner, fetched_at, rows). `owner` is the broker instance the rows
# came from: a registry rebuild (new credentials) must not serve the old one's.
_entries: dict[str, tuple[object, float, list[dict]]] = {}
_locks: dict[str, asyncio.Lock] = {}
_refreshing: dict[str, asyncio.Task] = {}


async def cached_catalog(
    key: str, owner: object, fetch: Fetch, *, now: Callable[[], float] = time.monotonic
) -> list[dict]:
    entry = _entries.get(key)
    if entry is not None and entry[0] is owner:
        if now() - entry[1] >= TTL_S and key not in _refreshing:
            task = asyncio.get_running_loop().create_task(_refresh(key, owner, fetch, now))
            _refreshing[key] = task
            task.add_done_callback(lambda _t: _refreshing.pop(key, None))
        return entry[2]
    async with _locks.setdefault(key, asyncio.Lock()):
        entry = _entries.get(key)
        if entry is not None and entry[0] is owner:
            return entry[2]  # a concurrent miss filled it while we waited
        rows = await fetch()
        _entries[key] = (owner, now(), rows)
        return rows


async def _refresh(key: str, owner: object, fetch: Fetch, now: Callable[[], float]) -> None:
    try:
        rows = await fetch()
    except Exception as e:  # keep serving the stale rows
        log.warning("catalogue refresh for %s failed: %s", key, e)
        return
    entry = _entries.get(key)
    if entry is None or entry[0] is owner:
        _entries[key] = (owner, now(), rows)


def clear() -> None:
    """Drop everything (tests)."""
    _entries.clear()
    _locks.clear()
    _refreshing.clear()

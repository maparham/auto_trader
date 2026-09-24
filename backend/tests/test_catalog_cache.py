"""core/catalog_cache.py: stale-while-revalidate catalogue cache."""

import asyncio

import pytest

from auto_trader.core import catalog_cache
from auto_trader.core.catalog_cache import TTL_S, cached_catalog


@pytest.fixture(autouse=True)
def _clear():
    catalog_cache.clear()
    yield
    catalog_cache.clear()


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def fetcher(*results):
    """A fetch returning (or raising) each result in turn, counting calls."""
    calls = []

    async def fetch():
        calls.append(1)
        r = results[min(len(calls), len(results)) - 1]
        if isinstance(r, Exception):
            raise r
        return r

    return fetch, calls


def test_second_call_within_ttl_is_served_from_cache():
    fetch, calls = fetcher([{"epic": "MU"}])
    owner, clock = object(), Clock()

    async def run():
        a = await cached_catalog("capital", owner, fetch, now=clock)
        clock.t += TTL_S - 1
        b = await cached_catalog("capital", owner, fetch, now=clock)
        return a, b

    a, b = asyncio.run(run())
    assert a == b == [{"epic": "MU"}]
    assert len(calls) == 1


def test_stale_rows_are_served_while_one_refresh_runs():
    fetch, calls = fetcher([{"epic": "OLD"}], [{"epic": "NEW"}])
    owner, clock = object(), Clock()

    async def run():
        await cached_catalog("capital", owner, fetch, now=clock)
        clock.t += TTL_S
        stale = await cached_catalog("capital", owner, fetch, now=clock)
        again = await cached_catalog("capital", owner, fetch, now=clock)  # refresh already running
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        fresh = await cached_catalog("capital", owner, fetch, now=clock)
        return stale, again, fresh

    stale, again, fresh = asyncio.run(run())
    assert stale == again == [{"epic": "OLD"}]
    assert fresh == [{"epic": "NEW"}]
    assert len(calls) == 2


def test_failed_refresh_keeps_the_old_rows():
    fetch, calls = fetcher([{"epic": "OLD"}], RuntimeError("upstream down"))
    owner, clock = object(), Clock()

    async def run():
        await cached_catalog("capital", owner, fetch, now=clock)
        clock.t += TTL_S
        await cached_catalog("capital", owner, fetch, now=clock)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return await cached_catalog("capital", owner, fetch, now=clock)

    assert asyncio.run(run()) == [{"epic": "OLD"}]


def test_failed_first_fetch_is_not_cached():
    fetch, calls = fetcher(RuntimeError("upstream down"), [{"epic": "MU"}])
    owner = object()

    async def run():
        with pytest.raises(RuntimeError):
            await cached_catalog("capital", owner, fetch)
        return await cached_catalog("capital", owner, fetch)

    assert asyncio.run(run()) == [{"epic": "MU"}]
    assert len(calls) == 2


def test_concurrent_misses_share_one_fetch():
    calls = []

    async def fetch():
        calls.append(1)
        await asyncio.sleep(0.01)
        return [{"epic": "MU"}]

    async def run():
        owner = object()
        return await asyncio.gather(*(cached_catalog("capital", owner, fetch) for _ in range(3)))

    assert asyncio.run(run()) == [[{"epic": "MU"}]] * 3
    assert len(calls) == 1


def test_a_rebuilt_broker_instance_refetches():
    fetch, calls = fetcher([{"epic": "A"}], [{"epic": "B"}])

    async def run():
        a = await cached_catalog("capital", object(), fetch)
        b = await cached_catalog("capital", object(), fetch)
        return a, b

    assert asyncio.run(run()) == ([{"epic": "A"}], [{"epic": "B"}])
    assert len(calls) == 2

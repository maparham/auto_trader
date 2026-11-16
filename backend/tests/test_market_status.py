"""Shared market-status cache (core/market_status.py) and GET /api/markets/status.
Direct-call convention per test_api_candles.py."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

import auto_trader.api.routers.markets as markets
from auto_trader.core import market_status as ms


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


WALL = datetime(2026, 11, 16, 0, 0, tzinfo=timezone.utc).timestamp()


def _cache(clock):
    return ms.MarketStatusCache(clock=clock, wall=lambda: WALL + (clock.t - 1000.0))


def _counting(meta):
    calls = []

    async def fetch():
        calls.append(1)
        await asyncio.sleep(0)
        return meta

    return fetch, calls


def test_open_answer_is_kept_for_open_ttl():
    clock = Clock()
    cache = _cache(clock)
    fetch, calls = _counting({"closed": False, "nextOpen": None})

    async def run():
        await cache.get("capital", "US100", fetch)
        clock.t += ms.OPEN_TTL_S - 1
        await cache.get("capital", "US100", fetch)
        assert len(calls) == 1
        clock.t += 2
        await cache.get("capital", "US100", fetch)
        assert len(calls) == 2

    asyncio.run(run())


def test_closed_answer_is_kept_until_reopen():
    clock = Clock()
    cache = _cache(clock)
    fetch, calls = _counting({"closed": True, "nextOpen": "2026-11-16T01:00:00+00:00"})

    async def run():
        await cache.get("capital", "NVDA", fetch)
        clock.t += 3599  # past OPEN_TTL, before the 01:00 open
        await cache.get("capital", "NVDA", fetch)
        assert len(calls) == 1
        clock.t += 3  # past the open
        await cache.get("capital", "NVDA", fetch)
        assert len(calls) == 2

    asyncio.run(run())


def test_concurrent_lookups_share_one_fetch():
    cache = _cache(Clock())
    fetch, calls = _counting({"closed": False})

    async def run():
        out = await asyncio.gather(*(cache.get("capital", "AAPL", fetch) for _ in range(10)))
        assert len(calls) == 1
        assert all(o == {"closed": False} for o in out)

    asyncio.run(run())


def test_failures_are_not_cached():
    cache = _cache(Clock())
    calls = []

    async def boom():
        calls.append(1)
        raise RuntimeError("upstream")

    async def run():
        for _ in range(2):
            with pytest.raises(RuntimeError):
                await cache.get("capital", "AAPL", boom)
        assert len(calls) == 2

    asyncio.run(run())


def test_brokers_are_cached_separately():
    cache = _cache(Clock())
    fetch, calls = _counting({"closed": False})

    async def run():
        await cache.get("capital", "AAPL", fetch)
        await cache.get("yfinance", "AAPL", fetch)
        assert len(calls) == 2

    asyncio.run(run())


class FakeBroker:
    def __init__(self, metas):
        self.metas = metas
        self.calls = []

    async def get_market_meta(self, epic):
        self.calls.append(epic)
        m = self.metas[epic]
        if isinstance(m, Exception):
            raise m
        return m


def test_status_endpoint_answers_every_epic_and_hides_failures(monkeypatch):
    broker = FakeBroker(
        {
            "NVDA": {"closed": True, "nextOpen": "2026-11-16T01:00:00+00:00", "pricePrecision": 2},
            "US100": {"closed": False, "nextOpen": None},
            "BAD": RuntimeError("upstream"),
            "GONE": None,
        }
    )
    monkeypatch.setattr(markets, "get_data", lambda broker_id: broker)
    monkeypatch.setattr(markets, "MARKET_STATUS", ms.MarketStatusCache())

    out = asyncio.run(
        markets.markets_status(epic=["NVDA", "US100", "BAD", "GONE", "NVDA"], broker_id="capital")
    )
    assert out == {
        "NVDA": {"closed": True, "nextOpen": "2026-11-16T01:00:00+00:00"},
        "US100": {"closed": False, "nextOpen": None},
        "BAD": {"closed": None, "nextOpen": None, "error": True},
        "GONE": {"closed": None, "nextOpen": None},
    }
    # Duplicates collapse; a second call is served from the cache except the failure.
    asyncio.run(markets.markets_status(epic=["NVDA", "US100", "BAD"], broker_id="capital"))
    assert broker.calls.count("NVDA") == 1
    assert broker.calls.count("US100") == 1
    assert broker.calls.count("BAD") == 2


def test_status_endpoint_caps_epics(monkeypatch):
    monkeypatch.setattr(markets, "get_data", lambda broker_id: FakeBroker({}))
    with pytest.raises(markets.HTTPException) as e:
        asyncio.run(
            markets.markets_status(
                epic=[f"E{i}" for i in range(markets._STATUS_MAX_EPICS + 1)], broker_id="capital"
            )
        )
    assert e.value.status_code == 422


def test_single_meta_route_shares_the_cache(monkeypatch):
    broker = FakeBroker({"NVDA": {"closed": True, "nextOpen": None, "pricePrecision": 2}})
    monkeypatch.setattr(markets, "get_data", lambda broker_id: broker)
    monkeypatch.setattr(markets, "MARKET_STATUS", ms.MarketStatusCache())
    asyncio.run(markets.markets_status(epic=["NVDA"], broker_id="capital"))
    out = asyncio.run(markets.market_meta("NVDA", broker_id="capital", fresh=False))
    assert out["pricePrecision"] == 2 and out["closed"] is True
    assert broker.calls == ["NVDA"]


def test_a_cancelled_caller_does_not_fail_the_others():
    cache = _cache(Clock())
    gate = None
    calls = []

    async def slow():
        calls.append(1)
        await gate.wait()
        return {"closed": True, "nextOpen": None}

    async def run():
        nonlocal gate
        gate = asyncio.Event()
        first = asyncio.create_task(cache.get("capital", "NVDA", slow))
        await asyncio.sleep(0)
        second = asyncio.create_task(cache.get("capital", "NVDA", slow))
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.sleep(0)
        gate.set()
        assert await second == {"closed": True, "nextOpen": None}
        assert first.cancelled()
        assert len(calls) == 1
        # The lookup finished and was cached despite its starter going away.
        assert await cache.get("capital", "NVDA", slow) == {"closed": True, "nextOpen": None}
        assert len(calls) == 1

    asyncio.run(run())


def test_max_age_refuses_an_old_cached_answer_and_refills_it():
    clock = Clock()
    cache = _cache(clock)
    fetch, calls = _counting({"closed": False})

    async def run():
        await cache.get("capital", "US100", fetch)
        clock.t += 20
        await cache.get("capital", "US100", fetch, max_age_s=30)
        assert len(calls) == 1  # young enough
        clock.t += 20
        await cache.get("capital", "US100", fetch, max_age_s=30)
        assert len(calls) == 2  # 40 s old: refused
        await cache.get("capital", "US100", fetch)
        assert len(calls) == 2  # the fresh answer serves everyone

    asyncio.run(run())

# backend/tests/test_yahoo_splits.py
from __future__ import annotations

import asyncio
import threading
import time

from auto_trader.brokers.yahoo_splits import SplitRegistry, yahoo_ticker
from auto_trader.core.candle_clean import Split


def test_yahoo_ticker_maps_catalogue_stocks_and_plain_tickers():
    assert yahoo_ticker("AAPL") == "AAPL"
    assert yahoo_ticker("BKNG") == "BKNG"  # not curated: passes through
    assert yahoo_ticker("BRK-B") == "BRK-B"
    assert yahoo_ticker("VOD.L") == "VOD.L"


def test_yahoo_ticker_refuses_non_equities():
    assert yahoo_ticker("US100") is None  # curated index
    assert yahoo_ticker("EURUSD") is None  # curated fx
    assert yahoo_ticker("BTCUSD") is None  # curated crypto
    assert yahoo_ticker("OIL_CRUDE") is None  # not ticker-shaped
    assert yahoo_ticker("") is None


def _run(coro):
    return asyncio.run(coro)


def test_registry_caches_hits():
    calls: list[str] = []

    def fetch(t: str) -> list[Split]:
        calls.append(t)
        return [Split(ts=1, ratio=25.0)]

    reg = SplitRegistry(fetch)

    async def go():
        a = await reg.get("BKNG")
        b = await reg.get("BKNG")
        return a, b

    a, b = _run(go())
    assert a == b == [Split(ts=1, ratio=25.0)]
    assert calls == ["BKNG"]
    assert reg.peek("BKNG") == [Split(ts=1, ratio=25.0)]


def test_registry_caches_failures_as_empty():
    calls: list[str] = []

    def fetch(t: str) -> list[Split]:
        calls.append(t)
        raise RuntimeError("no such ticker")

    reg = SplitRegistry(fetch)

    async def go():
        return await reg.get("NOPE"), await reg.get("NOPE")

    assert _run(go()) == ([], [])
    assert calls == ["NOPE"]


def test_registry_skips_non_equities_without_fetching():
    reg = SplitRegistry(lambda t: (_ for _ in ()).throw(AssertionError("fetched")))
    assert _run(reg.get("EURUSD")) == []
    assert reg.peek("EURUSD") == []


def test_registry_expires_after_ttl():
    calls: list[str] = []
    reg = SplitRegistry(lambda t: calls.append(t) or [], ttl_s=0.0)

    async def go():
        await reg.get("BKNG")
        await reg.get("BKNG")

    _run(go())
    assert calls == ["BKNG", "BKNG"]


def test_registry_times_out_to_empty_and_dedupes_concurrent_calls():
    started = threading.Event()
    release = threading.Event()
    calls: list[str] = []

    def slow(t: str) -> list[Split]:
        calls.append(t)
        started.set()
        release.wait(2)
        return [Split(ts=1, ratio=2.0)]

    reg = SplitRegistry(slow, timeout_s=0.05)

    async def go():
        a, b = await asyncio.gather(reg.get("BKNG"), reg.get("BKNG"))
        release.set()
        return a, b

    t0 = time.monotonic()
    assert _run(go()) == ([], [])
    assert time.monotonic() - t0 < 1.5
    assert calls == ["BKNG"]


def test_registry_takes_a_broker_supplied_ticker_and_remembers_it():
    # IG's Booking Holdings is UC.D.PCLN.CASH.IP: nothing in the epic says
    # BKNG, so the broker names the ticker and later peeks (pattern search,
    # the candle repair) find it by epic.
    calls: list[str] = []

    def fetch(t: str) -> list[Split]:
        calls.append(t)
        return [Split(ts=1, ratio=25.0)]

    reg = SplitRegistry(fetch)
    epic = "UC.D.PCLN.CASH.IP"
    assert reg.peek(epic) == []  # not ticker-shaped, no alias yet
    assert _run(reg.get(epic, ticker="BKNG")) == [Split(ts=1, ratio=25.0)]
    assert calls == ["BKNG"]
    assert reg.peek(epic) == [Split(ts=1, ratio=25.0)]
    assert _run(reg.get(epic)) == [Split(ts=1, ratio=25.0)]
    assert calls == ["BKNG"]

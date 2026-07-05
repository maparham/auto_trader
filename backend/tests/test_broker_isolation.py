"""End-to-end isolation: one down/slow broker must not block the others.

Drives the real market route (`market_meta`) with a stub registry holding a SLOW
broker (hangs past the call budget) and a FAST one, and asserts that the slow
broker fast-fails (504 then 503 once the breaker opens) while the fast broker
stays quick even when called concurrently with the slow one. This pins the fix
for the 'capital is down so the whole app — including ig-demo — looks dead' bug.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi import HTTPException

from auto_trader.api import app as app_module
from auto_trader.api import deps
from auto_trader.brokers.base import MarketDataBroker
from auto_trader.brokers.registry import BrokerRegistry
from auto_trader.core.broker_health import BrokerHealth


class _StubBroker(MarketDataBroker):
    def __init__(self, delay: float) -> None:
        self._delay = delay

    async def get_market_meta(self, epic: str) -> dict:
        await asyncio.sleep(self._delay)
        return {"pricePrecision": 2, "closed": False, "nextOpen": None, "status": "OK"}

    # Unused abstract methods for this test.
    async def get_candles(self, *a, **k):  # type: ignore[override]
        return []

    async def get_recent_candles(self, *a, **k):  # type: ignore[override]
        return []

    async def get_quote(self, epic: str):  # type: ignore[override]
        return (None, None)


def _install(monkeypatch, *, call_timeout: float, fail_threshold: int) -> None:
    reg = BrokerRegistry()
    reg.add_data("slow", _StubBroker(delay=10.0))  # "down" broker: hangs
    reg.add_data("fast", _StubBroker(delay=0.0))  # healthy broker
    # _registry/BROKER_HEALTH moved to auto_trader.api.deps in the app split; the
    # market route's get_data()/guarded() read them from there, so patch deps.
    monkeypatch.setattr(deps, "_registry", reg)
    monkeypatch.setattr(
        deps,
        "BROKER_HEALTH",
        BrokerHealth(call_timeout=call_timeout, fail_threshold=fail_threshold),
    )


def test_slow_broker_times_out_then_fast_fails(monkeypatch) -> None:
    _install(monkeypatch, call_timeout=0.05, fail_threshold=1)

    async def scenario():
        t0 = time.monotonic()
        with pytest.raises(HTTPException) as e1:
            await app_module.market_meta("E", "slow")
        assert e1.value.status_code == 504  # bounded, didn't hang 10s
        assert time.monotonic() - t0 < 1.0
        # Breaker now open: the next call fast-fails as 503 without waiting.
        t1 = time.monotonic()
        with pytest.raises(HTTPException) as e2:
            await app_module.market_meta("E", "slow")
        assert e2.value.status_code == 503
        assert time.monotonic() - t1 < 0.05

    asyncio.run(scenario())


def test_fast_broker_not_blocked_by_concurrent_slow_broker(monkeypatch) -> None:
    """The crux: a hung 'slow' broker call running concurrently must not delay or
    fail the healthy 'fast' broker."""
    _install(monkeypatch, call_timeout=0.05, fail_threshold=1)

    async def scenario():
        t0 = time.monotonic()
        slow = asyncio.create_task(_swallow(app_module.market_meta("E", "slow")))
        fast = await app_module.market_meta("E", "fast")
        elapsed = time.monotonic() - t0
        await slow
        assert fast["pricePrecision"] == 2  # healthy broker returned its data
        assert elapsed < 0.5  # not stuck behind the slow broker's hang/timeout

    asyncio.run(scenario())


async def _swallow(coro):
    with pytest.raises(HTTPException):
        await coro

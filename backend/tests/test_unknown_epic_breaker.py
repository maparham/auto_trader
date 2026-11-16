"""A broker saying "no such symbol" is the caller's mistake, not an outage:
it must answer 404 and never open the shared breaker (a tab bar still naming
another broker's symbols once opened mt5-self's breaker for every call)."""

import asyncio

import pytest
from fastapi import HTTPException

from auto_trader.api import deps
from auto_trader.core.broker_health import UnknownEpic


async def _unknown() -> None:
    raise UnknownEpic("AAPL")


def test_unknown_epic_is_404_and_never_opens_the_breaker() -> None:
    for _ in range(10):
        with pytest.raises(HTTPException) as e:
            asyncio.run(deps.guarded("mt5-self-test", _unknown, "candles"))
        assert e.value.status_code == 404
        assert "AAPL" in e.value.detail
    assert not deps.BROKER_HEALTH.is_open("mt5-self-test")

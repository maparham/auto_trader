"""The idle watchdog tick undeploys a deployed+idle account, and no-ops when
the account is off or still within its idle window."""
import asyncio
from unittest.mock import AsyncMock

from auto_trader.api import deps


def _broker(state: str, remaining: int):
    b = AsyncMock()
    b.deploy_state.return_value = state
    b.seconds_until_idle_undeploy = lambda: remaining  # sync
    return b


def test_tick_undeploys_when_on_and_idle_expired():
    b = _broker("on", 0)
    assert asyncio.run(deps._mt5_idle_tick(b)) is True
    b.pause.assert_awaited_once()


def test_tick_noop_when_still_within_window():
    b = _broker("on", 120)
    assert asyncio.run(deps._mt5_idle_tick(b)) is False
    b.pause.assert_not_awaited()


def test_tick_noop_when_off():
    b = _broker("off", 0)
    assert asyncio.run(deps._mt5_idle_tick(b)) is False
    b.pause.assert_not_awaited()


def test_tick_swallows_errors():
    b = AsyncMock()
    b.deploy_state.side_effect = RuntimeError("boom")
    assert asyncio.run(deps._mt5_idle_tick(b)) is False

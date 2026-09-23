"""The idle watchdog tick undeploys a deployed+idle account it owns, and
no-ops when the account is off, still within its idle window, or deployed by
the other backend (local and hosted share one MetaApi account)."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from auto_trader.api import deps


def _broker(state: str, remaining: int, owns: bool = True):
    b = AsyncMock()
    b.deploy_state.return_value = state
    b.seconds_until_idle_undeploy = lambda: remaining  # sync
    b.owns_deploy = owns
    b._deploy_seq = 0
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
    b._deploy_seq = 0
    b.deploy_state.side_effect = RuntimeError("boom")
    assert asyncio.run(deps._mt5_idle_tick(b)) is False


def test_tick_leaves_a_deployment_it_does_not_own():
    # The other backend started it and never saw our idle clock: hands off.
    b = _broker("on", 0, owns=False)
    assert asyncio.run(deps._mt5_idle_tick(b)) is False
    b.pause.assert_not_awaited()


def test_tick_drops_ownership_when_stopped_elsewhere():
    b = _broker("off", 0, owns=True)
    asyncio.run(deps._mt5_idle_tick(b))
    assert b.owns_deploy is False


def test_tick_keeps_ownership_when_resume_raced_the_off_read():
    b = _broker("off", 0, owns=True)

    async def racing_state():
        b._deploy_seq += 1  # resume() landed while the reload was in flight
        return "off"

    b.deploy_state.side_effect = racing_state
    asyncio.run(deps._mt5_idle_tick(b))
    assert b.owns_deploy is True


@pytest.mark.parametrize("hosted, adopts", [(False, True), (True, False)])
def test_watchdog_boot_adoption(monkeypatch, hosted, adopts):
    # Local adopts a running deployment at boot; hosted must not, or it would
    # undeploy a local Start within one interval.
    monkeypatch.setattr(deps, "auth_enabled", lambda: hosted)
    b = _broker("on", 0, owns=not adopts)
    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(asyncio.wait_for(deps._run_mt5_idle_watchdog(b), 0.05))
    assert b.owns_deploy is adopts

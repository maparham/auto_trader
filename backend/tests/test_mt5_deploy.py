"""Deploy-lifecycle tests: the account must NEVER be auto-deployed (deploying
re-starts MetaApi billing) — a paused (undeployed) account raises MT5PausedError
from _ensure(); only the explicit resume() deploys."""

import asyncio

import pytest

from auto_trader.brokers.mt5 import MT5Broker, MT5PausedError


class _FakeAcct:
    """SDK MetatraderAccount stand-in. `state` mirrors the SDK's locally-tracked
    attribute; `reload()` refreshes it from `reload_state` (what MetaApi's REST
    API would report)."""

    def __init__(self, state="UNDEPLOYED", reload_state=None):
        self.state = state
        self._reload_state = reload_state if reload_state is not None else state
        self.deploy_calls = 0
        self.undeploy_calls = 0
        self.reload_calls = 0

    async def reload(self):
        self.reload_calls += 1
        self.state = self._reload_state

    async def deploy(self):
        self.deploy_calls += 1
        self.state = "DEPLOYING"

    async def undeploy(self):
        self.undeploy_calls += 1
        self.state = "UNDEPLOYING"


def _broker(acct) -> MT5Broker:
    b = MT5Broker(token="t", account_id="a")
    b._api = object()  # sentinel: skips MetaApi client construction in _ensure
    b._acct = acct
    return b


def test_ensure_raises_paused_instead_of_deploying():
    acct = _FakeAcct(state="UNDEPLOYED")
    broker = _broker(acct)
    with pytest.raises(MT5PausedError):
        asyncio.run(broker._ensure())
    assert acct.deploy_calls == 0  # the whole point: no silent re-deploy
    assert acct.reload_calls == 1  # one reload to notice a dashboard redeploy


def test_ensure_reload_detects_external_redeploy():
    # Stale local state says UNDEPLOYED but MetaApi reports DEPLOYED (user hit
    # deploy in the dashboard): _ensure must proceed past the pause gate. It
    # then fails on the fake's missing wait_connected — that's fine; the gate
    # not raising MT5PausedError is what's under test.
    acct = _FakeAcct(state="UNDEPLOYED", reload_state="DEPLOYED")
    broker = _broker(acct)
    with pytest.raises(AttributeError):  # _FakeAcct has no wait_connected
        asyncio.run(broker._ensure())
    assert acct.deploy_calls == 0


def test_deploy_state_maps_sdk_states():
    for sdk_state, ui in [
        ("DEPLOYED", "on"),
        ("DEPLOYING", "turning-on"),
        ("UNDEPLOYING", "turning-off"),
        ("UNDEPLOYED", "off"),
        ("CREATED", "off"),
    ]:
        broker = _broker(_FakeAcct(state=sdk_state))
        assert asyncio.run(broker.deploy_state()) == ui, sdk_state


def test_pause_undeploys_and_drops_connection():
    acct = _FakeAcct(state="DEPLOYED")
    broker = _broker(acct)
    broker._synced = True  # pretend a live RPC connection existed
    state = asyncio.run(broker.pause())
    assert acct.undeploy_calls == 1
    assert state == "turning-off"
    assert broker._synced is False and broker._conn is None


def test_pause_is_idempotent_when_already_off():
    acct = _FakeAcct(state="UNDEPLOYED")
    broker = _broker(acct)
    assert asyncio.run(broker.pause()) == "off"
    assert acct.undeploy_calls == 0


def test_resume_deploys_only_when_needed():
    acct = _FakeAcct(state="UNDEPLOYED")
    broker = _broker(acct)
    assert asyncio.run(broker.resume()) == "turning-on"
    assert acct.deploy_calls == 1

    already = _FakeAcct(state="DEPLOYED")
    broker2 = _broker(already)
    assert asyncio.run(broker2.resume()) == "on"
    assert already.deploy_calls == 0

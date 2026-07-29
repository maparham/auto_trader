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

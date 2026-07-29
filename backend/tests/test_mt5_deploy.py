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


class _StubConn:
    """Minimal connection stand-in so the drop-connection assertion is real
    (previously `_conn` was never non-None, so `assert broker._conn is None`
    passed trivially without exercising `_close_connections`)."""

    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


def test_pause_undeploys_and_drops_connection():
    acct = _FakeAcct(state="DEPLOYED")
    broker = _broker(acct)
    broker._synced = True  # pretend a live RPC connection existed
    conn = _StubConn()
    broker._conn = conn  # a real stub so the drop below is meaningfully exercised
    state = asyncio.run(broker.pause())
    assert acct.undeploy_calls == 1
    assert state == "turning-off"
    assert broker._synced is False and broker._conn is None
    assert conn.closed is True


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


# --- paused hint on the read path (_bounded) --------------------------------
# Important #1: while paused, `_bounded` must fast-fail as MT5PausedError (not
# spin forever as "reconnecting") and the rebuild path that discovers the pause
# must not treat it as a reconnect failure.


def test_bounded_raises_paused_when_hint_set():
    broker = _broker(_FakeAcct(state="UNDEPLOYED"))
    broker._paused_hint = True
    with pytest.raises(MT5PausedError):
        asyncio.run(broker._bounded(lambda c: c.get_positions()))


def test_bounded_without_hint_still_times_out_connecting(monkeypatch):
    # Sanity check the hint is what changed the behaviour, not the un-synced gate
    # itself: with no hint set, the pre-existing "still connecting" TimeoutException
    # path is untouched. This also kicks a background rebuild (_trigger_rebuild_if_
    # idle), so — same as the rebuild test below — _account_unlocked is monkeypatched
    # to avoid constructing a real MetaApi client/socket off a bare "t" token.
    from metaapi_cloud_sdk.clients.timeout_exception import TimeoutException

    acct = _FakeAcct(state="UNDEPLOYED")

    async def _fake_account_unlocked(self):
        self._acct = acct
        return acct

    monkeypatch.setattr(MT5Broker, "_account_unlocked", _fake_account_unlocked)

    broker = _broker(acct)
    with pytest.raises(TimeoutException):
        asyncio.run(broker._bounded(lambda c: c.get_positions()))


def test_rebuild_on_paused_account_sets_hint_and_does_not_count_as_failure(
    monkeypatch,
):
    acct = _FakeAcct(state="UNDEPLOYED")  # stays paused through reload

    async def _fake_account_unlocked(self):
        self._acct = acct
        return acct

    monkeypatch.setattr(MT5Broker, "_account_unlocked", _fake_account_unlocked)

    broker = _broker(acct)
    broker._rebuild_fails = 3  # pretend prior unrelated wedge failures happened
    asyncio.run(broker._rebuild(broker._gen, broker._conn))

    assert broker._paused_hint is True
    assert broker._rebuild_fails == 3  # unchanged — a pause is not a reconnect failure
    assert broker._state == "OK"  # rebuild always releases the RECONNECTING gate


def test_resume_resets_backoff():
    # Important #2: a long pause maxes out _rebuild_fails, so without a reset the
    # first reconnect attempt after clicking Start could be delayed up to
    # RECONNECT_BACKOFF_MAX (300s).
    acct = _FakeAcct(state="UNDEPLOYED")
    broker = _broker(acct)
    broker._paused_hint = True
    broker._rebuild_fails = 6  # near/at the backoff cap
    broker._last_rebuild_at = 12345.0  # some stale past monotonic timestamp

    asyncio.run(broker.resume())

    assert broker._paused_hint is False
    assert broker._rebuild_fails == 0
    assert broker._last_rebuild_at == float("-inf")

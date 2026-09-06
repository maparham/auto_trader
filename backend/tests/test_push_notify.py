"""Web push: `notifier` unit tests (send-per-subscription, muting, dead
endpoint pruning), `vapid_public` stability, and the
`/api/alerts/push/*` router endpoints."""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from py_vapid import Vapid01
from pywebpush import WebPushException

from auto_trader.api.app import app
from auto_trader.core import push_notify as push_notify_mod
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.push_notify import PUSH
from tests import clerk_fake

client = TestClient(app)


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


@pytest.fixture
def store(tmp_path):
    return AlertStore(str(tmp_path / "alerts.db"))


@pytest.fixture(autouse=True)
def _reset_push():
    """PUSH is a module singleton; every test configures it explicitly and
    this fixture guarantees it's disabled again afterward so no state (keys,
    store) leaks into an unrelated test."""
    yield
    PUSH.configure(None)


def _sync(coro):
    return asyncio.run(coro)


class _Recorder:
    def __init__(self, raise_exc: Exception | None = None):
        self.calls: list[dict] = []
        self.raise_exc = raise_exc

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self.raise_exc is not None:
            raise self.raise_exc
        return "ok"


class _FakeResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code
        self.text = ""


PAYLOAD = {
    "id": "al-1", "broker": "capital", "epic": "US100", "kind": "price_level",
    "price": 100.5, "level": 100.0, "condition": "crossing",
    "message": "hit", "precision": 2, "notify": {"push": True},
}


# --- notifier ---------------------------------------------------------


@pytest.mark.anyio
async def test_notifier_sends_one_webpush_per_subscription(store, monkeypatch):
    PUSH.configure(store)
    await store.add_push_sub("alice", "https://push.example/a", {"p256dh": "x", "auth": "y"})
    await store.add_push_sub("alice", "https://push.example/b", {"p256dh": "x2", "auth": "y2"})
    recorder = _Recorder()
    monkeypatch.setattr(push_notify_mod, "webpush", recorder)

    await PUSH.notifier("alice", PAYLOAD)

    assert len(recorder.calls) == 2
    endpoints = {c["subscription_info"]["endpoint"] for c in recorder.calls}
    assert endpoints == {"https://push.example/a", "https://push.example/b"}
    body = json.loads(recorder.calls[0]["data"])
    assert body["epic"] == "US100"
    assert body["message"] == "hit"
    # Must be a Vapid01 object, not the raw PEM string — see
    # test_vapid_private_pem_is_consumable_by_real_vapid_signer for why.
    assert isinstance(recorder.calls[0]["vapid_private_key"], Vapid01)


@pytest.mark.anyio
async def test_notifier_skips_when_muted(store, monkeypatch):
    PUSH.configure(store)
    await store.add_push_sub("alice", "https://push.example/a", {"p256dh": "x", "auth": "y"})
    recorder = _Recorder()
    monkeypatch.setattr(push_notify_mod, "webpush", recorder)

    payload = {**PAYLOAD, "notify": {"push": False}}
    await PUSH.notifier("alice", payload)

    assert recorder.calls == []


@pytest.mark.anyio
async def test_notifier_prunes_dead_endpoint_on_410(store, monkeypatch):
    PUSH.configure(store)
    await store.add_push_sub("alice", "https://push.example/dead", {"p256dh": "x", "auth": "y"})
    recorder = _Recorder(raise_exc=WebPushException("gone", response=_FakeResponse(410)))
    monkeypatch.setattr(push_notify_mod, "webpush", recorder)

    await PUSH.notifier("alice", PAYLOAD)

    subs = await store.list_push_subs("alice")
    assert subs == []


@pytest.mark.anyio
async def test_notifier_prunes_dead_endpoint_on_404(store, monkeypatch):
    PUSH.configure(store)
    await store.add_push_sub("alice", "https://push.example/dead", {"p256dh": "x", "auth": "y"})
    recorder = _Recorder(raise_exc=WebPushException("not found", response=_FakeResponse(404)))
    monkeypatch.setattr(push_notify_mod, "webpush", recorder)

    await PUSH.notifier("alice", PAYLOAD)

    subs = await store.list_push_subs("alice")
    assert subs == []


@pytest.mark.anyio
async def test_notifier_keeps_subscription_on_other_error(store, monkeypatch):
    PUSH.configure(store)
    await store.add_push_sub("alice", "https://push.example/flaky", {"p256dh": "x", "auth": "y"})
    recorder = _Recorder(raise_exc=WebPushException("server error", response=_FakeResponse(500)))
    monkeypatch.setattr(push_notify_mod, "webpush", recorder)

    await PUSH.notifier("alice", PAYLOAD)

    subs = await store.list_push_subs("alice")
    assert len(subs) == 1


@pytest.mark.anyio
async def test_notifier_noop_without_subscriptions(store, monkeypatch):
    PUSH.configure(store)
    recorder = _Recorder()
    monkeypatch.setattr(push_notify_mod, "webpush", recorder)

    await PUSH.notifier("alice", PAYLOAD)

    assert recorder.calls == []


# --- error logging doesn't leak the endpoint (finding 4) -----------------


@pytest.mark.anyio
async def test_notifier_server_error_log_has_no_exc_info_or_full_endpoint(store, monkeypatch, caplog):
    endpoint = "https://push.example/very-long-secret-looking-path-that-should-not-appear-in-full"
    PUSH.configure(store)
    await store.add_push_sub("alice", endpoint, {"p256dh": "x", "auth": "y"})
    recorder = _Recorder(raise_exc=WebPushException("server error", response=_FakeResponse(500)))
    monkeypatch.setattr(push_notify_mod, "webpush", recorder)

    with caplog.at_level("WARNING", logger="auto_trader.core.push_notify"):
        await PUSH.notifier("alice", PAYLOAD)

    assert caplog.records
    for record in caplog.records:
        assert record.exc_info is None
        assert endpoint not in record.getMessage()


@pytest.mark.anyio
async def test_notifier_unexpected_exception_log_has_no_exc_info_or_full_endpoint(store, monkeypatch, caplog):
    endpoint = "https://push.example/another-very-long-secret-looking-endpoint-path"
    PUSH.configure(store)
    await store.add_push_sub("alice", endpoint, {"p256dh": "x", "auth": "y"})
    recorder = _Recorder(raise_exc=RuntimeError("boom"))
    monkeypatch.setattr(push_notify_mod, "webpush", recorder)

    with caplog.at_level("WARNING", logger="auto_trader.core.push_notify"):
        await PUSH.notifier("alice", PAYLOAD)

    assert caplog.records
    for record in caplog.records:
        assert record.exc_info is None
        assert endpoint not in record.getMessage()


# --- vapid_public -------------------------------------------------------


@pytest.mark.anyio
async def test_vapid_public_stable_across_calls(store):
    PUSH.configure(store)

    key1 = await PUSH.vapid_public()
    key2 = await PUSH.vapid_public()

    assert key1
    assert key1 == key2


@pytest.mark.anyio
async def test_vapid_private_pem_is_consumable_by_real_vapid_signer(store):
    # Regression: pywebpush's own string handling for vapid_private_key
    # (`Vapid01.from_string`) assumes a bare base64 key, not PEM armor, and
    # fails to deserialize the PEM this module persists — the notifier must
    # not hand pywebpush that raw string (see push_notify._send). This test
    # goes straight at the stored PEM with the real py_vapid signer, no
    # `webpush` monkeypatching, so a regression can't hide behind the
    # recorder-based notifier tests above.
    PUSH.configure(store)
    private_pem, _public_b64 = await push_notify_mod.PUSH._keys()

    vapid = Vapid01.from_pem(private_pem.encode("utf8"))
    headers = vapid.sign({"sub": "mailto:alerts@auto-trader.local", "aud": "https://push.example"})

    assert "Authorization" in headers


@pytest.mark.anyio
async def test_vapid_public_persisted_across_reconfigure(store):
    PUSH.configure(store)
    key1 = await PUSH.vapid_public()

    # Simulate a fresh process: reconfigure clears the in-memory cache, but
    # the keypair is read back from the store rather than regenerated.
    PUSH.configure(store)
    key2 = await PUSH.vapid_public()

    assert key1 == key2


# --- router --------------------------------------------------------------


@pytest.fixture
def routed_store(store, monkeypatch):
    import auto_trader.api.routers.alerts as alerts_router
    monkeypatch.setattr(alerts_router, "ALERT_STORE", store)
    return store


def test_vapid_endpoint_returns_nonempty_key(clerk, routed_store):
    PUSH.configure(routed_store)

    res = client.get("/api/alerts/push/vapid", headers=_auth("alice"))

    assert res.status_code == 200
    assert res.json()["key"]


def test_subscribe_then_unsubscribe(clerk, routed_store):
    PUSH.configure(routed_store)
    body = {"endpoint": "https://push.example/sub", "keys": {"p256dh": "x", "auth": "y"}}

    res = client.post("/api/alerts/push/subscribe", json=body, headers=_auth("alice"))
    assert res.status_code == 204

    subs = _sync(routed_store.list_push_subs("alice"))
    assert len(subs) == 1
    assert subs[0]["endpoint"] == "https://push.example/sub"

    res = client.request(
        "DELETE", "/api/alerts/push/subscribe",
        json={"endpoint": "https://push.example/sub"}, headers=_auth("alice"),
    )
    assert res.status_code == 204

    subs = _sync(routed_store.list_push_subs("alice"))
    assert subs == []

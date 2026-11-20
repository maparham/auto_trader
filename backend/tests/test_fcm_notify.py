"""FCM push to the Android app: token storage, notification text, the
notifier (one data message per device, muting, dead-token pruning, OAuth
token caching), and the /api/alerts/fcm and /api/alerts/position-removal
endpoints."""
from __future__ import annotations

import asyncio
import json

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.fcm_notify import FCM, fcm_text
from tests import clerk_fake

client = TestClient(app)


def _sync(coro):
    return asyncio.run(coro)


@pytest.fixture
def store(tmp_path):
    return AlertStore(str(tmp_path / "alerts.db"))


@pytest.fixture(autouse=True)
def _reset_fcm():
    yield
    FCM.configure(None, None)


def _service_account() -> dict:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    return {
        "project_id": "chartkar-test",
        "client_email": "fcm@chartkar-test.iam.gserviceaccount.com",
        "private_key": pem,
        "token_uri": "https://oauth2.googleapis.com/token",
    }


class _Google:
    """Fake oauth2 + FCM endpoints. `gone` tokens answer 404 UNREGISTERED."""

    def __init__(self, gone: set[str] | None = None):
        self.gone = gone or set()
        self.token_calls = 0
        self.sent: list[dict] = []
        self.assertions: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "oauth2.googleapis.com":
            self.token_calls += 1
            form = dict(x.split("=", 1) for x in request.content.decode().split("&"))
            self.assertions.append(form["assertion"])
            return httpx.Response(200, json={"access_token": "ya29.test", "expires_in": 3600})
        body = json.loads(request.content)
        msg = body["message"]
        assert request.headers["authorization"] == "Bearer ya29.test"
        if msg["token"] in self.gone:
            return httpx.Response(404, json={"error": {"status": "NOT_FOUND", "details": [
                {"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": "UNREGISTERED"}]}})
        self.sent.append(msg)
        return httpx.Response(200, json={"name": "projects/chartkar-test/messages/1"})


def _configure(store, google: _Google, sa: dict | None = None):
    http = httpx.AsyncClient(transport=httpx.MockTransport(google.handler))
    FCM.configure(store, sa or _service_account(), http=http)


# ---- store ----

def test_store_registers_lists_and_deletes_tokens(store):
    _sync(store.add_fcm_token("u1", "tok-a"))
    _sync(store.add_fcm_token("u1", "tok-b"))
    _sync(store.add_fcm_token("u1", "tok-a"))  # idempotent
    assert sorted(_sync(store.list_fcm_tokens("u1"))) == ["tok-a", "tok-b"]
    _sync(store.delete_fcm_token("u1", "tok-a"))
    assert _sync(store.list_fcm_tokens("u1")) == ["tok-b"]


def test_store_moves_a_token_to_the_user_who_registers_it_last(store):
    # One phone, two accounts signed in one after the other: only the last owns it.
    _sync(store.add_fcm_token("u1", "tok"))
    _sync(store.add_fcm_token("u2", "tok"))
    assert _sync(store.list_fcm_tokens("u1")) == []
    assert _sync(store.list_fcm_tokens("u2")) == ["tok"]


def test_store_delete_only_touches_the_callers_token(store):
    _sync(store.add_fcm_token("u1", "tok"))
    _sync(store.delete_fcm_token("u2", "tok"))
    assert _sync(store.list_fcm_tokens("u1")) == ["tok"]


# ---- text ----

def test_text_price_alert_matches_the_web_push_wording():
    title, body = fcm_text({"epic": "US100", "condition": "crossing_up", "level": 18000.0,
                            "price": 18001.25, "precision": 2, "message": ""})
    assert title == "🔔 US100"
    assert body == "@ 18000.00 · now 18001.25"


def test_text_price_alert_with_message_and_label():
    t, b = fcm_text({"epic": "US100", "message": "breakout", "price": 1.5, "precision": 1, "level": 1})
    assert b == "breakout · now 1.5"
    t, b = fcm_text({"epic": "EURUSD", "label": "EMA 50", "condition": "crossing_down",
                     "level": 1.08, "price": 1.0799, "precision": 4, "message": ""})
    assert b == "EMA 50 crossed down 1.0800 · now 1.0799"


def test_text_account_and_position():
    t, b = fcm_text({"kind": "account", "account": "Capital live", "headline": "Margin level 118% < 120%",
                     "critical": True, "message": ""})
    assert (t, b) == ("🚨 Capital live", "Margin level 118% < 120%")
    t, b = fcm_text({"kind": "account_status", "status": "unmonitored", "broker": "capital-live:live",
                     "headline": "Not monitored"})
    assert t.startswith("⚠️")
    t, b = fcm_text({"kind": "position", "epic": "US100", "headline": "US100 long near SL", "message": "x"})
    assert (t, b) == ("🔔 US100", "US100 long near SL · x")


# ---- notifier ----

def test_disabled_without_a_service_account(store):
    FCM.configure(store, None)
    assert not FCM.enabled
    _sync(store.add_fcm_token("u1", "tok"))
    _sync(FCM.notifier("u1", {"epic": "US100", "level": 1, "price": 1}))  # no raise, nothing sent


def test_sends_one_data_message_per_device(store):
    g = _Google()
    _configure(store, g)
    _sync(store.add_fcm_token("u1", "tok-a"))
    _sync(store.add_fcm_token("u1", "tok-b"))
    _sync(FCM.notifier("u1", {"id": "a1", "epic": "US100", "broker": "capital", "condition": "crossing",
                              "level": 100.0, "price": 100.5, "precision": 1, "message": ""}))
    assert sorted(m["token"] for m in g.sent) == ["tok-a", "tok-b"]
    m = g.sent[0]
    assert "notification" not in m  # data-only: the app builds the notification
    assert m["android"]["priority"] == "HIGH"
    assert m["data"]["title"] == "🔔 US100"
    assert m["data"]["body"] == "@ 100.0 · now 100.5"
    assert m["data"]["kind"] == "price"
    assert m["data"]["epic"] == "US100"
    assert all(isinstance(v, str) for v in m["data"].values())
    assert g.token_calls == 1  # the access token is cached across sends


def test_service_account_assertion_is_signed_for_fcm(store):
    g = _Google()
    sa = _service_account()
    _configure(store, g, sa)
    _sync(store.add_fcm_token("u1", "tok"))
    _sync(FCM.notifier("u1", {"epic": "US100", "level": 1.0, "price": 1.0}))
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    pub = load_pem_private_key(sa["private_key"].encode(), None).public_key()
    claims = jwt.decode(g.assertions[0], pub, algorithms=["RS256"], audience=sa["token_uri"])
    assert claims["iss"] == sa["client_email"]
    assert claims["scope"] == "https://www.googleapis.com/auth/firebase.messaging"


def test_position_fire_carries_the_remove_token(store):
    g = _Google()
    _configure(store, g)
    _sync(store.add_fcm_token("u1", "tok"))
    _sync(FCM.notifier("u1", {"id": "p1", "kind": "position", "epic": "US100", "side": "sl",
                              "removeToken": "abcd1234", "headline": "US100 long near SL"}))
    d = g.sent[0]["data"]
    assert d["kind"] == "position"
    assert d["side"] == "sl"
    assert d["removeToken"] == "abcd1234"


def test_muted_push_channel_sends_nothing(store):
    g = _Google()
    _configure(store, g)
    _sync(store.add_fcm_token("u1", "tok"))
    _sync(FCM.notifier("u1", {"epic": "US100", "level": 1.0, "price": 1.0, "notify": {"push": False}}))
    assert g.sent == [] and g.token_calls == 0


def test_unregistered_token_is_pruned(store):
    g = _Google(gone={"dead"})
    _configure(store, g)
    _sync(store.add_fcm_token("u1", "dead"))
    _sync(store.add_fcm_token("u1", "live"))
    _sync(FCM.notifier("u1", {"epic": "US100", "level": 1.0, "price": 1.0}))
    assert _sync(store.list_fcm_tokens("u1")) == ["live"]


def test_a_failing_send_never_raises(store):
    def boom(_req):
        raise httpx.ConnectError("proxy down")
    FCM.configure(store, _service_account(), http=httpx.AsyncClient(transport=httpx.MockTransport(boom)))
    _sync(store.add_fcm_token("u1", "tok"))
    _sync(FCM.notifier("u1", {"epic": "US100", "level": 1.0, "price": 1.0}))


# ---- endpoints ----

@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


def test_register_and_unregister_endpoints(clerk, store, monkeypatch):
    from auto_trader.api.routers import alerts as alerts_router
    monkeypatch.setattr(alerts_router, "ALERT_STORE", store)
    r = client.post("/api/alerts/fcm/register", json={"token": "tok"}, headers=_auth("user_x"))
    assert r.status_code == 204
    assert _sync(store.list_fcm_tokens("user_x")) == ["tok"]
    r = client.request("DELETE", "/api/alerts/fcm/register", json={"token": "tok"}, headers=_auth("user_x"))
    assert r.status_code == 204
    assert _sync(store.list_fcm_tokens("user_x")) == []


def test_register_rejects_an_empty_token(clerk):
    r = client.post("/api/alerts/fcm/register", json={"token": ""}, headers=_auth("user_x"))
    assert r.status_code == 422


class _FakeRemoval:
    def __init__(self, refuse: bool = False):
        self.refuse = refuse
        self.removed: list[tuple[str, str]] = []

    async def describe(self, user_id: str, token: str):
        from auto_trader.core.telegram_notify import RemovalRefused
        if self.refuse:
            raise RemovalRefused("Dealing from alerts is not allowed for this account")
        if token != "good":
            return None
        return "Remove SL on US100 long (SL 18210.0) · Capital live?"

    async def remove(self, user_id: str, token: str) -> str:
        self.removed.append((user_id, token))
        return "SL removed ✓"


def test_position_removal_endpoints(clerk, monkeypatch):
    from auto_trader.api.routers import alerts as alerts_router
    fake = _FakeRemoval()
    monkeypatch.setattr(alerts_router, "_position_removal", lambda: fake)
    r = client.get("/api/alerts/position-removal/good", headers=_auth("user_x"))
    assert r.status_code == 200
    assert r.json() == {"question": "Remove SL on US100 long (SL 18210.0) · Capital live?"}
    r = client.get("/api/alerts/position-removal/stale", headers=_auth("user_x"))
    assert r.status_code == 404
    r = client.post("/api/alerts/position-removal/good", headers=_auth("user_x"))
    assert r.status_code == 200
    assert r.json() == {"answer": "SL removed ✓"}
    assert fake.removed == [("user_x", "good")]


def test_position_removal_refused_by_the_dealing_gate(clerk, monkeypatch):
    from auto_trader.api.routers import alerts as alerts_router
    monkeypatch.setattr(alerts_router, "_position_removal", lambda: _FakeRemoval(refuse=True))
    r = client.get("/api/alerts/position-removal/good", headers=_auth("user_x"))
    assert r.status_code == 403
    assert "not allowed" in r.json()["detail"]

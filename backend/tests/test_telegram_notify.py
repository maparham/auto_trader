"""Telegram delivery: `send`/`notifier` unit tests, the link-code claim flow
through `run_poller`, and the `/api/alerts/telegram/*` router endpoints."""
from __future__ import annotations

import asyncio
import contextlib
import json

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.core import telegram_notify as telegram_notify_mod
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.telegram_notify import TELEGRAM
from tests import clerk_fake

client = TestClient(app)

TOKEN = "123:ABC-token"


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def _auth(sub: str) -> dict:
    return {"Authorization": f"Bearer {clerk_fake.make_token(sub=sub)}"}


@pytest.fixture
def store(tmp_path):
    return AlertStore(str(tmp_path / "alerts.db"))


@pytest.fixture(autouse=True)
def _reset_telegram():
    """TELEGRAM is a module singleton; every test configures it explicitly
    and this fixture guarantees it's disabled again afterward so no state
    (token, pending codes) leaks into an unrelated test."""
    yield
    TELEGRAM.configure(None, None)


async def _wait_until(predicate, timeout=2.0, interval=0.01) -> bool:
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if await predicate():
            return True
        await asyncio.sleep(interval)
    return False


def _sync(coro):
    """Run a store coroutine from a plain (non-async) test function driving
    the app through the sync TestClient."""
    return asyncio.run(coro)


# --- send / notifier -----------------------------------------------------


@respx.mock
@pytest.mark.anyio
async def test_send_posts_sendmessage(store):
    TELEGRAM.configure(TOKEN, store)
    route = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    await TELEGRAM.send("999", "hello")

    assert route.called
    body = json.loads(route.calls.last.request.content)
    assert body == {"chat_id": "999", "text": "hello"}


@respx.mock
@pytest.mark.anyio
async def test_notifier_skips_when_muted(store):
    TELEGRAM.configure(TOKEN, store)
    await store.set_telegram("alice", "chat-1")
    route = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    await TELEGRAM.notifier(
        "alice",
        {
            "epic": "US100", "message": "", "level": 100.0, "price": 100.5,
            "precision": 2, "notify": {"telegram": False},
        },
    )

    assert not route.called


@respx.mock
@pytest.mark.anyio
async def test_notifier_skips_when_not_linked(store):
    TELEGRAM.configure(TOKEN, store)
    route = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    await TELEGRAM.notifier(
        "alice",
        {
            "epic": "US100", "message": "", "level": 100.0, "price": 100.5,
            "precision": 2, "notify": {"telegram": True},
        },
    )

    assert not route.called


@respx.mock
@pytest.mark.anyio
async def test_notifier_sends_when_linked(store):
    TELEGRAM.configure(TOKEN, store)
    await store.set_telegram("alice", "chat-1")
    route = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    await TELEGRAM.notifier(
        "alice",
        {
            "epic": "US100", "message": "broke out", "level": 100.0, "price": 100.456,
            "precision": 2, "notify": {"telegram": True},
        },
    )

    assert route.called
    body = json.loads(route.calls.last.request.content)
    assert body["chat_id"] == "chat-1"
    assert body["text"] == "🔔 US100 broke out @ 100.00 · now 100.46"


@respx.mock
@pytest.mark.anyio
async def test_notifier_default_channel_on_when_absent(store):
    """`notify.telegram` defaults True when the key is missing entirely (the
    documented `payload["notify"].get("telegram", True)` default)."""
    TELEGRAM.configure(TOKEN, store)
    await store.set_telegram("alice", "chat-1")
    route = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    await TELEGRAM.notifier(
        "alice",
        {"epic": "US100", "message": "", "level": 1.0, "price": 1.0, "precision": 2, "notify": {}},
    )

    assert route.called


# --- link-code claim flow, via run_poller ---------------------------------


def _updates_batch(chat_id: int, text: str):
    """First `getUpdates` call returns one batch with the given message; every
    call after that blocks (mirrors Telegram's real long-poll: it holds the
    connection open ~`timeout` seconds when there's nothing new) until the
    test cancels the poller task — never returns instantly, so the poller
    can't spin hot against the mock."""
    calls = {"n": 0}

    async def _updates(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": [{"update_id": 1, "message": {"chat": {"id": chat_id}, "text": text}}],
                },
            )
        await asyncio.sleep(3600)
        raise AssertionError("unreachable: poller should have been cancelled first")

    return _updates


@respx.mock
@pytest.mark.anyio
async def test_poller_claims_valid_link_code(store):
    TELEGRAM.configure(TOKEN, store)
    code = TELEGRAM.new_link_code("alice")

    respx.get(f"https://api.telegram.org/bot{TOKEN}/getUpdates").mock(
        side_effect=_updates_batch(555, f"/start {code}")
    )
    send_route = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    task = asyncio.create_task(TELEGRAM.run_poller())
    try:
        found = await _wait_until(lambda: _linked(store, "alice"))
        assert found, "poller never claimed the link code"
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    assert await store.get_telegram("alice") == "555"
    assert send_route.called
    confirm = json.loads(send_route.calls.last.request.content)
    assert confirm == {"chat_id": "555", "text": "✅ Alerts connected."}


async def _linked(store, user_id: str) -> bool:
    return await store.get_telegram(user_id) is not None


@respx.mock
@pytest.mark.anyio
async def test_poller_rejects_expired_code(store):
    TELEGRAM.configure(TOKEN, store)
    code = TELEGRAM.new_link_code("alice")
    user_id, _expiry = TELEGRAM._codes[code]
    TELEGRAM._codes[code] = (user_id, 0.0)  # force expired

    respx.get(f"https://api.telegram.org/bot{TOKEN}/getUpdates").mock(
        side_effect=_updates_batch(555, f"/start {code}")
    )
    send_route = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    task = asyncio.create_task(TELEGRAM.run_poller())
    try:
        found = await _wait_until(lambda: _called(send_route))
        assert found, "poller never replied to the expired code"
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    assert await store.get_telegram("alice") is None
    reply = json.loads(send_route.calls.last.request.content)
    assert reply == {
        "chat_id": "555",
        "text": "Link code expired — generate a new one in the app.",
    }


async def _called(route) -> bool:
    return route.called


@pytest.mark.anyio
async def test_run_poller_returns_immediately_when_disabled(store):
    TELEGRAM.configure(None, store)
    await asyncio.wait_for(TELEGRAM.run_poller(), timeout=1.0)


@respx.mock
@pytest.mark.anyio
async def test_poller_floor_bounds_request_rate_on_instant_empty_responses(store, monkeypatch):
    """An empty getUpdates that comes back INSTANTLY (e.g. a proxy/LB
    stripping the long-poll `timeout` param) must not let the loop busy-spin
    re-requesting as fast as the round-trip allows — the iteration floor
    (patched way down here so the test itself stays fast) caps the rate."""
    monkeypatch.setattr(telegram_notify_mod, "_MIN_POLL_ITERATION_SECONDS", 0.1)
    TELEGRAM.configure(TOKEN, store)

    route = respx.get(f"https://api.telegram.org/bot{TOKEN}/getUpdates").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": []})
    )

    task = asyncio.create_task(TELEGRAM.run_poller())
    try:
        await asyncio.sleep(0.2)
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    # Without the floor this would run into the hundreds/thousands in 0.2s;
    # with a 0.1s floor, at most ~3 iterations fit.
    assert route.call_count <= 3


# --- router ----------------------------------------------------------------


@pytest.fixture
def routed_store(store, monkeypatch):
    import auto_trader.api.routers.alerts as alerts_router
    monkeypatch.setattr(alerts_router, "ALERT_STORE", store)
    return store


@respx.mock
def test_telegram_link_returns_deep_link(clerk, routed_store):
    TELEGRAM.configure(TOKEN, routed_store)
    respx.get(f"https://api.telegram.org/bot{TOKEN}/getMe").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {"username": "AutoTraderBot"}})
    )

    res = client.post("/api/alerts/telegram/link", headers=_auth("alice"))

    assert res.status_code == 200
    url = res.json()["url"]
    assert url.startswith("https://t.me/AutoTraderBot?start=")


def test_telegram_link_503_without_token(clerk, routed_store):
    TELEGRAM.configure(None, routed_store)

    res = client.post("/api/alerts/telegram/link", headers=_auth("alice"))

    assert res.status_code == 503


def test_telegram_status_round_trip(clerk, routed_store):
    TELEGRAM.configure(TOKEN, routed_store)

    res = client.get("/api/alerts/telegram", headers=_auth("alice"))
    assert res.json() == {"linked": False, "enabled": True}

    _sync(routed_store.set_telegram("alice", "chat-1"))

    res = client.get("/api/alerts/telegram", headers=_auth("alice"))
    assert res.json() == {"linked": True, "enabled": True}


@respx.mock
def test_telegram_test_endpoint_sends_and_404s_when_unlinked(clerk, routed_store):
    TELEGRAM.configure(TOKEN, routed_store)
    route = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    res = client.post("/api/alerts/telegram/test", headers=_auth("alice"))
    assert res.status_code == 404

    _sync(routed_store.set_telegram("alice", "chat-1"))

    res = client.post("/api/alerts/telegram/test", headers=_auth("alice"))
    assert res.status_code == 204
    assert route.called
    body = json.loads(route.calls.last.request.content)
    assert body == {"chat_id": "chat-1", "text": "🔔 Test alert from Auto Trader"}


def test_telegram_unlink(clerk, routed_store):
    TELEGRAM.configure(TOKEN, routed_store)
    _sync(routed_store.set_telegram("alice", "chat-1"))

    res = client.delete("/api/alerts/telegram", headers=_auth("alice"))
    assert res.status_code == 204

    res = client.get("/api/alerts/telegram", headers=_auth("alice"))
    assert res.json()["linked"] is False

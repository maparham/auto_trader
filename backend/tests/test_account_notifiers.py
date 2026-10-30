"""Telegram and push branches for account alerts: text only, siren on
critical, no chart snapshot, no position lines, no buttons."""
from __future__ import annotations

import asyncio
import json

import httpx
import respx

from auto_trader.core.alert_store import AlertStore
from auto_trader.core.push_notify import PUSH
from auto_trader.core.telegram_notify import TELEGRAM

TOKEN = "123:ABC-token"


def _acct_payload(**kw):
    base = {"id": "al-1", "broker": "capital-live:live", "epic": "", "kind": "account",
            "price": 118.4, "level": 120, "condition": "below", "message": "", "precision": 2,
            "notify": {"telegram": True, "push": True}, "metric": "marginLevel", "tierLabel": "danger",
            "account": "capital-live:live", "critical": False, "time": 1_700_000_000_000,
            "headline": "MARGIN LEVEL 118.4% < 120% (danger) · Capital live · equity 4,210 EUR"}
    base.update(kw)
    return base


def _with_telegram(tmp_path):
    store = AlertStore(str(tmp_path / "a.db"))
    asyncio.run(store.set_telegram("u1", "chat-9"))
    TELEGRAM.configure(TOKEN, store, hooks=None)
    return store


@respx.mock
def test_telegram_account_fire_is_text_only(tmp_path):
    _with_telegram(tmp_path)
    send = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True}))
    photo = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendPhoto")
    try:
        asyncio.run(TELEGRAM.notifier("u1", _acct_payload()))
    finally:
        TELEGRAM.configure(None, None)
    assert send.called and not photo.called
    body = json.loads(send.calls[0].request.content)
    assert body["text"].startswith("🔔 MARGIN LEVEL 118.4% < 120% (danger)")
    assert "reply_markup" not in body


@respx.mock
def test_telegram_critical_gets_siren_and_status_message_sends(tmp_path):
    _with_telegram(tmp_path)
    send = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True}))
    try:
        asyncio.run(TELEGRAM.notifier("u1", _acct_payload(tierLabel="critical", critical=True)))
        asyncio.run(TELEGRAM.notifier("u1", {
            "kind": "account_status", "status": "unmonitored", "notify": {"telegram": True},
            "headline": "Capital live is not being monitored: session dropped", "broker": "capital-live:live"}))
    finally:
        TELEGRAM.configure(None, None)
    texts = [json.loads(c.request.content)["text"] for c in send.calls]
    assert texts[0].startswith("🚨")
    assert "not being monitored" in texts[1]


def test_push_body_carries_headline(tmp_path, monkeypatch):
    store = AlertStore(str(tmp_path / "a.db"))
    asyncio.run(store.add_push_sub("u1", "https://push.example/ep", {"p256dh": "k", "auth": "a"}))
    PUSH.configure(store)
    sent: list[str] = []

    async def fake_send(self, store_, user_id, sub, body, pem):
        sent.append(body)

    monkeypatch.setattr(type(PUSH), "_send", fake_send)
    monkeypatch.setattr(type(PUSH), "_keys", lambda self: _keys())
    asyncio.run(PUSH.notifier("u1", _acct_payload(critical=True)))
    body = json.loads(sent[0])
    assert body["kind"] == "account" and body["headline"].startswith("MARGIN LEVEL")
    assert body["critical"] is True and body["account"] == "capital-live:live"


async def _keys():
    return "pem", "pub"

"""Rich Telegram alerts: chart-snapshot photo messages, position-context
caption lines, inline buttons (re-arm / snooze / delete), the callback
authorization path, and the engine's snooze gate."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import respx

from auto_trader.core.alert_engine import AlertEngine
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.models import Candle
from auto_trader.core.telegram_notify import TELEGRAM, AlertHooks

TOKEN = "123:ABC-token"
_T0 = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def store(tmp_path):
    return AlertStore(str(tmp_path / "alerts.db"))


@pytest.fixture(autouse=True)
def _reset_telegram():
    yield
    TELEGRAM.configure(None, None)


def _candles(n=30):
    return [
        Candle(time=_T0 + timedelta(minutes=15 * i), open=100 + i, high=101 + i,
               low=99 + i, close=100.5 + i)
        for i in range(n)
    ]


def _payload(**kw):
    base = {
        "id": "al-1", "broker": "capital", "epic": "US100", "kind": "price_level",
        "price": 100.5, "level": 100.0, "condition": "crossing_up",
        "message": "", "precision": 2, "notify": {"telegram": True},
        "trigger": "every", "timeframe": "MINUTE_15", "triggered_id": 7,
    }
    base.update(kw)
    return base


class _Recorder:
    """AlertHooks whose every callable records its invocation and returns a
    configurable canned result."""

    def __init__(self, candles=None, positions=None):
        self.calls: list[tuple] = []
        self._candles = candles if candles is not None else _candles()
        self._positions = positions or []
        self.rearm_result: dict | Exception = {"id": "al-1"}
        self.delete_result = True

    def hooks(self) -> AlertHooks:
        async def get_candles(broker, epic, timeframe, count):
            self.calls.append(("candles", broker, epic, timeframe, count))
            return self._candles

        async def get_positions(broker, epic):
            self.calls.append(("positions", broker, epic))
            return self._positions

        async def rearm(user_id, row):
            self.calls.append(("rearm", user_id, row))
            if isinstance(self.rearm_result, Exception):
                raise self.rearm_result
            return self.rearm_result

        def snooze(user_id, alert_id, seconds):
            self.calls.append(("snooze", user_id, alert_id, seconds))

        async def delete(user_id, alert_id):
            self.calls.append(("delete", user_id, alert_id))
            return self.delete_result

        return AlertHooks(
            get_candles=get_candles, get_positions=get_positions,
            rearm=rearm, snooze=snooze, delete=delete,
        )


# ---- notifier: photo, caption, buttons ---------------------------------------


@respx.mock
@pytest.mark.anyio
async def test_notifier_sends_photo_with_buttons(store):
    rec = _Recorder()
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())
    await store.set_telegram("alice", "chat-1")
    photo = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendPhoto").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    await TELEGRAM.notifier("alice", _payload())

    assert photo.called
    req = photo.calls.last.request
    assert b"\x89PNG" in req.content  # a real rendered chart went out
    assert b"crossed up 100.00" in req.content  # caption
    markup = json.loads(_multipart_field(req, "reply_markup"))
    datas = [b["callback_data"] for b in markup["inline_keyboard"][0]]
    assert datas == ["sn:al-1", "del:al-1"]


@respx.mock
@pytest.mark.anyio
async def test_once_alert_gets_rearm_button(store):
    rec = _Recorder()
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())
    await store.set_telegram("alice", "chat-1")
    photo = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendPhoto").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    await TELEGRAM.notifier("alice", _payload(trigger="once", triggered_id=42))

    markup = json.loads(_multipart_field(photo.calls.last.request, "reply_markup"))
    assert markup["inline_keyboard"][0] == [
        {"text": "🔁 Re-arm", "callback_data": "ra:42"}
    ]


@respx.mock
@pytest.mark.anyio
async def test_snapshot_failure_falls_back_to_text(store):
    rec = _Recorder(candles=[])  # no candles -> no snapshot
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())
    await store.set_telegram("alice", "chat-1")
    text = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    await TELEGRAM.notifier("alice", _payload())

    assert text.called
    body = json.loads(text.calls.last.request.content)
    assert body["text"].startswith("🔔 US100 crossed up 100.00")
    assert body["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == "sn:al-1"


@respx.mock
@pytest.mark.anyio
async def test_position_lines_in_caption(store):
    rec = _Recorder(
        candles=[],
        positions=[{"side": "BUY", "quantity": 2.0, "open_level": 99.5, "upnl": 21.5, "env": "demo"}],
    )
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())
    await store.set_telegram("alice", "chat-1")
    text = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    await TELEGRAM.notifier("alice", _payload())

    body = json.loads(text.calls.last.request.content)
    assert "🟢 Long 2.0 from 99.50 · P&L +21.50 (demo)" in body["text"]


@respx.mock
@pytest.mark.anyio
async def test_no_hooks_still_sends_plain_text(store):
    """Configured without hooks (e.g. older wiring / tests): the notifier
    degrades to exactly the plain-text behavior — no photo, no buttons."""
    TELEGRAM.configure(TOKEN, store)
    await store.set_telegram("alice", "chat-1")
    text = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": {}})
    )

    await TELEGRAM.notifier("alice", _payload())

    body = json.loads(text.calls.last.request.content)
    assert "reply_markup" not in body


# ---- live snapshot preferred over matplotlib ----------------------------------


@pytest.mark.anyio
async def test_live_snapshot_preferred(monkeypatch, store):
    rec = _Recorder()
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())

    async def fake_live(user_id, payload):
        assert user_id == "u1"
        return b"LIVE-PNG"

    monkeypatch.setattr(
        "auto_trader.core.chart_snapshot.render_live_chart", fake_live
    )
    png = await TELEGRAM._render_snapshot("u1", _payload())
    assert png == b"LIVE-PNG"


@pytest.mark.anyio
async def test_falls_back_to_matplotlib_when_live_none(monkeypatch, store):
    rec = _Recorder()
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())

    async def fake_live(user_id, payload):
        return None

    monkeypatch.setattr(
        "auto_trader.core.chart_snapshot.render_live_chart", fake_live
    )
    png = await TELEGRAM._render_snapshot("u1", _payload())
    assert png is not None and png != b"LIVE-PNG"  # matplotlib image bytes


@pytest.mark.anyio
async def test_live_snapshot_used_without_hooks(monkeypatch, store):
    """The live path needs no hooks — only the matplotlib fallback does."""
    TELEGRAM.configure(TOKEN, store)

    async def fake_live(user_id, payload):
        return b"LIVE-PNG"

    monkeypatch.setattr(
        "auto_trader.core.chart_snapshot.render_live_chart", fake_live
    )
    png = await TELEGRAM._render_snapshot("u1", _payload())
    assert png == b"LIVE-PNG"


@pytest.mark.anyio
async def test_live_snapshot_raise_falls_back_to_matplotlib(monkeypatch, store):
    rec = _Recorder()
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())

    async def fake_live(user_id, payload):
        raise RuntimeError("boom")

    monkeypatch.setattr(
        "auto_trader.core.chart_snapshot.render_live_chart", fake_live
    )
    png = await TELEGRAM._render_snapshot("u1", _payload())
    assert png is not None and png != b"LIVE-PNG"


# ---- callbacks ---------------------------------------------------------------


def _callback(data: str, chat_id: str = "chat-1") -> dict:
    return {
        "id": "cq-1", "data": data,
        "message": {"chat": {"id": chat_id}, "message_id": 5},
    }


def _mock_callback_endpoints():
    answer = respx.post(f"https://api.telegram.org/bot{TOKEN}/answerCallbackQuery").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": True})
    )
    edit = respx.post(f"https://api.telegram.org/bot{TOKEN}/editMessageReplyMarkup").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": True})
    )
    return answer, edit


@respx.mock
@pytest.mark.anyio
async def test_snooze_callback_routes_to_hook(store):
    rec = _Recorder()
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())
    await store.set_telegram("alice", "chat-1")
    answer, _ = _mock_callback_endpoints()

    await TELEGRAM._handle_update({"callback_query": _callback("sn:al-9")})

    assert ("snooze", "alice", "al-9", 3600.0) in rec.calls
    assert json.loads(answer.calls.last.request.content)["text"] == "💤 Snoozed for 1 hour."


@respx.mock
@pytest.mark.anyio
async def test_delete_callback_clears_buttons(store):
    rec = _Recorder()
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())
    await store.set_telegram("alice", "chat-1")
    _, edit = _mock_callback_endpoints()

    await TELEGRAM._handle_update({"callback_query": _callback("del:al-9")})

    assert ("delete", "alice", "al-9") in rec.calls
    assert edit.called  # buttons removed after a successful delete


@respx.mock
@pytest.mark.anyio
async def test_unlinked_chat_is_refused(store):
    rec = _Recorder()
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())
    answer, _ = _mock_callback_endpoints()

    await TELEGRAM._handle_update({"callback_query": _callback("del:al-9", chat_id="stranger")})

    assert not any(c[0] == "delete" for c in rec.calls)
    assert "isn't linked" in json.loads(answer.calls.last.request.content)["text"]


@respx.mock
@pytest.mark.anyio
async def test_rearm_callback_recreates_from_triggered_row(store):
    rec = _Recorder()
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())
    await store.set_telegram("alice", "chat-1")
    alert_row = {"id": "al-1", "broker": "capital", "epic": "US100",
                 "params": {"level": 100.0, "condition": "crossing", "trigger": "once"},
                 "expires_at": None}
    rowid = await store.add_triggered("alice", {
        "time": 1, "alert_id": "al-1", "broker": "capital", "epic": "US100",
        "kind": "price_level", "price": 100.5, "level": 100.0,
        "condition": "crossing", "alert_json": json.dumps(alert_row),
    })
    answer, edit = _mock_callback_endpoints()

    await TELEGRAM._handle_update({"callback_query": _callback(f"ra:{rowid}")})

    assert ("rearm", "alice", alert_row) in rec.calls
    assert json.loads(answer.calls.last.request.content)["text"] == "🔁 Re-armed ✓"
    assert edit.called


@respx.mock
@pytest.mark.anyio
async def test_rearm_wrong_user_refused(store):
    """A triggered row belonging to another user can't be re-armed from this
    chat, even with a valid rowid."""
    rec = _Recorder()
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())
    await store.set_telegram("alice", "chat-1")
    rowid = await store.add_triggered("bob", {
        "time": 1, "alert_id": "al-1", "broker": "capital", "epic": "US100",
        "kind": "price_level", "price": 100.5, "level": 100.0,
        "condition": "crossing", "alert_json": "{}",
    })
    answer, _ = _mock_callback_endpoints()

    await TELEGRAM._handle_update({"callback_query": _callback(f"ra:{rowid}")})

    assert not any(c[0] == "rearm" for c in rec.calls)
    assert "Can't re-arm" in json.loads(answer.calls.last.request.content)["text"]


@respx.mock
@pytest.mark.anyio
async def test_rearm_duplicate_id_answers_already(store):
    rec = _Recorder()
    rec.rearm_result = ValueError("exists")
    TELEGRAM.configure(TOKEN, store, hooks=rec.hooks())
    await store.set_telegram("alice", "chat-1")
    rowid = await store.add_triggered("alice", {
        "time": 1, "alert_id": "al-1", "broker": "capital", "epic": "US100",
        "kind": "price_level", "price": 100.5, "level": 100.0,
        "condition": "crossing",
        "alert_json": json.dumps({"id": "al-1", "expires_at": None}),
    })
    answer, _ = _mock_callback_endpoints()

    await TELEGRAM._handle_update({"callback_query": _callback(f"ra:{rowid}")})

    assert json.loads(answer.calls.last.request.content)["text"] == "Already re-armed ✓"


# ---- engine snooze gate ------------------------------------------------------


def test_snoozed_alert_does_not_fire(tmp_path):
    from tests.test_alert_engine import make_engine, row

    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(trigger="every"))
        eng.on_alert_changed("u1", created, "al-1")
        eng.snooze("u1", "al-1", 3600)
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)  # would fire
        assert notified == []
        # Snooze lapsed: the same crossing fires again.
        eng._snoozed[("u1", "al-1")] = 0
        await eng.on_tick("capital", "US100", 99.0, None, None)
        await eng.on_tick("capital", "US100", 101.0, None, None)
        assert len(notified) == 1
    asyncio.run(main())


# ---- multipart helper --------------------------------------------------------


def _multipart_field(request: httpx.Request, name: str) -> str:
    """Extract one form field's value from a multipart request body."""
    body = request.content
    marker = f'name="{name}"'.encode()
    idx = body.find(marker)
    assert idx != -1, f"field {name!r} not in multipart body"
    start = body.find(b"\r\n\r\n", idx) + 4
    end = body.find(b"\r\n--", start)
    return body[start:end].decode()

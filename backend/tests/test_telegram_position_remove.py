"""Position alerts on Telegram: the fired message's Remove SL/TP button, the
confirm message (Yes / Cancel), and every refusal path of the removal hook.

The removal hook runs for real (`PositionRemoval` over a real PositionWatch
with a fake exec broker and an injected clock); Telegram HTTP is respx."""
from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone

import httpx
import pytest
import respx

from auto_trader.api.alert_hooks import PositionRemoval
from auto_trader.api.auth import can_deal_from_telegram
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.models import Candle, OrderResult, OrderStatus, Position, Side
from auto_trader.core.position_watch import PositionWatch
from auto_trader.core.telegram_notify import TELEGRAM, AlertHooks

TOKEN = "123:ABC-token"
ACCT = "capital-live:live"
NOW = 1_000_000.0 * 900
API = f"https://api.telegram.org/bot{TOKEN}"


@pytest.fixture(autouse=True)
def _reset_telegram(monkeypatch):
    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)
    monkeypatch.delenv("ADMIN_USER_IDS", raising=False)
    monkeypatch.setenv("SNAPSHOT_DISABLED", "1")
    yield
    TELEGRAM.configure(None, None)


def _bars(n=20, rng=10.0):
    return [
        Candle(time=datetime.fromtimestamp(NOW - (n - i) * 900, tz=timezone.utc),
               open=100.0, high=100.0 + rng / 2, low=100.0 - rng / 2, close=100.0)
        for i in range(n)
    ]


class FakeExec:
    def __init__(self):
        self.positions = [Position(epic="US100", side=Side.BUY, quantity=1, open_level=120.0,
                                   deal_id="D1", stop_level=100.0, take_profit_level=150.0,
                                   upnl=-84.2)]
        self.fail_positions: Exception | None = None
        self.modify_calls: list[tuple[str, dict]] = []
        self.modify_result = OrderResult(client_order_id="c", status=OrderStatus.FILLED)
        self.modify_raise: Exception | None = None

    async def get_positions(self, epic=None):
        if self.fail_positions:
            raise self.fail_positions
        return list(self.positions)

    async def modify_position(self, deal_id, **kw):
        self.modify_calls.append((deal_id, kw))
        if self.modify_raise:
            raise self.modify_raise
        return self.modify_result


class FakeEngine:
    def set_extra_feeds(self, owner, pairs):
        pass


class H:
    """A PositionWatch with one long US100 deal (SL 100, TP 150, ATR 10),
    TELEGRAM wired with real removal hooks, alice linked to chat-1."""

    def __init__(self, tmp_path):
        self.store = AlertStore(str(tmp_path / "alerts.db"))
        self.exec = FakeExec()
        self.now = NOW
        self.notified: list[dict] = []
        self.deleted: list[tuple[str, str]] = []
        self.w = PositionWatch()
        self.w.configure(
            store=self.store, get_exec=lambda k: self.exec, broadcast=self._bcast,
            notifiers=[self._notify], load_bars=self._load_bars, engine=FakeEngine(),
            clock=lambda: self.now,
        )
        self.removal = PositionRemoval(
            watch=self.w, get_exec=lambda k: self.exec, delete=self._delete,
            can_deal=can_deal_from_telegram,
        )

    async def _bcast(self, uid, msg): pass
    async def _notify(self, uid, p): self.notified.append(p)

    async def _load_bars(self, broker, epic, res, side, count):
        return _bars(), False

    async def _delete(self, user_id, alert_id):
        self.deleted.append((user_id, alert_id))
        ok = await self.store.delete(user_id, alert_id)
        self.w.on_alert_changed(user_id, None, alert_id)
        return ok

    def hooks(self) -> AlertHooks:
        async def get_candles(broker, epic, timeframe, count):
            return _bars(60)

        async def get_positions(broker, epic):
            return []

        async def rearm(user_id, row):
            return None

        def snooze(user_id, alert_id, seconds):
            pass

        return AlertHooks(
            get_candles=get_candles, get_positions=get_positions, rearm=rearm,
            snooze=snooze, delete=self._delete,
            describe_removal=self.removal.describe, remove_level=self.removal.remove,
        )

    async def setup(self, side="sl"):
        TELEGRAM.configure(TOKEN, self.store, hooks=self.hooks())
        await self.store.set_telegram("alice", "chat-1")
        row = {"id": f"p-{side}", "broker": ACCT, "epic": "US100", "kind": "position",
               "params": {"dealId": "D1", "side": side, "atrMult": 0.5}, "message": "",
               "expires_at": None, "notify": {"push": False, "telegram": False},
               "precision": 1, "active": 1}
        created = await self.store.create("alice", row)
        self.w.on_alert_changed("alice", created, created["id"])
        await self.w.poll_once(ACCT)

    async def fire(self, bid: float) -> dict:
        await self.w.on_tick("capital-live", "US100", bid + 0.5, bid, bid + 1.0)
        await self.w.drain_fires()
        assert self.notified, "the watch did not fire"
        return self.notified[-1]


def _callback(data: str, chat_id: str = "chat-1", message_id: int = 5) -> dict:
    return {"id": "cq-1", "data": data,
            "message": {"chat": {"id": chat_id}, "message_id": message_id}}


def _mock_endpoints():
    ok = httpx.Response(200, json={"ok": True, "result": True})
    return {
        "answer": respx.post(f"{API}/answerCallbackQuery").mock(return_value=ok),
        "edit": respx.post(f"{API}/editMessageReplyMarkup").mock(return_value=ok),
        "send": respx.post(f"{API}/sendMessage").mock(
            return_value=httpx.Response(200, json={"ok": True, "result": {}})),
        "photo": respx.post(f"{API}/sendPhoto").mock(
            return_value=httpx.Response(200, json={"ok": True, "result": {}})),
    }


def _answer(routes) -> str:
    return json.loads(routes["answer"].calls.last.request.content)["text"]


def _multipart_field(request: httpx.Request, name: str) -> str:
    body = request.content
    idx = body.find(f'name="{name}"'.encode())
    assert idx != -1, f"field {name!r} not in multipart body"
    start = body.find(b"\r\n\r\n", idx) + 4
    end = body.find(b"\r\n--", start)
    return body[start:end].decode()


async def _tap(data: str, chat_id: str = "chat-1", message_id: int = 5) -> None:
    await TELEGRAM._handle_update({"callback_query": _callback(data, chat_id, message_id)})


# ---- the fired message ------------------------------------------------------


@respx.mock
@pytest.mark.anyio
async def test_position_fire_has_remove_button(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    payload = await h.fire(104.0)

    await TELEGRAM.notifier("alice", {**payload, "notify": {"telegram": True}})

    req = routes["photo"].calls.last.request
    assert b"\x89PNG" in req.content
    caption = _multipart_field(req, "caption")
    assert caption.startswith("🔔 " + payload["headline"])
    markup = json.loads(_multipart_field(req, "reply_markup"))
    assert markup["inline_keyboard"] == [
        [{"text": "Remove SL", "callback_data": f"pr:{payload['removeToken']}"}]
    ]


@respx.mock
@pytest.mark.anyio
async def test_position_fire_tp_label(tmp_path):
    h = H(tmp_path)
    await h.setup(side="tp")
    routes = _mock_endpoints()
    payload = await h.fire(146.0)

    await TELEGRAM.notifier("alice", {**payload, "notify": {"telegram": True}})

    markup = json.loads(_multipart_field(routes["photo"].calls.last.request, "reply_markup"))
    assert markup["inline_keyboard"][0][0]["text"] == "Remove TP"


@respx.mock
@pytest.mark.anyio
async def test_pr_sends_confirm_message(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]

    await _tap(f"pr:{tok}")

    body = json.loads(routes["send"].calls.last.request.content)
    assert body["chat_id"] == "chat-1"
    assert body["text"] == "Remove SL on US100 long (SL 100.0) · Capital live?"
    assert body["reply_markup"] == {"inline_keyboard": [[
        {"text": "Yes, remove SL", "callback_data": f"pry:{tok}"},
        {"text": "Cancel", "callback_data": f"prn:{tok}"},
    ]]}
    assert h.exec.modify_calls == []
    # Peek only: the token is still there for the Yes tap.
    assert h.w.peek_remove_token(tok) is not None


@respx.mock
@pytest.mark.anyio
async def test_pr_unknown_token_sends_nothing(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()

    await _tap("pr:nosuchtk")

    assert not routes["send"].called
    assert _answer(routes) == "This warning was already used or has expired"


@respx.mock
@pytest.mark.anyio
async def test_cancel_clears_buttons_keeps_token(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]

    await _tap(f"prn:{tok}", message_id=9)

    assert _answer(routes) == "Cancelled"
    edit = json.loads(routes["edit"].calls.last.request.content)
    assert edit["message_id"] == 9 and edit["reply_markup"] == {"inline_keyboard": []}
    assert h.w.peek_remove_token(tok) is not None
    assert h.exec.modify_calls == []


# ---- Yes ---------------------------------------------------------------------


@respx.mock
@pytest.mark.anyio
async def test_confirm_removes_and_deletes_alert(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]

    await _tap(f"pry:{tok}", message_id=9)

    assert h.exec.modify_calls == [("D1", {"clear_stop": True})]
    assert _answer(routes) == "SL removed ✓"
    assert h.deleted == [("alice", "p-sl")]
    assert await h.store.list_user("alice") == []
    edit = json.loads(routes["edit"].calls.last.request.content)
    assert edit["message_id"] == 9 and edit["reply_markup"] == {"inline_keyboard": []}


@respx.mock
@pytest.mark.anyio
async def test_confirm_removes_tp(tmp_path):
    h = H(tmp_path)
    await h.setup(side="tp")
    routes = _mock_endpoints()
    tok = (await h.fire(146.0))["removeToken"]

    await _tap(f"pry:{tok}")

    assert h.exec.modify_calls == [("D1", {"clear_take_profit": True})]
    assert _answer(routes) == "TP removed ✓"


@respx.mock
@pytest.mark.anyio
async def test_confirm_refuses_changed_level(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    h.exec.positions = [replace(h.exec.positions[0], stop_level=98.0)]

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "SL has changed since this warning"
    assert h.exec.modify_calls == []
    assert h.deleted == []


@respx.mock
@pytest.mark.anyio
async def test_confirm_refuses_small_move_under_coarse_precision(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    # Coarse client precision (2) must not hide a real move of the stop.
    t = h.w._tokens[tok]
    h.w._tokens[tok] = t._replace(level=1.08345, precision=2) if hasattr(t, "_replace") else replace(t, level=1.08345, precision=2)
    h.exec.positions = [replace(h.exec.positions[0], stop_level=1.08349)]

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "SL has changed since this warning"
    assert h.exec.modify_calls == []


@respx.mock
@pytest.mark.anyio
async def test_confirm_refuses_closed_position(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    h.exec.positions = []

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "Position is already closed"
    assert h.exec.modify_calls == []


@respx.mock
@pytest.mark.anyio
async def test_confirm_snapshot_failure_is_reported(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    h.exec.fail_positions = RuntimeError("down")

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "Couldn't remove SL: broker unreachable"
    assert h.exec.modify_calls == []


@respx.mock
@pytest.mark.anyio
async def test_confirm_token_single_use(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]

    await _tap(f"pry:{tok}")
    await _tap(f"pry:{tok}")

    assert len(h.exec.modify_calls) == 1
    assert _answer(routes) == "This warning was already used or has expired"


@respx.mock
@pytest.mark.anyio
async def test_refused_confirm_consumes_token(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    h.exec.positions = [replace(h.exec.positions[0], stop_level=98.0)]
    await _tap(f"pry:{tok}")
    h.exec.positions = [replace(h.exec.positions[0], stop_level=100.0)]

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "This warning was already used or has expired"
    assert h.exec.modify_calls == []


@respx.mock
@pytest.mark.anyio
async def test_confirm_refuses_stale_token(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    h.now += 601

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "This warning is too old (over 10 minutes)"
    assert h.exec.modify_calls == []


@respx.mock
@pytest.mark.anyio
async def test_confirm_refuses_wrong_chat(tmp_path):
    h = H(tmp_path)
    await h.setup()
    await h.store.set_telegram("mallory", "chat-2")
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]

    await _tap(f"pry:{tok}", chat_id="chat-2")
    assert _answer(routes) == "This warning was already used or has expired"
    assert h.exec.modify_calls == []
    await _tap(f"pr:{tok}", chat_id="chat-2")
    assert not routes["send"].called

    # Not consumed: the owner can still confirm.
    await _tap(f"pry:{tok}")
    assert _answer(routes) == "SL removed ✓"
    assert len(h.exec.modify_calls) == 1


@respx.mock
@pytest.mark.anyio
async def test_confirm_refuses_non_admin_hosted(tmp_path, monkeypatch):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.example/.well-known/jwks.json")
    monkeypatch.setenv("ADMIN_USER_IDS", "user_other")

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "Removing a stop from Telegram needs your user id in ADMIN_USER_IDS"
    assert h.exec.modify_calls == []


@respx.mock
@pytest.mark.anyio
async def test_confirm_allows_listed_admin_hosted(tmp_path, monkeypatch):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.example/.well-known/jwks.json")
    monkeypatch.setenv("ADMIN_USER_IDS", "user_other, alice")

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "SL removed ✓"


@respx.mock
@pytest.mark.anyio
async def test_pr_refuses_non_admin_hosted_without_consuming(tmp_path, monkeypatch):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.example/.well-known/jwks.json")
    monkeypatch.setenv("ADMIN_USER_IDS", "user_other")

    await _tap(f"pr:{tok}")

    assert _answer(routes) == "Removing a stop from Telegram needs your user id in ADMIN_USER_IDS"
    assert not routes["send"].called
    assert h.w.peek_remove_token(tok) is not None


@respx.mock
@pytest.mark.anyio
async def test_trailing_checked_before_level(tmp_path):
    h = H(tmp_path)
    await h.setup(side="tp")
    routes = _mock_endpoints()
    tok = (await h.fire(146.0))["removeToken"]
    h.exec.positions = [replace(h.exec.positions[0], trailing_stop=True, take_profit_level=155.0)]

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "Trailing stop: remove it in the broker"
    assert h.exec.modify_calls == []


@respx.mock
@pytest.mark.anyio
async def test_modify_timeout_is_unconfirmed(tmp_path, monkeypatch):
    import asyncio

    import auto_trader.api.alert_hooks as hooks_mod

    monkeypatch.setattr(hooks_mod, "_MODIFY_TIMEOUT_S", 0.01)
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]

    async def slow_modify(deal_id, **kw):
        h.exec.modify_calls.append((deal_id, kw))
        await asyncio.sleep(1)

    h.exec.modify_position = slow_modify

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "Couldn't confirm SL removal: check the broker"
    assert h.deleted == []


@respx.mock
@pytest.mark.anyio
async def test_unknown_status_is_unconfirmed(tmp_path):
    h = H(tmp_path)
    await h.setup(side="tp")
    routes = _mock_endpoints()
    tok = (await h.fire(146.0))["removeToken"]
    h.exec.modify_result = OrderResult(client_order_id="c", status=OrderStatus.UNKNOWN,
                                       reason="dropped connection")

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "Couldn't confirm TP removal: check the broker"
    assert h.deleted == []


@respx.mock
@pytest.mark.anyio
async def test_remove_tp_on_trailing_refused_without_broker_call(tmp_path):
    h = H(tmp_path)
    await h.setup(side="tp")
    routes = _mock_endpoints()
    tok = (await h.fire(146.0))["removeToken"]
    h.exec.positions = [replace(h.exec.positions[0], trailing_stop=True)]

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "Trailing stop: remove it in the broker"
    assert h.exec.modify_calls == []


@respx.mock
@pytest.mark.anyio
async def test_broker_rejection_reported(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    h.exec.modify_result = OrderResult(client_order_id="c", status=OrderStatus.REJECTED,
                                       reason="market closed")

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "Couldn't remove SL: market closed"
    assert h.deleted == []


@respx.mock
@pytest.mark.anyio
async def test_broker_exception_reported(tmp_path):
    h = H(tmp_path)
    await h.setup()
    routes = _mock_endpoints()
    tok = (await h.fire(104.0))["removeToken"]
    h.exec.modify_raise = RuntimeError("timeout talking to broker")

    await _tap(f"pry:{tok}")

    assert _answer(routes) == "Couldn't remove SL: timeout talking to broker"
    assert h.deleted == []


@pytest.mark.anyio
async def test_remove_refuses_when_alert_deleted(tmp_path):
    h = H(tmp_path)
    await h.setup()
    payload = await h.fire(104.0)
    await h._delete("alice", "p-sl")
    h.deleted.clear()

    out = await h.removal.remove("alice", payload["removeToken"])

    assert out == "This alert was deleted"
    assert h.exec.modify_calls == []


# ---- the real delete hook ---------------------------------------------------


@pytest.mark.anyio
async def test_delete_hook_tells_position_watch(tmp_path, monkeypatch):
    import auto_trader.api.alert_hooks as hooks_mod

    store = AlertStore(str(tmp_path / "a.db"))
    monkeypatch.setattr(hooks_mod, "ALERT_STORE", store)
    seen: list[tuple] = []

    class Watch:
        def on_alert_changed(self, user_id, row, alert_id):
            seen.append((user_id, row, alert_id))

    monkeypatch.setattr(hooks_mod, "POSITION_WATCH", Watch())

    async def no_broadcast(*a, **k):
        pass

    monkeypatch.setattr(hooks_mod, "_changed_broadcast", no_broadcast)
    await store.create("alice", {"id": "p-1", "broker": ACCT, "epic": "US100", "kind": "position",
                                 "params": {"dealId": "D1", "side": "sl", "atrMult": 0.5},
                                 "message": "", "expires_at": None, "precision": 1, "active": 1,
                                 "notify": {"push": False, "telegram": False}})

    assert await hooks_mod._delete("alice", "p-1") is True
    assert seen == [("alice", None, "p-1")]


def test_can_deal_from_telegram(monkeypatch):
    monkeypatch.delenv("CLERK_JWKS_URL", raising=False)
    assert can_deal_from_telegram("anyone") is True
    monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.example/jwks")
    monkeypatch.setenv("ADMIN_USER_IDS", "a, b")
    assert can_deal_from_telegram("b") is True
    assert can_deal_from_telegram("c") is False
    monkeypatch.setenv("ADMIN_USER_IDS", "")
    assert can_deal_from_telegram("") is False

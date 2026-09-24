"""Telegram delivery: deep-link account linking, long-polling bot updates,
and a DM notifier the alert engine fires alongside toast/push.

Linking flow: the frontend calls `POST /api/alerts/telegram/link`, which mints
a short-lived (10 min) random code via `new_link_code` and returns a
`https://t.me/<bot>?start=<code>` deep link. The user taps it, Telegram opens
a chat with the bot and sends `/start <code>` as the first message.
`run_poller` long-polls `getUpdates`, recognizes that message, resolves the
code back to a `user_id`, and persists the mapping via `AlertStore.set_telegram`
— from then on the chat_id is a stable target for `send`/`notifier`.

`notifier` is the shape the alert engine expects of every entry in its
`notifiers` list (`async (user_id, payload) -> None`, best-effort — a raise is
caught and logged by the engine, never blocks other notifiers). It is a no-op
whenever Telegram isn't configured, the alert's `notify.telegram` is off, or
the user hasn't linked a chat.

This module owns its own `httpx.AsyncClient` (configured with the bot token
baked into the base path) rather than taking one as a dependency — same
choice `nobitex.py`/`oanor.py` make for their API clients.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx

from auto_trader.core.timeframe import TimeframeError, label

log = logging.getLogger(__name__)

_LINK_CODE_TTL_SECONDS = 600
_POLL_TIMEOUT_SECONDS = 50
_POLL_ERROR_BACKOFF_SECONDS = 5
# Real Telegram long-polls: an empty getUpdates normally blocks server-side for
# ~_POLL_TIMEOUT_SECONDS before returning, which throttles the loop for free.
# A misbehaving proxy/LB (or anything else that strips the `timeout` query
# param) could return instantly instead, and with no updates there's no other
# await in the loop body — that would busy-spin re-requesting as fast as the
# round-trip allows. This floor enforces a minimum wall-clock time per empty
# iteration regardless of how fast the response actually came back. A module
# constant (not inlined) so tests can monkeypatch it down to ~0.
_MIN_POLL_ITERATION_SECONDS = 1.0

# Chart snapshot shape: bars rendered, and the fallback timeframe for alerts
# created before the frontend started recording one.
_SNAPSHOT_BARS = 120
_DEFAULT_TIMEFRAME = "MINUTE_15"
_SNOOZE_SECONDS = 3600.0
# Telegram caps callback_data at 64 bytes; an id-carrying button that would
# exceed it is simply omitted (only reachable with unusually long legacy ids).
_CALLBACK_DATA_MAX = 64

_CONDITION_LABELS = {
    "crossing": "crossed",
    "crossing_up": "crossed up",
    "crossing_down": "crossed down",
    "greater": "above",
    "less": "below",
}

# Broker `side` -> (icon, word) for the open-position caption lines.
_SIDE_LABELS = {
    "BUY": ("🟢", "Long"),
    "SELL": ("🔴", "Short"),
}

_TIMEFRAME_LABELS = {
    "MINUTE": "1m", "MINUTE_5": "5m", "MINUTE_15": "15m", "MINUTE_30": "30m",
    "HOUR": "1h", "HOUR_4": "4h", "DAY": "1D", "WEEK": "1W",
}


def _timeframe_label(timeframe: str) -> str:
    """Caption label: the historical wording for natives, the grammar label for
    anything else, the raw string when neither applies."""
    if timeframe in _TIMEFRAME_LABELS:
        return _TIMEFRAME_LABELS[timeframe]
    try:
        return label(timeframe)
    except TimeframeError:
        return timeframe


def _format_fired_time(payload: dict) -> str:
    """UTC firing timestamp for the caption (`YYYY-MM-DD HH:MM:SS UTC`).

    The engine stamps `payload["time"]` (ms epoch); older/test payloads may
    lack it, in which case the send moment is used so the caption always
    carries a timestamp. Never raises — a missing, unparsable or
    out-of-range stamp falls back to now."""
    try:
        raw = payload.get("time")
        if isinstance(raw, bool):  # int(True) == 1 would caption 1970
            raise TypeError("bool time")
        ms = int(raw)  # type: ignore[arg-type]
        stamp = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S UTC"
        )
    except (TypeError, ValueError, OverflowError, OSError):
        stamp = datetime.fromtimestamp(time.time(), tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S UTC"
        )
    return stamp


@dataclass
class AlertHooks:
    """The alert-system seams the Telegram layer needs, injected by the app
    lifespan so this module never imports the engine/API layers (no cycles,
    trivially fake-able in tests).

    - `get_candles(broker, epic, timeframe, count)` -> list[Candle] — cached
      candle fetch for the snapshot image.
    - `get_positions(broker, epic)` -> list[dict] — open-position context lines
      ({side, quantity, open_level, upnl, env} per position); return [] to
      suppress.
    - `rearm(user_id, row)` — recreate a fired `once` alert (store + engine +
      tab broadcast); raises ValueError when the id already exists.
    - `snooze(user_id, alert_id, seconds)` — mute an `every` alert's firings.
    - `delete(user_id, alert_id)` -> bool — remove an alert (the hook resolves
      the row's broker/epic itself for the tab broadcast).
    """

    get_candles: Callable[[str, str, str, int], Awaitable[list[Any]]]
    get_positions: Callable[[str, str], Awaitable[list[dict]]]
    rearm: Callable[[str, dict], Awaitable[dict]]
    snooze: Callable[[str, str, float], None]
    delete: Callable[[str, str], Awaitable[bool]]


class TelegramNotify:
    """Singleton (`TELEGRAM` below), configured from `TelegramSettings` +
    `ALERT_STORE` in the app lifespan. Construct + `configure()` are split so
    tests can reconfigure (or disable) it without importing a fresh module."""

    def __init__(self) -> None:
        self._token: str | None = None
        self._store: Any = None
        self._hooks: AlertHooks | None = None
        self._client: httpx.AsyncClient | None = None
        self._bot_username: str | None = None
        # code -> (user_id, expires_at monotonic)
        self._codes: dict[str, tuple[str, float]] = {}
        self._offset: int | None = None

    def configure(
        self, token: str | None, store: Any, *, hooks: AlertHooks | None = None
    ) -> None:
        self._token = token or None
        self._store = store
        self._hooks = hooks
        self._bot_username = None
        self._client = (
            httpx.AsyncClient(base_url="https://api.telegram.org", timeout=65.0)
            if self._token
            else None
        )

    @property
    def enabled(self) -> bool:
        return bool(self._token)

    def new_link_code(self, user_id: str) -> str:
        # Sweep expired, never-claimed codes before minting a new one — keeps
        # this dict from growing unbounded across a long-running process.
        now = time.monotonic()
        for stale in [c for c, (_, expiry) in self._codes.items() if expiry < now]:
            del self._codes[stale]
        code = secrets.token_urlsafe(12)[:12]
        self._codes[code] = (user_id, now + _LINK_CODE_TTL_SECONDS)
        return code

    def _require_client(self) -> httpx.AsyncClient:
        if self._client is None or self._token is None:
            raise RuntimeError("TELEGRAM not configured")
        return self._client

    def _scrub(self, s: str) -> str:
        """Replace the bot token wherever it appears in `s` (e.g. baked into
        the request URL of an httpx exception message) with a redacted
        placeholder, so it never escapes into a log line or a route's error
        response."""
        if not self._token:
            return s
        return s.replace(self._token, "***")

    async def bot_username(self) -> str:
        client = self._require_client()
        if self._bot_username is None:
            try:
                resp = await client.get(f"/bot{self._token}/getMe")
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                # Re-raised as a plain RuntimeError with a scrubbed message —
                # the original httpx exception's str() embeds the full
                # request URL (token included), and this call is reachable
                # from /api/alerts/telegram/link, which would otherwise leak
                # the token into a FastAPI 500 traceback.
                raise RuntimeError(self._scrub(str(exc))) from None
            self._bot_username = resp.json()["result"]["username"]
        return self._bot_username

    async def send(
        self, chat_id: str, text: str, reply_markup: dict | None = None
    ) -> None:
        client = self._require_client()
        body: dict[str, Any] = {"chat_id": chat_id, "text": text}
        if reply_markup is not None:
            body["reply_markup"] = reply_markup
        try:
            resp = await client.post(f"/bot{self._token}/sendMessage", json=body)
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            # Same reasoning as bot_username: reachable from /link and /test
            # routes, so the raised message must never carry the token.
            raise RuntimeError(self._scrub(str(exc))) from None

    async def send_photo(
        self, chat_id: str, png: bytes, caption: str, reply_markup: dict | None = None
    ) -> None:
        client = self._require_client()
        data: dict[str, Any] = {"chat_id": chat_id, "caption": caption}
        if reply_markup is not None:
            data["reply_markup"] = json.dumps(reply_markup)
        try:
            resp = await client.post(
                f"/bot{self._token}/sendPhoto",
                data=data,
                files={"photo": ("chart.png", png, "image/png")},
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(self._scrub(str(exc))) from None

    # ---- the alert notifier (engine pipeline entry) ----

    async def notifier(self, user_id: str, payload: dict) -> None:
        if not self.enabled:
            return
        if not payload.get("notify", {}).get("telegram", True):
            return
        chat_id = await self._store.get_telegram(user_id)
        if chat_id is None:
            return
        caption = await self._build_caption(payload)
        markup = self._buttons_for(payload)

        # Best effort, richest first: photo with the chart snapshot, then plain
        # text with buttons, then bare text. The alert message must go out even
        # when market data or the renderer is down.
        png = await self._render_snapshot(user_id, payload)
        if png is not None:
            try:
                await self.send_photo(chat_id, png, caption, markup)
                return
            except Exception as exc:
                log.warning("telegram sendPhoto failed, falling back to text: %s",
                            self._scrub(str(exc)))
        try:
            await self.send(chat_id, caption, markup)
        except Exception:
            if markup is None:
                raise
            # A malformed keyboard must not eat the notification itself.
            await self.send(chat_id, caption)

    async def _build_caption(self, payload: dict) -> str:
        precision = max(0, min(10, payload.get("precision", 2) or 0))
        level = payload.get("level")
        price = payload.get("price")
        epic = payload.get("epic")
        cond = _CONDITION_LABELS.get(payload.get("condition"), payload.get("condition") or "")
        head = " ".join(p for p in (f"🔔 {epic}", cond, f"{level:.{precision}f}") if p)
        lines = [f"{head} · now {price:.{precision}f}"]
        lines.append(f"🕒 {_format_fired_time(payload)}")
        if payload.get("message"):
            lines.append(str(payload["message"]))
        lines.extend(await self._position_lines(payload, precision))
        return "\n".join(lines)

    async def _position_lines(self, payload: dict, precision: int) -> list[str]:
        """One line per open position on the alert's (broker, epic) — often the
        single most decision-relevant fact when an alert fires. Best effort:
        any failure (broker down, timeout) yields no lines, never a raise."""
        if self._hooks is None:
            return []
        try:
            positions = await asyncio.wait_for(
                self._hooks.get_positions(payload["broker"], payload["epic"]), timeout=3.0
            )
        except Exception as exc:
            log.warning("telegram: position context unavailable: %s", self._scrub(str(exc)))
            return []
        lines = []
        for p in positions:
            side = str(p.get("side", "")).upper()
            icon, word = _SIDE_LABELS.get(side, ("📊", side))
            pnl = p.get("upnl")
            pnl_txt = f" · P&L {pnl:+,.2f}" if isinstance(pnl, (int, float)) else ""
            env = f" ({p['env']})" if p.get("env") else ""
            lines.append(
                f"{icon} {word} {p.get('quantity')} from "
                f"{p.get('open_level'):.{precision}f}{pnl_txt}{env}"
            )
        return lines

    async def _render_snapshot(self, user_id: str, payload: dict) -> bytes | None:
        """Chart snapshot PNG for a firing, or None when anything along the way
        fails — candles unavailable, renderer error — so the caller falls back
        to a text message."""
        # Preferred: the user's real chart, rendered live in a headless
        # browser (chart_snapshot). Any None (no heartbeat, frontend down,
        # timeout, playwright missing) falls through to the matplotlib image.
        try:
            from auto_trader.core import chart_snapshot

            png = await chart_snapshot.render_live_chart(user_id, payload)
            if png is not None:
                return png
        except Exception as exc:
            log.warning(
                "telegram: live chart snapshot for %s/%s failed, falling back: %s",
                payload.get("broker"), payload.get("epic"), self._scrub(str(exc)),
            )

        if self._hooks is None:
            return None
        timeframe = payload.get("timeframe") or _DEFAULT_TIMEFRAME
        precision = max(0, min(10, payload.get("precision", 2) or 0))
        try:
            candles = await asyncio.wait_for(
                self._hooks.get_candles(
                    payload["broker"], payload["epic"], timeframe, _SNAPSHOT_BARS
                ),
                timeout=15.0,
            )
            if not candles:
                return None
            # Imported here (not module top) so this module stays importable
            # without matplotlib in minimal test environments.
            from auto_trader.core.alert_chart import render_alert_chart

            tf_label = _timeframe_label(timeframe)
            cond = _CONDITION_LABELS.get(
                payload.get("condition"), payload.get("condition") or ""
            )
            title = (
                f"{payload['epic']} · {tf_label} · {cond} "
                f"{payload['level']:.{precision}f} @ {payload['price']:.{precision}f} "
                f"· {_format_fired_time(payload)}"
            )
            return await asyncio.to_thread(
                render_alert_chart,
                candles, payload["level"], payload["price"], precision, title,
            )
        except Exception as exc:
            log.warning(
                "telegram: chart snapshot for %s/%s failed, sending text: %s",
                payload.get("broker"), payload.get("epic"), self._scrub(str(exc)),
            )
            return None

    def _buttons_for(self, payload: dict) -> dict | None:
        """Inline keyboard for a firing: Re-arm for `once` alerts (which just
        deleted themselves), Snooze/Delete for `every` alerts. None when hooks
        aren't wired or no button fits Telegram's callback-data cap."""
        if self._hooks is None:
            return None
        row: list[dict] = []
        if payload.get("trigger") == "once":
            triggered_id = payload.get("triggered_id")
            if triggered_id:
                row.append({"text": "🔁 Re-arm", "callback_data": f"ra:{triggered_id}"})
        elif payload.get("trigger") == "every":
            alert_id = payload.get("id", "")
            for label, data in (
                ("💤 Snooze 1h", f"sn:{alert_id}"),
                ("🗑 Delete", f"del:{alert_id}"),
            ):
                if len(data.encode()) <= _CALLBACK_DATA_MAX:
                    row.append({"text": label, "callback_data": data})
        return {"inline_keyboard": [row]} if row else None

    async def run_poller(self) -> None:
        """Long-polls `getUpdates` forever until cancelled. A network/API
        error is logged and backed off (5s) — the loop never dies."""
        if not self.enabled:
            return
        self._offset = None
        while True:
            started = time.monotonic()
            try:
                client = self._require_client()
                params: dict[str, Any] = {"timeout": _POLL_TIMEOUT_SECONDS}
                if self._offset is not None:
                    params["offset"] = self._offset
                resp = await client.get(f"/bot{self._token}/getUpdates", params=params)
                resp.raise_for_status()
                updates = resp.json().get("result", [])
                for update in updates:
                    self._offset = update["update_id"] + 1
                    await self._handle_update(update)
                if not updates:
                    # Normally a no-op: a real empty getUpdates already blocked
                    # ~_POLL_TIMEOUT_SECONDS server-side. Only bites when the
                    # response came back suspiciously fast (see the floor's
                    # docstring above) — the actual anti-busy-spin guard.
                    elapsed = time.monotonic() - started
                    if elapsed < _MIN_POLL_ITERATION_SECONDS:
                        await asyncio.sleep(_MIN_POLL_ITERATION_SECONDS - elapsed)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # No exc_info: the default traceback formatting would include
                # the request URL (token baked in) for an httpx error. Log
                # just the status (when the exception carries one) and a
                # scrubbed message instead.
                status = getattr(getattr(exc, "response", None), "status_code", None)
                log.warning(
                    "telegram poller error: status=%s type=%s msg=%s",
                    status, type(exc).__name__, self._scrub(str(exc)),
                )
                await asyncio.sleep(_POLL_ERROR_BACKOFF_SECONDS)

    async def _handle_update(self, update: dict) -> None:
        if "callback_query" in update:
            await self._handle_callback(update["callback_query"])
            return
        message = update.get("message") or {}
        text = (message.get("text") or "").strip()
        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is None or not text.startswith("/start"):
            return
        code = text[len("/start"):].strip()
        entry = self._codes.pop(code, None)
        if entry is None or entry[1] < time.monotonic():
            await self.send(str(chat_id), "Link code expired — generate a new one in the app.")
            return
        user_id, _expiry = entry
        await self._store.set_telegram(user_id, str(chat_id))
        await self.send(str(chat_id), "✅ Alerts connected.")

    # ---- inline-button callbacks ----

    async def _handle_callback(self, cq: dict) -> None:
        """One inline-button press. Authorization: the pressing chat must map
        back (telegram_links) to a linked user, and id-carrying actions verify
        that user owns the referenced row. Every path answers the callback so
        the client's spinner clears."""
        cq_id = cq.get("id")
        data = cq.get("data") or ""
        message = cq.get("message") or {}
        chat_id = (message.get("chat") or {}).get("id")
        message_id = message.get("message_id")
        if cq_id is None or chat_id is None:
            return
        try:
            answer, clear_buttons = await self._run_callback(str(chat_id), data)
        except Exception as exc:
            log.warning("telegram callback %r failed: %s", data[:16], self._scrub(str(exc)))
            answer, clear_buttons = "Something went wrong — try again.", False
        await self._answer_callback(cq_id, answer)
        if clear_buttons and message_id is not None:
            await self._clear_buttons(str(chat_id), message_id)

    async def _run_callback(self, chat_id: str, data: str) -> tuple[str, bool]:
        """(answer text, clear-the-buttons?) for one callback's data payload."""
        if self._hooks is None:
            return "Alert actions aren't available right now.", False
        user_id = await self._store.get_user_by_chat(chat_id)
        if user_id is None:
            return "This chat isn't linked — reconnect in the app.", False

        action, _, arg = data.partition(":")
        if action == "ra" and arg.isdigit():
            return await self._rearm_from_triggered(user_id, int(arg))
        if action == "sn" and arg:
            self._hooks.snooze(user_id, arg, _SNOOZE_SECONDS)
            return "💤 Snoozed for 1 hour.", False
        if action == "del" and arg:
            deleted = await self._hooks.delete(user_id, arg)
            return ("🗑 Alert deleted." if deleted else "Alert is already gone."), deleted
        return "Unknown action.", False

    async def _rearm_from_triggered(self, user_id: str, rowid: int) -> tuple[str, bool]:
        row = await self._store.get_triggered_row(rowid)
        if row is None or row.get("user_id") != user_id or not row.get("alert_json"):
            return "Can't re-arm this alert any more.", False
        try:
            alert_row = json.loads(row["alert_json"])
        except (TypeError, ValueError):
            return "Can't re-arm this alert any more.", False
        expires_at = alert_row.get("expires_at")
        if expires_at is not None and expires_at <= int(time.time() * 1000):
            return "Alert already expired.", False
        try:
            await self._hooks.rearm(user_id, alert_row)
        except ValueError:
            # Same id already present: the alert exists (double-tap, or it was
            # recreated in the app) — treat as success, clear the button.
            return "Already re-armed ✓", True
        return "🔁 Re-armed ✓", True

    async def _answer_callback(self, cq_id: str, text: str) -> None:
        try:
            client = self._require_client()
            resp = await client.post(
                f"/bot{self._token}/answerCallbackQuery",
                json={"callback_query_id": cq_id, "text": text},
            )
            resp.raise_for_status()
        except Exception as exc:
            log.warning("telegram answerCallbackQuery failed: %s", self._scrub(str(exc)))

    async def _clear_buttons(self, chat_id: str, message_id: int) -> None:
        try:
            client = self._require_client()
            resp = await client.post(
                f"/bot{self._token}/editMessageReplyMarkup",
                json={
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "reply_markup": {"inline_keyboard": []},
                },
            )
            resp.raise_for_status()
        except Exception as exc:
            log.warning("telegram editMessageReplyMarkup failed: %s", self._scrub(str(exc)))


# Module singleton, configured from settings + ALERT_STORE in the app lifespan.
TELEGRAM = TelegramNotify()

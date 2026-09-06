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
import logging
import secrets
import time
from typing import Any

import httpx

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


class TelegramNotify:
    """Singleton (`TELEGRAM` below), configured from `TelegramSettings` +
    `ALERT_STORE` in the app lifespan. Construct + `configure()` are split so
    tests can reconfigure (or disable) it without importing a fresh module."""

    def __init__(self) -> None:
        self._token: str | None = None
        self._store: Any = None
        self._client: httpx.AsyncClient | None = None
        self._bot_username: str | None = None
        # code -> (user_id, expires_at monotonic)
        self._codes: dict[str, tuple[str, float]] = {}
        self._offset: int | None = None

    def configure(self, token: str | None, store: Any) -> None:
        self._token = token or None
        self._store = store
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

    async def send(self, chat_id: str, text: str) -> None:
        client = self._require_client()
        try:
            resp = await client.post(
                f"/bot{self._token}/sendMessage", json={"chat_id": chat_id, "text": text}
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            # Same reasoning as bot_username: reachable from /link and /test
            # routes, so the raised message must never carry the token.
            raise RuntimeError(self._scrub(str(exc))) from None

    async def notifier(self, user_id: str, payload: dict) -> None:
        if not self.enabled:
            return
        if not payload.get("notify", {}).get("telegram", True):
            return
        chat_id = await self._store.get_telegram(user_id)
        if chat_id is None:
            return
        precision = payload.get("precision", 2)
        level = payload.get("level")
        price = payload.get("price")
        epic = payload.get("epic")
        text = (
            f"🔔 {epic} {payload['message'] or ''} @ {level:.{precision}f} · "
            f"now {price:.{precision}f}"
        ).strip()
        await self.send(chat_id, text)

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


# Module singleton, configured from settings + ALERT_STORE in the app lifespan.
TELEGRAM = TelegramNotify()

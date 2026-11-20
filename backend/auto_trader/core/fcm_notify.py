"""FCM delivery to the native Android app (android/), beside Web Push and
Telegram in the alert fan-out.

Each fire goes to every device token the user's app registered
(`/api/alerts/fcm/register`) as a DATA-only, high-priority message: the app
builds the notification itself (`ChartkarMessagingService`), so it can add
the Remove SL / Remove TP button and open the right page on tap. The text
matches the Web Push service worker (`frontend/public/alert-sw.js`).

Auth is FCM HTTP v1 with a Firebase service account: a self-signed RS256
assertion is traded at Google's token endpoint for a one-hour access token,
cached until a minute before it expires. Configured from
`FCM_SERVICE_ACCOUNT_FILE` (a service-account JSON); without it the notifier
is a no-op. On the hosted box every Google host goes through the egress
proxy, so `fcm.googleapis.com` and `oauth2.googleapis.com` must be on its
allowlist.

`notifier` has the alert engine's notifier shape and is best effort: a
failure is logged and never raised. A token FCM reports as unregistered is
deleted.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from decimal import Decimal
from typing import Any

import httpx
import jwt

log = logging.getLogger(__name__)

_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
_DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
_SEND_TIMEOUT_S = 15.0

_CONDITIONS = {
    "crossing": "crossed",
    "crossing_up": "crossed up",
    "crossing_down": "crossed down",
    "greater": "above",
    "less": "below",
}


def _sig6(v: Any) -> str:
    """JS `Number(Number(v).toPrecision(6)).toString()`: 6 significant digits,
    no trailing zeros, no exponent."""
    try:
        return format(Decimal(f"{float(v):.6g}").normalize(), "f")
    except Exception:
        return str(v)


def _fixed(v: Any, prec: int) -> str:
    try:
        return f"{float(v):.{prec}f}"
    except Exception:
        return str(v)


def fcm_text(p: dict) -> tuple[str, str]:
    """(title, body) for one fire, worded as the Web Push service worker."""
    kind = p.get("kind")
    if kind in ("account", "account_status"):
        if kind == "account_status":
            icon = "⚠️" if p.get("status") == "unmonitored" else "✅"
        else:
            icon = "🚨" if p.get("critical") else "🔔"
        name = p.get("account") or p.get("broker") or "Account"
        head = p.get("headline") or ""
        return f"{icon} {name}", (f"{head} · {p['message']}" if p.get("message") else head)
    if kind == "position":
        head = p.get("headline") or ""
        return f"🔔 {p.get('epic')}", (f"{head} · {p['message']}" if p.get("message") else head)
    prec = p.get("precision")
    prec = 2 if prec is None else int(prec)
    cond = _CONDITIONS.get(p.get("condition"), p.get("condition") or "")
    value_target = p.get("target") == "value"
    if p.get("message"):
        detail = str(p["message"])
    elif p.get("label"):
        lvl = _sig6(p.get("level")) if value_target else _fixed(p.get("level"), prec)
        detail = f"{p['label']} {cond} {lvl}"
    else:
        detail = f"@ {_fixed(p.get('level'), prec)}"
    now = _sig6(p.get("subject")) if value_target else _fixed(p.get("price"), prec)
    return f"🔔 {p.get('epic')}", f"{detail} · now {now}"


def _data(payload: dict) -> dict[str, str]:
    """The message's data map. FCM data values must all be strings."""
    title, body = fcm_text(payload)
    kind = payload.get("kind") or "price"
    out = {
        "title": title,
        "body": body,
        "kind": str(kind),
        "id": str(payload.get("id") or ""),
        "epic": str(payload.get("epic") or ""),
        "broker": str(payload.get("broker") or ""),
    }
    if kind == "position":
        if payload.get("side") in ("sl", "tp"):
            out["side"] = payload["side"]
        if payload.get("removeToken"):
            out["removeToken"] = str(payload["removeToken"])
    if payload.get("critical"):
        out["critical"] = "1"
    return out


class FcmNotify:
    """Singleton (`FCM` below), configured in the app lifespan. Construct +
    `configure()` are split so tests can reconfigure or disable it."""

    def __init__(self) -> None:
        self._store: Any = None
        self._sa: dict | None = None
        self._http: httpx.AsyncClient | None = None
        self._token: str | None = None
        self._token_exp = 0.0
        self._lock = asyncio.Lock()

    def configure(self, store: Any, service_account: dict | None, http: httpx.AsyncClient | None = None) -> None:
        self._store = store
        ok = bool(service_account) and all(
            service_account.get(k) for k in ("project_id", "client_email", "private_key")
        )
        self._sa = service_account if ok else None
        self._http = http
        self._token = None
        self._token_exp = 0.0
        self._lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return self._sa is not None and self._store is not None

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            # trust_env: the hosted box reaches Google through HTTPS_PROXY.
            self._http = httpx.AsyncClient(timeout=_SEND_TIMEOUT_S, trust_env=True)
        return self._http

    async def _access_token(self) -> str:
        assert self._sa is not None
        if self._token and time.time() < self._token_exp - 60:
            return self._token
        async with self._lock:
            if self._token and time.time() < self._token_exp - 60:
                return self._token
            sa = self._sa
            token_uri = sa.get("token_uri") or _DEFAULT_TOKEN_URI
            now = int(time.time())
            assertion = jwt.encode(
                {"iss": sa["client_email"], "scope": _SCOPE, "aud": token_uri, "iat": now, "exp": now + 3600},
                sa["private_key"],
                algorithm="RS256",
            )
            r = await self._client().post(
                token_uri,
                data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
            )
            r.raise_for_status()
            body = r.json()
            self._token = body["access_token"]
            self._token_exp = time.time() + float(body.get("expires_in", 3600))
            return self._token

    async def notifier(self, user_id: str, payload: dict) -> None:
        if not self.enabled:
            return
        if not payload.get("notify", {}).get("push", True):
            return
        try:
            tokens = await self._store.list_fcm_tokens(user_id)
            if not tokens:
                return
            access = await self._access_token()
        except Exception as exc:
            log.warning("fcm: no access token (%s)", type(exc).__name__)
            return
        data = _data(payload)
        for t in tokens:
            await self._send(user_id, t, data, access)

    async def _send(self, user_id: str, token: str, data: dict[str, str], access: str) -> None:
        assert self._sa is not None
        url = f"https://fcm.googleapis.com/v1/projects/{self._sa['project_id']}/messages:send"
        message = {"message": {"token": token, "data": data, "android": {"priority": "HIGH"}}}
        try:
            r = await self._client().post(url, json=message, headers={"Authorization": f"Bearer {access}"})
        except Exception as exc:
            log.warning("fcm send failed (%s)", type(exc).__name__)
            return
        if r.status_code == 200:
            return
        if _unregistered(r):
            try:
                await self._store.delete_fcm_token(user_id, token)
            except Exception:
                log.warning("fcm: could not prune a dead token", exc_info=True)
            return
        # The token is a device secret: log only its first characters.
        log.warning("fcm send failed (status %s, token %s)", r.status_code, token[:12])


def _unregistered(r: httpx.Response) -> bool:
    """FCM v1 reports a dead token as 404 NOT_FOUND or 400 with errorCode
    UNREGISTERED / INVALID_ARGUMENT on the token."""
    if r.status_code == 404:
        return True
    try:
        err = r.json().get("error", {})
    except Exception:
        return False
    codes = {d.get("errorCode") for d in err.get("details", []) if isinstance(d, dict)}
    return "UNREGISTERED" in codes


def load_service_account(path: str | None) -> dict | None:
    """The service-account JSON at `path`, or None (feature off) when unset,
    missing or unreadable."""
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        log.warning("fcm: cannot read FCM_SERVICE_ACCOUNT_FILE; FCM push is off")
        return None


FCM = FcmNotify()

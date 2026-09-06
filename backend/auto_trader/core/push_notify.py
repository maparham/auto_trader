"""Web Push delivery: VAPID keypair (generated once, persisted in
`AlertStore` meta), subscription storage, and a pruning notifier the alert
engine fires alongside toast/telegram.

VAPID: browsers require every push subscription to be created against a
stable "application server key" (the VAPID public key, base64url-encoded
raw EC point) so a push service can bind a subscription to this server and
reject forged senders. `vapid_public()` generates a fresh ECDSA keypair via
`py_vapid` on first call and persists both halves in `alert_meta` under the
sentinel user_id `""` (mirroring the "meta" convention `alert_store.py`
documents) — private key as PEM (what `pywebpush.webpush()` wants), public
key as the base64url raw point (what the frontend's
`PushManager.subscribe({applicationServerKey})` wants). Every later call
reads the persisted value back rather than regenerating, so the key handed
to browsers stays stable across restarts.

`notifier` is the same shape the alert engine expects of every entry in its
`notifiers` list (`async (user_id, payload) -> None`, best-effort — a raise
is caught and logged by the engine, never blocks other notifiers). For each
of the user's stored subscriptions it calls `pywebpush.webpush()` (a sync,
blocking network call — dispatched via `asyncio.to_thread`) with the alert
payload as the push body. A subscription the push service reports as gone
(404/410 — the browser unsubscribed, or the endpoint expired) is pruned from
the store; any other delivery error is logged and otherwise ignored, same as
Telegram's best-effort contract.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from py_vapid import Vapid01
from pywebpush import WebPushException, webpush

log = logging.getLogger(__name__)

_VAPID_META_USER = ""
_VAPID_PRIVATE_KEY = "vapid_private"
_VAPID_PUBLIC_KEY = "vapid_public"
_VAPID_CLAIMS = {"sub": "mailto:alerts@auto-trader.local"}


class PushNotify:
    """Singleton (`PUSH` below), configured from `ALERT_STORE` in the app
    lifespan. Construct + `configure()` are split so tests can reconfigure
    it without importing a fresh module."""

    def __init__(self) -> None:
        self._store: Any = None
        self._public_key: str | None = None
        self._private_key_pem: str | None = None
        self._lock = asyncio.Lock()

    def configure(self, store: Any) -> None:
        self._store = store
        self._public_key = None
        self._private_key_pem = None

    def _require_store(self) -> Any:
        if self._store is None:
            raise RuntimeError("PUSH not configured")
        return self._store

    async def _keys(self) -> tuple[str, str]:
        """Returns (private_key_pem, public_key_b64url), generating and
        persisting a keypair on first use."""
        if self._private_key_pem is not None and self._public_key is not None:
            return self._private_key_pem, self._public_key

        store = self._require_store()
        async with self._lock:
            # Re-check inside the lock: a concurrent caller may have already
            # generated (and this call may have already read a stale None).
            if self._private_key_pem is not None and self._public_key is not None:
                return self._private_key_pem, self._public_key

            private_pem = await store.get_meta(_VAPID_META_USER, _VAPID_PRIVATE_KEY)
            public_b64 = await store.get_meta(_VAPID_META_USER, _VAPID_PUBLIC_KEY)
            if private_pem is None or public_b64 is None:
                vapid = Vapid01()
                vapid.generate_keys()
                private_pem = vapid.private_pem().decode("utf8")
                public_b64 = _b64url_public_key(vapid)
                await store.set_meta(_VAPID_META_USER, _VAPID_PRIVATE_KEY, private_pem)
                await store.set_meta(_VAPID_META_USER, _VAPID_PUBLIC_KEY, public_b64)

            self._private_key_pem = private_pem
            self._public_key = public_b64
            return private_pem, public_b64

    async def vapid_public(self) -> str:
        _private_pem, public_b64 = await self._keys()
        return public_b64

    async def notifier(self, user_id: str, payload: dict) -> None:
        if not payload.get("notify", {}).get("push", True):
            return
        store = self._require_store()
        subs = await store.list_push_subs(user_id)
        if not subs:
            return
        private_pem, _public_b64 = await self._keys()
        body = json.dumps(
            {
                "id": payload.get("id"),
                "broker": payload.get("broker"),
                "epic": payload.get("epic"),
                "kind": payload.get("kind"),
                "price": payload.get("price"),
                "level": payload.get("level"),
                "condition": payload.get("condition"),
                "message": payload.get("message"),
                "precision": payload.get("precision"),
            }
        )
        for sub in subs:
            await self._send(store, user_id, sub, body, private_pem)

    async def _send(
        self, store: Any, user_id: str, sub: dict, body: str, private_pem: str
    ) -> None:
        subscription_info = {"endpoint": sub["endpoint"], "keys": sub["keys"]}
        # pywebpush's own PEM-string handling (`Vapid01.from_string`) assumes
        # a bare base64 key (raw or DER), not PEM armor, and fails to
        # deserialize a PEM string — so the private key is decoded into a
        # `Vapid01` instance here (`from_pem`, which does understand armor)
        # and that object is what's handed to `webpush`, not the PEM string.
        vapid = Vapid01.from_pem(private_pem.encode("utf8"))
        try:
            await asyncio.to_thread(
                webpush,
                subscription_info=subscription_info,
                data=body,
                vapid_private_key=vapid,
                vapid_claims=dict(_VAPID_CLAIMS),
            )
        except WebPushException as exc:
            status = exc.status_code
            if status in (404, 410):
                await store.delete_push_sub(user_id, sub["endpoint"])
            else:
                log.warning("web push delivery failed (status %s)", status, exc_info=True)
        except Exception:
            log.warning("web push delivery failed", exc_info=True)


def _b64url_public_key(vapid: Vapid01) -> str:
    from cryptography.hazmat.primitives import serialization
    from py_vapid.utils import b64urlencode

    raw = vapid.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return b64urlencode(raw)


# Module singleton, configured from ALERT_STORE in the app lifespan.
PUSH = PushNotify()

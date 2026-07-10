"""Shared CST/X-SECURITY-TOKEN session-auth lifecycle for Capital.com and IG.

IG is the upstream API Capital.com forked, so both brokers share the same
session model: POST credentials with an API-key header, receive CST +
X-SECURITY-TOKEN tokens that must be sent on every later request, refresh
before the session TTL expires, and transparently re-authenticate on a
mid-flight 401. This base owns that lifecycle; each broker keeps its own
`__init__` (setting `_cst`, `_security_token`, `_authed_at`, `_auth_lock`,
`_api_key`, `_identifier`, `_password`, `_client`, and a `SESSION_TTL` class
attribute) plus its own outer `_request` (the two brokers' outer signatures
differ — IG threads a per-endpoint `version` + `extra_headers` — so `_request`
is NOT unified here; only the retry loop pieces it delegates to are shared).

Per-broker seams (must be overridden by subclasses):
  - `_login_path(self) -> str` — the session POST path.
  - `_login_headers(self) -> dict` — headers for the login POST (API key, etc).
  - `_login_json(self) -> dict` — the login POST body.
  - `_missing_creds_message(self) -> str` — error text when creds are absent.
  - `_capture_login(self, resp) -> None` — stash broker-specific login fields
    (CST/X-SECURITY-TOKEN are captured here already; override to also capture
    e.g. IG's account id / Lightstreamer endpoint).
  - `_auth_headers(self) -> dict` — per-request auth headers.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx

# Retries for a 429 that slips through the caller's own rate limiter (shared
# limit across our own traffic).
_RATE_LIMIT_RETRIES = 3
# POST /session is rate-limited far more tightly than ordinary requests.
# Concurrent chart streams can collide on it, so retry a 429 a few times with a
# growing backoff before giving up.
_SESSION_MAX_RETRIES = 4
_SESSION_RETRY_BACKOFF = 1.0  # seconds; multiplied by the attempt number


class SessionAuthBroker:
    """Mixin providing the shared CST/X-SECURITY-TOKEN session lifecycle.

    Subclasses must set (typically in `__init__`): `_client` (httpx.AsyncClient),
    `_cst`, `_security_token`, `_authed_at`, `_auth_lock` (asyncio.Lock),
    `_api_key`, `_identifier`, `_password`, and a `SESSION_TTL` class attribute.
    """

    SESSION_TTL: "object"  # timedelta; set per-subclass

    # --- seams (override per broker) ---------------------------------------

    def _login_path(self) -> str:
        raise NotImplementedError

    def _login_headers(self) -> dict:
        raise NotImplementedError

    def _login_json(self) -> dict:
        raise NotImplementedError

    def _missing_creds_message(self) -> str:
        raise NotImplementedError

    def _capture_login(self, resp: httpx.Response) -> None:
        self._cst = resp.headers["CST"]
        self._security_token = resp.headers["X-SECURITY-TOKEN"]

    def _auth_headers(self) -> dict:
        raise NotImplementedError

    # --- shared lifecycle ----------------------------------------------------

    def _session_valid(self) -> bool:
        return (
            self._cst is not None
            and self._authed_at is not None
            and datetime.now(timezone.utc) - self._authed_at < self.SESSION_TTL
        )

    async def _ensure_session(self) -> None:
        if self._session_valid():
            return
        async with self._auth_lock:
            if self._session_valid():  # another task may have just authed
                return
            if not (self._api_key and self._identifier and self._password):
                raise RuntimeError(self._missing_creds_message())
            # The session endpoint is rate-limited far more tightly than ordinary
            # requests (a burst returns 429). When several chart streams
            # cold-start or reconnect at once they can collide here even though
            # the auth lock serialises them, so retry a 429 with a short backoff
            # instead of failing the caller (which, for a live stream, turns
            # into a reconnect that just tries the session endpoint again).
            for attempt in range(_SESSION_MAX_RETRIES):
                resp = await self._client.post(
                    self._login_path(),
                    headers=self._login_headers(),
                    json=self._login_json(),
                )
                if resp.status_code == 429 and attempt < _SESSION_MAX_RETRIES - 1:
                    await asyncio.sleep(_SESSION_RETRY_BACKOFF * (attempt + 1))
                    continue
                break
            resp.raise_for_status()
            self._capture_login(resp)
            self._authed_at = datetime.now(timezone.utc)

    async def _reauth(self, stale_cst: str | None) -> None:
        """Force a re-auth after a mid-flight 401, but only if the shared token is
        still the one our failed request used.

        `self._cst` is a process-wide singleton shared by every chart stream and
        request. Unconditionally nulling it on a 401 (the old code) was wrong under
        concurrency: a 401 from the OLD token that lands AFTER another task already
        refreshed would null the fresh token and force a redundant session POST —
        and the session endpoint is rate-limited to ~1/s, so a burst of these
        429-storms (the same bug class already fixed in capital_stream's reconnect
        path).

        Comparing the captured token under the auth lock makes re-auth idempotent:
        only the task whose token is still current invalidates and re-auths; late
        401s see a newer token and skip. _ensure_session() then performs the single
        re-auth or just waits for the in-flight one and returns the valid session."""
        async with self._auth_lock:
            if self._cst == stale_cst:
                self._cst = None
                self._authed_at = None
        await self._ensure_session()

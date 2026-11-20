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
import logging
import time
from datetime import datetime, timezone

import httpx

from auto_trader.core import candle_timing
from auto_trader.core.broker_health import BrokerBlocked, BrokerDown

# Retries for a 429 that slips through the caller's own rate limiter (shared
# limit across our own traffic).
_RATE_LIMIT_RETRIES = 3
# POST /session is rate-limited far more tightly than ordinary requests.
# Concurrent chart streams can collide on it, so retry a 429 a few times with a
# growing backoff before giving up.
_SESSION_MAX_RETRIES = 4
_SESSION_RETRY_BACKOFF = 1.0  # seconds; multiplied by the attempt number
# A call cut off before any answer (cancelled by BrokerHealth's budget, or an
# httpx timeout) can leave its pooled connection held for good, and enough of
# those wedge the client: every later call hangs while the broker itself is
# fine (2026-11-19, 15 h of capital-live timeouts that only a restart fixed).
# After this many cut-off calls with no answer in between, the next call gets
# a fresh client.
_STALL_REBUILD_AFTER = 5
# Only a call that waited this long counts as cut off: a fetch cancelled at
# once (a closed chart, a dropped browser request) says nothing about the
# client. BrokerHealth's budget (8 s) and the pool timeout (5 s) both pass it.
_STALL_MIN_WAIT_S = 4.0
# The replaced client is closed this much later, so calls still in flight on
# it can end; `aclose()` closes any still waiting.
_OLD_CLIENT_CLOSE_DELAY = 300.0
# Connect and pool waits end before BrokerHealth's 8 s budget, so httpx gives
# up on a dead connection itself instead of being cancelled from outside;
# reads keep 30 s for long history pages.
_CLIENT_TIMEOUT = httpx.Timeout(30.0, connect=5.0, pool=5.0)

log = logging.getLogger(__name__)

def raise_if_waf_blocked(resp: httpx.Response) -> None:
    """Classify an HTML error response: a blocked network path or a broker outage.

    The broker APIs only ever answer JSON; an error status carrying `text/html`
    came from the edge in front of them (Capital.com fronts with Incapsula) or a
    captive portal, never the API. A 4xx page is a WAF block or portal: the
    user's network path is refused (BrokerBlocked). A 429 page is the edge
    rate limiting us, not a block, so it falls through to the caller's usual
    status handling. A 5xx page is the edge
    reporting that the API behind it is down (Incapsula answers 503 with
    retry-after during a Capital outage): the broker's fault (BrokerDown), so
    the app must not tell the user to check their network."""
    if resp.status_code < 400:
        return
    if "text/html" not in resp.headers.get("content-type", "").lower():
        return
    if resp.status_code == 429:
        return
    if resp.status_code >= 500:
        raise BrokerDown(
            f"{resp.request.url.host}: the broker's API is down "
            f"(HTTP {resp.status_code} outage page from its edge)"
        )
    raise BrokerBlocked(
        f"{resp.request.url.host}: request blocked before reaching the broker "
        "API (WAF/HTML interstitial) — this network appears to restrict "
        "access to the broker"
    )


class SessionAuthBroker:
    """Mixin providing the shared CST/X-SECURITY-TOKEN session lifecycle.

    Subclasses must set (typically in `__init__`): `_client` (httpx.AsyncClient),
    `_cst`, `_security_token`, `_authed_at`, `_auth_lock` (asyncio.Lock),
    `_api_key`, `_identifier`, `_password`, and a `SESSION_TTL` class attribute.
    """

    SESSION_TTL: "object"  # timedelta; set per-subclass
    # Cut-off calls in a row on the current client (see _send). Class defaults
    # so a broker built without __init__ (tests) has them too.
    _stalls: int = 0
    _close_tasks: "frozenset[asyncio.Task] | set[asyncio.Task]" = frozenset()

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

    def _new_client(self) -> httpx.AsyncClient:
        """The HTTP client for this broker; `__init__` and the rebuild both use it."""
        return httpx.AsyncClient(base_url=self._base_url, timeout=_CLIENT_TIMEOUT)

    async def aclose(self) -> None:
        await self._client.aclose()
        for task in list(self._close_tasks):
            task.cancel()  # its `finally` closes the replaced client now
        await asyncio.gather(*self._close_tasks, return_exceptions=True)

    # --- every upstream call --------------------------------------------------

    async def _send(self, method: str, url: str, **kwargs) -> httpx.Response:
        """`self._client.request`, replacing the client first when it looks
        wedged (see _STALL_REBUILD_AFTER). Every Capital/IG call goes here."""
        if self._stalls >= _STALL_REBUILD_AFTER:
            self._replace_client()
        client = self._client
        started = time.monotonic()
        try:
            resp = await client.request(method, url, **kwargs)
        except (asyncio.CancelledError, httpx.TimeoutException):
            # A call on a client already replaced says nothing about the new one.
            if client is self._client and time.monotonic() - started >= _STALL_MIN_WAIT_S:
                self._stalls += 1
            raise
        if client is self._client:
            self._stalls = 0
        return resp

    def _replace_client(self) -> None:
        old = self._client
        self._client = self._new_client()
        log.warning(
            "%s: %d calls in a row got no answer, using a new HTTP client",
            type(self).__name__, self._stalls,
        )
        self._stalls = 0

        async def close_old() -> None:
            try:
                await asyncio.sleep(_OLD_CLIENT_CLOSE_DELAY)
            finally:
                try:
                    await old.aclose()
                except Exception:  # a wedged client may not close cleanly
                    log.debug("closing the replaced HTTP client failed", exc_info=True)

        # Per instance, never shared: a class-level set would mix brokers.
        if "_close_tasks" not in self.__dict__:
            self._close_tasks = set()
        task = asyncio.get_running_loop().create_task(close_old())
        self._close_tasks.add(task)
        task.add_done_callback(self._close_tasks.discard)

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
        # Timed (lock wait included) into the current /api/candles record, if
        # any: a login another caller started still costs this request.
        with candle_timing.span("auth"):
            await self._login_locked()

    async def _login_locked(self) -> None:
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
                resp = await self._send(
                    "POST",
                    self._login_path(),
                    headers=self._login_headers(),
                    json=self._login_json(),
                )
                if resp.status_code == 429 and attempt < _SESSION_MAX_RETRIES - 1:
                    candle_timing.note("session 429")
                    await asyncio.sleep(_SESSION_RETRY_BACKOFF * (attempt + 1))
                    continue
                break
            raise_if_waf_blocked(resp)
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

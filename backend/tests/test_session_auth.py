"""Session auth funnelling + 429 retry in the Capital.com broker.

Regression coverage for the "chart lags / stops updating" bug: the broker is a
process-wide singleton shared by every open chart's live stream. The stream
reconnect path used to null broker._cst on every drop, which defeated the
auth-lock funnel and made staggered reconnects collide on Capital's tightly
rate-limited POST /api/v1/session (~1/sec -> 429), reconnect-storming. These
tests pin the two guarantees that keep that from recurring:

  - concurrent _ensure_session() calls inside the TTL collapse to ONE POST, and
  - a 429 on /session is retried rather than thrown straight at the caller.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest

import auto_trader.brokers.capital as capital_mod
from auto_trader.brokers.capital import CapitalComBroker


def _make_broker(transport: httpx.MockTransport) -> CapitalComBroker:
    # Bypass __init__'s settings read / real AsyncClient; wire a mock transport
    # and the auth state the session methods touch.
    b = CapitalComBroker.__new__(CapitalComBroker)
    b._api_key = "k"
    b._identifier = "id"
    b._password = "pw"
    b._client = httpx.AsyncClient(base_url="http://t", transport=transport)
    b._cst = None
    b._security_token = None
    b._authed_at = None
    b._auth_lock = asyncio.Lock()
    return b


def _session_ok() -> httpx.Response:
    return httpx.Response(
        200, headers={"CST": "cst-1", "X-SECURITY-TOKEN": "tok-1"}
    )


def test_concurrent_ensure_session_makes_one_post() -> None:
    """N streams reconnecting at once must collapse to a single /session POST.

    This is the funnel the bug defeated. With broker._cst left intact across
    reconnects, simultaneous _ensure_session() callers see the lock + the
    re-check and reuse the one session instead of each POSTing (and 429ing).
    """
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        assert request.url.path == "/api/v1/session"
        calls += 1
        return _session_ok()

    broker = _make_broker(httpx.MockTransport(handler))

    async def run() -> None:
        await asyncio.gather(*(broker._ensure_session() for _ in range(8)))
        await broker.aclose()

    asyncio.run(run())
    assert calls == 1


def test_valid_session_skips_post() -> None:
    """A reconnect inside the 9-min TTL reuses the session: zero /session POSTs.

    This is the direct payoff of NOT nulling broker._cst on reconnect.
    """
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return _session_ok()

    broker = _make_broker(httpx.MockTransport(handler))
    broker._cst = "cst-existing"
    broker._security_token = "tok-existing"
    broker._authed_at = datetime.now(timezone.utc)  # well within SESSION_TTL

    async def run() -> None:
        await broker._ensure_session()
        await broker.aclose()

    asyncio.run(run())
    assert calls == 0


def test_session_429_is_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 429 on /session is retried with backoff, then succeeds — not thrown."""
    # Don't actually sleep through the backoff in the test.
    monkeypatch.setattr(capital_mod.asyncio, "sleep", _no_sleep)
    statuses = iter([429, 429, 200])

    def handler(request: httpx.Request) -> httpx.Response:
        code = next(statuses)
        if code == 200:
            return _session_ok()
        return httpx.Response(429)

    broker = _make_broker(httpx.MockTransport(handler))

    async def run() -> None:
        await broker._ensure_session()
        await broker.aclose()

    asyncio.run(run())
    assert broker._cst == "cst-1"


def test_session_429_exhausted_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """Persistent 429s eventually surface as an error (caller reconnects)."""
    monkeypatch.setattr(capital_mod.asyncio, "sleep", _no_sleep)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429)

    broker = _make_broker(httpx.MockTransport(handler))

    async def run() -> None:
        try:
            with pytest.raises(httpx.HTTPStatusError):
                await broker._ensure_session()
        finally:
            await broker.aclose()

    asyncio.run(run())


async def _no_sleep(*_args, **_kwargs) -> None:
    return None

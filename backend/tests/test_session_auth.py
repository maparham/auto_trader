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


# A trimmed Incapsula/Imperva WAF block page: what Capital's edge serves (as
# text/html) when the client network is restricted. The API itself never
# responds with HTML, so this must be classified as a blocked network path,
# not an auth failure.
_WAF_HTML = (
    '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX">'
    '<script src="/_Incapsula_Resource?SWJIYLWA=deadbeef"></script></head>'
    "<body>Request unsuccessful.</body></html>"
)


def _waf_403() -> httpx.Response:
    return httpx.Response(
        403, headers={"content-type": "text/html"}, content=_WAF_HTML
    )


def test_session_waf_block_raises_broker_blocked() -> None:
    """A WAF/HTML 403 on /session is a blocked network path, not an auth error."""
    from auto_trader.core.broker_health import BrokerBlocked

    broker = _make_broker(httpx.MockTransport(lambda r: _waf_403()))

    async def run() -> None:
        try:
            with pytest.raises(BrokerBlocked):
                await broker._ensure_session()
        finally:
            await broker.aclose()

    asyncio.run(run())


def test_request_waf_block_raises_broker_blocked() -> None:
    """A WAF/HTML 403 on an ordinary API call (session still in TTL) is also
    classified as a blocked network path — the block can start mid-session."""
    from auto_trader.core.broker_health import BrokerBlocked

    broker = _make_broker(httpx.MockTransport(lambda r: _waf_403()))
    broker._cst = "cst-existing"
    broker._security_token = "tok-existing"
    broker._authed_at = datetime.now(timezone.utc)

    class _NoRate:
        async def acquire(self) -> None:
            return None

    broker._rate = _NoRate()

    async def run() -> None:
        try:
            with pytest.raises(BrokerBlocked):
                await broker._request("GET", "/api/v1/accounts")
        finally:
            await broker.aclose()

    asyncio.run(run())


def test_plain_403_is_not_broker_blocked() -> None:
    """A real API 403 (JSON body) must stay an HTTPStatusError — only the
    WAF's HTML page means the network path is blocked."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            headers={"content-type": "application/json"},
            json={"errorCode": "error.invalid.details"},
        )

    broker = _make_broker(httpx.MockTransport(handler))

    async def run() -> None:
        try:
            with pytest.raises(httpx.HTTPStatusError):
                await broker._ensure_session()
        finally:
            await broker.aclose()

    asyncio.run(run())


def test_html_503_is_broker_down_not_blocked() -> None:
    """Incapsula answers 503 + text/html (retry-after) while Capital's API is
    down. That is the broker's outage, not the user's network: BrokerDown,
    never BrokerBlocked, so the app doesn't tell the user to check their
    connection."""
    from auto_trader.core.broker_health import BrokerBlocked, BrokerDown

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            503,
            headers={"content-type": "text/html", "retry-after": "5"},
            content=_WAF_HTML,
        )

    broker = _make_broker(httpx.MockTransport(handler))

    async def run() -> None:
        try:
            with pytest.raises(BrokerDown) as info:
                await broker._ensure_session()
            assert not isinstance(info.value, BrokerBlocked)
        finally:
            await broker.aclose()

    asyncio.run(run())


def test_html_429_is_neither_blocked_nor_down(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 429 page from the edge is rate limiting, not a blocked network: it
    stays an ordinary HTTPStatusError after the session retries run out."""
    monkeypatch.setattr(capital_mod.asyncio, "sleep", _no_sleep)
    from auto_trader.core.broker_health import BrokerBlocked, BrokerDown

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"content-type": "text/html"}, content=_WAF_HTML)

    broker = _make_broker(httpx.MockTransport(handler))

    async def run() -> None:
        try:
            with pytest.raises(httpx.HTTPStatusError) as info:
                await broker._ensure_session()
            assert not isinstance(info.value, (BrokerBlocked, BrokerDown))
        finally:
            await broker.aclose()

    asyncio.run(run())


# --- a wedged client is replaced --------------------------------------------
#
# Incident 2026-11-19: the hosted capital-live client stopped answering. Every
# login POST hung until the breaker's 8 s budget cancelled it, for 15 hours,
# while a fresh curl login from the same box took 1 s. The process held 51
# dead pooled sockets; a restart fixed it. These pin the self-heal: calls cut
# off with no answer are counted, and after enough in a row the next call
# gets a new client.


def _stuck_transport() -> httpx.MockTransport:
    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.Event().wait()  # never answers
        raise AssertionError("unreachable")

    return httpx.MockTransport(handler)


def _ok_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url="http://t", transport=httpx.MockTransport(lambda r: _session_ok())
    )


async def _cut_off_logins(broker: CapitalComBroker, n: int) -> None:
    """n logins, each cancelled by a short budget as BrokerHealth.run does."""
    for _ in range(n):
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(broker._ensure_session(), 0.01)


def test_client_rebuilt_after_calls_cut_off_in_a_row(monkeypatch: pytest.MonkeyPatch) -> None:
    import auto_trader.brokers._session as session_mod

    monkeypatch.setattr(session_mod, "_OLD_CLIENT_CLOSE_DELAY", 0.0)
    monkeypatch.setattr(session_mod, "_STALL_MIN_WAIT_S", 0.0)
    broker = _make_broker(_stuck_transport())
    broker._new_client = _ok_client  # type: ignore[method-assign]
    stuck = broker._client

    async def run() -> None:
        try:
            await _cut_off_logins(broker, session_mod._STALL_REBUILD_AFTER)
            await asyncio.wait_for(broker._ensure_session(), 1.0)
            assert broker._client is not stuck
            assert broker._cst == "cst-1"
            await asyncio.gather(*broker._close_tasks)  # the deferred close
            assert stuck.is_closed
        finally:
            await broker.aclose()

    asyncio.run(run())


def test_an_answer_resets_the_cut_off_count(monkeypatch: pytest.MonkeyPatch) -> None:
    import auto_trader.brokers._session as session_mod

    monkeypatch.setattr(session_mod, "_STALL_MIN_WAIT_S", 0.0)

    answers = {"on": False}

    async def handler(request: httpx.Request) -> httpx.Response:
        if not answers["on"]:
            await asyncio.Event().wait()
        return _session_ok()

    broker = _make_broker(httpx.MockTransport(handler))
    first = broker._client
    broker._new_client = _ok_client  # type: ignore[method-assign]

    async def run() -> None:
        try:
            await _cut_off_logins(broker, session_mod._STALL_REBUILD_AFTER - 1)
            answers["on"] = True
            await broker._ensure_session()  # an answer: the client is fine
            broker._cst = None  # force the next call to log in again
            answers["on"] = False
            await _cut_off_logins(broker, session_mod._STALL_REBUILD_AFTER - 1)
            assert broker._client is first
        finally:
            await broker.aclose()

    asyncio.run(run())


def test_quick_cancels_do_not_count() -> None:
    """A fetch cancelled at once (a closed chart) says nothing about the client."""
    import auto_trader.brokers._session as session_mod

    broker = _make_broker(_stuck_transport())
    first = broker._client

    async def run() -> None:
        try:
            await _cut_off_logins(broker, session_mod._STALL_REBUILD_AFTER + 2)
            assert broker._stalls == 0
            assert broker._client is first
        finally:
            await broker.aclose()

    asyncio.run(run())


def test_late_cut_offs_on_the_old_client_do_not_count(monkeypatch: pytest.MonkeyPatch) -> None:
    """Calls still hung on a replaced client must not count against the new one."""
    import auto_trader.brokers._session as session_mod

    monkeypatch.setattr(session_mod, "_STALL_MIN_WAIT_S", 0.0)
    broker = _make_broker(_stuck_transport())
    broker._new_client = _ok_client  # type: ignore[method-assign]
    stuck = broker._client

    async def run() -> None:
        try:
            # Hung data calls on the stuck client, cut off only after the swap.
            hung = [
                asyncio.ensure_future(broker._send("GET", "/x"))
                for _ in range(session_mod._STALL_REBUILD_AFTER)
            ]
            await asyncio.sleep(0)
            broker._stalls = session_mod._STALL_REBUILD_AFTER
            await broker._send("POST", "/api/v1/session")  # swaps, then answers
            fresh = broker._client
            assert fresh is not stuck
            for t in hung:
                t.cancel()
            await asyncio.gather(*hung, return_exceptions=True)
            assert broker._stalls == 0
            assert broker._client is fresh
        finally:
            await broker.aclose()
        assert stuck.is_closed  # aclose closes the replaced client too

    asyncio.run(run())

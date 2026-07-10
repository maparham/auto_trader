"""Capital.com maps expires_at to goodTillDate (UTC, YYYY-MM-DDTHH:MM:SS, no ms).
There is no timeInForce field — presence of goodTillDate implies GTD."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import httpx

from auto_trader.brokers.capital import (
    CapitalComBroker,
    CapitalExecutionBroker,
    _capital_gtd,
)


def test_capital_gtd_format_no_millis_utc() -> None:
    when = datetime(2022, 6, 9, 1, 1, 0, tzinfo=timezone.utc)
    assert _capital_gtd(when) == "2022-06-09T01:01:00"


def test_capital_gtd_normalizes_to_utc() -> None:
    est = timezone(timedelta(hours=-5))
    when = datetime(2022, 6, 8, 20, 1, 0, tzinfo=est)  # 01:01 UTC next day
    assert _capital_gtd(when) == "2022-06-09T01:01:00"


def _broker(handler) -> CapitalComBroker:
    """A pre-authed CapitalComBroker backed by `handler` (a MockTransport fn), so
    _request skips /session and just issues the dealing call. Mirrors
    test_capital_exec.py's helper."""
    b = CapitalComBroker.__new__(CapitalComBroker)
    b._api_key = "k"
    b._identifier = "id"
    b._password = "pw"
    b._client = httpx.AsyncClient(base_url="http://t", transport=httpx.MockTransport(handler))
    b._cst = "cst-1"
    b._security_token = "tok-1"
    b._authed_at = datetime.now(timezone.utc)
    b._auth_lock = asyncio.Lock()
    from auto_trader.brokers.capital import _RateLimiter, _MAX_REQUESTS_PER_SEC

    b._rate = _RateLimiter(_MAX_REQUESTS_PER_SEC)
    b._market_cache = {}
    b._fx_cache = {}
    return b


def test_get_working_orders_reads_back_expires_at(monkeypatch) -> None:
    """A resting GTD order's goodTillDate must round-trip into WorkingOrder.expires_at
    (C1) — otherwise a level-only UI edit re-sends clear_expiry and silently downgrades
    a live GTD order to GTC."""
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/v1/workingorders":
            return httpx.Response(200, json={"workingOrders": [{
                "workingOrderData": {
                    "dealId": "WOG", "epic": "EPIC1", "direction": "BUY",
                    "orderSize": 1.0, "orderLevel": 90.0,
                    "goodTillDate": "2026-07-11T16:00:00",
                },
            }]})
        raise AssertionError(req.url.path)

    b = _broker(handler)
    ex = CapitalExecutionBroker(b)
    [wo] = asyncio.run(ex.get_working_orders())
    asyncio.run(ex.aclose())
    assert wo.expires_at == datetime(2026, 7, 11, 16, 0, tzinfo=timezone.utc)


def test_get_working_orders_expires_at_none_without_goodtilldate(monkeypatch) -> None:
    """A GTC resting order (no goodTillDate) must read back expires_at=None."""
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/v1/workingorders":
            return httpx.Response(200, json={"workingOrders": [{
                "workingOrderData": {
                    "dealId": "WOC", "epic": "EPIC1", "direction": "BUY",
                    "orderSize": 1.0, "orderLevel": 90.0,
                },
            }]})
        raise AssertionError(req.url.path)

    b = _broker(handler)
    ex = CapitalExecutionBroker(b)
    [wo] = asyncio.run(ex.get_working_orders())
    asyncio.run(ex.aclose())
    assert wo.expires_at is None

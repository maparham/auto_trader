"""Real Capital.com dealing (CapitalExecutionBroker).

Capital dealing is untested upstream of this file; these pin the money-critical
guarantees, several of which are shared with IG via AsyncConfirmExecutionBroker:

  - a non-404 error reading /confirms AFTER a successful submit resolves to a
    STORED UNKNOWN (never an escaped exception), so a retried click returns the
    recorded UNKNOWN instead of opening a second real-money position;
  - the dealt id comes from affectedDeals[0].dealId, NOT the confirm's top-level
    dealId (the deal-REQUEST id, which 404s every close/modify);
  - place_order is idempotent on client_order_id.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx

from auto_trader.brokers import _dealing
from auto_trader.brokers.capital import CapitalComBroker, CapitalExecutionBroker
from auto_trader.core.models import Order, OrderStatus, OrderType, Side


def _broker(handler) -> CapitalComBroker:
    """A pre-authed CapitalComBroker backed by `handler` (a MockTransport fn), so
    _request skips /session and just issues the dealing call."""
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


def _market_order(coid: str = "co-1") -> Order:
    return Order(
        client_order_id=coid,
        epic="EPIC1",
        side=Side.BUY,
        quantity=2.0,
        type=OrderType.MARKET,
    )


def test_market_order_accepted_confirm_is_filled() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/api/v1/positions" and req.method == "POST":
            return httpx.Response(200, json={"dealReference": "DREF1"})
        if p == "/api/v1/confirms/DREF1":
            return httpx.Response(200, json={
                "dealStatus": "ACCEPTED",
                "affectedDeals": [{"dealId": "POS1", "status": "OPENED"}],
                "dealId": "REQ1",  # the deal-REQUEST id — must NOT be used
                "level": 101.5,
                "size": 2.0,
                "reason": "SUCCESS",
            })
        raise AssertionError(f"unexpected {req.method} {p}")

    ex = CapitalExecutionBroker(_broker(handler))
    res = asyncio.run(ex.place_order(_market_order()))
    asyncio.run(ex.aclose())

    assert res.status is OrderStatus.FILLED
    # The dealt id is the OPENED position id, not the top-level request id (issue 4).
    assert res.deal_id == "POS1"
    assert res.fill_price == 101.5
    assert res.filled_quantity == 2.0
    assert res.deal_reference == "DREF1"


def test_deal_id_is_none_when_no_affected_deal_id() -> None:
    """With no usable affectedDeals id, deal_id is None — NOT the confirm's top-level
    `dealId` (the request id), which would 404 every later close/modify (issue 4)."""
    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/api/v1/positions" and req.method == "POST":
            return httpx.Response(200, json={"dealReference": "DREF2"})
        if p == "/api/v1/confirms/DREF2":
            return httpx.Response(200, json={
                "dealStatus": "ACCEPTED", "affectedDeals": [], "dealId": "REQ2",
                "level": 50.0, "size": 2.0,
            })
        raise AssertionError(f"unexpected {req.method} {p}")

    ex = CapitalExecutionBroker(_broker(handler))
    res = asyncio.run(ex.place_order(_market_order()))
    asyncio.run(ex.aclose())

    assert res.status is OrderStatus.FILLED
    assert res.deal_id is None  # never "REQ2"


def test_confirm_error_after_submit_is_stored_unknown_not_raised(monkeypatch) -> None:
    """The submit SUCCEEDS, then /confirms returns a non-404 error (a 429 storm /
    5xx). This must resolve to a STORED UNKNOWN — not an escaped exception — so a
    retry returns the recorded UNKNOWN rather than opening a SECOND real-money
    position (issue 1)."""
    monkeypatch.setattr(_dealing, "CONFIRM_ATTEMPTS", 2)
    monkeypatch.setattr(_dealing, "CONFIRM_BACKOFF", 0.0)
    submits = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal submits
        p = req.url.path
        if p == "/api/v1/positions" and req.method == "POST":
            submits += 1
            return httpx.Response(200, json={"dealReference": "DREF3"})
        if p == "/api/v1/confirms/DREF3":
            return httpx.Response(500, json={"errorCode": "error.server"})
        raise AssertionError(f"unexpected {req.method} {p}")

    ex = CapitalExecutionBroker(_broker(handler))
    # First submit: the confirm 429s, but no exception escapes — UNKNOWN, recorded.
    res = asyncio.run(ex.place_order(_market_order("co-x")))
    assert res.status is OrderStatus.UNKNOWN

    # Retry with the SAME client_order_id: returns the stored UNKNOWN, no 2nd submit.
    res2 = asyncio.run(ex.place_order(_market_order("co-x")))
    asyncio.run(ex.aclose())
    assert res2.status is OrderStatus.UNKNOWN
    assert submits == 1  # the success was never resubmitted


def test_confirm_unparseable_body_after_submit_is_stored_unknown() -> None:
    """The submit SUCCEEDS, then /confirms returns 200 with a NON-JSON body. The
    JSON decode must NOT escape place_order — it resolves to a stored UNKNOWN, same
    as a 5xx, so a retry never opens a second position (issue 1, parsing variant)."""
    submits = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal submits
        p = req.url.path
        if p == "/api/v1/positions" and req.method == "POST":
            submits += 1
            return httpx.Response(200, json={"dealReference": "DREF5"})
        if p == "/api/v1/confirms/DREF5":
            return httpx.Response(200, content=b"<html>gateway timeout</html>")
        raise AssertionError(f"unexpected {req.method} {p}")

    ex = CapitalExecutionBroker(_broker(handler))
    res = asyncio.run(ex.place_order(_market_order("co-y")))
    res2 = asyncio.run(ex.place_order(_market_order("co-y")))  # retry, same id
    asyncio.run(ex.aclose())

    assert res.status is OrderStatus.UNKNOWN
    assert res2.status is OrderStatus.UNKNOWN
    assert submits == 1  # the success was never resubmitted


def test_business_rejection_maps_to_rejected_with_reason() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/v1/positions" and req.method == "POST":
            return httpx.Response(400, json={"errorCode": "error.invalid.stoploss.minvalue"})
        raise AssertionError(f"unexpected {req.method} {req.url.path}")

    ex = CapitalExecutionBroker(_broker(handler))
    res = asyncio.run(ex.place_order(_market_order()))
    asyncio.run(ex.aclose())

    assert res.status is OrderStatus.REJECTED
    assert res.reason == "error.invalid.stoploss.minvalue"


def test_place_order_idempotent_on_client_order_id() -> None:
    submits = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal submits
        p = req.url.path
        if p == "/api/v1/positions" and req.method == "POST":
            submits += 1
            return httpx.Response(200, json={"dealReference": "DREF4"})
        if p == "/api/v1/confirms/DREF4":
            return httpx.Response(200, json={
                "dealStatus": "ACCEPTED", "affectedDeals": [{"dealId": "POS4"}],
                "level": 10.0, "size": 2.0,
            })
        raise AssertionError(f"unexpected {req.method} {p}")

    ex = CapitalExecutionBroker(_broker(handler))
    r1 = asyncio.run(ex.place_order(_market_order("same")))
    r2 = asyncio.run(ex.place_order(_market_order("same")))  # same id
    asyncio.run(ex.aclose())

    assert r1.status is OrderStatus.FILLED
    assert r2.deal_id == r1.deal_id
    assert submits == 1  # the second call returned the recorded result


def test_account_summary_picks_preferred_account() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/v1/accounts":
            return httpx.Response(200, json={"accounts": [
                {"preferred": False, "currency": "USD", "balance": {"balance": 1.0, "available": 1.0}},
                {"preferred": True, "currency": "EUR",
                 "balance": {"balance": 500.0, "available": 480.0, "deposit": 20.0, "profitLoss": 5.0}},
            ]})
        raise AssertionError(f"unexpected {req.url.path}")

    ex = CapitalExecutionBroker(_broker(handler))
    summary = asyncio.run(ex.get_account_summary())
    asyncio.run(ex.aclose())

    assert summary["currency"] == "EUR"
    assert summary["balance"] == 500.0
    assert summary["available"] == 480.0


def test_position_margin_uses_broker_leverage_and_fx() -> None:
    """A USD share in a EUR account: margin must use the broker's real per-position
    leverage and the *current* mid (not the entry), FX-converted into EUR. Capital
    margins 5:1 on US shares — the old fixed-leverage estimate was ~2x wrong."""
    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path == "/api/v1/accounts":
            return httpx.Response(200, json={"accounts": [
                {"preferred": True, "currency": "EUR",
                 "balance": {"balance": 1000.0, "available": 800.0}},
            ]})
        if path == "/api/v1/positions":
            return httpx.Response(200, json={"positions": [{
                "position": {"direction": "SELL", "level": 1200.0, "size": 1.0,
                             "leverage": 5, "contractSize": 1, "currency": "USD",
                             "dealId": "d1", "upl": 70.0,
                             "createdDateUTC": "2026-06-25T16:38:05.592"},
                "market": {"epic": "MU", "bid": 1130.0, "offer": 1132.0},
            }]})
        if path == "/api/v1/markets/EURUSD":  # USD→EUR conversion pair
            return httpx.Response(200, json={"snapshot": {"bid": 1.1386, "offer": 1.1388}})
        raise AssertionError(f"unexpected {path}")

    ex = CapitalExecutionBroker(_broker(handler))
    positions = asyncio.run(ex.get_positions())
    asyncio.run(ex.aclose())

    assert len(positions) == 1
    p = positions[0]
    assert p.leverage == 5.0
    # current mid 1131 / 5 = 226.2 USD; / EURUSD ~1.1387 = ~198.6 EUR (NOT entry-based
    # 240, and NOT the old 1200/10 = 120 fixed-leverage estimate).
    assert p.margin is not None
    assert abs(p.margin - 198.6) < 1.0

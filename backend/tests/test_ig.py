"""IG adapter: auth header shape, price parsing, market-status, and the
asynchronous deal→confirm dealing flow — all against a fake httpx transport so no
network or credentials are needed. Mirrors the asyncio.run style used elsewhere
(this project has no pytest-asyncio plugin)."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from auto_trader.brokers import ig
from auto_trader.brokers import _dealing
from auto_trader.config import IGSettings
from auto_trader.brokers.ig import IGBroker, IGExecutionBroker
from auto_trader.core.models import Order, OrderStatus, OrderType, Resolution, Side


def _broker(handler, monkeypatch) -> IGBroker:
    """An IGBroker whose HTTP client is backed by `handler` (a MockTransport fn)."""
    monkeypatch.setattr(IGSettings, "creds", lambda self, side: ("k", "u", "p"))
    monkeypatch.setattr(IGSettings, "base_url", lambda self, side: "https://ig.test")
    b = IGBroker("demo")
    b._client = httpx.AsyncClient(
        base_url="https://ig.test", transport=httpx.MockTransport(handler)
    )
    return b


def _session_response() -> httpx.Response:
    return httpx.Response(
        200,
        headers={"CST": "cst-123", "X-SECURITY-TOKEN": "xst-456"},
        json={"currentAccountId": "Z4MUP2"},
    )


# --- auth + price parsing ----------------------------------------------------


def test_recent_candles_sends_ig_headers_and_parses_prices(monkeypatch) -> None:
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/session":
            seen["session_key"] = req.headers.get("X-IG-API-KEY")
            seen["session_version"] = req.headers.get("Version")
            return _session_response()
        if req.url.path.startswith("/prices/"):
            seen["price_headers"] = dict(req.headers)
            seen["price_params"] = dict(req.url.params)
            return httpx.Response(200, json={
                "instrumentType": "CURRENCIES",
                "metadata": {"allowance": {"remainingAllowance": 9000}},
                "prices": [{
                    "snapshotTime": "2026/06/26 21:56:00",
                    "snapshotTimeUTC": "2026-06-26T20:56:00",
                    "openPrice": {"bid": 100.0, "ask": 102.0},
                    "highPrice": {"bid": 103.0, "ask": 105.0},
                    "lowPrice": {"bid": 99.0, "ask": 101.0},
                    "closePrice": {"bid": 101.0, "ask": 103.0},
                    "lastTradedVolume": 56,
                }],
            })
        raise AssertionError(f"unexpected path {req.url.path}")

    b = _broker(handler, monkeypatch)
    candles = asyncio.run(b.get_recent_candles("EPIC1", Resolution.MINUTE, 3))
    asyncio.run(b.aclose())

    assert seen["session_key"] == "k"
    assert seen["session_version"] == "2"
    assert seen["price_headers"]["x-ig-api-key"] == "k"
    assert seen["price_headers"]["cst"] == "cst-123"
    assert seen["price_headers"]["x-security-token"] == "xst-456"
    assert seen["price_headers"]["version"] == "3"
    # pageSize=0 disables IG's 20/page response paging — without it the chart only
    # ever gets the first 20 bars per request (clusters-with-gaps bug).
    assert seen["price_params"]["pageSize"] == "0"
    assert len(candles) == 1
    c = candles[0]
    assert c.open == 101.0 and c.high == 104.0 and c.close == 102.0  # mids
    assert c.volume == 56.0
    assert c.time.isoformat() == "2026-06-26T20:56:00+00:00"


def test_all_markets_seeds_browse_from_watchlists_deduped(monkeypatch) -> None:
    """IG has no bulk catalogue, so the browse list is the union of the account's
    watchlists, deduped by epic, tradeable first."""
    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/watchlists":
            return httpx.Response(200, json={"watchlists": [
                {"id": "Popular Markets", "name": "Popular Markets"},
                {"id": "16480173", "name": "My Watchlist"},
            ]})
        if p == "/watchlists/Popular Markets":
            return httpx.Response(200, json={"markets": [
                {"epic": "IX.D.DOW.IFD.IP", "instrumentName": "Wall Street",
                 "instrumentType": "INDICES", "marketStatus": "EDITS_ONLY"},
                {"epic": "CS.D.EURUSD.CFD.IP", "instrumentName": "EUR/USD",
                 "instrumentType": "CURRENCIES", "marketStatus": "TRADEABLE"},
            ]})
        if p == "/watchlists/16480173":
            return httpx.Response(200, json={"markets": [
                # duplicate epic (also in Popular Markets) — must be deduped
                {"epic": "CS.D.EURUSD.CFD.IP", "instrumentName": "EUR/USD",
                 "instrumentType": "CURRENCIES", "marketStatus": "TRADEABLE"},
                {"epic": "CS.D.USDJPY.CFD.IP", "instrumentName": "USD/JPY",
                 "instrumentType": "CURRENCIES", "marketStatus": "TRADEABLE"},
            ]})
        raise AssertionError(p)

    b = _broker(handler, monkeypatch)
    markets = asyncio.run(b.all_markets())
    asyncio.run(b.aclose())
    epics = [m["epic"] for m in markets]
    assert epics.count("CS.D.EURUSD.CFD.IP") == 1  # deduped across watchlists
    assert set(epics) == {"IX.D.DOW.IFD.IP", "CS.D.EURUSD.CFD.IP", "CS.D.USDJPY.CFD.IP"}
    assert markets[0]["status"] == "TRADEABLE"  # tradeable sorted first
    assert markets[0]["type"] in {"CURRENCIES", "INDICES"}


def test_exhausted_allowance_raises_ig_allowance_exceeded(monkeypatch) -> None:
    """A 403 'exceeded-account-historical-data-allowance' from /prices is a quota
    signal, not a 404 (empty) or a generic error — it surfaces as its own type so
    the route can show a clear 'limit reached' message and the breaker stays closed."""
    from auto_trader.brokers.ig import IGAllowanceExceeded

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/session":
            return _session_response()
        return httpx.Response(403, json={
            "errorCode": "error.public-api.exceeded-account-historical-data-allowance"
        })

    b = _broker(handler, monkeypatch)
    with pytest.raises(IGAllowanceExceeded):
        asyncio.run(b.get_recent_candles("EPIC1", Resolution.MINUTE, 50))
    asyncio.run(b.aclose())


def test_market_meta_closed_from_status_when_no_opening_hours(monkeypatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/session":
            return _session_response()
        return httpx.Response(200, json={
            "instrument": {"openingHours": None, "currencies": [{"code": "USD"}]},
            "dealingRules": {"minStepDistance": {"value": 0.5}},
            "snapshot": {"marketStatus": "EDITS_ONLY", "decimalPlacesFactor": 1,
                         "bid": 11381.5, "offer": 11387.8},
        })

    b = _broker(handler, monkeypatch)
    meta = asyncio.run(b.get_market_meta("EPIC1"))
    quote = asyncio.run(b.get_quote("EPIC1"))
    asyncio.run(b.aclose())
    assert meta["closed"] is True  # EDITS_ONLY != TRADEABLE
    assert meta["pricePrecision"] == 1
    assert meta["nextOpen"] is None
    assert quote == (11381.5, 11387.8)


# --- dealing: deal -> confirm flow -------------------------------------------


def _market_order() -> Order:
    return Order(epic="EPIC1", side=Side.BUY, quantity=2.0, client_order_id="cid-1")


def test_market_order_accepted_confirm_is_filled(monkeypatch) -> None:
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/markets/EPIC1":  # currency_code lookup
            return httpx.Response(200, json={"instrument": {"currencies": [{"code": "USD", "isDefault": True}]}, "dealingRules": {"marketOrderPreference": "AVAILABLE_DEFAULT_OFF"}, "snapshot": {}})
        if p == "/positions/otc":
            calls.append("submit")
            body = json.loads(req.content)
            assert body["direction"] == "BUY"
            assert body["orderType"] == "MARKET"
            assert body["currencyCode"] == "USD"
            assert "stopLevel" not in body  # None-valued keys dropped by _clean
            return httpx.Response(200, json={"dealReference": "DREF1"})
        if p == "/confirms/DREF1":
            calls.append("confirm")
            return httpx.Response(200, json={
                "dealStatus": "ACCEPTED", "dealId": "DIABC", "level": 101.5, "reason": "SUCCESS",
            })
        raise AssertionError(f"unexpected {p}")

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    res = asyncio.run(ex.place_order(_market_order()))
    asyncio.run(b.aclose())

    assert res.status is OrderStatus.FILLED
    assert res.deal_id == "DIABC"
    assert res.fill_price == 101.5
    assert res.filled_quantity == 2.0
    assert res.deal_reference == "DREF1"
    assert calls == ["submit", "confirm"]


def test_market_order_falls_back_to_marketable_limit_when_unsupported(monkeypatch) -> None:
    """When the epic disallows plain MARKET orders, the 'market' fill is sent as a
    marketable LIMIT at the crossing quote (offer for a BUY) with
    EXECUTE_AND_ELIMINATE — never rejected as not-supported."""
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/markets/EPIC1":
            return httpx.Response(200, json={
                "instrument": {"currencies": [{"code": "GBP"}]},
                "dealingRules": {"marketOrderPreference": "NOT_AVAILABLE"},
                "snapshot": {"bid": 99.0, "offer": 101.0},
            })
        if p == "/positions/otc":
            seen["body"] = json.loads(req.content)
            return httpx.Response(200, json={"dealReference": "DREFM"})
        if p == "/confirms/DREFM":
            return httpx.Response(200, json={"dealStatus": "ACCEPTED", "dealId": "DM", "level": 101.0})
        raise AssertionError(p)

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    res = asyncio.run(ex.place_order(_market_order()))  # BUY
    asyncio.run(b.aclose())
    assert res.status is OrderStatus.FILLED
    assert seen["body"]["orderType"] == "LIMIT"
    # BUY priced a buffer (the 2.0 spread) through the offer: 101 + 2 = 103.
    assert seen["body"]["level"] == 103.0
    assert seen["body"]["timeInForce"] == "EXECUTE_AND_ELIMINATE"


def test_marketable_limit_level_quantized_to_precision(monkeypatch) -> None:
    """The marketable-limit level is rounded to the instrument's price precision in
    the through-market direction (buy up), so an over-precise level can't be rejected
    by the very epics that need this fallback."""
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/markets/EPIC1":
            return httpx.Response(200, json={
                "instrument": {"currencies": [{"code": "USD"}]},
                "dealingRules": {"marketOrderPreference": "NOT_AVAILABLE"},
                "snapshot": {"bid": 1.105, "offer": 1.105, "decimalPlacesFactor": 5},
            })
        if p == "/positions/otc":
            seen["body"] = json.loads(req.content)
            return httpx.Response(200, json={"dealReference": "DREFQ"})
        if p == "/confirms/DREFQ":
            return httpx.Response(200, json={"dealStatus": "ACCEPTED", "dealId": "DQ", "level": 1.10556})
        raise AssertionError(p)

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    asyncio.run(ex.place_order(_market_order()))  # BUY
    asyncio.run(b.aclose())
    # raw = offer 1.105 + buffer 1.105*0.0005 = 1.1055525 -> ceil to 5dp = 1.10556.
    assert seen["body"]["level"] == 1.10556


def test_market_order_partial_fill_records_dealt_size(monkeypatch) -> None:
    """A partial fill (EXECUTE_AND_ELIMINATE can leave a remainder) must record the
    confirm's actual dealt `size`, not the requested quantity — recording 2 when 0.5
    dealt corrupts position/PnL reconciliation."""
    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/markets/EPIC1":
            return httpx.Response(200, json={"instrument": {"currencies": [{"code": "USD"}]}, "dealingRules": {"marketOrderPreference": "AVAILABLE_DEFAULT_OFF"}, "snapshot": {}})
        if p == "/positions/otc":
            return httpx.Response(200, json={"dealReference": "DREFP"})
        if p == "/confirms/DREFP":
            return httpx.Response(200, json={
                "dealStatus": "ACCEPTED", "dealId": "DP", "level": 101.0, "size": 0.5,
            })
        raise AssertionError(p)

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    res = asyncio.run(ex.place_order(_market_order()))  # requested 2.0
    asyncio.run(b.aclose())
    assert res.status is OrderStatus.FILLED
    assert res.filled_quantity == 0.5  # dealt size from the confirm, not the 2.0 asked


def test_clear_stop_on_working_order_sends_null_not_omitted(monkeypatch) -> None:
    """Dragging a stop off a resting order must clear it. IG's amend REPLACES
    levels, so a cleared field has to be sent as literal null; omitting it (the old
    _clean bug) makes IG keep the old stop — real money, the stop stays live."""
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/workingorders" and req.method == "GET":
            return httpx.Response(200, json={"workingOrders": [{
                "workingOrderData": {"dealId": "WO9", "epic": "EPIC1", "direction": "BUY",
                                     "orderSize": 1.0, "orderLevel": 90.0,
                                     "stopLevel": 85.0, "limitLevel": 110.0},
            }]})
        if p == "/workingorders/otc/WO9" and req.method == "PUT":
            seen["body"] = json.loads(req.content)
            return httpx.Response(200, json={"dealReference": "AREF"})
        if p == "/confirms/AREF":
            return httpx.Response(200, json={"dealStatus": "ACCEPTED", "dealId": "WO9"})
        raise AssertionError(f"{req.method} {p}")

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    res = asyncio.run(ex.modify_working_order("WO9", clear_stop=True))
    asyncio.run(b.aclose())
    assert res.status is OrderStatus.PENDING  # amend accepted on a resting order
    # The cleared stop is present as an explicit null (NOT omitted), while the
    # untouched take-profit resends its current value.
    assert "stopLevel" in seen["body"] and seen["body"]["stopLevel"] is None
    assert seen["body"]["limitLevel"] == 110.0


def test_rejected_confirm_maps_to_rejected_with_reason(monkeypatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/markets/EPIC1":
            return httpx.Response(200, json={"instrument": {"currencies": [{"code": "USD"}]}, "dealingRules": {"marketOrderPreference": "AVAILABLE_DEFAULT_OFF"}, "snapshot": {}})
        if p == "/positions/otc":
            return httpx.Response(200, json={"dealReference": "DREF2"})
        if p == "/confirms/DREF2":
            return httpx.Response(200, json={"dealStatus": "REJECTED", "reason": "INSUFFICIENT_FUNDS"})
        raise AssertionError(p)

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    res = asyncio.run(ex.place_order(_market_order()))
    asyncio.run(b.aclose())
    assert res.status is OrderStatus.REJECTED
    assert res.reason == "INSUFFICIENT_FUNDS"


def test_confirm_never_arrives_is_unknown_not_filled(monkeypatch) -> None:
    """A deal that submits but never confirms must be UNKNOWN — never FILLED — so
    the caller reconciles instead of assuming success."""
    monkeypatch.setattr(_dealing, "CONFIRM_ATTEMPTS", 2)
    monkeypatch.setattr(_dealing, "CONFIRM_BACKOFF", 0.0)

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/markets/EPIC1":
            return httpx.Response(200, json={"instrument": {"currencies": [{"code": "USD"}]}, "dealingRules": {"marketOrderPreference": "AVAILABLE_DEFAULT_OFF"}, "snapshot": {}})
        if p == "/positions/otc":
            return httpx.Response(200, json={"dealReference": "DREF3"})
        if p == "/confirms/DREF3":
            return httpx.Response(404, json={"errorCode": "error.service.execution.find"})
        raise AssertionError(p)

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    res = asyncio.run(ex.place_order(_market_order()))
    asyncio.run(b.aclose())
    assert res.status is OrderStatus.UNKNOWN


def test_place_order_is_idempotent_on_client_order_id(monkeypatch) -> None:
    submits = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/markets/EPIC1":
            return httpx.Response(200, json={"instrument": {"currencies": [{"code": "USD"}]}, "dealingRules": {"marketOrderPreference": "AVAILABLE_DEFAULT_OFF"}, "snapshot": {}})
        if p == "/positions/otc":
            submits["n"] += 1
            return httpx.Response(200, json={"dealReference": "DREF4"})
        if p == "/confirms/DREF4":
            return httpx.Response(200, json={"dealStatus": "ACCEPTED", "dealId": "D4", "level": 1.0})
        raise AssertionError(p)

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    r1 = asyncio.run(ex.place_order(_market_order()))
    r2 = asyncio.run(ex.place_order(_market_order()))  # same client_order_id
    asyncio.run(b.aclose())
    assert r1.deal_id == r2.deal_id == "D4"
    assert submits["n"] == 1  # second call served from the idempotency cache


def test_close_position_uses_delete_method_header(monkeypatch) -> None:
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/positions" and req.method == "GET":
            return httpx.Response(200, json={"positions": [{
                "position": {"dealId": "D9", "direction": "BUY", "size": 1.0, "level": 100.0},
                "market": {"epic": "EPIC1", "bid": 105.0, "offer": 106.0},
            }]})
        if p == "/markets/EPIC1":  # close checks market-order support
            return httpx.Response(200, json={
                "dealingRules": {"marketOrderPreference": "AVAILABLE_DEFAULT_OFF"}, "snapshot": {},
            })
        if p == "/positions/otc":
            seen["method_header"] = req.headers.get("_method")
            body = json.loads(req.content)
            seen["direction"] = body["direction"]
            return httpx.Response(200, json={"dealReference": "DREFC"})
        if p == "/confirms/DREFC":
            return httpx.Response(200, json={"dealStatus": "ACCEPTED", "dealId": "D9", "level": 105.0})
        raise AssertionError(p)

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    res = asyncio.run(ex.close_position("D9"))
    asyncio.run(b.aclose())
    assert seen["method_header"] == "DELETE"
    assert seen["direction"] == "SELL"  # opposite of the BUY position
    assert res.status is OrderStatus.FILLED


def test_get_positions_computes_signed_upnl(monkeypatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/session":
            return _session_response()
        if req.url.path == "/positions":
            return httpx.Response(200, json={"positions": [{
                "position": {"dealId": "D1", "direction": "BUY", "size": 2.0,
                             "level": 100.0, "stopLevel": 95.0, "limitLevel": 110.0},
                "market": {"epic": "EPIC1", "bid": 104.0, "offer": 105.0},
            }]})
        raise AssertionError(req.url.path)

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    positions = asyncio.run(ex.get_positions())
    asyncio.run(b.aclose())
    [pos] = positions
    assert pos.side is Side.BUY
    assert pos.stop_level == 95.0 and pos.take_profit_level == 110.0
    # long marks at bid: uPnL = 2 * (104 - 100) = 8
    assert pos.upnl == pytest.approx(8.0)


def test_account_summary_picks_preferred_account(monkeypatch) -> None:
    """A live IG account exposes real balance/available/currency from GET /accounts
    (version 1), so the dock shows its true figures instead of paper ones. Pins the
    assumed IG payload shape: accounts[].balance.{balance,available,...} + currency."""
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/session":
            return _session_response()
        if req.url.path == "/accounts":
            assert req.headers.get("Version") == "1"
            return httpx.Response(200, json={"accounts": [
                {"preferred": False, "currency": "USD", "balance": {"balance": 1.0, "available": 1.0}},
                {"preferred": True, "currency": "GBP",
                 "balance": {"balance": 750.0, "available": 700.0, "deposit": 50.0, "profitLoss": -3.0}},
            ]})
        raise AssertionError(req.url.path)

    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    summary = asyncio.run(ex.get_account_summary())
    asyncio.run(b.aclose())

    assert summary["currency"] == "GBP"
    assert summary["balance"] == 750.0
    assert summary["available"] == 700.0
    assert summary["profitLoss"] == -3.0


def test_limit_order_rests_as_working_order_pending(monkeypatch) -> None:
    """A LIMIT order posts to /workingorders/otc and an accepted confirm is PENDING
    (resting), not FILLED — with the SL/TP carried as stop/limit levels."""
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/session":
            return _session_response()
        if p == "/markets/EPIC1":
            return httpx.Response(200, json={"instrument": {"currencies": [{"code": "USD"}]}})
        if p == "/workingorders/otc":
            seen["body"] = json.loads(req.content)
            return httpx.Response(200, json={"dealReference": "WREF"})
        if p == "/confirms/WREF":
            return httpx.Response(200, json={"dealStatus": "ACCEPTED", "dealId": "WO1"})
        raise AssertionError(p)

    order = Order(epic="EPIC1", side=Side.BUY, quantity=2.0, client_order_id="lim-1",
                  type=OrderType.LIMIT, limit_level=90.0, stop_level=85.0, take_profit_level=110.0)
    b = _broker(handler, monkeypatch)
    ex = IGExecutionBroker(b)
    res = asyncio.run(ex.place_order(order))
    asyncio.run(b.aclose())
    assert res.status is OrderStatus.PENDING
    assert res.deal_id == "WO1"
    assert seen["body"]["type"] == "LIMIT"
    assert seen["body"]["level"] == 90.0
    assert seen["body"]["stopLevel"] == 85.0
    assert seen["body"]["limitLevel"] == 110.0


def test_request_pins_account_id_header(monkeypatch) -> None:
    """After login the account id is sent as IG-ACCOUNT-ID on every request, so a
    multi-account live key can't route a deal to the wrong account."""
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/session":
            return _session_response()
        seen["account_header"] = req.headers.get("IG-ACCOUNT-ID")
        return httpx.Response(200, json={"snapshot": {"bid": 1.0, "offer": 2.0}})

    b = _broker(handler, monkeypatch)
    asyncio.run(b.get_quote("EPIC1"))
    asyncio.run(b.aclose())
    assert seen["account_header"] == "Z4MUP2"  # from _session_response


def test_ig_broker_supports_streaming() -> None:
    """IG live streaming is wired (Lightstreamer, see ig_stream), so ws_candles
    routes IG to ig_stream rather than capital_stream."""
    assert IGBroker.supports_streaming is True

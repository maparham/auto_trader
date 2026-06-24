"""FAVORITES watchlist mutation logic in the Capital.com broker.

These exercise the branch logic of add/remove/lookup directly, stubbing the HTTP
layer (`_request`) so no session or network is involved.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from auto_trader.brokers.capital import CapitalComBroker


def _make_broker() -> CapitalComBroker:
    # Bypass __init__ (which opens an AsyncClient and reads settings); we only
    # touch the watchlist methods, which go through the stubbed `_request`.
    return CapitalComBroker.__new__(CapitalComBroker)


def _resp(json_body: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=json_body, request=httpx.Request("GET", "http://t"))


def test_add_creates_watchlist_when_absent() -> None:
    broker = _make_broker()
    calls: list[tuple] = []

    async def fake_request(method, path, *, params=None, json=None):
        calls.append((method, path, json))
        if path == "/api/v1/watchlists" and method == "GET":
            return _resp({"watchlists": []})  # no FAVORITES yet
        return _resp({"status": "SUCCESS"})

    broker._request = fake_request  # type: ignore[method-assign]
    asyncio.run(broker.add_favorite("EURUSD"))

    # First add with no watchlist must POST a create carrying the epic.
    create = [c for c in calls if c[0] == "POST"]
    assert create == [("POST", "/api/v1/watchlists", {"name": "FAVORITES", "epics": ["EURUSD"]})]


def test_add_puts_into_existing_watchlist() -> None:
    broker = _make_broker()
    calls: list[tuple] = []

    async def fake_request(method, path, *, params=None, json=None):
        calls.append((method, path, json))
        if path == "/api/v1/watchlists" and method == "GET":
            return _resp({"watchlists": [{"id": "w42", "name": "FAVORITES"}]})
        return _resp({"status": "SUCCESS"})

    broker._request = fake_request  # type: ignore[method-assign]
    asyncio.run(broker.add_favorite("AAPL"))

    assert ("PUT", "/api/v1/watchlists/w42", {"epic": "AAPL"}) in calls
    assert not any(c[0] == "POST" for c in calls)


def test_remove_is_noop_without_watchlist() -> None:
    broker = _make_broker()
    calls: list[tuple] = []

    async def fake_request(method, path, *, params=None, json=None):
        calls.append((method, path, json))
        return _resp({"watchlists": []})

    broker._request = fake_request  # type: ignore[method-assign]
    asyncio.run(broker.remove_favorite("AAPL"))  # should not raise, should not DELETE

    assert not any(c[0] == "DELETE" for c in calls)


def test_remove_tolerates_404() -> None:
    broker = _make_broker()

    async def fake_request(method, path, *, params=None, json=None):
        if method == "GET":
            return _resp({"watchlists": [{"id": "w1", "name": "FAVORITES"}]})
        raise httpx.HTTPStatusError(
            "not found", request=httpx.Request("DELETE", "http://t"), response=_resp({}, 404)
        )

    broker._request = fake_request  # type: ignore[method-assign]
    asyncio.run(broker.remove_favorite("AAPL"))  # 404 swallowed, no raise


def test_remove_reraises_non_404() -> None:
    broker = _make_broker()

    async def fake_request(method, path, *, params=None, json=None):
        if method == "GET":
            return _resp({"watchlists": [{"id": "w1", "name": "FAVORITES"}]})
        raise httpx.HTTPStatusError(
            "boom", request=httpx.Request("DELETE", "http://t"), response=_resp({}, 500)
        )

    broker._request = fake_request  # type: ignore[method-assign]
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(broker.remove_favorite("AAPL"))

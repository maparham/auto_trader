"""`Position.trailing_stop` is filled from the Capital and IG positions payloads."""

from __future__ import annotations

import asyncio

import httpx

from auto_trader.brokers.capital import CapitalExecutionBroker
from auto_trader.brokers.ig import IGExecutionBroker
from test_capital_exec import _broker as _capital_broker
from test_ig import _broker as _ig_broker, _session_response


def _capital_positions(trailing: bool | None) -> list:
    pos = {"direction": "BUY", "level": 100.0, "size": 1.0, "dealId": "d1",
           "stopLevel": 95.0}
    if trailing is not None:
        pos["trailingStop"] = trailing

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/v1/accounts":
            return httpx.Response(200, json={"accounts": [
                {"preferred": True, "currency": "USD",
                 "balance": {"balance": 1000.0, "available": 800.0}}]})
        if req.url.path == "/api/v1/positions":
            return httpx.Response(200, json={"positions": [
                {"position": pos, "market": {"epic": "US100", "bid": 101.0, "offer": 102.0}}]})
        raise AssertionError(req.url.path)

    ex = CapitalExecutionBroker(_capital_broker(handler))
    out = asyncio.run(ex.get_positions())
    asyncio.run(ex.aclose())
    return out


def _ig_positions(monkeypatch, trailing_distance) -> list:
    pos = {"dealId": "D1", "direction": "BUY", "size": 1.0, "level": 100.0,
           "trailingStopDistance": trailing_distance}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/session":
            return _session_response()
        if req.url.path == "/positions":
            return httpx.Response(200, json={"positions": [
                {"position": pos, "market": {"epic": "E1", "bid": 101.0, "offer": 102.0}}]})
        raise AssertionError(req.url.path)

    b = _ig_broker(handler, monkeypatch)
    out = asyncio.run(IGExecutionBroker(b).get_positions())
    asyncio.run(b.aclose())
    return out


def test_capital_position_trailing_flag() -> None:
    [p] = _capital_positions(True)
    assert p.trailing_stop is True
    [p] = _capital_positions(False)
    assert p.trailing_stop is False
    [p] = _capital_positions(None)
    assert p.trailing_stop is False


def test_ig_position_trailing_flag(monkeypatch) -> None:
    [p] = _ig_positions(monkeypatch, 12.5)
    assert p.trailing_stop is True
    [p] = _ig_positions(monkeypatch, None)
    assert p.trailing_stop is False

"""GET /api/history: unsupported accounts answer supported:false, bad ranges
422, broker failures map like the positions route, times go out as epoch ms."""

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from auto_trader.api import deps
from auto_trader.api.routers import trading
from auto_trader.brokers.base import ExecutionBroker
from auto_trader.brokers.registry import BrokerRegistry
from auto_trader.core.broker_health import BrokerReconnecting
from auto_trader.core.models import AccountHistory, ClosedTrade, LedgerEntry, Side

UTC = timezone.utc


class _Broker(ExecutionBroker):
    def __init__(self, history=None, error=None, supported=True):
        self.supports_history = supported
        self._history = history
        self._error = error
        self.asked = None

    async def get_history(self, since, until):
        self.asked = (since, until)
        if self._error:
            raise self._error
        return self._history

    @property
    def env(self):
        return "demo"

    @property
    def is_real_money(self):
        return False

    async def place_order(self, order):
        raise NotImplementedError

    async def get_positions(self, epic=None):
        return []

    async def close_position(self, deal_id, quantity=None):
        raise NotImplementedError

    async def modify_position(self, deal_id, **kwargs):
        raise NotImplementedError

    async def get_working_orders(self, epic=None):
        return []

    async def modify_working_order(self, order_id, **kwargs):
        raise NotImplementedError

    async def cancel_working_order(self, order_id):
        raise NotImplementedError


def _install(monkeypatch, broker, key="capital:demo"):
    reg = BrokerRegistry()
    reg.add_exec(key, broker)
    monkeypatch.setattr(deps, "_registry", reg)
    return reg


def test_unsupported_account_answers_supported_false(monkeypatch):
    _install(monkeypatch, _Broker(supported=False), "capital:paper")
    out = asyncio.run(trading.account_history(account="capital:paper", days=30))
    assert out.supported is False and out.trades == []


def test_bad_days_is_422(monkeypatch):
    _install(monkeypatch, _Broker(history=AccountHistory([], [])))
    with pytest.raises(HTTPException) as e:
        asyncio.run(trading.account_history(account="capital:demo", days=14))
    assert e.value.status_code == 422


def test_reconnecting_is_503(monkeypatch):
    _install(monkeypatch, _Broker(error=BrokerReconnecting("capital")))
    with pytest.raises(HTTPException) as e:
        asyncio.run(trading.account_history(account="capital:demo", days=7))
    assert e.value.status_code == 503


def test_other_failures_are_502(monkeypatch):
    _install(monkeypatch, _Broker(error=RuntimeError("boom")))
    with pytest.raises(HTTPException) as e:
        asyncio.run(trading.account_history(account="capital:demo", days=7))
    assert e.value.status_code == 502


def test_payload_uses_epoch_ms_and_totals(monkeypatch):
    closed = datetime(2026, 10, 21, 8, 18, 41, 723000, tzinfo=UTC)
    trade = ClosedTrade("D1", "TSLA", Side.BUY, 1.0, 400.0, 430.0, None, closed, "TP", 12.5, "EUR")
    entry = LedgerEntry(closed, "TRADE", "TSLA", "Trade closed", 12.5, "EUR", "r1", "D1")
    broker = _Broker(history=AccountHistory([trade], [entry]))
    _install(monkeypatch, broker)
    out = asyncio.run(trading.account_history(account="capital:demo", days=30))
    assert out.supported is True
    assert out.trades[0].closed_at == 1792570721723
    assert out.trades[0].opened_at is None and out.trades[0].side == "buy"
    assert out.ledger[0].at == 1792570721723
    assert out.totals.realized == 12.5 and out.totals.currency == "EUR"
    since, until = broker.asked
    assert (until - since).days == 30 and until.tzinfo is not None


def test_describe_flags_history_accounts():
    reg = BrokerRegistry()
    reg.add_exec("capital:demo", _Broker())
    reg.add_exec("capital:paper", _Broker(supported=False))
    items = {i["key"]: i for i in reg.describe()["exec"]}
    assert items["capital:demo"]["history"] is True
    assert items["capital:paper"]["history"] is False

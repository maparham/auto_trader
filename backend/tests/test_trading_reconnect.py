"""The trading + market routers must surface a broker that is rebuilding its
wedged connection as a transient 503 ("reconnecting"), not a generic 502 — so the
dock/chart can show a reconnecting state and keep polling instead of rendering a
hard error over empty panels."""

import asyncio

import pytest
from fastapi import HTTPException

from auto_trader.api import deps
from auto_trader.api.routers import markets, trading
from auto_trader.brokers.base import ExecutionBroker, MarketDataBroker
from auto_trader.brokers.registry import BrokerRegistry
from auto_trader.core.broker_health import BrokerReconnecting


class _ReconnectingBroker(ExecutionBroker):
    async def get_positions(self, epic=None):
        raise BrokerReconnecting("mt5")

    async def get_working_orders(self, epic=None):
        raise BrokerReconnecting("mt5")

    async def get_account_summary(self):
        raise BrokerReconnecting("mt5")

    # Unused abstract methods for this test.
    def env(self) -> str:  # type: ignore[override]
        return "demo"

    def is_real_money(self) -> bool:  # type: ignore[override]
        return False

    async def place_order(self, order):  # type: ignore[override]
        raise NotImplementedError

    async def close_position(self, deal_id, quantity=None):  # type: ignore[override]
        raise NotImplementedError

    async def modify_position(self, deal_id, **kwargs):  # type: ignore[override]
        raise NotImplementedError

    async def modify_working_order(self, order_id, **kwargs):  # type: ignore[override]
        raise NotImplementedError

    async def cancel_working_order(self, order_id):  # type: ignore[override]
        raise NotImplementedError


def _install(monkeypatch) -> None:
    reg = BrokerRegistry()
    reg.add_exec("mt5:live", _ReconnectingBroker())
    monkeypatch.setattr(deps, "_registry", reg)


def test_positions_reconnecting_is_503(monkeypatch) -> None:
    _install(monkeypatch)
    with pytest.raises(HTTPException) as e:
        asyncio.run(trading.positions(account="mt5:live", epic=""))
    assert e.value.status_code == 503


def test_working_orders_reconnecting_is_503(monkeypatch) -> None:
    _install(monkeypatch)
    with pytest.raises(HTTPException) as e:
        asyncio.run(trading.working_orders(account="mt5:live", epic=""))
    assert e.value.status_code == 503


def test_account_summary_reconnecting_is_503(monkeypatch) -> None:
    _install(monkeypatch)
    with pytest.raises(HTTPException) as e:
        asyncio.run(trading.account_summary(account="mt5:live"))
    assert e.value.status_code == 503


class _ReconnectingData(MarketDataBroker):
    """A data broker whose market-info reads are wedged/reconnecting. These go
    through deps.guarded (circuit breaker), which mapped BrokerReconnecting to a
    generic 502 until it learned the transient-reconnect state."""

    async def get_market_meta(self, epic):
        raise BrokerReconnecting("mt5")

    async def get_market_detail(self, epic):
        raise BrokerReconnecting("mt5")

    async def get_candles(self, epic, resolution, start, end, price_side="bid"):  # type: ignore[override]
        raise NotImplementedError

    async def get_recent_candles(self, epic, resolution, count, price_side="bid"):  # type: ignore[override]
        raise NotImplementedError

    async def get_quote(self, epic):  # type: ignore[override]
        raise NotImplementedError


def _install_data(monkeypatch) -> None:
    reg = BrokerRegistry()
    reg.add_data("mt5", _ReconnectingData())
    monkeypatch.setattr(deps, "_registry", reg)


def test_market_meta_reconnecting_is_503(monkeypatch) -> None:
    # The guarded() path (circuit breaker) must map reconnecting to 503, not the
    # generic 502 that every other broker error yields — and NOT trip the breaker.
    _install_data(monkeypatch)
    with pytest.raises(HTTPException) as e:
        asyncio.run(markets.market_meta(epic="EURUSD", broker_id="mt5"))
    assert e.value.status_code == 503


def test_market_details_reconnecting_is_503(monkeypatch) -> None:
    _install_data(monkeypatch)
    with pytest.raises(HTTPException) as e:
        asyncio.run(markets.market_details(epic="EURUSD", broker_id="mt5"))
    assert e.value.status_code == 503


def test_reconnecting_does_not_trip_the_shared_breaker(monkeypatch) -> None:
    # A transient reconnect must not count as a breaker failure — MT5 owns its own
    # recovery, and tripping the shared breaker would pin every call for that broker
    # into cooldown. Many reconnecting reads in a row must stay 503, never flip to
    # the breaker's own BrokerUnavailable/503-with-different-message or open state.
    _install_data(monkeypatch)
    for _ in range(10):
        with pytest.raises(HTTPException) as e:
            asyncio.run(markets.market_meta(epic="EURUSD", broker_id="mt5"))
        assert e.value.status_code == 503
    assert "mt5" not in deps.BROKER_HEALTH._open_until  # breaker never opened

"""MT5/MetaApi adapter unit tests (no live connection — the MetaApi read path is
stubbed). Focus: account-summary mapping, since a broken mapping shows the trader
wrong money on the dock's account strip."""

import asyncio

import pytest

from auto_trader.brokers.mt5 import MT5ExecutionBroker


class _FakeConn:
    def __init__(self, info):
        self._info = info

    async def get_account_information(self, options=None):
        return self._info


class _FakeData:
    """Stands in for MT5Broker: `read` just runs the coroutine against a fake conn,
    skipping the real connect/sync."""

    def __init__(self, info):
        self._conn = _FakeConn(info)

    async def read(self, make_coro):
        return await make_coro(self._conn)


def test_account_summary_maps_metaapi_fields():
    # A losing account: equity < balance by the floating loss; freeMargin is what's
    # available; margin is the (small) used margin MetaApi reports directly.
    info = {
        "balance": 100000.0,
        "equity": 83753.68,
        "margin": 17.25,
        "freeMargin": 83736.43,
        "marginLevel": 485653.53,
        "currency": "USD",
    }
    broker = MT5ExecutionBroker(_FakeData(info))
    out = asyncio.run(broker.get_account_summary())

    assert out["balance"] == 100000.0
    assert out["available"] == 83736.43  # freeMargin, not a leverage estimate
    assert out["equity"] == 83753.68     # passed through verbatim
    assert out["margin"] == 17.25        # MetaApi's own used margin
    assert out["currency"] == "USD"
    # profitLoss is the floating component: equity − balance (a loss here).
    assert out["profitLoss"] == pytest.approx(83753.68 - 100000.0)


def test_account_summary_tolerates_missing_fields():
    broker = MT5ExecutionBroker(_FakeData({"currency": "EUR"}))
    out = asyncio.run(broker.get_account_summary())
    assert out["currency"] == "EUR"
    assert out["balance"] is None
    assert out["profitLoss"] is None  # can't derive without balance+equity

"""GET /api/market/{epic}/earnings: earnings markers for equities only.
Direct-call convention per test_api_splits.py."""

from __future__ import annotations

import asyncio

import auto_trader.api.routers.markets as markets
from auto_trader.brokers.yahoo_earnings import Earnings


class FakeBroker:
    def __init__(self, kind, ticker=None, fail=False):
        self.kind = kind
        self.ticker = ticker
        self.fail = fail

    async def get_market_meta(self, epic):
        if self.fail:
            raise RuntimeError("meta down")
        return {"pricePrecision": 2, "type": self.kind, "yahooTicker": self.ticker}


class FakeEarnings:
    def __init__(self):
        self.calls = []

    async def get(self, epic, ticker=None):
        self.calls.append(epic if ticker is None else (epic, ticker))
        return [
            Earnings(ts=1785441600, eps_estimate=1.89, eps_actual=2.02, surprise_pct=6.74,
                     revenue_actual=109.4e9, session="post",
                     open_ts=1785418200, close_ts=1785441600),
            Earnings(ts=1793649600, eps_estimate=1.98, eps_actual=None, surprise_pct=None,
                     revenue_estimate=113.4e9),
        ]


def _call(monkeypatch, kind, epic="AAPL", ticker=None, fail=False):
    fe = FakeEarnings()
    monkeypatch.setattr(markets, "EARNINGS", fe)
    monkeypatch.setattr(markets, "get_data", lambda broker_id: FakeBroker(kind, ticker, fail))
    out = asyncio.run(markets.market_earnings(epic, broker_id="yfinance"))
    return out, fe


def test_equity_gets_its_earnings(monkeypatch):
    out, fe = _call(monkeypatch, "stock")
    assert out == {
        "epic": "AAPL",
        "earnings": [
            {"time": 1785441600, "epsEstimate": 1.89, "epsActual": 2.02, "surprisePct": 6.74,
             "revenueEstimate": None, "revenueActual": 109.4e9, "session": "post",
             "openTime": 1785418200, "closeTime": 1785441600},
            {"time": 1793649600, "epsEstimate": 1.98, "epsActual": None, "surprisePct": None,
             "revenueEstimate": 113.4e9, "revenueActual": None, "session": None,
             "openTime": None, "closeTime": None},
        ],
    }
    assert fe.calls == ["AAPL"]


def test_non_equity_gets_none_without_asking_yahoo(monkeypatch):
    for kind in ("COMMODITIES", "etf_not", None, "index"):
        out, fe = _call(monkeypatch, kind)
        assert out == {"epic": "AAPL", "earnings": []} and fe.calls == []


def test_failed_meta_lookup_reads_as_none(monkeypatch):
    out, fe = _call(monkeypatch, "stock", fail=True)
    assert out["earnings"] == [] and fe.calls == []


def test_broker_named_ticker_is_passed_to_the_registry(monkeypatch):
    out, fe = _call(monkeypatch, "SHARES", epic="UC.D.AAPL.CASH.IP", ticker="AAPL")
    assert len(out["earnings"]) == 2
    assert fe.calls == [("UC.D.AAPL.CASH.IP", "AAPL")]

"""GET /api/market/{epic}/splits: split markers for equities only.
Direct-call convention per test_api_candles.py."""

from __future__ import annotations

import asyncio

import auto_trader.api.routers.markets as markets
from auto_trader.core.candle_clean import Split


class FakeBroker:
    def __init__(self, kind, ticker=None):
        self.kind = kind
        self.ticker = ticker

    async def get_market_meta(self, epic):
        return {"pricePrecision": 2, "type": self.kind, "yahooTicker": self.ticker}


class FakeSplits:
    def __init__(self):
        self.calls = []

    async def get(self, epic, ticker=None):
        self.calls.append(epic if ticker is None else (epic, ticker))
        return [Split(ts=1775482200, ratio=25.0)]


def _call(monkeypatch, kind, epic="BKNG", ticker=None):
    fs = FakeSplits()
    monkeypatch.setattr(markets, "SPLITS", fs)
    monkeypatch.setattr(markets, "get_data", lambda broker_id: FakeBroker(kind, ticker))
    out = asyncio.run(markets.market_splits(epic, broker_id="capital"))
    return out, fs


def test_equity_gets_its_splits(monkeypatch):
    out, fs = _call(monkeypatch, "SHARES")
    assert out == {"epic": "BKNG", "splits": [{"time": 1775482200, "ratio": 25.0}]}
    assert fs.calls == ["BKNG"]


def test_yfinance_stock_and_etf_types_count_as_equities(monkeypatch):
    assert _call(monkeypatch, "stock")[0]["splits"]
    assert _call(monkeypatch, "etf")[0]["splits"]


def test_non_equity_gets_none_without_asking_yahoo(monkeypatch):
    # Capital's GOLD is a commodity; Yahoo's GOLD is Barrick, whose splits
    # must never land on the gold chart.
    out, fs = _call(monkeypatch, "COMMODITIES")
    assert out == {"epic": "BKNG", "splits": []}
    assert fs.calls == []


def test_unknown_type_gets_none(monkeypatch):
    out, fs = _call(monkeypatch, None)
    assert out["splits"] == [] and fs.calls == []


def test_broker_named_ticker_is_passed_to_the_registry(monkeypatch):
    # IG and MT5 epics are not tickers; their meta names the Yahoo ticker.
    out, fs = _call(monkeypatch, "SHARES", epic="UC.D.PCLN.CASH.IP", ticker="BKNG")
    assert out["splits"] == [{"time": 1775482200, "ratio": 25.0}]
    assert fs.calls == [("UC.D.PCLN.CASH.IP", "BKNG")]

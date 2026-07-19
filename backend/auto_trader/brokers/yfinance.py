"""Yahoo Finance historical candles as a read-only data broker.

Free deep history: daily/weekly bars back decades for FX, indices, futures,
US stocks/ETFs and crypto. Intraday is capped by Yahoo (1m ~30 days,
1h ~730 days); requests beyond the window simply return what Yahoo has.

Data-only, same shape as the Dukascopy source: no stream, no quote, no
executor. Cache namespace ("yfinance", epic, resolution, side) keeps its
series isolated from the live brokers.

Prices are split/dividend-adjusted (auto_adjust=True) so long stock
backtests see a continuous series. price_side is ignored: Yahoo publishes
last-trade data, which we treat as mid.

Epics not in the curated catalogue pass through verbatim as Yahoo tickers,
so anything surfaced by search_markets fetches without a map entry.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import yfinance as yf

from auto_trader.brokers.base import MarketDataBroker
from auto_trader.core.models import Candle, Resolution


@dataclass(frozen=True)
class InstrumentInfo:
    epic: str  # our symbol, shown in the picker
    ticker: str  # Yahoo ticker
    name: str  # display name
    precision: int  # decimal places for price display
    kind: str  # "fx" | "metal" | "index" | "stock" | "etf" | "crypto"


# Curated catalogue. FX uses Yahoo's "=X" pairs, metals/indices use futures /
# cash-index tickers (closest to the CFD epics the app already trades).
_INSTRUMENT_LIST: list[InstrumentInfo] = [
    InstrumentInfo("EURUSD", "EURUSD=X", "EUR/USD", 5, "fx"),
    InstrumentInfo("GBPUSD", "GBPUSD=X", "GBP/USD", 5, "fx"),
    InstrumentInfo("USDJPY", "USDJPY=X", "USD/JPY", 3, "fx"),
    InstrumentInfo("AUDUSD", "AUDUSD=X", "AUD/USD", 5, "fx"),
    InstrumentInfo("USDCHF", "USDCHF=X", "USD/CHF", 5, "fx"),
    InstrumentInfo("USDCAD", "USDCAD=X", "USD/CAD", 5, "fx"),
    InstrumentInfo("NZDUSD", "NZDUSD=X", "NZD/USD", 5, "fx"),
    InstrumentInfo("XAUUSD", "GC=F", "Gold (COMEX)", 3, "metal"),
    InstrumentInfo("XAGUSD", "SI=F", "Silver (COMEX)", 4, "metal"),
    InstrumentInfo("US500", "^GSPC", "S&P 500", 2, "index"),
    InstrumentInfo("US30", "^DJI", "Dow 30", 1, "index"),
    InstrumentInfo("US100", "^NDX", "Nasdaq 100", 1, "index"),
    InstrumentInfo("AAPL", "AAPL", "Apple", 2, "stock"),
    InstrumentInfo("MSFT", "MSFT", "Microsoft", 2, "stock"),
    InstrumentInfo("NVDA", "NVDA", "NVIDIA", 2, "stock"),
    InstrumentInfo("AMZN", "AMZN", "Amazon", 2, "stock"),
    InstrumentInfo("GOOGL", "GOOGL", "Alphabet", 2, "stock"),
    InstrumentInfo("META", "META", "Meta", 2, "stock"),
    InstrumentInfo("TSLA", "TSLA", "Tesla", 2, "stock"),
    InstrumentInfo("SPY", "SPY", "SPDR S&P 500 ETF", 2, "etf"),
    InstrumentInfo("QQQ", "QQQ", "Invesco QQQ ETF", 2, "etf"),
    InstrumentInfo("IWM", "IWM", "iShares Russell 2000 ETF", 2, "etf"),
    InstrumentInfo("BTCUSD", "BTC-USD", "Bitcoin", 2, "crypto"),
    InstrumentInfo("ETHUSD", "ETH-USD", "Ethereum", 2, "crypto"),
    InstrumentInfo("SOLUSD", "SOL-USD", "Solana", 2, "crypto"),
]
_INSTRUMENTS: dict[str, InstrumentInfo] = {i.epic: i for i in _INSTRUMENT_LIST}

# HOUR_4 deliberately absent: Yahoo has no 4h interval, we fetch 1h and
# resample (see _resample_4h).
_INTERVALS: dict[Resolution, str] = {
    Resolution.MINUTE: "1m",
    Resolution.MINUTE_5: "5m",
    Resolution.MINUTE_15: "15m",
    Resolution.MINUTE_30: "30m",
    Resolution.HOUR: "1h",
    Resolution.DAY: "1d",
    Resolution.WEEK: "1wk",
}

_DEFAULT_PRECISION = 2  # searched/uncurated instruments


def _ticker_for(epic: str) -> str:
    info = _INSTRUMENTS.get(epic)
    # Verbatim fallback: any Yahoo ticker found via search works without a
    # catalogue entry.
    return info.ticker if info is not None else epic


def _interval_for(resolution: Resolution) -> str:
    interval = _INTERVALS.get(resolution)
    if interval is None:
        raise ValueError(f"unsupported yfinance resolution: {resolution}")
    return interval

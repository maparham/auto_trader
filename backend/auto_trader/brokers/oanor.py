"""oanor (oanor.com) — Iran's free-market (bazaar) rial & gold prices as a
read-only data broker.

Iran's official rate is fixed and unused in practice; the real economy trades
on the open bazaar rate, which is what oanor exposes (source: tgju.org).
Instruments: foreign currencies vs IRR (usd, eur, gbp, aed, try …) and Iran's
gold market (ounce, 18k/24k gram, mesghal, Emami/Bahar Azadi coins).

Upstream constraints that shape this module: daily granularity only, max 365
rows of history per symbol, 2 req/s on the free tier (client-side throttle).
Data-only, same shape as the Dukascopy/yfinance sources: no stream, no
executor. Cache namespace ("oanor", epic, resolution, side) isolates its
series; the cache accumulates history beyond oanor's rolling 1-year window.

DAY is the only native resolution; WEEK is folded locally from daily bars;
anything finer returns []. get_quote returns (close, close) — bazaar prices
have no bid/ask spread, the daily close is treated as mid.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone

import httpx

from auto_trader.brokers.base import MarketDataBroker
from auto_trader.core.candle_aggregate import BucketRule, bucket_end, fold
from auto_trader.core.models import Candle, Resolution

_BASE_URL = "https://api.oanor.com/irr-api"
_MAX_ROWS = 365  # upstream hard cap on /v1/history limit
_MIN_REQUEST_INTERVAL = 0.6  # free tier allows 2 req/s; stay politely under
_SYMBOLS_TTL = 3600.0  # catalogue changes rarely; cache /v1/symbols in-process
_DAY = timedelta(days=1)
_WEEK_RULE = BucketRule(Resolution.DAY, "week", 1)


def _parse_date(s: str) -> datetime:
    """oanor Gregorian date "2026/06/10" → UTC-midnight datetime (bar open)."""
    return datetime.strptime(s, "%Y/%m/%d").replace(tzinfo=timezone.utc)


def _rows_to_candles(rows: list[dict], now: datetime | None = None) -> list[Candle]:
    """Newest-first oanor history rows → ascending closed Candles.

    Rows with missing/zero OHLC are dropped (upstream padding, not real
    sessions), as is any bar whose day hasn't completed yet — only closed bars
    may reach the candle cache."""
    if now is None:
        now = datetime.now(timezone.utc)
    out: list[Candle] = []
    for row in rows:
        try:
            t = _parse_date(row["date"])
            o = float(row["open"])
            h = float(row["high"])
            low = float(row["low"])
            c = float(row["close"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (o and h and low and c):
            continue
        if t + _DAY > now:
            continue  # still-forming daily bar
        out.append(Candle(time=t, open=o, high=h, low=low, close=c, volume=0.0))
    out.sort(key=lambda c: c.time)
    return out

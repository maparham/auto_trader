"""Nobitex (nobitex.ir) — Iran's largest crypto exchange as a read-only data
broker for crypto/IRR pairs, USDT/IRR foremost.

USDT/IRR is a live, 24/7, orderbook-traded proxy for the rial-dollar rate
(tracks the bazaar dollar within ~1%) with real volume and bid/ask — the only
IRR source in the app with intraday granularity (bazaar feeds like oanor are
daily-only). Complements, not replaces, oanor: no gold/coin market here.

Upstream: public TradingView-UDF endpoint, no API key.
  GET /market/udf/history?symbol=USDTIRT&resolution=60&from=..&to=..
Constraints that shape this module (verified live 2026-08-10):
  - 500-bar cap per request keeping the NEWEST bars of the range — an
    over-wide request silently drops the old end, so windows are chunked to
    <=450 bars each.
  - Prices are in TOMAN; /market/stats is in rial (factor exactly 10). We
    normalize candles x10 to RIAL so Nobitex series compare directly with
    oanor's IRR series. Volume stays in base-asset units (e.g. USDT).
  - Daily bars anchor at Tehran midnight (20:30 UTC); restamped to UTC
    midnight of the Tehran calendar date so weekly/monthly folds bucket
    correctly (same idea as yfinance session-day normalization).

Data-only, same shape as dukascopy/yfinance: no stream, no executor. Unlike
those, get_quote returns a REAL (bid, ask) from the live orderbook, so paper
trading can price off this broker. WEEK is folded locally from restamped
dailies; resolutions finer than 1m don't exist upstream.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone

import httpx

from auto_trader.brokers.base import MarketDataBroker
from auto_trader.core.candle_aggregate import fold_days_to_weeks
from auto_trader.core.models import Candle, Resolution

_BASE_URL = "https://apiv2.nobitex.ir"
_MAX_BARS = 450  # upstream caps responses at 500 bars, newest-first kept
_MIN_REQUEST_INTERVAL = 0.35  # public API; stay polite
_TOMAN_TO_RIAL = 10.0
# Tehran is UTC+3:30 (no DST since 2022). The +6h slack makes the date
# extraction robust to the pre-2023 DST era (+4:30 anchors) in deep history.
_TEHRAN_DATE_SHIFT = timedelta(hours=3, minutes=30) + timedelta(hours=6)

_RESOLUTIONS: dict[Resolution, str] = {
    Resolution.MINUTE: "1",
    Resolution.MINUTE_5: "5",
    Resolution.MINUTE_15: "15",
    Resolution.MINUTE_30: "30",
    Resolution.HOUR: "60",
    Resolution.HOUR_4: "240",
    Resolution.DAY: "1D",
}


def _udf_to_candles(
    payload: dict, resolution: Resolution, now: datetime | None = None
) -> list[Candle]:
    """UDF parallel arrays (t/o/h/l/c/v, toman) → ascending closed Candles in
    rial. The still-forming trailing bar (open time + width > now, judged on
    the ORIGINAL timestamp) is dropped. DAY bars are restamped to UTC midnight
    of their Tehran calendar date."""
    if payload.get("s") != "ok":
        return []  # "no_data" or error envelope
    if now is None:
        now = datetime.now(timezone.utc)
    width = timedelta(seconds=resolution.seconds)
    out: list[Candle] = []
    for ts, o, h, low, c, v in zip(
        payload["t"], payload["o"], payload["h"], payload["l"],
        payload["c"], payload["v"],
    ):
        t = datetime.fromtimestamp(int(ts), tz=timezone.utc)
        if t + width > now:
            continue
        if resolution is Resolution.DAY:
            day = (t + _TEHRAN_DATE_SHIFT).date()
            t = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
        out.append(
            Candle(
                time=t,
                open=float(o) * _TOMAN_TO_RIAL,
                high=float(h) * _TOMAN_TO_RIAL,
                low=float(low) * _TOMAN_TO_RIAL,
                close=float(c) * _TOMAN_TO_RIAL,
                volume=float(v or 0.0),
            )
        )
    out.sort(key=lambda candle: candle.time)
    return out


def _chunks(start_ts: int, end_ts: int, res_seconds: int, max_bars: int = _MAX_BARS):
    """Split [start_ts, end_ts] into contiguous spans of <= max_bars bars each.
    Required: an over-wide UDF request keeps only the newest 500 bars, so a
    single big fetch would silently lose the old end of the window."""
    span = max_bars * res_seconds
    s = start_ts
    while s < end_ts:
        e = min(s + span, end_ts)
        yield s, e
        s = e

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

# Curated catalogue: the liquid IRT pairs worth surfacing in the picker.
# Uncurated epics pass through verbatim (any Nobitex UDF symbol fetches
# without a map entry — yfinance precedent). Rial prices are integers, so
# pricePrecision 0 across the board.
_INSTRUMENT_LIST: list[tuple[str, str]] = [
    ("USDTIRT", "Tether (USDT/IRR)"),
    ("BTCIRT", "Bitcoin (BTC/IRR)"),
    ("ETHIRT", "Ethereum (ETH/IRR)"),
    ("XRPIRT", "Ripple (XRP/IRR)"),
    ("DOGEIRT", "Dogecoin (DOGE/IRR)"),
    ("TRXIRT", "Tron (TRX/IRR)"),
    ("SOLIRT", "Solana (SOL/IRR)"),
    ("TONIRT", "Toncoin (TON/IRR)"),
    ("ADAIRT", "Cardano (ADA/IRR)"),
    ("LTCIRT", "Litecoin (LTC/IRR)"),
]
_INSTRUMENTS: dict[str, str] = dict(_INSTRUMENT_LIST)

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


async def _api_get(client: httpx.AsyncClient, path: str, params: dict) -> dict:
    """One GET → parsed JSON. Module-level so tests monkeypatch it. HTTP errors
    propagate into the caller's circuit breaker — a failed fetch must never
    read as "no data" or the cache would mark the range covered-empty."""
    resp = await client.get(path, params=params)
    resp.raise_for_status()
    return resp.json()


class NobitexBroker(MarketDataBroker):
    """Read-only crypto/IRR candles + live orderbook quote from Nobitex.
    Data-only (no executor, no stream); prices in rial; price_side ignored for
    history (trade data = mid) but get_quote is a true (bid, ask)."""

    supports_streaming = False

    def __init__(self, base_url: str = _BASE_URL) -> None:
        self._client = httpx.AsyncClient(base_url=base_url, timeout=20.0)
        self._throttle = asyncio.Lock()
        self._last_request = 0.0

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _get(self, path: str, params: dict) -> dict:
        async with self._throttle:
            wait = self._last_request + _MIN_REQUEST_INTERVAL - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                return await _api_get(self._client, path, params)
            finally:
                self._last_request = time.monotonic()

    async def _fetch_series(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
    ) -> list[Candle]:
        """Chunked UDF fetch of a native resolution, deduped across seams."""
        udf_res = _RESOLUTIONS[resolution]
        out: list[Candle] = []
        seen: set[datetime] = set()
        for s, e in _chunks(int(start.timestamp()), int(end.timestamp()), resolution.seconds):
            payload = await self._get(
                "/market/udf/history",
                {"symbol": epic, "resolution": udf_res, "from": s, "to": e},
            )
            for c in _udf_to_candles(payload, resolution):
                if c.time not in seen:
                    seen.add(c.time)
                    out.append(c)
        out.sort(key=lambda c: c.time)
        return out

    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: str = "mid",
    ) -> list[Candle]:
        if resolution is Resolution.WEEK:
            # No weekly upstream: fetch the dailies covering the window and
            # fold, then slice. Pad BOTH edges by a week (yfinance-4h
            # precedent) so edge buckets fold from complete weeks — a window
            # ending mid-week (cache backfill ranges do) would otherwise emit
            # a truncated final week as a wrong "closed" bar. The genuinely
            # forming trailing week is dropped inside the fold.
            daily = await self._fetch_series(
                epic,
                Resolution.DAY,
                start - timedelta(days=7),
                end + timedelta(days=7),
            )
            weekly = fold_days_to_weeks(daily)
            return [c for c in weekly if start <= c.time <= end]
        if resolution not in _RESOLUTIONS:
            return []
        candles = await self._fetch_series(epic, resolution, start, end)
        return [c for c in candles if start <= c.time <= end]

    async def get_recent_candles(
        self,
        epic: str,
        resolution: Resolution,
        count: int,
        price_side: str = "mid",
    ) -> list[Candle]:
        """24/7 market: a window of count×width plus modest padding suffices
        (padding absorbs the dropped forming bar and rare exchange downtime)."""
        if count <= 0 or (resolution is not Resolution.WEEK and resolution not in _RESOLUTIONS):
            return []
        now = datetime.now(timezone.utc)
        span = timedelta(seconds=int(resolution.seconds * count * 1.2)) + timedelta(days=1)
        candles = await self.get_candles(epic, resolution, now - span, now, price_side)
        return candles[-count:]

    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """Live orderbook top from /market/stats — already in RIAL (only the
        UDF candle endpoint speaks toman). Real spread: paper trading can
        price fills off this broker."""
        base = epic[:-3].lower() if epic.upper().endswith("IRT") else epic.lower()
        payload = await self._get(
            "/market/stats", {"srcCurrency": base, "dstCurrency": "rls"}
        )
        stats = (payload.get("stats") or {}).get(f"{base}-rls") or {}
        try:
            bid = float(stats["bestBuy"])
            ask = float(stats["bestSell"])
        except (KeyError, TypeError, ValueError):
            return (None, None)
        return (bid, ask)

    @staticmethod
    def _market_row(epic: str, name: str) -> dict:
        return {
            "epic": epic,
            "name": name,
            "status": "TRADEABLE",  # 24/7 market, no session gate
            "type": "crypto",
            # `pricePrecision` is the key the /api/market route + frontend read.
            "pricePrecision": 0,  # rial prices are integers
            "note": "",
        }

    async def all_markets(self) -> list[dict]:
        return [self._market_row(e, n) for e, n in _INSTRUMENT_LIST]

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        ql = query.strip().lower()
        rows = [
            self._market_row(e, n)
            for e, n in _INSTRUMENT_LIST
            if ql in e.lower() or ql in n.lower()
        ]
        return rows[:limit]

    async def get_market_meta(self, epic: str) -> dict | None:
        name = _INSTRUMENTS.get(epic)
        if name is not None:
            return self._market_row(epic, name)
        # Uncurated epic: minimal row so charts open without a catalogue entry.
        return self._market_row(epic, epic)

    async def get_market_detail(self, epic: str) -> dict | None:
        return await self.get_market_meta(epic)


def register(registry) -> NobitexBroker:
    """Register the read-only Nobitex data broker. No credentials, always
    available. Data-only: no executor, so it appears as a chart/backtest source
    but not a tradeable account (its real bid/ask does let paper trading price
    off it, unlike the other data-only sources)."""
    broker = NobitexBroker()
    registry.add_data("nobitex", broker)
    return broker

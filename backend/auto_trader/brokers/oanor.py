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
from auto_trader.core.models import Candle, Resolution

_BASE_URL = "https://api.oanor.com/irr-api"
_MAX_ROWS = 365  # upstream hard cap on /v1/history limit
_MIN_REQUEST_INTERVAL = 0.6  # free tier allows 2 req/s; stay politely under
_SYMBOLS_TTL = 3600.0  # catalogue changes rarely; cache /v1/symbols in-process
_DAY = timedelta(days=1)
_WEEK = timedelta(days=7)


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


def _fold_weekly(daily: list[Candle], now: datetime | None = None) -> list[Candle]:
    """Ascending daily bars → ISO weeks opening Monday-UTC-midnight. The
    still-forming trailing week is dropped — only closed bars may reach the
    cache. (candle_aggregate's "week" rule can't do this: it groups existing
    WEEK bars into 2W/3W buckets, it doesn't build weeks from days.)"""
    if now is None:
        now = datetime.now(timezone.utc)
    out: list[Candle] = []
    week_open: datetime | None = None
    o = h = low = c = 0.0
    for bar in daily:
        wo = bar.time - timedelta(days=bar.time.weekday())
        if wo != week_open:
            if week_open is not None:
                out.append(Candle(time=week_open, open=o, high=h, low=low, close=c))
            week_open = wo
            o, h, low, c = bar.open, bar.high, bar.low, bar.close
        else:
            h = max(h, bar.high)
            low = min(low, bar.low)
            c = bar.close
    if week_open is not None:
        out.append(Candle(time=week_open, open=o, high=h, low=low, close=c))
    return [w for w in out if w.time + _WEEK <= now]


async def _api_get(client: httpx.AsyncClient, path: str, params: dict) -> dict:
    """One authenticated GET → parsed JSON. Module-level so tests monkeypatch it.
    HTTP errors (429 rate cap, 5xx) propagate into the caller's circuit
    breaker — a partial/failed fetch must never read as "no data" or the cache
    would mark the range covered-empty."""
    resp = await client.get(path, params=params)
    resp.raise_for_status()
    return resp.json()


class OanorBroker(MarketDataBroker):
    """Read-only daily IRR bazaar candles + latest price from oanor. Data-only:
    no stream, no executor. price_side ignored (single bazaar rate = mid)."""

    supports_streaming = False

    def __init__(self, api_key: str, base_url: str = _BASE_URL) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"x-oanor-key": api_key},
            timeout=15.0,
        )
        # Serialize requests and space them under the free tier's 2 req/s cap.
        self._throttle = asyncio.Lock()
        self._last_request = 0.0
        self._symbols_cache: list[dict] | None = None
        self._symbols_cached_at = 0.0

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

    async def _fetch_daily(self, epic: str) -> list[Candle]:
        payload = await self._get("/v1/history", {"symbol": epic, "limit": _MAX_ROWS})
        rows = (payload.get("data") or {}).get("history") or []
        return _rows_to_candles(rows)

    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: str = "mid",
    ) -> list[Candle]:
        if resolution not in (Resolution.DAY, Resolution.WEEK):
            return []  # daily feed: nothing finer exists upstream
        daily = await self._fetch_daily(epic)
        series = _fold_weekly(daily) if resolution is Resolution.WEEK else daily
        return [c for c in series if start <= c.time <= end]

    async def get_recent_candles(
        self,
        epic: str,
        resolution: Resolution,
        count: int,
        price_side: str = "mid",
    ) -> list[Candle]:
        """One /v1/history call already returns the full available depth, so
        'recent N' is just the tail of the same fetch."""
        if count <= 0 or resolution not in (Resolution.DAY, Resolution.WEEK):
            return []
        now = datetime.now(timezone.utc)
        candles = await self.get_candles(
            epic, resolution, datetime(1970, 1, 1, tzinfo=timezone.utc), now, price_side
        )
        return candles[-count:]

    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """Latest bazaar price as (close, close): the feed publishes one rate,
        no bid/ask spread. Lets watchlists show a live-ish IRR level; fills
        simulated off it carry no spread cost."""
        payload = await self._get("/v1/price", {"symbol": epic})
        close = (payload.get("data") or {}).get("close")
        if not close:
            return (None, None)
        return (float(close), float(close))

    @staticmethod
    def _market_row(sym: dict) -> dict:
        # IRR prices are integers; the global gold ounce is USD with decimals.
        precision = 0 if sym.get("unit") == "IRR" else 2
        return {
            "epic": sym["symbol"],
            "name": sym.get("name") or sym["symbol"],
            "status": "TRADEABLE",  # history is always fetchable; no session gate
            "type": sym.get("category") or "currency",
            # `pricePrecision` is the key the /api/market route + frontend read;
            # "precision" would be silently dropped.
            "pricePrecision": precision,
            "note": "",
        }

    async def _symbols(self) -> list[dict]:
        now = time.monotonic()
        if self._symbols_cache is None or now - self._symbols_cached_at > _SYMBOLS_TTL:
            payload = await self._get("/v1/symbols", {})
            raw = (payload.get("data") or {}).get("symbols") or []
            self._symbols_cache = [self._market_row(s) for s in raw if s.get("symbol")]
            self._symbols_cached_at = now
        return self._symbols_cache

    async def all_markets(self) -> list[dict]:
        return list(await self._symbols())

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        ql = query.strip().lower()
        rows = [
            r for r in await self._symbols()
            if ql in r["epic"].lower() or ql in r["name"].lower()
        ]
        return rows[:limit]

    async def get_market_meta(self, epic: str) -> dict | None:
        for row in await self._symbols():
            if row["epic"] == epic:
                return row
        return None

    async def get_market_detail(self, epic: str) -> dict | None:
        return await self.get_market_meta(epic)


def register(registry, *, api_key: str, base_url: str = _BASE_URL) -> OanorBroker:
    """Register the read-only oanor IRR data broker. Data-only: no executor, so
    it appears as a chart/backtest source but not a tradeable account."""
    broker = OanorBroker(api_key, base_url)
    registry.add_data("oanor", broker)
    return broker

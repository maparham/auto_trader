"""Dukascopy Bank historical candles as a read-only data broker.

Dukascopy publishes free deep history (back to ~2003) for FX, metals and
indices. Our brokers only keep a rolling window of low-timeframe bars, so this
source exists to give backtests and charts years of 1-minute (and higher) data.

Data-only: no live stream (supports_streaming stays False) and no quote, so it
cannot back paper trading. It rides the standard broker-extension path: implement
the ABCs + register(), no route edits. Its cache namespace is
("dukascopy", epic, resolution, side), isolated from the live brokers so the two
price feeds never blend under one coverage watermark.

The underlying dukascopy_python.fetch() is synchronous and does the bi5 download,
LZMA decompression, tick-to-bar aggregation and per-instrument price scaling
internally, so get_candles just maps our epic/resolution/side to its constants
and runs it in a thread.

NOTE ON VOLUME: Dukascopy is a retail FX/CFD source with no centralized
exchange volume. Its per-tick "volume" is the liquidity available at the best
bid + best ask, expressed in MILLIONS of base units, summed per bar. So it is
not real traded volume and not a plain tick count, and it comes out fractional
(e.g. US100 ~0.4/bar) with an instrument-specific scale (EURUSD ~hundreds/bar,
index CFDs <1/bar). Treat it as meaningless as tradeable volume. We pass it
through verbatim; on the default mid side it's the average of the bid- and
ask-side figures, not a sum.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import dukascopy_python
import dukascopy_python.instruments as dinstr

from auto_trader.brokers.base import MarketDataBroker
from auto_trader.core.models import Candle, Resolution


@dataclass(frozen=True)
class InstrumentInfo:
    epic: str  # our symbol, shown in the picker
    constant: str  # dukascopy_python.instruments constant VALUE
    name: str  # display name
    precision: int  # decimal places for price display
    kind: str  # "fx" | "metal" | "index"
    approx: bool = False  # index CFDs differ from broker pricing/sessions


# Curated catalogue. Constant names verified against dukascopy_python 4.0.1.
_INSTRUMENT_LIST: list[InstrumentInfo] = [
    InstrumentInfo("EURUSD", dinstr.INSTRUMENT_FX_MAJORS_EUR_USD, "EUR/USD", 5, "fx"),
    InstrumentInfo("GBPUSD", dinstr.INSTRUMENT_FX_MAJORS_GBP_USD, "GBP/USD", 5, "fx"),
    InstrumentInfo("USDJPY", dinstr.INSTRUMENT_FX_MAJORS_USD_JPY, "USD/JPY", 3, "fx"),
    InstrumentInfo("AUDUSD", dinstr.INSTRUMENT_FX_MAJORS_AUD_USD, "AUD/USD", 5, "fx"),
    InstrumentInfo("USDCHF", dinstr.INSTRUMENT_FX_MAJORS_USD_CHF, "USD/CHF", 5, "fx"),
    InstrumentInfo("USDCAD", dinstr.INSTRUMENT_FX_MAJORS_USD_CAD, "USD/CAD", 5, "fx"),
    InstrumentInfo("NZDUSD", dinstr.INSTRUMENT_FX_MAJORS_NZD_USD, "NZD/USD", 5, "fx"),
    InstrumentInfo("XAUUSD", dinstr.INSTRUMENT_FX_METALS_XAU_USD, "Gold", 3, "metal"),
    InstrumentInfo("XAGUSD", dinstr.INSTRUMENT_FX_METALS_XAG_USD, "Silver", 4, "metal"),
    InstrumentInfo(
        "US500", dinstr.INSTRUMENT_IDX_AMERICA_E_SANDP_500, "S&P 500", 2, "index", approx=True
    ),
    InstrumentInfo(
        "US30", dinstr.INSTRUMENT_IDX_AMERICA_E_D_J_IND, "Dow 30", 1, "index", approx=True
    ),
    InstrumentInfo(
        "US100", dinstr.INSTRUMENT_IDX_AMERICA_E_NQ_100, "Nasdaq 100", 1, "index", approx=True
    ),
]
_INSTRUMENTS: dict[str, InstrumentInfo] = {i.epic: i for i in _INSTRUMENT_LIST}

_INTERVALS: dict[Resolution, str] = {
    Resolution.MINUTE: dukascopy_python.INTERVAL_MIN_1,
    Resolution.MINUTE_5: dukascopy_python.INTERVAL_MIN_5,
    Resolution.MINUTE_15: dukascopy_python.INTERVAL_MIN_15,
    Resolution.MINUTE_30: dukascopy_python.INTERVAL_MIN_30,
    Resolution.HOUR: dukascopy_python.INTERVAL_HOUR_1,
    Resolution.HOUR_4: dukascopy_python.INTERVAL_HOUR_4,
    Resolution.DAY: dukascopy_python.INTERVAL_DAY_1,
    Resolution.WEEK: dukascopy_python.INTERVAL_WEEK_1,
}

_OFFER_SIDES: dict[str, str] = {
    "bid": dukascopy_python.OFFER_SIDE_BID,
    "ask": dukascopy_python.OFFER_SIDE_ASK,
}


def _instrument_for(epic: str) -> str:
    info = _INSTRUMENTS.get(epic)
    if info is None:
        raise ValueError(f"unknown dukascopy epic: {epic}")
    return info.constant


def _interval_for(resolution: Resolution) -> str:
    interval = _INTERVALS.get(resolution)
    if interval is None:
        raise ValueError(f"unsupported dukascopy resolution: {resolution}")
    return interval


def _offer_side_for(price_side: str) -> str | None:
    """bid/ask map to the library constant; mid returns None (caller averages
    bid and ask). Any other value falls back to mid."""
    return _OFFER_SIDES.get(price_side)


def _df_to_candles(df) -> list[Candle]:
    """OHLCV DataFrame (index = timestamp) -> ascending, tz-aware-UTC Candles.
    An empty frame yields []. The index may be tz-naive (assume UTC) or tz-aware
    (convert to UTC)."""
    if df is None or len(df) == 0:
        return []
    idx = df.index
    if idx.tz is None:
        idx = idx.tz_localize(timezone.utc)
    else:
        idx = idx.tz_convert(timezone.utc)
    out: list[Candle] = []
    for ts, row in zip(idx, df.itertuples(index=False)):
        out.append(
            Candle(
                time=ts.to_pydatetime(),
                open=float(row.open),
                high=float(row.high),
                low=float(row.low),
                close=float(row.close),
                volume=float(getattr(row, "volume", 0.0)),
            )
        )
    out.sort(key=lambda c: c.time)
    return out


class DukascopyBroker(MarketDataBroker):
    """Read-only historical candles from Dukascopy. Data-only: no stream, no quote."""

    supports_streaming = False

    async def get_candles(
        self,
        epic: str,
        resolution: Resolution,
        start: datetime,
        end: datetime,
        price_side: str = "mid",
    ) -> list[Candle]:
        instrument = _instrument_for(epic)  # raises on unknown epic
        interval = _interval_for(resolution)  # raises on unsupported resolution
        side = _offer_side_for(price_side)
        if side is not None:
            df = await asyncio.to_thread(
                dukascopy_python.fetch, instrument, interval, side, start, end
            )
            return _df_to_candles(df)
        # mid: average bid and ask on their shared index. Two fetches, run
        # concurrently (each is a heavy bi5 download); the cache stores the result
        # under side="mid" so this cost is paid once per series.
        bid, ask = await asyncio.gather(
            asyncio.to_thread(
                dukascopy_python.fetch,
                instrument,
                interval,
                dukascopy_python.OFFER_SIDE_BID,
                start,
                end,
            ),
            asyncio.to_thread(
                dukascopy_python.fetch,
                instrument,
                interval,
                dukascopy_python.OFFER_SIDE_ASK,
                start,
                end,
            ),
        )
        # Only synthesize mid where BOTH sides exist. If either is empty, return no
        # bars rather than caching a single-sided (spread-shifted) series as "mid";
        # the inner align below already drops any timestamp missing from one side.
        if bid is None or len(bid) == 0 or ask is None or len(ask) == 0:
            return []
        bid_a, ask_a = bid.align(ask, join="inner", axis=0)
        return _df_to_candles((bid_a + ask_a) / 2.0)

    # Slack added below the count-sized span on each widening pass of
    # get_recent_candles: publish lag (Dukascopy consolidates with a few hours'
    # delay), then a weekend/holiday gap, then the full 7-day slab as the last
    # resort (the pre-expansion behavior). Every download is a synchronous bi5
    # walk over the whole window, so a warm-cache tail fetch (count=3) must stay
    # hours-sized or chart loads time out.
    _RECENT_SLACKS_S = (6 * 3600, 4 * 86_400, 7 * 86_400)

    async def get_recent_candles(
        self,
        epic: str,
        resolution: Resolution,
        count: int,
        price_side: str = "mid",
    ) -> list[Candle]:
        """Most-recent `count` bars. Dukascopy has no 'recent N' primitive, so page
        backward from now in expanding windows until `count` bars land, fetching
        only the extension below the previous window each pass."""
        if count <= 0:
            return []
        now = datetime.now(timezone.utc)
        span = timedelta(seconds=resolution.seconds * count * 3)
        bars: list[Candle] = []
        end = now
        for slack_s in self._RECENT_SLACKS_S:
            start = now - span - timedelta(seconds=slack_s)
            chunk = await self.get_candles(epic, resolution, start, end, price_side)
            # A bar exactly on the window seam could come back in both chunks
            # (upstream end-inclusivity is unspecified); drop seam duplicates so
            # the cold-cache path can't hand the chart a doubled timestamp.
            seen = {int(b.time.timestamp()) for b in bars}
            bars = [b for b in chunk if int(b.time.timestamp()) not in seen] + bars
            if len(bars) >= count:
                break
            end = start
        return bars[-count:]

    async def get_quote(self, epic: str) -> tuple[float | None, float | None]:
        """Historical-only source: no live quote. Paper trading cannot price off
        this broker (documented limitation)."""
        return (None, None)

    def _market_row(self, info: InstrumentInfo) -> dict:
        note = "Index pricing/sessions differ from broker CFDs." if info.approx else ""
        return {
            "epic": info.epic,
            "name": info.name,
            "status": "TRADEABLE",  # history is always available; no live session gate
            "type": info.kind,
            # `pricePrecision` is the key the /api/market route + frontend read
            # (every other broker uses it); "precision" would be silently dropped.
            "pricePrecision": info.precision,
            "note": note,
        }

    async def all_markets(self) -> list[dict]:
        return [self._market_row(i) for i in _INSTRUMENT_LIST]

    async def search_markets(self, query: str, limit: int = 20) -> list[dict]:
        q = query.strip().lower()
        rows = [
            self._market_row(i)
            for i in _INSTRUMENT_LIST
            if q in i.epic.lower() or q in i.name.lower()
        ]
        return rows[:limit]

    async def get_market_meta(self, epic: str) -> dict | None:
        info = _INSTRUMENTS.get(epic)
        return self._market_row(info) if info else None

    async def get_market_detail(self, epic: str) -> dict | None:
        return await self.get_market_meta(epic)


def register(registry) -> DukascopyBroker:
    """Register the read-only dukascopy data broker. No credentials needed, so it
    is always available. Data-only: no executor is registered, so it appears as a
    chart/backtest source but not a tradeable account."""
    broker = DukascopyBroker()
    registry.add_data("dukascopy", broker)
    return broker

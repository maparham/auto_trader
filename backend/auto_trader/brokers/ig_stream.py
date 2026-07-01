"""IG live candle streaming over Lightstreamer.

IG streams market data via Lightstreamer (https://labs.ig.com/lightstreamer-downloads.html),
a different protocol from Capital's raw WebSocket. We subscribe to IG's
`CHART:{epic}:{scale}` item, which pushes a forming OHLC bar — bid AND offer sides,
last-traded volume (LTV), the bar-open epoch (UTM), and a CONS_END flag when the
bar consolidates.

The official `lightstreamer-client-lib` is thread-based, so its update callbacks
fire on Lightstreamer threads. We bridge them onto the asyncio loop through a queue
(`loop.call_soon_threadsafe`), and the async generator drains the queue and yields
`LiveBar` in the SAME shape as `capital_stream` — so the `/ws/candles` relay and the
frontend are unchanged.

IG's native CHART scales are SECOND / 1MINUTE / 5MINUTE / HOUR. Other intraday
resolutions (15m, 30m, 4h) are aggregated up from the largest native scale that
divides them, by epoch-bucketing the bar-open time. Daily/weekly are NOT streamed:
IG's daily bars open at 22:00–23:00 UTC (not midnight), so a midnight-aligned live
bucket wouldn't line up with the REST history — and a daily bar barely needs live
ticking. The route gates those out before calling here.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from lightstreamer.client import (  # type: ignore[import-untyped]
    LightstreamerClient,
    Subscription,
    SubscriptionListener,
)

from auto_trader.brokers.capital import pick_side
from auto_trader.brokers.capital_stream import LiveBar, StreamFatalError
from auto_trader.core.models import Candle
from auto_trader.core.tick_store import TICK_STORE

if TYPE_CHECKING:
    from auto_trader.brokers.ig import IGBroker

log = logging.getLogger(__name__)

# IG CHART consolidation scales: bar seconds -> Lightstreamer scale name.
_NATIVE_SCALES = {1: "SECOND", 60: "1MINUTE", 300: "5MINUTE", 3600: "HOUR"}
_CHART_FIELDS = [
    "UTM", "LTV", "CONS_END",
    "BID_OPEN", "BID_HIGH", "BID_LOW", "BID_CLOSE",
    "OFR_OPEN", "OFR_HIGH", "OFR_LOW", "OFR_CLOSE",
]
# Live streaming is intraday only (see module docstring); DAY = 86400s.
DAY_SECONDS = 86400


def streamable(target_seconds: int) -> bool:
    """Whether IG can stream a forming bar for this resolution (intraday only)."""
    return 0 < target_seconds < DAY_SECONDS


def _source_scale(target_seconds: int) -> int:
    """Largest native CHART scale (seconds) that evenly divides `target_seconds`."""
    for s in (3600, 300, 60, 1):
        if s <= target_seconds and target_seconds % s == 0:
            return s
    return 1


def _f(v: object) -> float | None:
    """Lightstreamer values are strings; '' / None mean 'no value yet'."""
    if v is None or v == "":
        return None
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _mid(u, suffix: str, side: str) -> float | None:
    """Mid (or bid/ask per `side`) of one OHLC component from its bid & offer sides."""
    return pick_side(_f(u.getValue(f"BID_{suffix}")), _f(u.getValue(f"OFR_{suffix}")), side)


class _StreamError:
    """Sentinel pushed onto the queue when the subscription fails, so the async
    generator raises StreamFatalError (the /ws relay then tells the client to STOP
    retrying — a subscription error is permanent, not a transient blip)."""

    def __init__(self, msg: str) -> None:
        self.msg = msg


class _Aggregator:
    """Folds IG CHART source bars into the forming target-resolution bar.

    Each update is one source bar (open time = UTM). When target == source it's a
    passthrough; otherwise source bars are merged into an epoch-aligned target
    bucket: open = the bucket's first source-bar open, high/low = running extremes,
    close = latest, volume = sum of the source bars' LTV. Returns the current
    LiveBar, or None when the update is still missing OHLC (MERGE mode can deliver
    fields incrementally)."""

    def __init__(self, target_seconds: int, price_side: str) -> None:
        self._bucket_ms = target_seconds * 1000
        self._side = price_side
        self._bucket: int | None = None
        self._open = self._high = self._low = self._close = 0.0
        self._vols: dict[int, float] = {}  # source UTM -> latest LTV, summed per bucket

    def update(self, u) -> LiveBar | None:
        utm = _f(u.getValue("UTM"))
        o, h, lo, c = (
            _mid(u, "OPEN", self._side), _mid(u, "HIGH", self._side),
            _mid(u, "LOW", self._side), _mid(u, "CLOSE", self._side),
        )
        if utm is None or o is None or h is None or lo is None or c is None:
            return None
        bucket = int(utm // self._bucket_ms) * self._bucket_ms
        if bucket != self._bucket:
            self._bucket = bucket
            self._vols = {}
            self._open, self._high, self._low, self._close = o, h, lo, c
        else:
            self._high = max(self._high, h)
            self._low = min(self._low, lo)
            self._close = c  # open stays the bucket's first source-bar open
        self._vols[int(utm)] = _f(u.getValue("LTV")) or 0.0
        candle = Candle(
            time=datetime.fromtimestamp(bucket / 1000, tz=timezone.utc),
            open=self._open, high=self._high, low=self._low, close=self._close,
            volume=sum(self._vols.values()),
        )
        # bid/ask ride alongside for the optional bid & ask price lines.
        return LiveBar(candle, _f(u.getValue("BID_CLOSE")), _f(u.getValue("OFR_CLOSE")))


class _ChartListener(SubscriptionListener):
    def __init__(self, agg: _Aggregator, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
        self._agg = agg
        self._loop = loop
        self._queue = queue

    def onItemUpdate(self, update) -> None:  # noqa: N802 (SDK callback name)
        bar = self._agg.update(update)
        if bar is not None:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, bar)

    def onSubscriptionError(self, code, message) -> None:  # noqa: N802
        self._loop.call_soon_threadsafe(
            self._queue.put_nowait,
            _StreamError(f"IG stream error {code}: {message}"),
        )


async def stream_candles(
    broker: "IGBroker", epic: str, resolution, price_side: str = "mid"
):
    """Yield the forming `resolution` candle for `epic` as IG streams it.

    Mirrors capital_stream.stream_candles: an async generator of `LiveBar`. Also
    feeds the mid close into TICK_STORE so the IG paper executor has a fresh price
    for fills and limit/SL/TP triggers (priced from the loop thread, not the LS
    thread)."""
    await broker._ensure_session()
    ls = broker._ls_endpoint
    if not (ls and broker._account_id and broker._cst and broker._security_token):
        raise RuntimeError("IG streaming session unavailable")
    scale = _NATIVE_SCALES[_source_scale(resolution.seconds)]

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    client = LightstreamerClient(ls, "DEFAULT")
    client.connectionDetails.setUser(broker._account_id)
    client.connectionDetails.setPassword(
        f"CST-{broker._cst}|XST-{broker._security_token}"
    )
    sub = Subscription("MERGE", [f"CHART:{epic}:{scale}"], _CHART_FIELDS)
    sub.addListener(_ChartListener(_Aggregator(resolution.seconds, price_side), loop, queue))
    client.subscribe(sub)
    client.connect()
    try:
        while True:
            item = await queue.get()
            if isinstance(item, _StreamError):
                # A Lightstreamer subscription error is permanent (unknown/invalid
                # epic, bad schema, no permission) — it would fail identically on
                # every reconnect. Raise FATAL so the client stops retrying instead
                # of opening/closing the socket in a tight loop.
                raise StreamFatalError(item.msg)
            TICK_STORE.record(broker.broker_id, epic, int(time.time() * 1000), item.candle.close)
            yield item
    finally:
        for stop in (lambda: client.unsubscribe(sub), client.disconnect):
            try:
                stop()
            except Exception:  # best-effort teardown; never mask the real exit
                log.debug("ig_stream teardown error", exc_info=True)

"""Live MT5 (self-hosted terminal, `mt5-self`) candle streaming, tick-folded to
mid-price bars.

The broker polls quote ticks and routes each to the consumer queues registered for
its symbol (see MT5MCPBroker.register_tick_queue).

Each `stream_candles` consumer drains its queue and folds quote ticks into the
forming bar for its resolution: the terminal doesn't stream candles, and quotes
carry bid/ask, giving the
optional bid & ask price lines for free. The forming bar is seeded from the current
still-forming REST bar (get_forming_candle) so it carries the in-progress bucket's
real OHLCV from the first frame instead of cold-starting the open at the first tick.

Scope: native resolutions (1m–4h, plus DAY and WEEK). DAY and WEEK phase their
bucket to the broker's actual bar-open, taken from the seed candle (AvaTrade opens
dailies at 00:00 UTC and weeklies on Sun/Mon per instrument — see `_bucket_ms`).
MONTH is built one level up by folding this DAY stream in the router's derived
path. Seconds intervals aren't wired.
"""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from auto_trader.brokers.capital_stream import LiveBar, StreamFatalError
from auto_trader.core.models import Candle, Resolution
from auto_trader.core.tick_store import TICK_STORE

if TYPE_CHECKING:
    from auto_trader.brokers.mt5_mcp import MT5MCPBroker

log = logging.getLogger(__name__)


def _pick_side(bid: float | None, ask: float | None, side: str) -> float | None:
    """Bid / mid / ask from a quote, or None if a needed side is missing. Unknown
    `side` falls back to mid (a bad chart setting can't break the stream)."""
    if bid is None or ask is None:
        return None
    if side == "bid":
        return bid
    if side == "ask":
        return ask
    return (bid + ask) / 2


def _bucket_ms(ts_ms: int, step_ms: int, anchor_ms: int = 0) -> int:
    """Floor a millisecond timestamp to its bar-open time for a `step_ms` bucket,
    phased to `anchor_ms`.

    anchor_ms=0 (the default) gives plain epoch buckets — correct for intraday,
    whose bars are already epoch-aligned. DAY and WEEK pass a non-zero anchor (the
    seed candle's open) so the bucket lands on the broker's actual bar-open: a
    604800s epoch week opens on a Thursday (the Unix epoch was a Thursday) but the
    broker's weeks open Sun/Mon per instrument, and other MT5 brokers open dailies
    at server-time midnight rather than 00:00 UTC. Phasing to the seed is correct
    for any such convention; anchor 0 would only be right when the broker's bar
    happens to open on an epoch boundary."""
    return anchor_ms + ((ts_ms - anchor_ms) // step_ms) * step_ms


class _Bar:
    """One forming intraday bar, folded purely from ticks (MT5 has no OHLC channel).

    Seed from the latest REST candle for the current bucket, or cold-start from the
    first tick. `open` is fixed for the life of the bar; ticks push close and
    stretch high/low. Quote ticks carry no volume, so volume is whatever the seed
    supplied (0 on a cold start). `roll(t)` resets everything for a new bucket."""

    __slots__ = ("step_ms", "t", "open", "high", "low", "close", "volume")

    def __init__(self, step_ms: int) -> None:
        self.step_ms = step_ms
        self.t: int | None = None
        self.open: float | None = None
        self.high: float | None = None
        self.low: float | None = None
        self.close: float | None = None
        self.volume: float = 0.0

    def roll(self, t: int) -> None:
        self.t = t
        self.open = self.high = self.low = self.close = None
        self.volume = 0.0

    def seed(self, candle: Candle) -> None:
        """Adopt a REST candle as the current bucket's starting OHLCV."""
        self.t = int(candle.time.timestamp() * 1000)
        self.open = candle.open
        self.high = candle.high
        self.low = candle.low
        self.close = candle.close
        self.volume = candle.volume

    def apply(self, price: float) -> None:
        if self.open is None:  # pin open to the first tick of a cold-started bar
            self.open = price
            self.high = self.low = price
        else:
            self.high = max(self.high, price)
            self.low = min(self.low, price)
        self.close = price

    def candle(self) -> Candle | None:
        """Merged bar, or None if nothing has priced it yet."""
        if self.t is None or self.close is None:
            return None
        return Candle(
            time=datetime.fromtimestamp(self.t / 1000, tz=timezone.utc),
            open=float(self.open),
            high=float(self.high),
            low=float(self.low),
            close=float(self.close),
            volume=self.volume,
        )


async def stream_candles(
    broker: "MT5MCPBroker", epic: str, resolution: Resolution, price_side: str = "mid"
) -> AsyncIterator[LiveBar]:
    """Yield the forming `resolution` candle for `epic` as ticks arrive.

    `broker` is the local-terminal adapter (mt5_mcp): it polls ticks and hands
    (bid, ask) tuples through its register_tick_queue queue.

    Mirrors capital_stream/ig_stream: an async generator of `LiveBar`. Also feeds
    the mid close into TICK_STORE so the MT5 paper executor has a fresh price for
    fills and limit/SL/TP triggers."""
    step_ms = resolution.seconds * 1000
    try:
        await broker._ensure_stream()
    except Exception as e:  # noqa: BLE001
        # Connect failure (the terminal is down or unreachable).
        # This is NOT a StreamFatalError/RuntimeError, so it would escape the router's
        # forward() uncaught and close the socket with no error frame. Surface it as a
        # RECOVERABLE RuntimeError: the client reports the feed down but keeps
        # reconnecting, so the chart self-heals once the terminal finishes syncing.
        raise RuntimeError(f"mt5 stream connect failed for {epic}: {e}") from e
    try:
        queue = await broker.register_tick_queue(epic)
    except Exception as e:  # noqa: BLE001
        # Subscribe failed — for a per-epic fault (unknown/invalid symbol) this is
        # permanent and would fail identically on every reconnect. Raise FATAL so the
        # router stops the client retrying; the chart keeps its REST view.
        raise StreamFatalError(f"mt5 stream subscribe failed for {epic}: {e}") from e
    try:
        bar = _Bar(step_ms)
        # Seed the forming bar from the current REST bar so it carries the in-progress
        # bucket's real OHLCV from frame one instead of cold-starting the open at the
        # first tick. MUST be get_forming_candle, not get_recent_candles: the latter is
        # closed-only, so its bucket is always the PREVIOUS one and the guard below
        # would never match (a cold start on every connect — worst on higher TFs).
        # Best-effort: a failed fetch cold-starts. Only seed if the fetched bar is the
        # CURRENT bucket — a stale bar from a rollover gap must not pin the live bar.
        try:
            seed = await broker.get_forming_candle(epic, resolution, price_side)
        except Exception:  # noqa: BLE001 — best-effort; fall back to cold start
            seed = None
        # DAY and WEEK phase their bucket to the broker's actual bar-open, taken from
        # the seed candle's time, rather than a plain epoch floor. AvaTrade opens
        # dailies at 00:00 UTC (so the epoch day happens to be right), but a 604800s
        # epoch week opens on a Thursday while the broker's weeks open Sun/Mon (per
        # instrument) — and other MT5 brokers open dailies at server-time midnight,
        # not UTC. Anchoring to the seed makes the current bucket match on connect
        # regardless of that convention, so the bar seeds instead of cold-starting.
        # Intraday stays epoch-anchored (anchor 0): its bars are already epoch-aligned.
        # No seed means no anchor: DAY safely falls back to the epoch day (00:00 UTC,
        # where AvaTrade dailies open), but WEEK on the epoch-Thursday bucket would
        # stamp the weekly bar at the wrong time (the client renders a SPURIOUS candle
        # beside history, not an update), so WEEK fails recoverably — the client shows
        # the feed down and retries, and the retry's seed fetch usually lands.
        anchor_ms = 0
        if resolution.seconds >= Resolution.DAY.seconds:
            if seed is not None:
                anchor_ms = int(seed.time.timestamp() * 1000)
            elif resolution is Resolution.WEEK:
                raise RuntimeError(f"mt5 weekly stream needs a seed for {epic}; retrying")
        now_ms = int(time.time() * 1000)
        if seed is not None and (
            _bucket_ms(int(seed.time.timestamp() * 1000), step_ms, anchor_ms)
            == _bucket_ms(now_ms, step_ms, anchor_ms)
        ):
            bar.seed(seed)

        while True:
            # The broker's poller keeps feeding this queue across recoverable
            # drops. A PERMANENT outage leaves this awaiting forever with no error
            # frame (unlike Capital/IG's RuntimeError-after-N-failures).
            bid, ask = await queue.get()
            ts_ms = int(time.time() * 1000)
            bucket = _bucket_ms(ts_ms, step_ms, anchor_ms)
            if bar.t is None or bucket > bar.t:
                # A new bucket cold-starts (open = first tick), same as the daily
                # bar at midnight. The CURRENT bucket was seeded from REST on
                # connect, so a rollover only cold-starts if the user is watching
                # across the exact week/day boundary — rare and self-heals on the
                # next reload's REST seed.
                bar.roll(bucket)
            price = _pick_side(bid, ask, price_side)
            if price is None:
                continue
            bar.apply(price)
            # Record the canonical mid (never the price_side value): TICK_STORE is
            # shared and drives paper triggers, so bid/ask must not bleed into it.
            mid = _pick_side(bid, ask, "mid")
            if mid is not None:
                TICK_STORE.record(broker.broker_id, epic, ts_ms, mid)
            candle = bar.candle()
            if candle is not None:
                yield LiveBar(candle=candle, bid=bid, ask=ask)
    finally:
        await broker.unregister_tick_queue(epic, queue)

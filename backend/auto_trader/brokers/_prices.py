"""Broker-agnostic price/rate helpers shared by Capital.com and IG.

Each broker keeps its own `_parse_prices` (Capital reads `snapshotTimeUTC` via
`_parse_utc`; IG's time parsing falls back to a local `snapshotTime` and takes
no `resolution` param) — those bodies genuinely differ and are NOT merged here.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone


class _RateLimiter:
    """Minimal async rate limiter: at most `rate` acquisitions per second.

    Spaces calls by a fixed interval (1/rate). A single lock serializes the
    bookkeeping; callers await until their slot is due, so concurrent tasks are
    throttled to a steady stream rather than bursting."""

    def __init__(self, rate: int) -> None:
        self._interval = 1.0 / rate
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            loop = asyncio.get_event_loop()
            now = loop.time()
            wait = self._next - now
            if wait > 0:
                await asyncio.sleep(wait)
                now = loop.time()
            self._next = max(now, self._next) + self._interval


# Price side a chart renders: bid (sell), ask (buy), or their midpoint. Mirrors
# the frontend's global setting; the capital.com platform itself draws bid by
# default, so "bid" makes our candles line up with theirs. Default stays "mid".
PriceSide = str  # one of: "bid" | "mid" | "ask"


def pick_side(bid: float | None, ask: float | None, side: PriceSide) -> float | None:
    """Choose bid, ask, or mid from a bid/ask pair.

    Falls back to whichever side exists when the preferred one is missing, so a
    one-sided quote still prices a bar. Returns None only when BOTH are missing
    (callers drop the bar rather than fabricate a 0.0, which would corrupt SMA
    signals and draw a low=0 spike)."""
    if side == "bid":
        chosen = bid if bid is not None else ask
    elif side == "ask":
        chosen = ask if ask is not None else bid
    elif bid is not None and ask is not None:
        chosen = (bid + ask) / 2
    else:
        chosen = bid if bid is not None else ask
    return None if chosen is None else float(chosen)


def _mid(price: dict | None, side: PriceSide = "mid") -> float | None:
    """Pick bid/mid/ask from a {bid, ask} price object (see `pick_side`)."""
    if not price:
        return None
    return pick_side(price.get("bid"), price.get("ask"), side)


def _price_precision(m: dict) -> int | None:
    """Decimal places for displaying this instrument's price.

    Capital's markets-list payload has no `decimalPlaces`, but `tickSize` (the
    minimum price increment) implies it: EURUSD 1e-05 -> 5, USDJPY 0.001 -> 3,
    US100 0.1 -> 1, BTCUSD 0.05 -> 2. We honour an explicit `decimalPlaces` if a
    future endpoint ever provides one, else derive from `tickSize`."""
    dp = m.get("decimalPlaces")
    if isinstance(dp, int):
        return dp
    tick = m.get("tickSize")
    if tick is None:
        return None
    try:
        exp = Decimal(str(tick)).normalize().as_tuple().exponent
    except (InvalidOperation, ValueError):
        return None
    return max(0, -exp) if isinstance(exp, int) else None


def _to_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_utc(s: str) -> datetime:
    # snapshotTimeUTC looks like "2022-02-24T10:00:00" (already UTC, no offset)
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)

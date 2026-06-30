"""Aggregate native DAY/WEEK candles into higher "derived" timeframes.

Derived resolutions (2W/3W/6W, 1M/2M/3M, 1Y) are NOT broker resolutions and
are NEVER cached as their own series. The API folds cached base bars into
calendar-aware buckets on read; this module is the pure, I/O-free core (plus a
thin streaming wrapper that re-folds the forming bucket live).
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from auto_trader.core.models import Candle, Resolution

_WEEK = 604800
_MAX_BASE = 5000  # ceiling on a single base fetch (a derived chart never needs more)


@dataclass(frozen=True, slots=True)
class BucketRule:
    base: Resolution  # native series to fold from
    kind: str         # "week" | "month" | "year"
    group: int        # multiplier: 2W->2, 3M->3, 1Y->1


DERIVED: dict[str, BucketRule] = {
    "WEEK_2": BucketRule(Resolution.WEEK, "week", 2),
    "WEEK_3": BucketRule(Resolution.WEEK, "week", 3),
    "WEEK_6": BucketRule(Resolution.WEEK, "week", 6),
    "MONTH": BucketRule(Resolution.DAY, "month", 1),
    "MONTH_2": BucketRule(Resolution.DAY, "month", 2),
    "MONTH_3": BucketRule(Resolution.DAY, "month", 3),
    "YEAR": BucketRule(Resolution.DAY, "year", 1),
}


def is_derived(res: str) -> bool:
    return res in DERIVED


def _utc_ts(dt: datetime) -> int:
    return int(dt.timestamp())


def bucket_open(ts: int, rule: BucketRule) -> int:
    """UTC open timestamp of the bucket containing a base bar opening at `ts`."""
    if rule.kind == "week":
        # Weekly bars share a fixed weekday offset; group by absolute week index so
        # subtracting whole weeks always lands on another weekly bar's open.
        idx = ts // _WEEK
        return (idx - idx % rule.group) * _WEEK
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    if rule.kind == "year":
        return _utc_ts(datetime(dt.year, 1, 1, tzinfo=timezone.utc))
    # month groups: snap to the first month of the group (1-based months).
    g = rule.group
    start_month = ((dt.month - 1) // g) * g + 1
    return _utc_ts(datetime(dt.year, start_month, 1, tzinfo=timezone.utc))


def _emit(bucket_ts: int, o: float, h: float, l: float, c: float, v: float) -> Candle:
    return Candle(datetime.fromtimestamp(bucket_ts, tz=timezone.utc), o, h, l, c, v)


def fold(base_bars: list[Candle], rule: BucketRule) -> list[Candle]:
    """Reduce ascending base bars into aggregate bars, one per bucket."""
    out: list[Candle] = []
    cur_open: int | None = None
    o = h = l = c = v = 0.0
    for bar in base_bars:
        bo = bucket_open(int(bar.time.timestamp()), rule)
        if bo != cur_open:
            if cur_open is not None:
                out.append(_emit(cur_open, o, h, l, c, v))
            cur_open = bo
            o, h, l, c, v = bar.open, bar.high, bar.low, bar.close, bar.volume
        else:
            h = max(h, bar.high)
            l = min(l, bar.low)
            c = bar.close
            v += bar.volume
    if cur_open is not None:
        out.append(_emit(cur_open, o, h, l, c, v))
    return out


def base_count_for(rule: BucketRule, n: int) -> int:
    """Base bars to fetch to cover `n` aggregate bars (over-fetch, then slice)."""
    if rule.kind == "week":
        per = rule.group
    elif rule.kind == "month":
        per = 31 * rule.group
    else:  # year
        per = 366
    return min(_MAX_BASE, n * per)


async def aggregate_candle_stream(
    base_stream: AsyncIterator[Any],
    rule: BucketRule,
    seed_loader: Callable[[int], Awaitable[list[Candle]]],
) -> AsyncIterator[Any]:
    """Fold a forming base-bar stream into forming aggregate bars.

    For each base update we re-fold [closed base bars of the current bucket] +
    [the forming base bar]. Closed bars accumulate from the stream as base bars
    roll over; `seed_loader(bucket_open_ts)` provides the bars already elapsed
    when the stream starts mid-bucket (reconnect). Yields the same LiveBar shape
    (candle/bid/ask) the relay forwards verbatim, with `candle` replaced by the
    aggregate."""
    cur_bo: int | None = None
    closed: list[Candle] = []
    prev: Candle | None = None
    async for bar in base_stream:
        bc = bar.candle
        bo = bucket_open(int(bc.time.timestamp()), rule)
        if (
            prev is not None
            and prev.time != bc.time
            and bucket_open(int(prev.time.timestamp()), rule) == cur_bo
        ):
            closed.append(prev)  # the prior forming base bar just closed
        if bo != cur_bo:
            cur_bo = bo
            closed = await seed_loader(bo)
        prev = bc
        bar.candle = fold(closed + [bc], rule)[-1]
        yield bar

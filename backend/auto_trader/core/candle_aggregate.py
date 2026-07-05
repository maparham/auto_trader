"""Aggregate native MINUTE/DAY/WEEK candles into "derived" timeframes.

Derived resolutions (3m, 2W/3W/6W, 1M/2M/3M, 1Y) are NOT broker resolutions and
are NEVER cached as their own series. The API folds cached base bars into
fixed-duration or calendar-aware buckets on read; this module is the pure,
I/O-free core (plus a thin streaming wrapper that re-folds the forming bucket
live). 3m is the one derived TF finer than a native (it folds native 1m bars);
the rest are coarser.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from auto_trader.core.models import Candle, Resolution

_MINUTE = 60
_WEEK = 604800
# Nominal seconds for calendar buckets (months vary 28–31 days, years 365–366).
# Only for coarse math like backtest annualization — never for bucketing.
_MONTH = 30 * 86400
_YEAR = 365 * 86400
# Ceiling on a single base fetch. Capital's get_recent_candles hard-clamps to
# 1000 bars/request (no pagination), so a larger value would only defeat the
# cache warm-path (cached_n < count-1 stays true forever -> every recent() refetches
# the full page). Deeper history comes from scroll-back, not a bigger recent fetch.
_MAX_BASE = 1000


@dataclass(frozen=True, slots=True)
class BucketRule:
    base: Resolution  # native series to fold from
    kind: str         # "minute" | "week" | "month" | "year"
    group: int        # multiplier: 3m->3, 2W->2, 3M->3, 1Y->1


DERIVED: dict[str, BucketRule] = {
    # NB: 3m folds from native 1m, so its history depth is bounded by Capital's
    # 1-minute retention — Capital serves only ~the last ~10 days of MINUTE bars
    # (a /prices?resolution=MINUTE request for older dates returns HTTP 400), while
    # 5m+ go back weeks/months. So a 3m chart has a hard left edge ~10 days back
    # (sliding forward with time). This is a BROKER limit, not the cache; verified
    # 2026-07-05 on capital-live/OIL_CRUDE. Coarser derived TFs fold from DAY/WEEK,
    # which have deep history, so they're unaffected.
    "MINUTE_3": BucketRule(Resolution.MINUTE, "minute", 3),
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


def resolution_seconds(res: str) -> int:
    """Nominal bar width in seconds for any resolution, native or derived.

    Native resolutions defer to Resolution.seconds. Derived ones can't (their
    keys aren't in the enum): fixed-duration buckets are exact, month/year use a
    nominal average (matches the frontend's RESOLUTION_SECONDS). Intended for
    coarse math like backtest annualization, never for bucketing."""
    rule = DERIVED.get(res)
    if rule is None:
        return Resolution(res).seconds
    if rule.kind == "minute":
        return rule.group * _MINUTE
    if rule.kind == "week":
        return rule.group * _WEEK
    if rule.kind == "month":
        return rule.group * _MONTH
    return _YEAR  # year


def _utc_ts(dt: datetime) -> int:
    return int(dt.timestamp())


def bucket_open(ts: int, rule: BucketRule) -> int:
    """UTC open timestamp of the bucket containing a base bar opening at `ts`."""
    if rule.kind == "minute":
        # Fixed-duration buckets aligned to the epoch. group*60 divides an hour
        # evenly (3m -> 180s, and 3600 % 180 == 0), so buckets land on :00/:03/:06…
        span = rule.group * _MINUTE
        return ts - ts % span
    if rule.kind == "week":
        # Weekly bars share a fixed weekday offset; group by absolute week index and
        # subtract whole weeks from `ts` itself so the result PRESERVES that offset
        # (lands on the group's first real weekly-bar open, not epoch-Thursday).
        idx = ts // _WEEK
        return ts - (idx % rule.group) * _WEEK
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    if rule.kind == "year":
        return _utc_ts(datetime(dt.year, 1, 1, tzinfo=timezone.utc))
    # month groups: snap to the first month of the group (1-based months).
    g = rule.group
    start_month = ((dt.month - 1) // g) * g + 1
    return _utc_ts(datetime(dt.year, start_month, 1, tzinfo=timezone.utc))


def bucket_end(ts: int, rule: BucketRule) -> int:
    """UTC open timestamp of the bucket AFTER the one containing `ts` (exclusive
    upper edge). Used to snap a scroll-back window outward so every folded bucket
    is complete — partial edge buckets would corrupt the chart on prepend."""
    if rule.kind == "minute":
        return bucket_open(ts, rule) + rule.group * _MINUTE
    if rule.kind == "week":
        return bucket_open(ts, rule) + rule.group * _WEEK
    dt = datetime.fromtimestamp(bucket_open(ts, rule), tz=timezone.utc)
    if rule.kind == "year":
        return _utc_ts(datetime(dt.year + 1, 1, 1, tzinfo=timezone.utc))
    # advance `group` months from the bucket's start month, carrying into years.
    total = (dt.year * 12 + (dt.month - 1)) + rule.group
    return _utc_ts(datetime(total // 12, total % 12 + 1, 1, tzinfo=timezone.utc))


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
    if rule.kind in ("minute", "week"):
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
        # The relay yields LiveBar, an immutable NamedTuple — never assign to
        # `bar.candle` (raises AttributeError). Emit a copy with the folded candle,
        # preserving bid/ask so the relay's JSON frame is unchanged.
        yield bar._replace(candle=fold(closed + [bc], rule)[-1])

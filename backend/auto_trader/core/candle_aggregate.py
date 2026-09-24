"""Aggregate native MINUTE/DAY/WEEK candles into "derived" timeframes.

Derived resolutions are any non-native timeframe the grammar in
`core/timeframe.py` accepts (the eight built-ins plus user-defined ones),
folded on read, never cached as their own series; intraday ones reset daily
at 00:00 UTC. The API folds cached base bars into fixed-duration or
calendar-aware buckets on read; this module is the pure, I/O-free core (plus
a thin streaming wrapper that re-folds the forming bucket live). 3m is the
one built-in derived TF finer than a native (it folds native 1m bars); the
rest are coarser.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any

from auto_trader.core import timeframe as _tf
from auto_trader.core.models import Candle, Resolution

_MINUTE = 60
_WEEK = 604800
_DAY = 86400
# Ceiling on a single base fetch. Capital's get_recent_candles hard-clamps to
# 1000 bars/request (no pagination), so a larger value would only defeat the
# cache warm-path (cached_n < count-1 stays true forever -> every recent() refetches
# the full page). Deeper history comes from scroll-back, not a bigger recent fetch.
_MAX_BASE = 1000


@dataclass(frozen=True, slots=True)
class BucketRule:
    base: Resolution  # native series to fold from
    kind: str         # "minute" (daily-reset intraday, group = span in minutes) | "day" | "week" | "month" | "year"
    group: int        # minute: span in minutes (6H -> 360); others: multiplier


# Native minute bases, largest first: a MINUTE_N fold uses the largest one
# dividing N. All of them divide a day, so no base bar straddles the 00:00 reset.
# NB: any MINUTE_N whose largest divisor is native 1m (N not a multiple of 5)
# folds from it, so its history depth is bounded by Capital's 1-minute
# retention — Capital serves only ~the last ~10 days of MINUTE bars (a
# /prices?resolution=MINUTE request for older dates returns HTTP 400), while
# 5m+ go back weeks/months. So a 3m (and any other 1m-based) chart has a hard
# left edge ~10 days back (sliding forward with time). This is a BROKER limit,
# not the cache; verified 2026-07-05 on capital-live/OIL_CRUDE. Coarser
# derived TFs fold from HOUR/DAY/WEEK, which have deep history, unaffected.
_MINUTE_BASES = (
    (30, Resolution.MINUTE_30), (15, Resolution.MINUTE_15),
    (5, Resolution.MINUTE_5), (1, Resolution.MINUTE),
)
_BUILTIN_DERIVED = (
    "MINUTE_3", "WEEK_2", "WEEK_3", "WEEK_6", "MONTH", "MONTH_2", "MONTH_3", "YEAR",
)


@lru_cache(maxsize=512)
def rule_for(res: str) -> BucketRule | None:
    """The fold rule for a non-native timeframe; None for natives, seconds keys
    and anything the grammar rejects. Hours fold from HOUR, never HOUR_4: some
    brokers offset their 4H bars from UTC midnight, which would break the daily
    reset."""
    try:
        t = _tf.parse(res)
    except _tf.TimeframeError:
        return None
    if t.unit == "SECOND" or _tf.is_native(res):
        return None
    if t.unit == "MINUTE":
        base = next(r for step, r in _MINUTE_BASES if t.n % step == 0)
        return BucketRule(base, "minute", t.n)
    if t.unit == "HOUR":
        return BucketRule(Resolution.HOUR, "minute", t.n * 60)
    if t.unit == "DAY":
        return BucketRule(Resolution.DAY, "day", t.n)
    if t.unit == "WEEK":
        return BucketRule(Resolution.WEEK, "week", t.n)
    if t.unit == "MONTH":
        return BucketRule(Resolution.DAY, "month", t.n)
    return BucketRule(Resolution.DAY, "year", 1)


class _DerivedRules(Mapping[str, BucketRule]):
    """Every derived timeframe's rule, computed on demand from the grammar.
    Membership and lookup accept any valid derived timeframe; iteration lists
    only the built-in set (the grammar itself is unbounded)."""

    def __getitem__(self, res: str) -> BucketRule:
        rule = rule_for(res) if isinstance(res, str) else None
        if rule is None:
            raise KeyError(res)
        return rule

    def __contains__(self, res: object) -> bool:
        return isinstance(res, str) and rule_for(res) is not None

    def __iter__(self) -> Iterator[str]:
        return iter(_BUILTIN_DERIVED)

    def __len__(self) -> int:
        return len(_BUILTIN_DERIVED)


DERIVED: Mapping[str, BucketRule] = _DerivedRules()


def is_derived(res: str) -> bool:
    return res in DERIVED


def resolution_seconds(res: str) -> int:
    """Nominal bar width in seconds for any timeframe (months 30d, year 365d).
    For coarse math like annualization, never for bucketing. Raises
    TimeframeError (a ValueError) on an invalid timeframe."""
    return _tf.seconds(res)


def _utc_ts(dt: datetime) -> int:
    return int(dt.timestamp())


def bucket_open(ts: int, rule: BucketRule) -> int:
    """UTC open timestamp of the bucket containing a base bar opening at `ts`."""
    if rule.kind == "minute":
        # Daily reset at 00:00 UTC: buckets tile each day from midnight, so a
        # span that doesn't divide the day ends the day on a short bar.
        span = rule.group * _MINUTE
        day = ts - ts % _DAY
        return day + ((ts - day) // span) * span
    if rule.kind == "day":
        # Like weeks: subtract whole days from `ts` so the broker's daily-bar
        # offset is preserved.
        return ts - ((ts // _DAY) % rule.group) * _DAY
    if rule.kind == "week":
        # Weekly bars share a fixed weekday offset; group by absolute week index and
        # subtract whole weeks from `ts` itself so the result PRESERVES that offset
        # (lands on the group's first real weekly-bar open, not epoch-Thursday).
        idx = ts // _WEEK
        return ts - (idx % rule.group) * _WEEK
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    if rule.kind == "year":
        return _utc_ts(datetime(dt.year, 1, 1, tzinfo=timezone.utc))
    # month groups: January-anchored within the year (1-based months).
    g = rule.group
    start_month = ((dt.month - 1) // g) * g + 1
    return _utc_ts(datetime(dt.year, start_month, 1, tzinfo=timezone.utc))


def bucket_end(ts: int, rule: BucketRule) -> int:
    """UTC open timestamp of the bucket AFTER the one containing `ts` (exclusive
    upper edge). Used to snap a scroll-back window outward so every folded bucket
    is complete. Short buckets (the last intraday bar of a day, the last month
    group of a year) end at the reset, not a full span later."""
    start = bucket_open(ts, rule)
    if rule.kind == "minute":
        return min(start + rule.group * _MINUTE, start - start % _DAY + _DAY)
    if rule.kind == "day":
        return start + rule.group * _DAY
    if rule.kind == "week":
        return start + rule.group * _WEEK
    dt = datetime.fromtimestamp(start, tz=timezone.utc)
    if rule.kind == "year":
        return _utc_ts(datetime(dt.year + 1, 1, 1, tzinfo=timezone.utc))
    idx = dt.year * 12 + (dt.month - 1)
    nxt = min(idx + rule.group, (dt.year + 1) * 12)
    return _utc_ts(datetime(nxt // 12, nxt % 12 + 1, 1, tzinfo=timezone.utc))


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
    if rule.kind == "minute":
        per = rule.group * _MINUTE // rule.base.seconds
    elif rule.kind in ("day", "week"):
        per = rule.group
    elif rule.kind == "month":
        per = 31 * rule.group
    else:  # year
        per = 366
    return min(_MAX_BASE, n * per)


def fold_days_to_weeks(daily: list[Candle], now: datetime | None = None) -> list[Candle]:
    """Ascending daily bars → ISO weeks opening Monday-UTC-midnight, volume
    summed. The still-forming trailing week is dropped — only closed bars may
    reach the cache. Used by daily-native brokers (oanor, nobitex) to serve
    WEEK; the "week" BucketRule above can't do this — it groups existing WEEK
    bars into 2W/3W buckets, it doesn't build weeks from days."""
    if now is None:
        now = datetime.now(timezone.utc)
    out: list[Candle] = []
    week_open: datetime | None = None
    o = h = low = c = v = 0.0
    for bar in daily:
        wo = bar.time - timedelta(days=bar.time.weekday())
        if wo != week_open:
            if week_open is not None:
                out.append(Candle(time=week_open, open=o, high=h, low=low, close=c, volume=v))
            week_open = wo
            o, h, low, c, v = bar.open, bar.high, bar.low, bar.close, bar.volume
        else:
            h = max(h, bar.high)
            low = min(low, bar.low)
            c = bar.close
            v += bar.volume
    if week_open is not None:
        out.append(Candle(time=week_open, open=o, high=h, low=low, close=c, volume=v))
    week = timedelta(days=7)
    return [w for w in out if w.time + week <= now]


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

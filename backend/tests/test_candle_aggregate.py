import asyncio
from datetime import datetime, timezone

from auto_trader.core.candle_aggregate import (
    DERIVED,
    aggregate_candle_stream,
    base_count_for,
    bucket_end,
    bucket_open,
    fold,
    is_derived,
)
from auto_trader.core.models import Candle, Resolution


def _c(y, m, d, o, h, l, c, v=1.0):
    return Candle(datetime(y, m, d, tzinfo=timezone.utc), o, h, l, c, v)


def _ts(y, m, d):
    return int(datetime(y, m, d, tzinfo=timezone.utc).timestamp())


def test_registry_covers_seven_tokens():
    assert set(DERIVED) == {
        "WEEK_2", "WEEK_3", "WEEK_6", "MONTH", "MONTH_2", "MONTH_3", "YEAR",
    }
    assert DERIVED["WEEK_2"].base is Resolution.WEEK
    assert DERIVED["MONTH"].base is Resolution.DAY
    assert DERIVED["YEAR"].base is Resolution.DAY


def test_is_derived():
    assert is_derived("MONTH") is True
    assert is_derived("WEEK_2") is True
    assert is_derived("WEEK") is False
    assert is_derived("MINUTE_5") is False


def test_bucket_open_month_groups_calendar_month():
    r = DERIVED["MONTH"]
    assert bucket_open(_ts(2026, 3, 1), r) == _ts(2026, 3, 1)
    assert bucket_open(_ts(2026, 3, 31), r) == _ts(2026, 3, 1)
    assert bucket_open(_ts(2026, 4, 1), r) == _ts(2026, 4, 1)


def test_bucket_open_quarter_and_2month():
    q = DERIVED["MONTH_3"]
    assert bucket_open(_ts(2026, 2, 15), q) == _ts(2026, 1, 1)
    assert bucket_open(_ts(2026, 5, 15), q) == _ts(2026, 4, 1)
    two = DERIVED["MONTH_2"]
    assert bucket_open(_ts(2026, 2, 15), two) == _ts(2026, 1, 1)
    assert bucket_open(_ts(2026, 3, 15), two) == _ts(2026, 3, 1)


def test_bucket_open_year():
    y = DERIVED["YEAR"]
    assert bucket_open(_ts(2026, 7, 1), y) == _ts(2026, 1, 1)
    assert bucket_open(_ts(2026, 12, 31), y) == _ts(2026, 1, 1)


def test_bucket_open_week_multiple_groups_consecutive_weeks():
    r = DERIVED["WEEK_2"]
    week = 604800
    base = _ts(2026, 1, 1)
    b0 = bucket_open(base, r)
    assert bucket_open(base + week, r) == b0
    assert bucket_open(base + 2 * week, r) == b0 + 2 * week


def test_bucket_end_is_next_bucket_open():
    # month: end of March's bucket is April 1
    assert bucket_end(_ts(2026, 3, 15), DERIVED["MONTH"]) == _ts(2026, 4, 1)
    # quarter containing Feb -> next quarter opens April 1
    assert bucket_end(_ts(2026, 2, 15), DERIVED["MONTH_3"]) == _ts(2026, 4, 1)
    # December rolls the year over
    assert bucket_end(_ts(2026, 12, 10), DERIVED["MONTH"]) == _ts(2027, 1, 1)
    # year
    assert bucket_end(_ts(2026, 7, 1), DERIVED["YEAR"]) == _ts(2027, 1, 1)
    # week multiple: open + group weeks
    r = DERIVED["WEEK_2"]
    base = _ts(2026, 1, 1)
    assert bucket_end(base, r) == bucket_open(base, r) + 2 * 604800


def test_fold_month_reduces_ohlcv():
    bars = [
        _c(2026, 3, 1, 10, 12, 9, 11, v=5),
        _c(2026, 3, 2, 11, 15, 10, 14, v=7),
        _c(2026, 4, 1, 14, 16, 13, 15, v=3),
    ]
    out = fold(bars, DERIVED["MONTH"])
    assert len(out) == 2
    mar = out[0]
    assert mar.time == datetime(2026, 3, 1, tzinfo=timezone.utc)
    assert (mar.open, mar.high, mar.low, mar.close, mar.volume) == (10, 15, 9, 14, 12)
    assert out[1].open == 14 and out[1].close == 15


def test_fold_empty():
    assert fold([], DERIVED["MONTH"]) == []


def test_base_count_for():
    assert base_count_for(DERIVED["WEEK_2"], 10) == 20
    assert base_count_for(DERIVED["WEEK_3"], 10) == 30
    assert base_count_for(DERIVED["MONTH"], 4) == 4 * 31
    assert base_count_for(DERIVED["MONTH_3"], 2) == 2 * 3 * 31
    assert base_count_for(DERIVED["YEAR"], 2) == 2 * 366
    assert base_count_for(DERIVED["YEAR"], 100) == 5000


class _Bar:
    def __init__(self, candle, bid=None, ask=None):
        self.candle = candle
        self.bid = bid
        self.ask = ask


def _drain(rule, bars, seed):
    async def base_stream():
        for b in bars:
            yield b

    async def go():
        return [b async for b in aggregate_candle_stream(base_stream(), rule, seed)]

    return asyncio.run(go())


def test_aggregate_stream_folds_forming_bucket():
    async def seed(bucket_ts):
        return []

    out = _drain(
        DERIVED["MONTH"],
        [
            _Bar(_c(2026, 3, 1, 10, 12, 9, 11)),
            _Bar(_c(2026, 3, 2, 11, 15, 8, 13)),
            _Bar(_c(2026, 4, 1, 13, 14, 12, 13)),
        ],
        seed,
    )
    assert len(out) == 3
    assert out[1].candle.open == 10 and out[1].candle.high == 15 and out[1].candle.low == 8
    assert out[2].candle.open == 13 and out[2].candle.time.month == 4


def test_aggregate_stream_seeds_partial_bucket_on_reconnect():
    async def seed(bucket_ts):
        return [_c(2026, 3, 1, 8, 30, 5, 20)]

    out = _drain(DERIVED["MONTH"], [_Bar(_c(2026, 3, 20, 12, 13, 11, 12))], seed)
    assert out[0].candle.open == 8
    assert out[0].candle.high == 30
    assert out[0].candle.close == 12

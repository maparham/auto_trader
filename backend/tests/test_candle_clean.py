# backend/tests/test_candle_clean.py
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from auto_trader.core.candle_clean import (
    Split,
    needs_prev,
    repair_stale_prints,
    suspect_indices,
)
from auto_trader.core.models import Candle

DAY = 86_400
# Real Capital.com BKNG daily bars around the 2026-04-06 25:1 split.
T_APR2 = 1775088000
T_APR6 = 1775433600
T_APR7 = 1775520000
BKNG_SPLIT = Split(ts=1775482200, ratio=25.0)  # 2026-04-06 09:30 America/New_York


def _bar(ts: int, o: float, h: float, l: float, c: float, v: float = 1.0) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(ts, tz=timezone.utc),
        open=o, high=h, low=l, close=c, volume=v,
    )


def _bkng_days() -> list[Candle]:
    return [
        _bar(T_APR2, 165.6, 168.12, 162.405, 167.5),
        _bar(T_APR6, 4187.5, 4187.5, 166.295, 176.12, 22839.0),
        _bar(T_APR7, 177.6, 180.25, 169.835, 177.375),
    ]


def test_confirmed_split_repairs_stale_open_and_high():
    bars, repairs = repair_stale_prints(_bkng_days(), [BKNG_SPLIT], res_seconds=DAY)
    fixed = bars[1]
    assert (fixed.open, fixed.high, fixed.low, fixed.close) == (167.5, 176.12, 166.295, 176.12)
    assert fixed.volume == 22839.0
    assert [r.index for r in repairs] == [1]
    assert repairs[0].ratio == 25.0
    # Neighbours untouched.
    assert bars[0] == _bkng_days()[0] and bars[2] == _bkng_days()[2]


def test_threshold_repairs_the_same_bar_without_a_split_list():
    bars, repairs = repair_stale_prints(_bkng_days(), [], res_seconds=DAY)
    assert bars[1].open == 167.5 and bars[1].high == 176.12
    assert repairs[0].ratio is None


def test_threshold_can_be_disabled():
    bars, repairs = repair_stale_prints(
        _bkng_days(), [], res_seconds=DAY, allow_threshold=False
    )
    assert repairs == [] and bars[1].open == 4187.5


def test_real_gap_that_holds_is_untouched():
    # 3.2x gap up that stays up: the open agrees with its own close.
    bars = [_bar(0, 99, 101, 98, 100), _bar(DAY, 320, 330, 300, 310)]
    out, repairs = repair_stale_prints(bars, [], res_seconds=DAY)
    assert repairs == [] and out == bars


def test_listed_split_with_mismatched_ratio_does_not_fire():
    # A 2:1 split listed on the day, but the bar is BKNG's 25x print: the split
    # ratio test fails, and with the threshold off nothing else may repair it.
    out, repairs = repair_stale_prints(
        _bkng_days(), [Split(ts=BKNG_SPLIT.ts, ratio=2.0)], res_seconds=DAY,
        allow_threshold=False,
    )
    assert repairs == [] and out[1].open == 4187.5


def test_split_far_from_the_bar_does_not_confirm():
    far = Split(ts=BKNG_SPLIT.ts + 30 * DAY, ratio=25.0)
    _, repairs = repair_stale_prints(
        _bkng_days(), [far], res_seconds=DAY, allow_threshold=False
    )
    assert repairs == []


def test_small_split_below_threshold_needs_the_split_list():
    # 2:1 split: stale open 200 vs adjusted prev close 100, close 104.
    bars = [_bar(0, 99, 101, 98, 100), _bar(DAY, 200, 200, 99, 104)]
    split = Split(ts=DAY + 13 * 3600, ratio=2.0)
    _, none = repair_stale_prints(bars, [], res_seconds=DAY)
    assert none == []  # 2x is under the 3x threshold
    out, repairs = repair_stale_prints(bars, [split], res_seconds=DAY)
    assert repairs[0].ratio == 2.0
    assert (out[1].open, out[1].high, out[1].low) == (100, 104, 99)


def test_split_with_gap_clamps_open_into_the_bars_range():
    # 2:1 split plus a real 10% gap: prev 100 adjusted, day trades 108..112.
    bars = [_bar(0, 99, 101, 98, 100), _bar(DAY, 200, 200, 108, 112)]
    out, _ = repair_stale_prints(bars, [Split(ts=DAY, ratio=2.0)], res_seconds=DAY)
    assert out[1].open == 108  # not 100, which would sit below the low
    assert out[1].high == 112 and out[1].low == 108


def test_reverse_split_repairs_stale_low():
    # 1:10 reverse split: adjusted prev close 50, stale open 5 (old price).
    bars = [_bar(0, 49, 51, 48, 50), _bar(DAY, 5, 53, 5, 52)]
    out, repairs = repair_stale_prints(bars, [Split(ts=DAY, ratio=0.1)], res_seconds=DAY)
    assert repairs[0].ratio == 0.1
    assert (out[1].open, out[1].high, out[1].low, out[1].close) == (50, 53, 50, 52)


def test_first_bar_uses_prev_when_given():
    days = _bkng_days()[1:]  # window starts on the stale bar
    out, repairs = repair_stale_prints(days, [], res_seconds=DAY, prev=_bkng_days()[0])
    assert [r.index for r in repairs] == [0]
    assert out[0].open == 167.5


def test_first_bar_without_prev_confirms_from_split_and_own_close():
    days = _bkng_days()[1:]
    out, repairs = repair_stale_prints(days, [BKNG_SPLIT], res_seconds=DAY)
    assert [r.index for r in repairs] == [0]
    assert out[0].open == 167.5  # 4187.5 / 25


def test_first_bar_without_prev_or_split_is_left_alone():
    days = _bkng_days()[1:]
    out, repairs = repair_stale_prints(days, [], res_seconds=DAY)
    assert repairs == [] and out[0].open == 4187.5


def test_suspects_and_needs_prev():
    assert suspect_indices(_bkng_days()) == [1]
    assert suspect_indices([_bar(0, 99, 101, 98, 100), _bar(DAY, 320, 330, 300, 310)]) == []
    assert needs_prev(_bkng_days()[1:]) is True
    assert needs_prev(_bkng_days()) is False
    assert needs_prev([]) is False


@pytest.mark.parametrize("bars", [[], [_bar(0, 1, 1, 1, 1)]])
def test_degenerate_inputs(bars):
    out, repairs = repair_stale_prints(bars, [], res_seconds=DAY)
    assert out == bars and repairs == []


# --- array form (pattern search reads the store into numpy) -----------------


def _arrays(bars):
    import numpy as np

    ts = np.array([int(b.time.timestamp()) for b in bars], dtype=np.int64)
    ohlc = np.array([[b.open, b.high, b.low, b.close] for b in bars], dtype=np.float64)
    return ts, ohlc


def test_array_repair_matches_the_candle_repair():
    from auto_trader.core.candle_clean import repair_stale_arrays

    ts, ohlc = _arrays(_bkng_days())
    n = repair_stale_arrays(ts, ohlc, [BKNG_SPLIT], res_seconds=DAY)
    assert n == 1
    assert ohlc[1].tolist() == [167.5, 176.12, 166.295, 176.12]
    assert ohlc[0].tolist() == [165.6, 168.12, 162.405, 167.5]


def test_array_repair_uses_prev_close_for_the_first_bar():
    from auto_trader.core.candle_clean import repair_stale_arrays

    ts, ohlc = _arrays(_bkng_days()[1:])
    assert repair_stale_arrays(ts, ohlc, [], res_seconds=DAY) == 0
    assert repair_stale_arrays(ts, ohlc, [], res_seconds=DAY, prev_close=167.5) == 1
    assert ohlc[0][0] == 167.5


def test_array_repair_leaves_gaps_and_crypto_alone():
    from auto_trader.core.candle_clean import repair_stale_arrays

    ts, gap = _arrays([_bar(0, 99, 101, 98, 100), _bar(DAY, 320, 330, 300, 310)])
    before = gap.copy()
    assert repair_stale_arrays(ts, gap, [], res_seconds=DAY) == 0
    assert (gap == before).all()
    ts, ohlc = _arrays(_bkng_days())
    assert repair_stale_arrays(ts, ohlc, [], res_seconds=DAY, allow_threshold=False) == 0
    assert ohlc[1][0] == 4187.5

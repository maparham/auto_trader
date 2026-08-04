from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.evaluate import compile_row, series_of
from auto_trader.strategy.expr.parser import parse


def _bars(ohlc):
    """ohlc: list of (open, close); high/low derived."""
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(minutes=5 * i), open=o, high=max(o, c) + 1, low=min(o, c) - 1, close=c, volume=100)
        for i, (o, c) in enumerate(ohlc)
    ]


def _candles(closes, resolution_s=3600):
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    for k, c in enumerate(closes):
        out.append(Candle(time=base + timedelta(seconds=resolution_s * k),
                          open=c, high=c, low=c, close=c, volume=100.0))
    return out


def _row_bools(src, candles, resolution="HOUR", htf=None, is_exit=False, entry=None):
    row = compile_row(parse(src), candles, resolution, htf or {})
    return [row.evaluate(i, entry) for i in range(len(candles))]


def test_ema_comparison():
    c = _candles([1, 2, 3, 2, 1])
    # EMA(2): 1, 1.6667, 2.5556, 2.3704, 1.7901
    assert _row_bools("EMA(2) > 2", c) == [False, False, True, True, False]


def test_arith_and_atr():
    c = _candles([1, 2, 3, 2, 1])
    # candle.close + 0 > EMA(2) at each bar
    assert _row_bools("candle.close > EMA(2)", c) == [False, True, True, False, False]


def test_highest_includes_current_bar():
    c = _candles([1, 2, 3, 2, 1])
    # highest(candle.close, 2): None, 2, 3, 3, 2  -> > 2.5 -> F,F,T,T,F
    assert _row_bools("highest(candle.close, 2) > 2.5", c) == [False, False, True, True, False]


def test_slope_positive():
    c = _candles([1, 2, 3, 2, 1])
    # slope(candle.close, 1) [%/hr]: None, 100, 50, -33.3, -50 -> > 0 -> F,T,T,F,F
    assert _row_bools("slope(candle.close, 1) > 0", c) == [False, True, True, False, False]


def test_offset_reads_prior_bar():
    c = _candles([1, 2, 3, 2, 1])
    # candle[-1].close: None, 1, 2, 3, 2 -> > 1.5 -> F,F,T,T,T
    assert _row_bools("candle[-1].close > 1.5", c) == [False, False, True, True, True]


def test_nan_poisons_to_false():
    c = _candles([1, 2, 3, 2, 1])
    # division by zero -> nan -> false everywhere
    assert _row_bools("candle.close / 0 > 0", c) == [False] * 5


def test_nan_poisons_highest_window():
    # closes [3, 2, 5, 4]; raw = close/(close-2): [3, nan (2/0), 5/3, 2].
    # highest(raw, 2) per bar:
    #   bar0: window too short -> None -> False
    #   bar1: window [3, nan] -> poisoned. Without the NaN screen, max(3, nan)
    #         returns 3 (order-dependent) and would leak 3 > 0 -> True.
    #   bar2: window [nan, 5/3] -> poisoned -> False
    #   bar3: window [5/3, 2] -> max 2 > 0 -> True
    c = _candles([3, 2, 5, 4])
    assert _row_bools("highest(candle.close / (candle.close - 2), 2) > 0", c) == [
        False, False, False, True]


def test_cross_above():
    c = _candles([1, 2, 3, 2, 1])
    # crossAbove(candle.close, 2): prev<=2 and now>2 -> only bar 2
    assert _row_bools("crossAbove(candle.close, 2)", c) == [False, False, True, False, False]


def test_entry_in_exit_rule():
    c = _candles([1, 2, 3, 2, 1])
    # candle.close > entry with entry price 2.5 -> only bar 2 (close 3)
    assert _row_bools("candle.close > entry", c, is_exit=True, entry=2.5) == [
        False, False, True, False, False]


def test_tf_forward_fill():
    # base hourly 5 bars; HOUR_4 has closes [10,20] at t=0 and t=4h. The first
    # HOUR_4 bar (opens t=0) closes at t=4h, so it becomes usable only at base
    # bar 4 (wait-close, no hindsight) -> [None, None, None, None, 10.0].
    base = _candles([1, 1, 1, 1, 1], resolution_s=3600)
    htf_base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    htf = {"HOUR_4": [
        Candle(time=htf_base, open=10, high=10, low=10, close=10, volume=1),
        Candle(time=htf_base + timedelta(seconds=14400), open=20, high=20, low=20, close=20, volume=1),
    ]}
    arr = series_of(parse("candle.close@HOUR_4 > 5").left, base, "HOUR", htf)
    assert arr == [None, None, None, None, 10.0]


def test_tf_field_wrapped_over_tf():
    # Field wrapped over Tf: candle@HOUR_4.high pushes the field onto the inner
    # Candle leaf, then forward-fills the HTF highs the same way as the close path.
    base = _candles([1, 1, 1, 1, 1], resolution_s=3600)
    htf_base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    htf = {"HOUR_4": [
        Candle(time=htf_base, open=10, high=10, low=10, close=10, volume=1),
        Candle(time=htf_base + timedelta(seconds=14400), open=20, high=20, low=20, close=20, volume=1),
    ]}
    arr = series_of(parse("candle@HOUR_4.high > 0").left, base, "HOUR", htf)
    assert arr == [None, None, None, None, 10.0]


def test_series_of_arith():
    c = _candles([1, 2, 3, 2, 1])
    assert series_of(parse("candle.close - EMA(1) > 0").left, c, "HOUR", {}) == [0.0, 0.0, 0.0, 0.0, 0.0]


def test_count_series_red_candles():
    # closes below opens on bars 1,2,4
    candles = _bars([(10, 11), (11, 10), (10, 9), (9, 10), (10, 8), (8, 9)])
    node = parse("count(candle.open > candle.close, 3) >= 2")
    vals = series_of(node.left, candles, "MINUTE_5", {})
    # window of 3 incl current: None,None,2,2,2,1? -> bar2 window [0,1,2]=2, bar3 [1,2,3]=2, bar4 [2,3,4]=2, bar5 [3,4,5]=1
    assert vals == [None, None, 2.0, 2.0, 2.0, 1.0]


def test_count_window_below_one_is_zero():
    candles = _bars([(10, 9), (9, 8)])
    node = parse("count(candle.open > candle.close, 0.5) > 0")
    assert series_of(node.left, candles, "MINUTE_5", {}) == [0.0, 0.0]


def test_count_undefined_cond_counts_zero():
    # EMA(3) is undefined for the first 2 bars; those bars count 0, and the
    # count itself is defined once the window fits (window 2 -> from bar 1).
    candles = _bars([(10, 11), (11, 12), (12, 13), (13, 14)])
    node = parse("count(candle.close > EMA(3), 2) >= 1")
    vals = series_of(node.left, candles, "MINUTE_5", {})
    assert vals[0] is None and vals[1] is not None


def test_predicate_row_evaluate():
    candles = _bars([(10, 11), (11, 10), (10, 10)])
    row = compile_row(parse("bearish(candle)"), candles, "MINUTE_5", {})
    assert [row.evaluate(i, None) for i in range(3)] == [False, True, False]  # doji is neither


def test_bullish_predicate_row():
    candles = _bars([(10, 11), (11, 10)])
    row = compile_row(parse("bullish(candle)"), candles, "MINUTE_5", {})
    assert [row.evaluate(i, None) for i in range(2)] == [True, False]


def test_count_cross_condition():
    # close crossing above a constant-ish SMA is fiddly; use crossAbove(close, open) shape
    candles = _bars([(10, 9), (10, 11), (10, 9), (10, 11)])
    node = parse("count(crossAbove(candle.close, candle.open), 4) >= 2")
    vals = series_of(node.left, candles, "MINUTE_5", {})
    # matches at bars 1 and 3 (close moves from below open to above)
    assert vals[3] == 2.0


def test_bars_since_entry_not_a_series():
    candles = _bars([(10, 11)])
    with pytest.raises(ValueError):
        series_of(parse("barsSinceEntry > 1").left, candles, "MINUTE_5", {})

from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.warmup import warmup_bars


def test_indicator_length():
    assert warmup_bars(parse("EMA(50) > 0")) == 50


def test_max_across_row():
    assert warmup_bars(parse("EMA(9) > SMA(20)")) == 20


def test_nested_sum():
    # slope(highest(EMA(9),5),3) -> 9 + 5 + 3
    assert warmup_bars(parse("slope(highest(EMA(9),5),3) > 0")) == 17


def test_offset_adds():
    assert warmup_bars(parse("EMA(9)[-2] > 0")) == 11


def test_no_length_indicators_zero():
    assert warmup_bars(parse("VOL > 0")) == 0
    assert warmup_bars(parse("candle.close > entry")) == 0


# --- @tf pins ----------------------------------------------------------------
# With the base resolution known, a pin contributes ZERO base bars: its series
# is computed from its own higher-timeframe candles (sourced and sufficiency-
# checked by the routes — expr.py::_ensure_htf), never from the base history.
# Only terms operating on the base-aligned series (outside offsets/wrappers)
# count.


def test_tf_pin_needs_no_base_history():
    assert warmup_bars(parse("EMA(50)@1H > 0"), "MINUTE_5") == 0


def test_tf_base_side_still_counts():
    # EMA(9) runs on the base candles; the pinned EMA(50) does not.
    assert warmup_bars(parse("crossAbove(EMA(9), EMA(50)@1H)"), "MINUTE_5") == 9


def test_tf_without_resolution_passes_through():
    # No base resolution known: legacy behaviour (callers that only ever see
    # base-timeframe rows keep their numbers).
    assert warmup_bars(parse("EMA(50)@1H > 0")) == 50


def test_tf_offset_outside_pin_is_base_bars():
    # candle@D.close[-1] parses as Offset(Field(Tf(...))): the offset shifts the
    # base-ALIGNED series, so it needs 1 base bar; the pin itself needs none.
    assert warmup_bars(parse("candle@D.close[-1] > 0"), "MINUTE_5") == 1


def test_tf_wrapper_outside_pin_is_base_bars():
    # slope's window runs over the base-aligned series: 3 base bars.
    assert warmup_bars(parse("slope(EMA(50)@1H, 3) > 0"), "MINUTE_5") == 3

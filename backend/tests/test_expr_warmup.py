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


def test_warmup_count_literal_window():
    # window 10 + cond warmup (EMA 9) = 19
    assert warmup_bars(parse("count(candle.close > EMA(9), 10) >= 3")) == 19


def test_warmup_count_dynamic_window():
    # barsSinceEntry window contributes 0; cond is candle-only -> 0
    assert warmup_bars(parse("count(bearish(candle), barsSinceEntry) >= 3")) == 0


def test_warmup_predicate_offset():
    assert warmup_bars(parse("bearish(candle[-2])")) == 2


def test_warmup_bars_since_entry_standalone():
    assert warmup_bars(parse("barsSinceEntry > 12")) == 0


# --- candle pattern predicates -----------------------------------------------
# A pattern needs 14 bars for the epsilon series (0.05 * SMA14 of true range) +
# 4 for the deepest lookback (ladderBottom). Mirrored by the frontend's
# catalog.ts PATTERN_WARMUP.


def test_pattern_predicate_warms_up_18_bars():
    assert warmup_bars(parse("bullEngulfing(candle)"), "MINUTE_5") == 18


def test_pattern_warm_up_adds_the_offset():
    assert warmup_bars(parse("bullEngulfing(candle[-3])"), "MINUTE_5") == 21


def test_a_tf_pinned_pattern_costs_no_base_bars_beyond_the_pattern_itself():
    """An @tf pin contributes zero BASE bars (the pinned series has its own
    history), so only the pattern's own 18 remain."""
    assert warmup_bars(parse("bullEngulfing(candle@4H)"), "MINUTE_5") == 18


def test_bullish_predicate_still_warms_up_zero():
    assert warmup_bars(parse("bullish(candle)"), "MINUTE_5") == 0

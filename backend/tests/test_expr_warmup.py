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

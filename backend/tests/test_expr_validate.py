import pytest
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate


def _err(src, is_exit=False):
    with pytest.raises(ExprError) as exc:
        validate(parse(src), is_exit=is_exit)
    return exc.value


def test_valid_expression_passes():
    validate(parse("EMA(50) > candle.high + 3 * ATR(14)"), is_exit=False)
    validate(parse("slope(EMA(9), 3) > 0"), is_exit=False)
    validate(parse("crossAbove(candle.close, EMA(9))"), is_exit=False)


def test_unknown_name():
    e = _err("FOO(9) > 0")
    assert e.code == "unknown_name" and (e.start, e.end) == (0, 6)


def test_bad_arity():
    assert _err("EMA(9, 3) > 0").code == "bad_arity"
    assert _err("slope(EMA(9)) > 0").code == "bad_arity"


def test_field_on_call_rejected():
    e = _err("MACD(12,26,9).signal > 0")
    assert e.code == "unknown_name"  # MACD is not registered
    e2 = _err("EMA(9).signal > 0")
    assert e2.code == "field_on_call"


def test_entry_only_in_exit_rules():
    assert _err("entry > candle.close", is_exit=False).code == "entry_in_entry_rule"
    validate(parse("candle.close < entry"), is_exit=True)  # ok in exit


def test_cross_not_toplevel():
    # A cross used as a comparison operand (not the whole row) is rejected. The
    # source differs from the brief sample: the parser's top-level cross branch
    # requires EOF after `)`, so `crossAbove(...) > 0` raises unexpected_token at
    # parse time and never reaches the validator. Nesting the cross under a
    # comparison operand is the shape that exercises the validator's branch.
    e = _err("EMA(9) > crossAbove(candle.close, EMA(9))")
    assert e.code == "cross_not_toplevel"


def test_bad_candle_field():
    assert _err("candle.foo > 0").code == "bad_candle_field"
    assert _err("candle > 0").code == "bad_candle_field"  # bare candle needs a field


def test_wrapped_candle_field_passes():
    # candle@D.high and candle[-1].open validate: the field lives on the outer
    # Field node and the inner Candle(field=None) is a legitimate base.
    validate(parse("candle@D.high > 5"), is_exit=False)
    validate(parse("candle[-1].high > 5"), is_exit=False)


def test_wrapped_candle_bad_field():
    assert _err("candle@D.bogus > 5").code == "bad_candle_field"


def test_predicate_row_valid():
    validate(parse("bullish(candle)"), is_exit=False)
    validate(parse("bearish(candle[-2])"), is_exit=False)
    validate(parse("bearish(candle@1H)"), is_exit=False)


def test_predicate_arg_must_be_bare_candle():
    with pytest.raises(ExprError) as ei:
        validate(parse("bullish(candle.close)"), is_exit=False)
    assert ei.value.code == "bad_predicate_arg"
    with pytest.raises(ExprError) as ei:
        validate(parse("bullish(EMA(9))"), is_exit=False)
    assert ei.value.code == "bad_predicate_arg"


def test_predicate_unknown_tf_still_reported():
    with pytest.raises(ExprError) as ei:
        validate(parse("bullish(candle@BOGUS)"), is_exit=False)
    assert ei.value.code == "unknown_tf"


def test_predicate_as_value_rejected():
    with pytest.raises(ExprError) as ei:
        validate(parse("bullish(candle) + 1 > 0"), is_exit=False)
    assert ei.value.code == "predicate_as_value"


def test_count_validates_condition_and_window():
    validate(parse("count(candle.open > candle.close, 10) >= 3"), is_exit=False)
    validate(parse("count(crossAbove(candle.close, EMA(9)), 20) >= 1"), is_exit=False)
    validate(parse("count(bearish(candle), barsSinceEntry) >= 3"), is_exit=True)


def test_bars_since_entry_exit_only():
    with pytest.raises(ExprError) as ei:
        validate(parse("barsSinceEntry > 5"), is_exit=False)
    assert ei.value.code == "entry_in_entry_rule"
    validate(parse("barsSinceEntry > 5"), is_exit=True)


def test_count_condition_operands_validated():
    with pytest.raises(ExprError) as ei:
        validate(parse("count(FOO(9) > 0, 10) > 1"), is_exit=False)
    assert ei.value.code == "unknown_name"

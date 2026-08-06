import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate


def test_hash_is_legal_inside_a_name():
    row = parse("SLOPE#a1b2c3.slope0 > 0")
    assert isinstance(row.left, N.IndicatorRef)
    assert row.left.instance == "SLOPE#a1b2c3"
    assert row.left.output == "slope0"


def test_a_plain_instance_ref_parses():
    row = parse("SLOPE.slope0 > 0.5")
    assert isinstance(row.left, N.IndicatorRef)
    assert (row.left.instance, row.left.output) == ("SLOPE", "slope0")


def test_a_ref_composes_under_offset_and_timeframe():
    row = parse("SLOPE.slope0[-2] @1H > 0")
    tf = row.left
    assert isinstance(tf, N.Tf) and tf.tf == "1H"
    assert isinstance(tf.base, N.Offset)
    assert isinstance(tf.base.base, N.IndicatorRef)


def test_a_ref_composes_inside_a_wrapper():
    row = parse("slope(SLOPE.slope0, 5) > 0")
    assert isinstance(row.left, N.Call)
    assert isinstance(row.left.args[0], N.IndicatorRef)


def test_a_registered_indicator_call_is_still_a_call_not_a_ref():
    row = parse("EMA(9) > 0")
    assert isinstance(row.left, N.Call) and row.left.name == "EMA"


def test_a_field_on_a_registered_call_is_untouched():
    # Still Field(Call), so validate keeps reporting field_on_call.
    row = parse("EMA(9).signal > 0")
    assert isinstance(row.left, N.Field)


def test_hash_still_rejected_as_a_leading_character():
    with pytest.raises(ExprError) as e:
        parse("#SLOPE > 0")
    assert e.value.code == "bad_char"


def test_contains_tf_sees_through_a_ref():
    assert N.contains_tf(parse("SLOPE.slope0 @1H > 0").left) is True
    assert N.contains_tf(parse("SLOPE.slope0 > 0").left) is False


def test_field_on_zero_arg_indicator_is_untouched():
    # VOL is arity-0 and registered in INDICATORS, so `VOL.x` must stay a
    # Field(Call) — not an IndicatorRef — and validate must still report
    # field_on_call, exercising the INDICATORS exclusion term specifically
    # (unlike EMA(9).signal, which is excluded earlier by `not node.args`).
    row = parse("VOL.x > 0")
    assert isinstance(row.left, N.Field)
    with pytest.raises(ExprError) as e:
        validate(row, is_exit=False)
    assert e.value.code == "field_on_call"


def test_field_on_bare_wrapper_name_is_untouched():
    # `slope` is a registered wrapper name; bare (no parens) it's still
    # Call('slope', []), so `.x` must stay Field, exercising WRAPPERS.
    row = parse("slope.x > 0")
    assert isinstance(row.left, N.Field)
    with pytest.raises(ExprError) as e:
        validate(row, is_exit=False)
    assert e.value.code == "field_on_call"


def test_field_on_bare_predicate_name_is_untouched():
    # `doji` is a registered candle-pattern predicate name; bare it's
    # Call('doji', []), so `.x` must stay Field, exercising PREDICATE_FNS.
    row = parse("doji.x > 0")
    assert isinstance(row.left, N.Field)
    with pytest.raises(ExprError) as e:
        validate(row, is_exit=False)
    assert e.value.code == "unknown_name"


def test_field_on_bare_cross_fn_name_is_untouched():
    # `crossAbove` is a registered cross fn name; bare it's Call('crossAbove',
    # []), so `.x` must stay Field, exercising CROSS_FNS.
    row = parse("crossAbove.x > 0")
    assert isinstance(row.left, N.Field)
    with pytest.raises(ExprError) as e:
        validate(row, is_exit=False)
    assert e.value.code == "cross_not_toplevel"

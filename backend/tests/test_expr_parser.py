import pytest
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.parser import parse


def test_precedence_star_over_plus():
    # EMA(50) > candle.high + 3 * ATR(14)
    top = parse("EMA(50) > candle.high + 3 * ATR(14)")
    assert isinstance(top, N.Compare) and top.op == ">"
    assert isinstance(top.right, N.Binary) and top.right.op == "+"
    # the '+' right operand is the '*' term
    assert isinstance(top.right.right, N.Binary) and top.right.right.op == "*"


def test_postfix_offset_binds_to_candle_then_field():
    # candle[-1].open  ->  Field(Offset(Candle(None), 1), "open")
    top = parse("candle[-1].open > candle.open")
    left = top.left
    assert isinstance(left, N.Field) and left.name == "open"
    assert isinstance(left.base, N.Offset) and left.base.n == 1
    assert isinstance(left.base.base, N.Candle) and left.base.base.field is None


def test_tf_then_field():
    # candle@D.high  ->  Field(Tf(Candle(None), "DAY"?), "high") -- tf string kept raw here
    top = parse("candle@D.high > 5")
    left = top.left
    assert isinstance(left, N.Field) and left.name == "high"
    assert isinstance(left.base, N.Tf) and left.base.tf == "D"


def test_cross_top_level():
    top = parse("crossAbove(candle.close, EMA(9))")
    assert isinstance(top, N.Cross) and top.fn == "crossAbove"
    assert isinstance(top.a, N.Candle) and isinstance(top.b, N.Call)


def test_nested_tf_is_parse_error():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9)@4H@D > 0")
    assert exc.value.code == "nested_tf"


def test_missing_comparison_operator_is_error():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) EMA(21)")
    assert exc.value.code == "expected_operator"


def test_offset_requires_negative_integer():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9)[2] > 0")
    assert exc.value.code == "bad_offset"

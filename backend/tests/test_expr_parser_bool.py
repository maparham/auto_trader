import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse


def test_or_of_two_comparisons():
    row = parse("RSI(14) > 70 or RSI(14) < 30")
    assert isinstance(row, N.BoolOp) and row.op == "or"
    assert [type(p) for p in row.parts] == [N.Compare, N.Compare]
    assert row.start == 0 and row.end == len("RSI(14) > 70 or RSI(14) < 30")


def test_precedence_and_binds_tighter_than_or():
    row = parse("candle.close > 1 or candle.close > 2 and candle.close > 3")
    assert isinstance(row, N.BoolOp) and row.op == "or"
    assert isinstance(row.parts[0], N.Compare)
    assert isinstance(row.parts[1], N.BoolOp) and row.parts[1].op == "and"


def test_chained_same_op_flattens():
    row = parse("candle.close > 1 or candle.close > 2 or candle.close > 3")
    assert isinstance(row, N.BoolOp) and row.op == "or" and len(row.parts) == 3


def test_not_wraps_the_whole_comparison():
    row = parse("not candle.close > EMA(9)")
    assert isinstance(row, N.Not)
    assert isinstance(row.operand, N.Compare)
    assert row.start == 0


def test_double_not():
    row = parse("not not bullish(candle)")
    assert isinstance(row, N.Not) and isinstance(row.operand, N.Not)
    assert isinstance(row.operand.operand, N.Predicate)


def test_parens_group_conditions():
    row = parse("(candle.close > EMA(9) or bullish(candle)) and RSI(14) < 70")
    assert isinstance(row, N.BoolOp) and row.op == "and"
    assert isinstance(row.parts[0], N.BoolOp) and row.parts[0].op == "or"


def test_parenthesized_arith_still_works():
    row = parse("(candle.high + candle.low) / 2 > EMA(9)")
    assert isinstance(row, N.Compare)
    assert isinstance(row.left, N.Binary) and row.left.op == "/"


def test_crosses_compose_with_or():
    row = parse("EMA(9) x> EMA(50) or RSI(14) x< 30")
    assert isinstance(row, N.BoolOp)
    assert all(isinstance(p, N.Cross) for p in row.parts)


def test_two_crosses_in_one_chain_now_parse():
    # multiple_crosses is deleted: unrestricted crosses.
    row = parse("EMA(9) x> EMA(50) x< EMA(20)")
    assert isinstance(row, N.Chain)
    assert sum(isinstance(p, N.Cross) for p in row.parts) == 2


def test_count_takes_boolean_condition():
    row = parse("count(bullish(candle) and candle.close > EMA(9), 5) > 2")
    assert isinstance(row, N.Compare)
    assert isinstance(row.left, N.Count)
    assert isinstance(row.left.cond, N.BoolOp) and row.left.cond.op == "and"


def test_and_needs_conditions():
    with pytest.raises(ExprError) as e:
        parse("candle.close and EMA(9)")
    assert e.value.code == "expected_condition"
    assert (e.value.start, e.value.end) == (0, len("candle.close"))


def test_not_needs_a_condition():
    with pytest.raises(ExprError) as e:
        parse("not candle.close")
    assert e.value.code == "expected_condition"
    assert (e.value.start, e.value.end) == (4, len("not candle.close"))


def test_postfix_on_paren_condition_rejected():
    with pytest.raises(ExprError) as e:
        parse("(candle.close > EMA(9))[-1]")
    assert e.value.code == "bool_as_value"


def test_bare_arith_row_still_expected_operator():
    with pytest.raises(ExprError) as e:
        parse("EMA(9) EMA(21)")
    assert e.value.code == "expected_operator"
    assert (e.value.start, e.value.end) == (7, 10)


def test_trailing_and_reports_missing_value():
    with pytest.raises(ExprError) as e:
        parse("candle.close > EMA(9) and")
    assert e.value.code == "unexpected_token"


def test_equality_composes_with_the_boolean_layer():
    node = parse("candle.close == 10 and candle.close > 5")
    assert node.op == "and"
    assert [p.op for p in node.parts] == ["==", ">"]


def test_not_over_an_equality():
    node = parse("not RSI(14) == 50")
    assert node.__class__.__name__ == "Not"
    assert node.operand.op == "=="


def test_count_takes_a_boolean_equality_condition():
    node = parse("count(candle.open == candle.close or candle.close > 1, 5) > 2")
    cond = node.left.cond
    assert cond.op == "or"
    assert [p.op for p in cond.parts] == ["==", ">"]

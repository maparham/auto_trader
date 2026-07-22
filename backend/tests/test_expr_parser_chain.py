import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate


def test_single_comparison_stays_compare():
    assert isinstance(parse("candle.close > 100"), N.Compare)


def test_two_links_become_chain_sharing_middle_operand():
    node = parse("candle.close > EMA(9) > EMA(50)")
    assert isinstance(node, N.Chain)
    assert len(node.parts) == 2
    assert node.parts[0].op == ">" and node.parts[1].op == ">"
    # middle operand (EMA(9)) is the same object in both links
    assert node.parts[0].right is node.parts[1].left


def test_mixed_operators_are_allowed():
    node = parse("candle.close > EMA(9) < EMA(50)")
    assert isinstance(node, N.Chain)
    assert [p.op for p in node.parts] == [">", "<"]


def test_trailing_operator_still_errors():
    with pytest.raises(ExprError):
        parse("candle.close > EMA(9) >")


def test_cross_is_not_chained():
    assert isinstance(parse("crossAbove(candle.close, EMA(9))"), N.Cross)


def test_original_failing_rule_now_parses_and_validates():
    node = parse("candle.close>EMA(9)>EMA(50)")
    validate(node, is_exit=False)  # no raise
    assert isinstance(node, N.Chain)

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


def test_parse_count_with_comparison_condition():
    node = parse("count(candle.open > candle.close, 10) >= 3")
    assert isinstance(node, N.Compare) and node.op == ">="
    cnt = node.left
    assert isinstance(cnt, N.Count)
    assert isinstance(cnt.cond, N.Compare) and cnt.cond.op == ">"
    assert isinstance(cnt.window, N.Num) and cnt.window.value == 10


def test_parse_count_with_cross_condition():
    node = parse("count(crossBelow(candle.close, EMA(9)), 20) >= 1")
    cnt = node.left
    assert isinstance(cnt, N.Count)
    assert isinstance(cnt.cond, N.Cross) and cnt.cond.fn == "crossBelow"


def test_parse_count_with_predicate_condition_and_dynamic_window():
    node = parse("count(bearish(candle), barsSinceEntry) >= 3")
    cnt = node.left
    assert isinstance(cnt, N.Count)
    assert isinstance(cnt.cond, N.Predicate) and cnt.cond.fn == "bearish"
    assert isinstance(cnt.window, N.BarsSinceEntry)


def test_parse_predicate_as_whole_row():
    node = parse("bearish(candle[-1])")
    assert isinstance(node, N.Predicate) and node.fn == "bearish"
    assert isinstance(node.base, N.Offset) and node.base.n == 1


def test_parse_bars_since_entry_standalone():
    node = parse("barsSinceEntry > 12")
    assert isinstance(node.left, N.BarsSinceEntry)


def test_count_without_condition_errors():
    with pytest.raises(ExprError) as ei:
        parse("count(candle.close, 10) > 3")
    assert ei.value.code == "count_needs_condition"


def test_count_spans():
    node = parse("count(bullish(candle), 5) > 2")
    cnt = node.left
    assert (cnt.start, cnt.end) == (0, 25)  # "count(bullish(candle), 5)"
    assert (cnt.cond.start, cnt.cond.end) == (6, 21)  # "bullish(candle)"


def test_equality_at_top_level():
    top = parse("count(candle.close > candle.open, 5) == 3")
    assert isinstance(top, N.Compare) and top.op == "=="
    assert isinstance(top.left, N.Count)
    assert isinstance(top.right, N.Num) and top.right.value == 3


def test_equality_inside_count_condition():
    # The other reading of "count needs equality": equality as the counted condition.
    top = parse("count(EMA(9) == EMA(21), 20) > 0")
    assert isinstance(top.left, N.Count)
    assert isinstance(top.left.cond, N.Compare) and top.left.cond.op == "=="


def test_expected_operator_copy_lists_equality():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) EMA(21)")
    assert exc.value.code == "expected_operator"
    assert exc.value.message == "Expected a comparison operator (> < >= <= == x> x<)."

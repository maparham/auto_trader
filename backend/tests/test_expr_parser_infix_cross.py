import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import BAD_CROSS_MSG, ExprError
from auto_trader.strategy.expr.parser import parse


def test_lone_infix_cross_above_is_bare_cross_node():
    row = parse("EMA(9) x> EMA(50)")
    assert isinstance(row, N.Cross)
    assert row.fn == "crossAbove"
    assert isinstance(row.a, N.Call) and row.a.name == "EMA"
    assert isinstance(row.b, N.Call) and row.b.name == "EMA"
    # spans: operand-start .. operand-end (unlike the fn form's fn.start..close.end)
    assert (row.start, row.end) == (0, 17)


def test_lone_infix_cross_below():
    row = parse("candle.close x< EMA(9)")
    assert isinstance(row, N.Cross)
    assert row.fn == "crossBelow"


def test_function_form_unchanged():
    row = parse("crossAbove(EMA(9), EMA(50))")
    assert isinstance(row, N.Cross)
    assert row.fn == "crossAbove"
    assert (row.start, row.end) == (0, 27)


def test_mixed_chain_cross_first():
    row = parse("EMA(9) x> EMA(50) > EMA(200)")
    assert isinstance(row, N.Chain)
    assert [type(p) for p in row.parts] == [N.Cross, N.Compare]
    # middle operand is shared: cross.b is compare.left
    assert row.parts[0].b is row.parts[1].left


def test_mixed_chain_cross_last():
    row = parse("EMA(9) > EMA(50) x> EMA(200)")
    assert isinstance(row, N.Chain)
    assert [type(p) for p in row.parts] == [N.Compare, N.Cross]
    assert row.parts[0].right is row.parts[1].a


def test_multiple_crosses_rejected():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) x> EMA(50) x> EMA(200)")
    assert exc.value.code == "multiple_crosses"
    # span of the second cross part: its left operand start .. right operand end
    assert (exc.value.start, exc.value.end) == (10, 29)


def test_infix_cross_inside_count():
    row = parse("count(EMA(9) x> EMA(50), 10) >= 2")
    assert isinstance(row, N.Compare)
    cnt = row.left
    assert isinstance(cnt, N.Count)
    assert isinstance(cnt.cond, N.Cross)
    assert cnt.cond.fn == "crossAbove"


def test_nested_infix_cross_is_cross_not_toplevel():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) > (EMA(9) x> EMA(50))")
    assert exc.value.code == "cross_not_toplevel"
    # span of the offending x> token
    assert (exc.value.start, exc.value.end) == (17, 19)


def test_spaced_x_is_bad_cross_op():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) x > EMA(50)")
    assert exc.value.code == "bad_cross_op"
    assert (exc.value.start, exc.value.end) == (7, 8)


def test_uppercase_x_is_bad_cross_op():
    with pytest.raises(ExprError) as exc:
        parse("X> EMA(9)")
    assert exc.value.code == "bad_cross_op"
    assert (exc.value.start, exc.value.end) == (0, 1)


def test_part_operands_accessor():
    row = parse("EMA(9) x> EMA(50) > EMA(200)")
    l0, r0 = N.part_operands(row.parts[0])
    l1, r1 = N.part_operands(row.parts[1])
    assert (l0, r0) == (row.parts[0].a, row.parts[0].b)
    assert (l1, r1) == (row.parts[1].left, row.parts[1].right)


def test_trailing_bare_x_is_bad_cross_op():
    # "... x" with nothing after it used to fail expect("EOF") generically.
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) x> EMA(50) x")
    assert exc.value.code == "bad_cross_op"
    assert exc.value.message == BAD_CROSS_MSG
    assert (exc.value.start, exc.value.end) == (18, 19)


def test_trailing_uppercase_x_is_bad_cross_op():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) > EMA(50) X")
    assert exc.value.code == "bad_cross_op"
    assert (exc.value.start, exc.value.end) == (17, 18)


def test_bare_x_operand_not_before_a_bracket_is_an_unknown_name():
    # A bare "x" used as a value has nothing to do with cross operators, so it
    # must reach the validator as an unknown name instead of being second-guessed.
    row = parse("count(candle.close > 2, x) >= 1")
    window = row.left.window
    assert isinstance(window, N.Call)
    assert (window.name, window.args) == ("x", [])
    assert (window.start, window.end) == (24, 25)


def test_bare_x_operand_before_a_bracket_is_still_bad_cross_op():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) > X> EMA(50)")
    assert exc.value.code == "bad_cross_op"
    assert (exc.value.start, exc.value.end) == (9, 10)


def test_x_ge_reaches_the_parser_as_bad_cross_op():
    with pytest.raises(ExprError) as exc:
        parse("EMA(9) x>= 2")
    assert exc.value.code == "bad_cross_op"
    assert (exc.value.start, exc.value.end) == (7, 10)


def test_no_space_fuse_parses_as_a_cross():
    row = parse("EMA(9)x>EMA(50)")
    assert isinstance(row, N.Cross) and row.fn == "crossAbove"

import pytest

from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars


def test_valid_boolean_rows_validate():
    for src in (
        "RSI(14) > 70 or RSI(14) < 30",
        "not bullish(candle)",
        "(candle.close > EMA(9) or bullish(candle)) and RSI(14) < 70",
        "count(bullish(candle) and candle.close > EMA(9), 5) > 2",
        "EMA(9) x> EMA(50) or crossBelow(RSI(14), 30)",
        # Stacked nots: each Not must recurse into its operand rather than fall
        # through to _walk (which used to hit `node.left` and AttributeError).
        "not not not candle.close > 1",
    ):
        validate(parse(src), is_exit=False)


def test_count_over_boolean_and_chain_conditions():
    # count's cond is now any condition, not just Predicate/Cross/Compare. The
    # BoolOp case used to reach `cond.left`, the Chain case `cond.left` too —
    # both AttributeError before the recursion landed.
    validate(parse("count(candle.close > 1 and candle.open > 1, 3) > 0"), is_exit=False)
    validate(parse("count(EMA(9) x> EMA(21) x> EMA(50), 3) > 0"), is_exit=False)


def test_entry_still_rejected_in_entry_rules_inside_bool():
    with pytest.raises(ExprError) as e:
        validate(parse("candle.close > entry or bullish(candle)"), is_exit=False)
    assert e.value.code == "entry_in_entry_rule"


def test_unknown_name_reported_inside_not():
    with pytest.raises(ExprError) as e:
        validate(parse("not FOO(9) > 0"), is_exit=False)
    assert e.value.code == "unknown_name"


def test_condition_in_value_position_rejected_by_validate():
    # (a > b) + 1 parses (Binary over a Compare); validation rejects it.
    with pytest.raises(ExprError) as e:
        validate(parse("(candle.close > EMA(9)) + 1 > 2"), is_exit=False)
    assert e.value.code == "cross_not_toplevel"
    # The copy is shared with the parser's own value-position guard
    # (parser.py's cross_not_toplevel raise) and must stay identical.
    assert e.value.message == "A comparison or cross can't be used as a value."


def test_boolean_node_in_value_position_rejected():
    # A BoolOp as a comparison operand is the same mistake as a Compare/Cross
    # there; without BoolOp in the isinstance tuple it fell through to the
    # catch-all and reported a misleading unknown_name.
    row = parse("EMA(9) > (bullish(candle) and bullish(candle))")
    with pytest.raises(ExprError) as e:
        validate(row, is_exit=False)
    assert e.value.code == "cross_not_toplevel"
    assert e.value.message == "A comparison or cross can't be used as a value."
    # Reported at the boolean node's own span, not the whole row's.
    assert (e.value.start, e.value.end) == (row.right.start, row.right.end)


def test_not_in_value_position_rejected():
    with pytest.raises(ExprError) as e:
        validate(parse("EMA(9) > (not bullish(candle))"), is_exit=False)
    assert e.value.code == "cross_not_toplevel"


def test_warmup_is_max_over_bool_branches():
    assert warmup_bars(parse("EMA(50) > 0 or EMA(9) > 0")) == 50
    assert warmup_bars(parse("not EMA(21) > 0")) == 21
    assert warmup_bars(parse("EMA(9) > 0 and EMA(200) > 0 or EMA(50) > 0")) == 200

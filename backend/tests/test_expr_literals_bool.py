from auto_trader.strategy.expr.literals import compute_literals, substitute
from auto_trader.strategy.expr.parser import parse


def test_literals_collected_across_or_branches_in_position_order():
    lits = compute_literals(parse("RSI(14) > 70 or RSI(21) < 30"))
    assert [l.value for l in lits] == [14, 70, 21, 30]
    assert [l.ordinal for l in lits] == [0, 1, 2, 3]
    assert lits[0].label == "RSI length"
    assert lits[1].label == "threshold"


def test_literals_inside_not():
    lits = compute_literals(parse("not EMA(9) > 100"))
    assert [l.value for l in lits] == [9, 100]
    assert lits[1].label == "threshold"


def test_cross_branch_literals_stay_constants():
    lits = compute_literals(parse("EMA(9) x> EMA(50) or RSI(14) > 70"))
    assert [l.value for l in lits] == [9, 50, 14, 70]
    # cross operands follow the cross rule ("EMA length" for args, no threshold)
    assert lits[0].label == "EMA length"
    assert lits[1].label == "EMA length"
    assert lits[2].label == "RSI length"
    assert lits[3].label == "threshold"


def test_count_with_boolop_condition():
    """BoolOp inside count() collects literals with proper labels from all branches."""
    lits = compute_literals(parse("count(RSI(14) > 70 or RSI(21) < 30, 10) >= 3"))
    assert [l.value for l in lits] == [14.0, 70.0, 21.0, 30.0, 10.0, 3.0]
    # Literals from the count condition preserve indicator/numeric labeling; comparisons inside count use "constant"
    assert lits[0].label == "RSI length"
    assert lits[1].label == "constant"  # threshold inside count is "constant"
    assert lits[2].label == "RSI length"
    assert lits[3].label == "constant"  # threshold inside count is "constant"
    assert lits[4].label == "count window"
    assert lits[5].label == "threshold"


def test_count_with_not_condition():
    """Not inside count() collects literals from the negated condition."""
    lits = compute_literals(parse("count(not bullish(candle), 5) >= 2"))
    assert [l.value for l in lits] == [5.0, 2.0]
    assert lits[0].label == "count window"
    assert lits[1].label == "threshold"


def test_substitute_on_boolop():
    """Substitute should rewrite literals in both branches of a BoolOp."""
    node = parse("RSI(14) > 70 or RSI(21) < 30")
    # Replace first indicator length (ordinal 0) with 9 and second threshold (ordinal 2) with 5
    rewritten = substitute(node, {0: 9.0, 2: 5.0})
    lits = compute_literals(rewritten)
    assert [l.value for l in lits] == [9, 70, 5, 30]

from auto_trader.strategy.expr.literals import literals, substitute
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.evaluate import series_of


def test_ordinals_and_labels():
    lits = literals(parse("EMA(50) > candle.high + 3 * ATR(14)"))
    assert [(lit.ordinal, lit.value) for lit in lits] == [(0, 50.0), (1, 3.0), (2, 14.0)]
    assert lits[0].label == "EMA length"
    assert lits[1].label == "multiplier of ATR(14)"
    assert lits[2].label == "ATR length"


def test_threshold_label():
    lits = literals(parse("RSI(14) > 30"))
    assert lits[1].label == "threshold"


def test_wrapper_and_offset_labels():
    lits = literals(parse("highest(EMA(9), 5)[-1] > 0"))
    labels = [lit.label for lit in lits]
    assert labels == ["EMA length", "highest window", "bar offset", "threshold"]


def test_substitute_changes_value():
    node = parse("EMA(50) > 0")
    sub = substitute(node, {0: 9.0})
    assert literals(sub)[0].value == 9.0
    # confirm substitution feeds the evaluator
    assert literals(node)[0].value == 50.0  # original untouched


def test_substitute_bar_offset():
    # The bar offset is a sweepable literal even though the parser stores it
    # as an int; substituting it rewrites Offset.n and leaves the original AST
    # untouched.
    node = parse("highest(EMA(9), 5)[-1] > 0")
    sub = substitute(node, {2: 3.0})
    assert sub.left.n == 3
    assert node.left.n == 1


def test_dropped_ordinal_ignored():
    node = parse("EMA(9) > 0")
    # ordinal 5 does not exist -> substitution is a no-op, not an error
    sub = substitute(node, {5: 1.0})
    assert literals(sub)[0].value == 9.0


def test_count_literals_labels():
    lits = literals(parse("count(candle.open > candle.close, 10) >= 3"))
    assert [(l.value, l.label) for l in lits] == [(10.0, "count window"), (3.0, "threshold")]


def test_count_predicate_offset_literal():
    lits = literals(parse("count(bearish(candle[-1]), 20) >= 2"))
    assert [(l.value, l.label) for l in lits] == [(1.0, "bar offset"), (20.0, "count window"), (2.0, "threshold")]


def test_predicate_row_no_spurious_literals():
    assert literals(parse("bullish(candle)")) == []


def test_substitute_count_window():
    node = parse("count(candle.open > candle.close, 10) >= 3")
    lits = literals(node)
    window_ord = next(l.ordinal for l in lits if l.label == "count window")
    new = substitute(node, {window_ord: 25})
    assert new.left.window.value == 25


def test_underfilled_wrapper_does_not_crash():
    """/api/expr/literals parses without validating, so a half-typed wrapper
    reaches _collect with too few args. It must degrade to the literals it can
    see, not IndexError into a 500. Mirrored by the frontend's
    parser.test.ts "returns a typed error for a bare wrapper name"."""
    # `slope.x` is a bare (zero-arg) wrapper name with a field access: no
    # wrapper literals survive, only the row's own threshold.
    assert [(l.value, l.label) for l in literals(parse("slope.x > 0"))] == [(0.0, "threshold")]
    # One arg supplied, window still missing: the inner term still contributes.
    assert [(l.value, l.label) for l in literals(parse("avg(EMA(9)) > 0"))] == [
        (9.0, "EMA length"), (0.0, "threshold"),
    ]

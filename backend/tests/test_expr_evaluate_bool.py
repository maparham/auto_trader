from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.parser import parse


def _candles(closes):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=c, high=c + 1, low=c - 1, close=c, volume=100)
        for i, c in enumerate(closes)
    ]


def _row(src, candles):
    return compile_row(parse(src), candles, "HOUR", {}, source=src)


def test_or_true_when_one_branch_true():
    candles = _candles([10] * 10)
    row = _row("candle.close > 100 or candle.close > 5", candles)
    assert row.evaluate(9, None) is True


def test_and_false_when_one_branch_false():
    candles = _candles([10] * 10)
    row = _row("candle.close > 5 and candle.close > 100", candles)
    assert row.evaluate(9, None) is False


def test_not_flips_a_defined_comparison():
    candles = _candles([10] * 10)
    assert _row("not candle.close > 100", candles).evaluate(9, None) is True
    assert _row("not candle.close > 5", candles).evaluate(9, None) is False


def test_not_never_fires_on_undefined_data():
    # Bar 3 is inside SMA(50)'s warm-up, so SMA is undefined -> unknown -> not
    # unknown = unknown -> row False. The Kleene trap from the spec. (SMA, not
    # EMA: ema_series seeds from bar 0 and is never undefined.)
    candles = _candles([10] * 10)
    row = _row("not SMA(50) > 0", candles)
    assert row.evaluate(3, None) is False


def test_unknown_or_true_is_true():
    # SMA(50) undefined at bar 3 (unknown branch); the defined branch is true.
    candles = _candles([10] * 10)
    row = _row("SMA(50) > 0 or candle.close > 5", candles)
    assert row.evaluate(3, None) is True


def test_unknown_and_false_is_false_unknown_and_true_is_false():
    candles = _candles([10] * 10)
    assert _row("SMA(50) > 0 and candle.close > 100", candles).evaluate(3, None) is False
    # unknown AND true -> unknown -> row False
    assert _row("SMA(50) > 0 and candle.close > 5", candles).evaluate(3, None) is False


def test_count_with_boolean_condition():
    candles = _candles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    row = _row("count(candle.close > 8 or candle.close < 2, 10) > 1", candles)
    # bars with close>8: 9,10 (two); close<2: 1 (one) -> count=3 at the last bar
    assert row.evaluate(9, None) is True


def test_entry_bearing_boolean_inside_count():
    # An entry-bearing boolean must NOT be classified entry-free by _entry_free,
    # or compile_row precomputes it via series_of and raises "entry is not a
    # series". This is also the only path through _val's Count -> _match3 branch.
    candles = _candles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    row = _row("count(candle.close > entry and candle.close > 5, 3) > 1", candles)
    # entry=6: bars 7,8,9,10 beat it; at bar 9 the 3-bar window (8,9,10) has all
    # three above both 6 and 5 -> count 3 > 1.
    assert row.evaluate(9, 6.0) is True
    # entry=100: nothing beats it -> count 0.
    assert row.evaluate(9, 100.0) is False


def test_terms_at_lists_only_passing_branches():
    # The popover shows why a row fired; a FALSE or-branch is not a reason.
    candles = _candles([10] * 10)
    src = "candle.close > 5 or candle.close > 100"
    row = _row(src, candles)
    assert row.evaluate(9, None) is True
    [term] = row.terms_at(9, None)
    assert term.left_label == "candle.close" and term.op == ">"
    assert term.right_label == "5"


def test_terms_at_flips_the_operator_under_not():
    # `not close > 100` passed because close <= 100 — report the comparison that
    # actually held, not its negation.
    candles = _candles([10] * 10)
    row = _row("not candle.close > 100", candles)
    assert row.evaluate(9, None) is True
    [term] = row.terms_at(9, None)
    assert term.left_label == "candle.close" and term.op == "<="
    assert term.right_label == "100" and term.left_val == 10


def test_terms_at_emits_nothing_for_a_negated_predicate():
    # No honest scalar term exists for `not bullish(...)`: the label-only term
    # would read as if the pattern MATCHED.
    candles = _candles([10] * 10)  # open == close: neither bullish nor bearish
    row = _row("not bullish(candle)", candles)
    assert row.evaluate(9, None) is True
    assert row.terms_at(9, None) == ()


def test_two_crosses_in_or_both_evaluate():
    ups = _candles([1, 2, 3, 10, 3, 2, 1, 1, 1, 1])
    row = _row("candle.close x> 5 or candle.close x< 5", ups)
    assert row.evaluate(3, None) is True   # crossed above 5
    assert row.evaluate(4, None) is True   # crossed back below 5
    assert row.evaluate(6, None) is False


def test_terms_at_emits_nothing_for_a_negated_equality():
    # `not (a == b)` held because a != b, but the language has no `!=` operator,
    # so there is no honest flipped comparison to show. Say nothing rather than
    # invent one (and never KeyError on the _NEG_OP table).
    candles = _candles([10] * 10)
    row = _row("not candle.close == 100", candles)
    assert row.evaluate(9, None) is True
    assert row.terms_at(9, None) == ()


def test_equality_term_survives_a_boolean_row():
    candles = _candles([10] * 10)
    src = "candle.close == 10 and candle.close > 5"
    row = _row(src, candles)
    assert row.evaluate(9, None) is True
    ops = [(t.left_label, t.op, t.right_label) for t in row.terms_at(9, None)]
    assert ops == [("candle.close", "==", "10"), ("candle.close", ">", "5")]


def test_equality_is_unknown_on_undefined_data():
    # Kleene: an undefined operand makes == unknown, so `== and >` is not True.
    candles = _candles([10] * 10)
    assert _row("SMA(50) == 10 and candle.close > 5", candles).evaluate(3, None) is False
    # ... and unknown-or-true is still true.
    assert _row("SMA(50) == 10 or candle.close > 5", candles).evaluate(3, None) is True


def test_count_over_a_boolean_equality_condition():
    candles = _candles([10, 11, 10, 11, 10, 11, 10, 11, 10, 11])
    row = _row("count(candle.close == 10 or candle.close > 100, 4) > 1", candles)
    assert row.evaluate(9, None) is True


def test_terms_at_negated_chain_shows_only_the_falsifying_side():
    # `not (0 < close < 5)` with close=10: the band failed on its upper side
    # only, so the evidence is `candle.close >= 5` — nothing about the lower
    # bound, which actually held and so is not a reason the NOT fired.
    candles = _candles([10] * 10)
    row = _row("not (0 < candle.close < 5)", candles)
    assert row.evaluate(9, None) is True
    [term] = row.terms_at(9, None)
    assert term.left_label == "candle.close" and term.op == ">="
    assert term.right_label == "5" and term.left_val == 10


def test_terms_at_negated_chain_lower_side():
    # Same band shape failing on the other side: `not (20 < close < 30)` with
    # close=10 held because 20 >= close.
    candles = _candles([10] * 10)
    row = _row("not (20 < candle.close < 30)", candles)
    assert row.evaluate(9, None) is True
    [term] = row.terms_at(9, None)
    assert term.left_label == "20" and term.op == ">="
    assert term.right_label == "candle.close" and term.right_val == 10


def test_terms_at_negated_and_shows_the_false_branch_flipped():
    # De Morgan: `not (A and B)` fired because A was false — show A flipped;
    # B held, so it is not evidence for the negation.
    candles = _candles([10] * 10)
    row = _row("not (candle.close > 100 and candle.close > 1)", candles)
    assert row.evaluate(9, None) is True
    [term] = row.terms_at(9, None)
    assert term.left_label == "candle.close" and term.op == "<="
    assert term.right_label == "100"


def test_terms_at_double_not_reports_the_inner_comparison_unflipped():
    # `not not close > 5` passed because `close > 5` held — plain passing term.
    candles = _candles([10] * 10)
    row = _row("not not candle.close > 5", candles)
    assert row.evaluate(9, None) is True
    [term] = row.terms_at(9, None)
    assert term.op == ">" and term.left_val == 10

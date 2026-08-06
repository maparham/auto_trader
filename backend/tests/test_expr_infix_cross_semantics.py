from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.closeness import Norm, row_closeness
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.literals import literals
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars


def _candles(closes, resolution_s=3600):
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=base + timedelta(seconds=resolution_s * k),
               open=c, high=c, low=c, close=c, volume=100.0)
        for k, c in enumerate(closes)
    ]


def _row_bools(src, candles, resolution="HOUR"):
    row = compile_row(parse(src), candles, resolution, {})
    return [row.evaluate(i, None) for i in range(len(candles))]


def test_lone_infix_cross_matches_function_form():
    c = _candles([1, 2, 3, 2, 1])
    infix = _row_bools("candle.close x> 2", c)
    fn = _row_bools("crossAbove(candle.close, 2)", c)
    assert infix == fn == [False, False, True, False, False]


def test_infix_cross_below_matches_function_form():
    c = _candles([3, 2, 1, 2, 3])
    infix = _row_bools("candle.close x< 2", c)
    fn = _row_bools("crossBelow(candle.close, 2)", c)
    assert infix == fn == [False, False, True, False, False]


def test_mixed_chain_is_conjunction():
    # close x> 2  AND  2 > candle.open - 10 (always true) -> same as lone cross
    c = _candles([1, 2, 3, 2, 1])
    assert _row_bools("candle.close x> 2 > candle.open - 10", c) == [False, False, True, False, False]
    # AND with an always-false tail kills every bar
    assert _row_bools("candle.close x> 2 > candle.open + 10", c) == [False] * 5


def test_chain_cross_shares_middle_operand():
    # cross fires at bar 2 (1->3 through 2); right comparison 2 > close is
    # False exactly at bar 2 (close=3), so the row never fires.
    c = _candles([1, 2, 3, 2, 1])
    assert _row_bools("candle.close x> 2 > candle.close - 1", c) == [False, False, False, False, False]


def test_infix_count_matches_function_form():
    c = _candles([1, 3, 1, 3, 1, 3])
    infix = _row_bools("count(candle.close x> 2, 4) >= 2", c)
    fn = _row_bools("count(crossAbove(candle.close, 2), 4) >= 2", c)
    assert infix == fn


def test_validate_accepts_cross_in_chain():
    validate(parse("EMA(9) x> EMA(50) > EMA(200)"), is_exit=False)  # no raise


def test_warmup_covers_cross_part():
    assert warmup_bars(parse("EMA(9) x> EMA(50) > EMA(200)")) == 200
    assert warmup_bars(parse("EMA(9) x> EMA(50)")) == 50


def test_literals_mixed_chain():
    lits = literals(parse("EMA(9) x> EMA(50) > EMA(200)"))
    assert [(l.ordinal, l.value, l.label) for l in lits] == [
        (0, 9.0, "EMA length"), (1, 50.0, "EMA length"), (2, 200.0, "EMA length"),
    ]


def test_literals_cross_part_bare_number_is_constant():
    # cross part numerics label "constant" (top-level Cross rule);
    # compare part numerics label "threshold".
    lits = literals(parse("candle.close x> 5 > candle.open - 3"))
    assert [(l.value, l.label) for l in lits] == [(5.0, "constant"), (3.0, "threshold")]


def test_closeness_chain_with_cross_part_defined():
    c = _candles([1, 2, 3, 2, 1, 2, 3, 2, 1, 2])
    norm = Norm(basis="volatility", width=1.0, window=5, atr_length=14)
    out = row_closeness(parse("candle.close x> 2 > candle.open - 10"), c, "HOUR", {}, norm)
    assert len(out) == len(c)
    assert any(v is not None for v in out)

from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.literals import literals
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars


def _candles(closes):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [Candle(time=t0 + timedelta(hours=k), open=c, high=c, low=c, close=c, volume=1.0)
            for k, c in enumerate(closes)]


def _bools(src, closes, entry=None):
    node = parse(src)
    validate(node, is_exit=entry is not None)
    row = compile_row(node, _candles(closes), "HOUR", {})
    return [row.evaluate(i, entry) for i in range(len(closes))]


def test_abs_of_negative_difference():
    # close - 10 is -2 then +2; abs is 2 both times.
    assert _bools("abs(candle.close - 10) == 2", [8, 12]) == [True, True]


def test_abs_with_entry_in_exit_rule():
    # entry-bearing abs goes through the per-bar path, not the precompute.
    assert _bools("abs(candle.close - entry) > 1", [10, 10.5, 12], entry=10.0) == [False, False, True]


def test_abs_wraps_indicator_and_warms_up():
    node = parse("abs(candle.close - EMA(3)) < 100")
    assert warmup_bars(node, "HOUR") == 3


def test_abs_arity():
    with pytest.raises(ExprError) as e:
        validate(parse("abs(candle.close, 2) > 1"), is_exit=False)
    assert e.value.code == "bad_arity"


def test_abs_is_not_an_instance_ref():
    with pytest.raises(ExprError) as e:
        validate(parse("abs.x > 1"), is_exit=False)
    assert e.value.code != "unknown_indicator_ref"


def test_abs_literals_recurse_into_argument():
    lits = literals(parse("abs(candle.close - EMA(200)) < 2 * ATR(14)"))
    assert [(l.value, l.label) for l in lits] == [
        (200, "EMA length"), (2, "multiplier of ATR(14)"), (14, "ATR length"),
    ]

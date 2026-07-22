import pytest

from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars


def _cmp(op, a, b):
    return N.Compare(op, a, b, a.start, b.end)


def test_validate_walks_all_chain_parts():
    close = N.Candle("close", 0, 5)
    # second link has a bad candle field (candle with no field)
    bad = N.Candle(None, 8, 14)
    chain = N.Chain([_cmp(">", close, N.Num(1, 0, 0)), _cmp(">", close, bad)], 0, 14)
    with pytest.raises(ExprError) as e:
        validate(chain, is_exit=False)
    assert e.value.code == "bad_candle_field"


def test_validate_accepts_valid_chain():
    close = N.Candle("close", 0, 5)
    e9 = N.Call("EMA", [N.Num(9, 0, 0)], 0, 0)
    e50 = N.Call("EMA", [N.Num(50, 0, 0)], 0, 0)
    validate(N.Chain([_cmp(">", close, e9), _cmp(">", e9, e50)], 0, 0), is_exit=False)


def test_warmup_is_max_over_chain_parts():
    close = N.Candle("close", 0, 0)
    e9 = N.Call("EMA", [N.Num(9, 0, 0)], 0, 0)
    e50 = N.Call("EMA", [N.Num(50, 0, 0)], 0, 0)
    chain = N.Chain([_cmp(">", close, e9), _cmp(">", e9, e50)], 0, 0)
    assert warmup_bars(chain) == 50

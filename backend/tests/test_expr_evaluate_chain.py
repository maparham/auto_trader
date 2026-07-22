from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.evaluate import compile_row


def _c(close, i):
    t = datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp() + i * 60
    return Candle(time=datetime.fromtimestamp(t, tz=timezone.utc),
                  open=close, high=close + 1, low=close - 1, close=close, volume=100)


def _cmp(op, a, b):
    return N.Compare(op, a, b, 0, 0)


def _chain(*parts):
    return N.Chain(list(parts), 0, 0)


def test_chain_true_only_when_all_links_hold():
    # links: close > 100  AND  close < 200
    candles = [_c(x, i) for i, x in enumerate([90, 150, 250])]
    close = N.Candle("close", 0, 0)
    chain = _chain(_cmp(">", close, N.Num(100, 0, 0)),
                   _cmp("<", close, N.Num(200, 0, 0)))
    row = compile_row(chain, candles, "MINUTE", {})
    assert row.evaluate(0, None) is False   # 90 not > 100
    assert row.evaluate(1, None) is True    # 100<150<200
    assert row.evaluate(2, None) is False   # 250 not < 200


def test_chain_false_when_an_operand_undefined():
    # SMA(5) is undefined on bar 0 (warmup) -> its link is False -> chain False
    candles = [_c(x, i) for i, x in enumerate([100, 101, 102, 103, 104, 105])]
    close = N.Candle("close", 0, 0)
    sma = N.Call("SMA", [N.Num(5, 0, 0)], 0, 0)
    chain = _chain(_cmp(">", close, N.Num(0, 0, 0)),
                   _cmp(">", close, sma))
    row = compile_row(chain, candles, "MINUTE", {})
    assert row.evaluate(0, None) is False

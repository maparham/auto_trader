from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.closeness import Norm, row_closeness
from auto_trader.strategy.expr.parser import parse

NORM = Norm(basis="volatility", width=2.0, window=3, atr_length=14)


def _candles(closes):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=c, high=c + 1, low=c - 1, close=c, volume=100)
        for i, c in enumerate(closes)
    ]


def _closeness(src, closes):
    candles = _candles(closes)
    return row_closeness(parse(src), candles, "HOUR", {}, NORM)


def test_or_takes_the_best_branch():
    closes = [10.0, 10.5, 11.0, 11.5, 12.0, 12.5]
    both = _closeness("candle.close > 100 or candle.close > 11", closes)
    hard = _closeness("candle.close > 100", closes)
    easy = _closeness("candle.close > 11", closes)
    i = len(closes) - 1
    assert both[i] == max(hard[i], easy[i])


def test_and_takes_the_worst_branch():
    closes = [10.0, 10.5, 11.0, 11.5, 12.0, 12.5]
    both = _closeness("candle.close > 100 and candle.close > 11", closes)
    hard = _closeness("candle.close > 100", closes)
    easy = _closeness("candle.close > 11", closes)
    i = len(closes) - 1
    assert both[i] == min(hard[i], easy[i])


def test_not_compare_is_the_flipped_comparison():
    closes = [10.0, 10.5, 11.0, 11.5, 12.0, 12.5]
    a = _closeness("not candle.close > 11", closes)
    b = _closeness("candle.close <= 11", closes)
    assert a == b


def test_not_predicate_is_binary_complement():
    # all-bullish bars: bullish -> 1.0, not bullish -> 0.0
    closes = [10.0, 11.0, 12.0, 13.0]
    candles = _candles(closes)
    for i, c in enumerate(candles):
        candles[i] = Candle(time=c.time, open=c.close - 0.5, high=c.high, low=c.low, close=c.close, volume=100)
    vals = row_closeness(parse("not bullish(candle)"), candles, "HOUR", {}, NORM)
    assert all(v == 0.0 for v in vals)


def test_not_cross_is_cold_during_warm_up():
    # SMA(4) is undefined for bars 0-2, and a cross also needs the previous bar,
    # so the cross's truth is UNKNOWN through bar 3 and definitely-False after
    # (a rising close never crosses above 1000). Unknown must read cold (0.0),
    # not "fully close to firing" — otherwise every warm-up bar of a
    # `not crossAbove(...)` row paints the heatmap hot.
    closes = [10.0, 11.0, 12.0, 13.0, 14.0, 15.0]
    vals = _closeness("not crossAbove(SMA(4), 1000)", closes)
    assert vals[:4] == [0.0, 0.0, 0.0, 0.0]
    assert vals[4:] == [1.0, 1.0]


def _min_or_none(a, b):
    """The AND fold: min per bar, but any undefined bar poisons the result."""
    return [None if (a[i] is None or b[i] is None) else min(a[i], b[i]) for i in range(len(a))]


def test_not_equality_falls_back_to_the_binary_complement():
    # The language has no `!=`, so `not (a == b)` has no flipped-operator gap to
    # ramp. It must take the binary-complement path (definite-False -> 1.0,
    # unknown -> 0.0) rather than KeyError on the _NEG_OP table.
    closes = [10.0, 11.0, 12.0, 13.0]
    vals = _closeness("not candle.close == 11", closes)
    assert vals == [1.0, 0.0, 1.0, 1.0]


def test_not_equality_reads_cold_while_unknown():
    # SMA(50) is undefined here, so `candle.close == SMA(50)` is UNKNOWN, and an
    # unknown negation must read cold rather than fully hot.
    closes = [10.0, 11.0, 12.0, 13.0]
    vals = _closeness("not candle.close == SMA(50)", closes)
    assert vals == [0.0, 0.0, 0.0, 0.0]


def test_equality_inside_a_boolean_fold():
    # AND folds by min: the == row is the binding constraint at its own bars.
    closes = [10.0, 11.0, 12.0, 13.0]
    both = _closeness("candle.close == 11 and candle.close > 5", closes)
    eq = _closeness("candle.close == 11", closes)
    gt = _closeness("candle.close > 5", closes)
    assert both == _min_or_none(eq, gt)


def test_not_equality_under_de_morgan():
    # not (a == b or c) = (not a == b) and (not c) — the == arm must survive the
    # De Morgan recursion into the same binary complement.
    closes = [10.0, 11.0, 12.0, 13.0]
    a = _closeness("not (candle.close == 11 or candle.close > 100)", closes)
    b = _closeness("not candle.close == 11", closes)
    c = _closeness("not candle.close > 100", closes)
    assert a == _min_or_none(b, c)

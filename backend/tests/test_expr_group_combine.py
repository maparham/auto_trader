"""Per-group AND/OR combine: how a group's rows fold, and what a firing group
stamps on its Signal (reason / terms / combine).

The rows in a group used to combine with AND unconditionally; each group now
carries its own conjunction. An empty group still never fires, in either mode.
"""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.strategy.base import Context
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.strategy import ExprRuleStrategy


def _candles(closes):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=c, high=c + 1, low=c - 1, close=c, volume=100)
        for i, c in enumerate(closes)
    ]


def _rows(candles, *srcs):
    return [compile_row(parse(s), candles, "HOUR", {}, source=s) for s in srcs]


def _ctx(candles):
    ctx = Context()
    ctx.history = list(candles)
    return ctx


def test_or_group_fires_when_one_row_passes():
    candles = _candles([10] * 5)
    rows = _rows(candles, "candle.close > 100", "candle.close > 5")
    strat = ExprRuleStrategy(rows, [], [], [], quantity=1.0,
                             long_entry_combine="OR")
    signals = strat.on_bar(_ctx(candles))
    assert len(signals) == 1
    # Only the passing row's source appears in the reason.
    assert signals[0].reason == "candle.close > 5"


def test_and_group_needs_every_row():
    candles = _candles([10] * 5)
    rows = _rows(candles, "candle.close > 100", "candle.close > 5")
    strat = ExprRuleStrategy(rows, [], [], [], quantity=1.0)  # default AND
    assert strat.on_bar(_ctx(candles)) == []


def test_or_reason_joins_multiple_passing_rows():
    candles = _candles([10] * 5)
    rows = _rows(candles, "candle.close > 5", "candle.close > 6")
    strat = ExprRuleStrategy(rows, [], [], [], quantity=1.0,
                             long_entry_combine="OR")
    signals = strat.on_bar(_ctx(candles))
    assert signals[0].reason == "candle.close > 5 OR candle.close > 6"


def test_empty_group_never_fires_even_in_or():
    candles = _candles([10] * 5)
    strat = ExprRuleStrategy([], [], [], [], quantity=1.0,
                             long_entry_combine="OR")
    assert strat.on_bar(_ctx(candles)) == []


def test_or_terms_come_from_passing_rows_only():
    # The popover reads `terms`; a failing row's captured values would
    # misattribute the signal, so only the passing row contributes.
    candles = _candles([10] * 5)
    rows = _rows(candles, "candle.close > 100", "candle.close > 5")
    strat = ExprRuleStrategy(rows, [], [], [], quantity=1.0,
                             long_entry_combine="OR")
    (sig,) = strat.on_bar(_ctx(candles))
    assert [t.right_label for t in sig.terms] == ["5"]
    assert sig.combine == "OR"


def test_and_signal_stamps_and_combine():
    candles = _candles([10] * 5)
    rows = _rows(candles, "candle.close > 5", "candle.close > 6")
    strat = ExprRuleStrategy(rows, [], [], [], quantity=1.0)
    (sig,) = strat.on_bar(_ctx(candles))
    assert sig.combine == "AND"
    assert sig.reason == "candle.close > 5 AND candle.close > 6"
    assert len(sig.terms) == 2


def test_or_exit_group_folds_independently():
    # Exits get their own combine; the entry group's setting must not leak.
    candles = _candles([10] * 5)
    exits = _rows(candles, "candle.close > 100", "candle.close > 5")
    strat = ExprRuleStrategy([], exits, [], [], quantity=1.0,
                             long_exit_combine="OR")
    ctx = _ctx(candles)
    ctx.position_long = 1.0
    ctx.long_entry_price = 9.0
    ctx.long_entry_time = candles[0].time
    (sig,) = strat.on_bar(ctx)
    assert sig.leg == "long" and sig.combine == "OR"
    assert sig.reason == "candle.close > 5"


def test_short_groups_carry_their_own_combine():
    candles = _candles([10] * 5)
    entry = _rows(candles, "candle.close > 100", "candle.close > 5")
    strat = ExprRuleStrategy([], [], entry, [], quantity=1.0,
                             short_entry_combine="OR")
    (sig,) = strat.on_bar(_ctx(candles))
    assert sig.leg == "short" and sig.combine == "OR"

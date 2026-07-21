"""The coded-exit wrapper carries panel-authored expression exits along a coded
run: coded supplies entries, an exit-only ExprRuleStrategy contributes exits."""

from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.strategy.base import Context, Strategy
from auto_trader.strategy.coded import CodedWithExprExits
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.strategy import ExprRuleStrategy


@pytest.fixture(autouse=True)
def _isolated_run_store():
    # This test drives the wrapper directly and never touches the run store or
    # API router. Shadow the conftest fixture so setup does not import the
    # backtest router (which imports sweep_apply, still mid-migration here).
    yield


def make_candles(closes):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [Candle(time=t0 + timedelta(hours=i), open=c, high=c, low=c,
                   close=c, volume=10) for i, c in enumerate(closes)]


class _OpenLongOnce(Strategy):
    """Minimal coded stand-in: BUY 1 on the first bar, nothing after."""
    hedged = False
    file_brackets_overridden = False

    def __init__(self):
        self._opened = False

    def on_bar(self, ctx: Context) -> list[Signal]:
        if not self._opened:
            self._opened = True
            return [Signal(Side.BUY, 1, "", leg="long")]
        return []


def test_coded_with_expr_exits_fires_exit():
    candles = make_candles([100, 100, 100, 1])  # last close plunges below EMA(2)
    resolution = "MINUTE"
    row = compile_row(parse("candle.close < EMA(2)"), candles, resolution, {})
    exits = ExprRuleStrategy([], [row], [], [], quantity=1.0)
    strat = CodedWithExprExits(_OpenLongOnce(), exits)

    ctx = Context()
    ctx.history = candles
    ctx.position_long = 1
    ctx.long_entry_price = 100.0
    out = strat.on_bar(ctx)
    assert any(s.side == Side.SELL and s.leg == "long" for s in out)

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.engine.scaling import ScalingConfig, SpacingSpec
from auto_trader.strategy.base import Context, Strategy


def _c(t0, i, o, h, l, c):
    return Candle(t0 + timedelta(minutes=i), o, h, l, c, 0.0)


class BuyEveryBar(Strategy):
    """Emit a BUY(long) on every bar (tests the engine cap, not the strategy)."""
    def on_bar(self, ctx: Context):
        return [Signal(Side.BUY, 1.0, "enter", leg="long")]


def test_cap_limits_concurrent_opens():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    candles = [_c(t0, i, 100, 100, 100, 100) for i in range(6)]
    res = BacktestEngine(BuyEveryBar(), long_scaling=ScalingConfig(max_concurrent=3)).run(candles)
    # BUY fires every bar; fills land from bar 1 on; only 3 ever open.
    assert len([f for f in res.fills if f.side is Side.BUY]) == 3


def test_default_cap_one_reproduces_single_position():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    candles = [_c(t0, i, 100, 100, 100, 100) for i in range(5)]
    res = BacktestEngine(BuyEveryBar()).run(candles)  # default cap 1
    assert len([f for f in res.fills if f.side is Side.BUY]) == 1


def test_spacing_rejects_until_price_moves():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # rising opens: 100,101,102,... ; 1% spacing lets each successive bar open.
    candles = [_c(t0, i, 100 + i, 100 + i, 100 + i, 100 + i) for i in range(5)]
    scaling = ScalingConfig(max_concurrent=5, spacing=SpacingSpec("pct", value=0.5))
    res = BacktestEngine(BuyEveryBar(), long_scaling=scaling).run(candles)
    assert len([f for f in res.fills if f.side is Side.BUY]) >= 2  # opens spaced by the rise

    flat = [_c(t0, i, 100, 100, 100, 100) for i in range(5)]
    res2 = BacktestEngine(BuyEveryBar(), long_scaling=scaling).run(flat)
    assert len([f for f in res2.fills if f.side is Side.BUY]) == 1  # never moves -> one open


class OpenTwoThenExit(Strategy):
    """Open on the first two decision bars (fills open two positions under
    max_concurrent=2), then emit an exit that must close BOTH."""
    def on_bar(self, ctx: Context):
        n = len(ctx.history)
        if n <= 2:
            return [Signal(Side.BUY, 1.0, "enter", leg="long")]
        if n == 5:
            return [Signal(Side.SELL, 1.0, "exit", leg="long")]
        return []


def test_rule_exit_closes_all_open_positions():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    candles = [_c(t0, i, 100, 100, 100, 100) for i in range(7)]
    res = BacktestEngine(
        OpenTwoThenExit(), commission_per_side=1.0,
        long_scaling=ScalingConfig(max_concurrent=2),
    ).run(candles)
    # two opens, then ONE exit signal closes BOTH positions
    assert len([f for f in res.fills if f.side is Side.BUY]) == 2
    assert len([f for f in res.fills if f.side is Side.SELL]) == 2
    assert len(res.trades) == 2
    # commission is charged per fill: 2 opens + 2 closes = 4; prices flat so pnl=0
    assert res.net_pnl == -4.0

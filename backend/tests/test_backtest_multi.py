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

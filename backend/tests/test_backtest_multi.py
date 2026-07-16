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


class OpenTwo(Strategy):
    """Open on the first two decision bars (fills at bar 2 and bar 3 opens
    under max_concurrent=2); never exit by rule."""
    def on_bar(self, ctx: Context):
        return [Signal(Side.BUY, 1.0, "enter", leg="long")] if len(ctx.history) <= 2 else []


def test_stop_enforced_on_every_stacked_position():
    from auto_trader.engine.risk import RiskConfig, StopSpec, TargetSpec

    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # Signals on bars 0 and 1 fill at bar1 open=100 (stop 98) and bar2
    # open=104 (stop 101.92). Bar 3 dips to 95, breaching BOTH stops: both
    # positions must exit as "stop" on that bar — not just positions[0].
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 104, 100, 104),
        _c(t0, 2, 104, 104, 104, 104),
        _c(t0, 3, 103, 103, 95, 96),
        _c(t0, 4, 96, 96, 96, 96),
    ]
    res = BacktestEngine(
        OpenTwo(),
        long_risk=RiskConfig(StopSpec("pct", value=2.0), TargetSpec("none")),
        long_scaling=ScalingConfig(max_concurrent=2),
    ).run(candles)
    assert len(res.trades) == 2
    assert [t.reason_out for t in res.trades] == ["stop", "stop"]
    assert sorted(t.exit_price for t in res.trades) == [98.0, 101.92]
    assert all(t.exit_time == candles[3].time for t in res.trades)

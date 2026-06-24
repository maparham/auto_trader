"""Engine correctness: deterministic synthetic data, hand-checkable PnL."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.base import Context, Strategy


def _series(closes: list[float]) -> list[Candle]:
    """Flat bars where open==high==low==close, one minute apart."""
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(t0 + timedelta(minutes=i), c, c, c, c, 0.0) for i, c in enumerate(closes)
    ]


class BuyBar1(Strategy):
    """Buy 1 unit exactly once (on the second bar), then hold."""

    def __init__(self) -> None:
        self.fired = False

    def on_bar(self, ctx: Context) -> Signal | None:
        if len(ctx.history) == 2 and not self.fired:
            self.fired = True
            return Signal(Side.BUY, 1.0, "enter")
        return None


def test_fill_is_next_open_not_current_close():
    # Signal fires on bar index 1 (price 10) -> must fill at bar index 2's OPEN.
    candles = _series([10, 10, 20, 20])
    res = BacktestEngine(BuyBar1()).run(candles)
    assert len(res.fills) == 1
    fill = res.fills[0]
    assert fill.price == 20.0  # bar index 2 open, NOT bar index 1 close (10)
    assert fill.time == candles[2].time


def test_round_trip_pnl():
    class Flip(Strategy):
        def on_bar(self, ctx: Context) -> Signal | None:
            n = len(ctx.history)
            if n == 1:
                return Signal(Side.BUY, 1.0, "in")
            if n == 3:
                return Signal(Side.SELL, 1.0, "out")
            return None

    # buy fills at bar1 open=100, sell fills at bar3 open=110 -> pnl = 10
    candles = _series([100, 100, 105, 110, 110])
    res = BacktestEngine(Flip()).run(candles)
    assert len(res.trades) == 1
    assert res.trades[0].entry_price == 100.0
    assert res.trades[0].exit_price == 110.0
    assert res.trades[0].pnl == 10.0
    assert res.net_pnl == 10.0
    assert res.win_rate == 1.0


def test_commission_and_slippage_reduce_pnl():
    class Flip(Strategy):
        def on_bar(self, ctx: Context) -> Signal | None:
            n = len(ctx.history)
            if n == 1:
                return Signal(Side.BUY, 1.0, "in")
            if n == 3:
                return Signal(Side.SELL, 1.0, "out")
            return None

    candles = _series([100, 100, 105, 110, 110])
    res = BacktestEngine(Flip(), commission_per_side=0.5, slippage=1.0).run(candles)
    # buy fills at 100+1=101, sell at 110-1=109 -> gross 8, minus 2x0.5 commission = 7
    assert res.trades[0].pnl == 8.0
    assert res.net_pnl == 7.0


def test_net_pnl_includes_open_position_at_end():
    # Buy 1 unit at bar2 open=20 and never sell. Last close is 50, so the open
    # position is +30 mark-to-market. net_pnl must reflect that (not ~0) and must
    # equal the final equity point minus starting cash.
    candles = _series([10, 10, 20, 50])
    res = BacktestEngine(BuyBar1()).run(candles)
    assert res.trades == []  # an open position is not a closed round-trip
    assert res.net_pnl == 30.0
    assert res.net_pnl == res.equity[-1].equity - 10_000.0


def test_signal_on_last_bar_is_dropped():
    class BuyLast(Strategy):
        def on_bar(self, ctx: Context) -> Signal | None:
            if len(ctx.history) == 3:  # final bar
                return Signal(Side.BUY, 1.0, "late")
            return None

    res = BacktestEngine(BuyLast()).run(_series([1, 2, 3]))
    assert res.fills == []  # nothing to fill on; no future bar

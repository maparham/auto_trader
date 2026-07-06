"""Engine hedging: independent long+short buckets, list-of-signals fills."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.base import Context, Strategy


def _series(closes: list[float]) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [Candle(t0 + timedelta(minutes=i), c, c, c, c, 0.0) for i, c in enumerate(closes)]


def test_short_round_trip_profits_when_price_falls():
    # Open short at bar1 open (fills next open = 100), close at bar3 open (110->? we want profit on a DROP)
    class ShortFlip(Strategy):
        def on_bar(self, ctx: Context) -> list[Signal]:
            n = len(ctx.history)
            if n == 1:
                return [Signal(Side.SELL, 1.0, "short-open", leg="short")]
            if n == 3:
                return [Signal(Side.BUY, 1.0, "short-close", leg="short")]
            return []

    # short opens at bar1 open=100, closes at bar3 open=90 -> short pnl = 100-90 = +10
    candles = _series([100, 100, 95, 90, 90])
    res = BacktestEngine(ShortFlip()).run(candles)
    assert len(res.trades) == 1
    assert res.trades[0].leg == "short"
    assert res.trades[0].side is Side.SELL  # short opened with a SELL
    assert res.trades[0].pnl == 10.0
    assert res.net_pnl == 10.0


def test_long_and_short_open_same_bar_both_fill_next_open():
    class Hedge(Strategy):
        def on_bar(self, ctx: Context) -> list[Signal]:
            if len(ctx.history) == 1:
                return [
                    Signal(Side.BUY, 1.0, "long-open", leg="long"),
                    Signal(Side.SELL, 1.0, "short-open", leg="short"),
                ]
            return []

    candles = _series([10, 20, 20])
    res = BacktestEngine(Hedge()).run(candles)
    # both fill at bar1 open=20; long unrealized at last close 20 -> 0; short unrealized -> 0
    # 4 fills: the two opens, plus a "range end" close for each still-open leg.
    assert len(res.fills) == 4
    legs = {(f.side, f.reason) for f in res.fills}
    assert (Side.BUY, "long-open") in legs
    assert (Side.SELL, "short-open") in legs
    # ctx exposed both positions after the fills (long=1, short=1) with net_pnl 0 at flat prices
    assert res.net_pnl == 0.0


def test_net_pnl_sums_both_open_legs_at_end():
    # Long opened at 10 and never closed; short opened at 10 and never closed; last close 12.
    # long unrealized = 1*(12-10)=+2 ; short unrealized = 1*(10-12)=-2 ; net = 0
    class Hedge(Strategy):
        def on_bar(self, ctx: Context) -> list[Signal]:
            if len(ctx.history) == 1:
                return [
                    Signal(Side.BUY, 1.0, "L", leg="long"),
                    Signal(Side.SELL, 1.0, "S", leg="short"),
                ]
            return []

    candles = _series([10, 10, 12])
    res = BacktestEngine(Hedge()).run(candles)
    # Both legs are booked as "range end" trades at the last close (12).
    assert len(res.trades) == 2
    assert all(t.reason_out == "range end" for t in res.trades)
    assert res.net_pnl == 0.0  # long +2, short -2 cancel
    assert res.net_pnl == res.equity[-1].equity - 10_000.0

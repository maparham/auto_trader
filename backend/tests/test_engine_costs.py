"""Spread and slippage-model fills. A scripted strategy opens long on bar 0
(fills at bar 1's open) and the engine closes at range end."""
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.base import Context, Strategy


def bars(prices: list[float], start=datetime(2026, 1, 5, tzinfo=timezone.utc)) -> list[Candle]:
    # Flat candles: open=high=low=close=price, 1h apart, so fills are exact.
    return [
        Candle(start + timedelta(hours=i), p, p, p, p, 0.0)
        for i, p in enumerate(prices)
    ]


class OpenLongOnce(Strategy):
    def __init__(self) -> None:
        self.done = False

    def on_bar(self, ctx: Context):
        if not self.done:
            self.done = True
            return [Signal(side=Side.BUY, quantity=1.0, reason="test", leg="long")]
        return []


def test_spread_widens_entry_and_exit():
    # Entry at bar1 open 100 -> BUY fills at 100 + spread/2 = 100.5.
    # Range end closes at last close 110 as SELL -> 110 - 0.5 = 109.5.
    res = BacktestEngine(OpenLongOnce(), spread=1.0).run(bars([100, 100, 110]))
    t = res.trades[0]
    assert t.entry_price == 100.5
    assert t.exit_price == 109.5
    assert res.net_pnl == 9.0  # 10 raw minus a full spread round trip


def test_zero_spread_is_todays_behavior():
    res = BacktestEngine(OpenLongOnce()).run(bars([100, 100, 110]))
    assert res.trades[0].entry_price == 100.0
    assert res.net_pnl == 10.0


def test_long_stop_triggers_on_bid_side():
    # Long from 100 (bar1 open), stop at 95. Bar2 low is 95.4: mid never
    # touches 95, but the bid (low - spread/2 = 95.4 - 0.5 = 94.9) does.
    candles = bars([100, 100, 100])
    candles[2] = Candle(candles[2].time, 100, 100, 95.4, 100, 0.0)
    # Per-signal bracket: stop 95 via signal stop_level (Signal is frozen, so
    # build it with the level set rather than mutating after the fact).
    class WithStop(Strategy):
        def __init__(self) -> None:
            self.done = False

        def on_bar(self, ctx):
            if self.done:
                return []
            self.done = True
            return [Signal(side=Side.BUY, quantity=1.0, reason="test",
                           leg="long", stop_level=95.0)]
    res = BacktestEngine(WithStop(), spread=1.0).run(candles)
    assert res.trades[0].reason_out == "stop"
    # Fill: raw = min(open=100, stop=95) = 95, SELL side -> 95 - 0.5 = 94.5.
    assert res.trades[0].exit_price == 94.5


def test_short_entry_and_stop_fill_on_the_ask_side():
    # Short entry fills at the bid (open - spread/2): 100 -> SELL at 99.5.
    # Its stop sits ABOVE entry and triggers when the ask (high + spread/2)
    # crosses it: bar2 high 104.6 -> ask 105.1 >= stop 105, then the BUY-to-cover
    # fills at raw + spread/2 = 105 + 0.5 = 105.5.
    candles = bars([100, 100, 100])
    candles[2] = Candle(candles[2].time, 100, 104.6, 100, 100, 0.0)

    class ShortWithStop(Strategy):
        def __init__(self) -> None:
            self.done = False

        def on_bar(self, ctx):
            if self.done:
                return []
            self.done = True
            return [Signal(side=Side.SELL, quantity=1.0, reason="test",
                           leg="short", stop_level=105.0)]
    res = BacktestEngine(ShortWithStop(), spread=1.0).run(candles)
    assert res.trades[0].side.value == "sell"
    assert res.trades[0].entry_price == 99.5
    assert res.trades[0].reason_out == "stop"
    assert res.trades[0].exit_price == 105.5


def test_atr_slippage_adds_per_fill():
    # atr mult 2 with a known ATR: candles with range 2 -> ATR14 warm-up is
    # None early, so the first fills fall back to base alone.
    candles = [
        Candle(datetime(2026, 1, 5, tzinfo=timezone.utc) + timedelta(hours=i),
               100, 101, 99, 100, 0.0)
        for i in range(20)
    ]
    res = BacktestEngine(OpenLongOnce(), slippage=0.1, slippage_atr_mult=2.0).run(candles)
    # Entry on bar 1: ATR14 undefined (needs 14 bars) -> slip = base 0.1 only.
    assert res.trades[0].entry_price == 100.1
    # Exit at range end (bar 19): ATR14 = 2.0 -> slip = 0.1 + 2*2 = 4.1.
    assert res.trades[0].exit_price == 100 - 4.1

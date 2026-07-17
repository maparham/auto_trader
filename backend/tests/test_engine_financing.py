from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from tests.test_engine_costs import OpenLongOnce, bars


def hourly(n: int, price=100.0, start=datetime(2026, 1, 5, 18, tzinfo=timezone.utc)):
    return [Candle(start + timedelta(hours=i), price, price, price, price, 0.0)
            for i in range(n)]


def test_one_night_charged_at_rollover():
    # Bars 18:00..23:00 Mon. Entry fills at bar1 (19:00). Rollover 21:00 UTC
    # crossed once (20:00 -> 21:00 bar boundary). qty 1 x entry 100 x 0.01%/night.
    res = BacktestEngine(OpenLongOnce(), fin_long_daily_pct=0.01).run(hourly(6))
    assert res.financing_total == 0.01  # 100 * 0.01 / 100
    assert res.trades[0].financing == 0.01
    assert res.net_pnl == -0.01        # flat price, one night's charge


def test_negative_rate_is_a_credit():
    res = BacktestEngine(OpenLongOnce(), fin_long_daily_pct=-0.01).run(hourly(6))
    assert res.net_pnl == 0.01


def test_daily_bars_charge_each_night():
    # 1D bars: each bar boundary spans exactly one 21:00 crossing.
    start = datetime(2026, 1, 5, tzinfo=timezone.utc)
    candles = [Candle(start + timedelta(days=i), 100, 100, 100, 100, 0.0)
               for i in range(5)]
    res = BacktestEngine(OpenLongOnce(), fin_long_daily_pct=0.01).run(candles)
    # Held from bar1 fill to range end at bar4: crossings during bars 2,3,4.
    assert res.financing_total == 0.03


def test_flat_positions_accrue_nothing():
    class Never(OpenLongOnce):
        def on_bar(self, ctx):
            return []
    res = BacktestEngine(Never(), fin_long_daily_pct=0.5).run(hourly(6))
    assert res.financing_total == 0.0

"""Engine progress callback: cadence and totals."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.base import Context, Strategy


class _Noop(Strategy):
    def on_bar(self, ctx: Context) -> list:
        return []


def _candles(n: int) -> list[Candle]:
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(t0 + timedelta(minutes=i), 100.0, 101.0, 99.0, 100.5, 0.0)
        for i in range(n)
    ]


def test_on_progress_reports_total_and_finishes_at_end():
    calls: list[tuple[int, int]] = []
    engine = BacktestEngine(_Noop(), starting_cash=1000.0)
    engine.run(_candles(250), on_progress=lambda done, total: calls.append((done, total)))
    assert calls, "callback never invoked"
    assert all(total == 250 for _, total in calls)
    assert calls[-1][0] == 250
    dones = [d for d, _ in calls]
    assert dones == sorted(dones)
    # every ~1% of 250 bars => step 2 => ~125 calls; bound it loosely
    assert len(calls) <= 130


def test_on_progress_none_is_default_and_harmless():
    engine = BacktestEngine(_Noop(), starting_cash=1000.0)
    result = engine.run(_candles(10))
    assert result is not None

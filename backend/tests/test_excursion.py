"""MAE/MFE excursion tracking: the engine records each trade's worst adverse
and best favorable price while open, raw and as R-multiples of the initial stop."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine


def _mk_candles(bars):
    """bars: list of (open, high, low, close) -> hourly Candles."""
    t0 = datetime(2026, 1, 5, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=o, high=h, low=lo, close=c, volume=0.0)
        for i, (o, h, lo, c) in enumerate(bars)
    ]


class _Script:
    """Emits pre-scripted signals keyed by bar index (0-based)."""

    def __init__(self, by_bar):
        self.by_bar = by_bar

    def on_bar(self, ctx):
        return self.by_bar.get(len(ctx.history) - 1, [])


def test_long_mae_mfe_with_r_multiples():
    # Signal on bar0 -> fills bar1 open=100 with per-signal stop 95 (risk = 5).
    # While open: low 97 on bar2 (MAE 3), high 106 on bar2 (MFE 6).
    # Exit signal on bar2 -> fills bar3 open=101.
    candles = _mk_candles([
        (100, 101, 99, 100),
        (100, 104, 98, 103),
        (103, 106, 97, 105),
        (101, 102, 100, 101),
    ])
    script = _Script({
        0: [Signal(side=Side.BUY, quantity=1.0, leg="long", stop_level=95.0)],
        2: [Signal(side=Side.SELL, quantity=1.0, leg="long")],
    })
    result = BacktestEngine(script).run(candles)

    assert len(result.trades) == 1
    t = result.trades[0]
    assert t.mae == 3.0   # 100 - min(low 98, 97) = 3, exit fill 101 doesn't worsen it
    assert t.mfe == 6.0   # max(high 104, 106) - 100
    assert t.mae_r == 0.6  # 3 / 5
    assert t.mfe_r == 1.2  # 6 / 5


def test_short_mae_mfe():
    # Short fills bar1 open=100; adverse = highs above entry, favorable = lows below.
    candles = _mk_candles([
        (100, 101, 99, 100),
        (100, 103, 96, 97),
        (97, 99, 95, 98),
        (98, 99, 97, 98),
    ])
    script = _Script({
        0: [Signal(side=Side.SELL, quantity=1.0, leg="short", stop_level=104.0)],
        2: [Signal(side=Side.BUY, quantity=1.0, leg="short")],
    })
    result = BacktestEngine(script).run(candles)

    t = result.trades[0]
    assert t.mae == 3.0   # high 103 - entry 100
    assert t.mfe == 5.0   # entry 100 - low 95
    assert t.mae_r == 0.75  # 3 / 4
    assert t.mfe_r == 1.25  # 5 / 4


def test_no_stop_means_no_r_multiples():
    candles = _mk_candles([
        (100, 101, 99, 100),
        (100, 104, 98, 103),
        (103, 106, 97, 105),
    ])
    script = _Script({0: [Signal(side=Side.BUY, quantity=1.0, leg="long")]})
    result = BacktestEngine(script).run(candles)  # closed by "range end" at last close

    t = result.trades[0]
    assert t.mae == 3.0 and t.mfe == 6.0
    assert t.mae_r is None and t.mfe_r is None

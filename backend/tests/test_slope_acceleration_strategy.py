"""slope_acceleration built-in strategy: long-only momentum ignition. Enter
when the EMA's slope (percent per bar) is both above a minimum and rising by
more than a margin versus one window earlier; close the long when the slope
flattens below the exit threshold. ATR stop as disaster protection."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.coded import CodedStrategy
from auto_trader.strategy.loader import load_strategy
from auto_trader.strategy.params import resolve_params


def bars_from_closes(closes: list[float], spread: float = 0.5) -> list[Candle]:
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=c, high=c + spread, low=c - spread, close=c)
        for i, c in enumerate(closes)
    ]


def run(closes: list[float], overrides: dict | None = None):
    candles = bars_from_closes(closes)
    module = load_strategy("slope_acceleration.py")
    params = resolve_params(module, overrides)
    strat = CodedStrategy(module, candles, quantity=1.0, params=params)
    return BacktestEngine(strat).run(candles)


def accelerating(n: int) -> list[float]:
    return [100 + 0.02 * i * i for i in range(n)]


def test_meta_declares_params():
    module = load_strategy("slope_acceleration.py")
    by_name = {p["name"]: p for p in module.meta["params"]}
    assert by_name["ema_len"]["default"] == 20
    assert by_name["slope_bars"]["default"] == 5
    assert by_name["min_slope_pct"]["default"] == 0.05
    assert by_name["accel_min_pct"]["default"] == 0.01
    assert by_name["exit_slope_pct"]["default"] == 0.0
    assert by_name["stop_atr"]["default"] == 2.0


def test_flat_market_never_enters():
    result = run([100.0] * 120)
    assert result.trades == []


def test_slope_below_minimum_never_enters():
    # Rising, but only ~0.02% per bar — under the 0.05 default minimum.
    result = run([100 + 0.02 * i for i in range(120)])
    assert result.trades == []


def test_accelerating_trend_enters_long_and_rides_it():
    result = run(accelerating(100))
    assert len(result.trades) == 1
    t = result.trades[0]
    assert t.leg == "long"
    assert t.reason_out == "range end"  # slope never flattened; held throughout
    assert t.pnl > 0


def test_flattening_slope_closes_the_long():
    # Accelerate for 60 bars, then drift down: the EMA slope goes negative,
    # crossing under the exit threshold long before the ATR stop is reached.
    closes = accelerating(60)
    closes += [closes[-1] - 0.2 * k for k in range(1, 41)]
    result = run(closes)
    assert len(result.trades) == 1
    t = result.trades[0]
    assert t.leg == "long"
    assert "slope" in t.reason_out.lower()

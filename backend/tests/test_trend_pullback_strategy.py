"""trend_pullback built-in strategy: long-only momentum. Enter on an RSI
pullback-and-recovery while the trend is up (fast EMA above slow EMA, slow EMA
rising); ATR stop, R-multiple target; close the long if the fast EMA falls
back below the slow EMA."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.indicators.core import atr_series
from auto_trader.strategy.coded import CodedStrategy
from auto_trader.strategy.loader import load_strategy
from auto_trader.strategy.params import resolve_params


def bars_from_closes(closes: list[float], spread: float = 0.5) -> list[Candle]:
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=c, high=c + spread, low=c - spread, close=c)
        for i, c in enumerate(closes)
    ]


def run(candles: list[Candle], overrides: dict | None = None):
    module = load_strategy("trend_pullback.py")
    params = resolve_params(module, overrides)
    strat = CodedStrategy(module, candles, quantity=1.0, params=params)
    return BacktestEngine(strat).run(candles), candles


# Steady rise (bars 0-39), a 4-bar dip shallow enough that the slow EMA keeps
# rising (bars 40-43), then a strong recovery (bars 44+). With fast/slow EMAs
# of 10/30 the trend gates hold through the dip, and Wilder RSI(14) bottoms
# near 49 — below a 55 floor.
PULLBACK_OVERRIDES = {"ema_fast": 10, "ema_slow": 30, "rsi_floor": 55}


def uptrend_with_pullback() -> list[float]:
    closes = [100 + 0.5 * i for i in range(40)]
    closes += [closes[-1] - 1.5 * k for k in range(1, 5)]
    closes += [closes[-1] + 1.5 * k for k in range(1, 15)]
    return closes


def test_meta_declares_params():
    module = load_strategy("trend_pullback.py")
    by_name = {p["name"]: p for p in module.meta["params"]}
    assert by_name["ema_fast"]["default"] == 20
    assert by_name["ema_slow"]["default"] == 50
    assert by_name["rsi_floor"]["default"] == 40
    assert by_name["stop_atr"]["default"] == 2.0
    assert by_name["target_r"]["default"] == 1.5


def test_smooth_uptrend_without_pullback_never_enters():
    closes = [100 + 0.5 * i for i in range(80)]
    result, _ = run(bars_from_closes(closes))
    assert result.trades == []


def test_downtrend_bounce_never_enters():
    # RSI dips and recovers, but the fast EMA stays below the slow EMA.
    closes = [200 - 1.0 * i for i in range(60)]
    closes += [closes[-1] + 0.8 * k for k in range(1, 10)]
    result, _ = run(bars_from_closes(closes), PULLBACK_OVERRIDES)
    assert result.trades == []


def test_pullback_recovery_in_uptrend_opens_long_with_atr_bracket():
    result, candles = run(bars_from_closes(uptrend_with_pullback()), PULLBACK_OVERRIDES)
    assert len(result.trades) >= 1
    t = result.trades[0]
    assert t.leg == "long"
    # Signal bar is the bar before the fill (signals fill at next open).
    times = [c.time for c in candles]
    sig_i = times.index(t.entry_time) - 1
    assert sig_i >= 44  # signalled during the recovery, not the dip
    atr = atr_series(candles, 14)[sig_i]
    sig_close = candles[sig_i].close
    assert t.stop_initial == sig_close - 2.0 * atr
    assert t.target == sig_close + 1.5 * (sig_close - t.stop_initial)


def test_fast_below_slow_closes_the_long():
    # Enter on the recovery, then roll over slowly so the EMAs cross down
    # before the (very wide) stop or target can hit.
    closes = uptrend_with_pullback()
    closes += [closes[-1] - 0.4 * k for k in range(1, 41)]
    result, _ = run(bars_from_closes(closes),
                    {**PULLBACK_OVERRIDES, "stop_atr": 30.0, "target_r": 30.0})
    assert len(result.trades) >= 1
    t = result.trades[0]
    assert t.leg == "long"
    assert "cross" in t.reason_out.lower()

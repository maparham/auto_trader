# backend/tests/test_backtest_stops.py
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.engine.risk import RiskConfig, StopSpec, TargetSpec
from auto_trader.strategy.base import Context, Strategy


def _c(t0, i, o, h, l, c):
    return Candle(t0 + timedelta(minutes=i), o, h, l, c, 0.0)


class BuyOnBar1(Strategy):
    """Open one long on bar index 1 (fills at bar 2's open), never exit by rule."""

    def on_bar(self, ctx: Context):
        return [Signal(Side.BUY, 1.0, "enter", leg="long")] if len(ctx.history) == 2 else []


def _run(candles, *, long_risk=None, short_risk=None, series=None):
    return BacktestEngine(
        BuyOnBar1(), long_risk=long_risk, short_risk=short_risk, series=series or {}
    ).run(candles)


def test_long_pct_stop_fills_at_level_when_low_pierces():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry fills at bar2 open=100; stop = 98. Bar 2 low dips to 97 -> stop at 98.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 97, 99),
        _c(t0, 3, 99, 99, 99, 99),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("none"))
    res = _run(candles, long_risk=risk)
    assert len(res.trades) == 1
    tr = res.trades[0]
    assert tr.entry_price == 100.0 and tr.exit_price == 98.0
    assert tr.reason_out == "stop"
    assert res.trades[0].pnl == -2.0


def test_long_stop_gap_down_fills_at_open_not_level():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry at bar2 open=100, stop=98; bar3 gaps to open=95 (below stop) -> fill 95.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 99, 100),
        _c(t0, 3, 95, 96, 90, 92),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("none"))
    res = _run(candles, long_risk=risk)
    assert res.trades[0].exit_price == 95.0  # min(open, stop) = min(95, 98)


def test_long_target_fills_exactly_at_level_no_positive_slippage():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry 100, target = 105; bar3 gaps up open=110 -> still fill at 105.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 99, 100),
        _c(t0, 3, 110, 112, 108, 111),
    ]
    risk = RiskConfig(StopSpec("none"), TargetSpec("pct", value=5.0))
    res = _run(candles, long_risk=risk)
    assert res.trades[0].exit_price == 105.0
    assert res.trades[0].reason_out == "target"


def test_stop_wins_when_one_bar_hits_both():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry 100, stop 98, target 105; bar2 range [96,106] straddles both.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 106, 96, 100),
        _c(t0, 3, 100, 100, 100, 100),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("pct", value=5.0))
    res = _run(candles, long_risk=risk)
    assert res.trades[0].reason_out == "stop"
    assert res.trades[0].exit_price == 98.0


def test_entry_and_stop_on_the_same_bar():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry fills at bar2 open=100; that same bar's low 97 hits the 98 stop.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 97, 99),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("none"))
    res = _run(candles, long_risk=risk)
    assert len(res.trades) == 1
    assert res.trades[0].exit_time == candles[2].time

def test_trailing_stop_ratchets_up_and_no_self_lookahead():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry 100, trail 10%. Bar2 runs to high 120 (stop -> 108) then bar3 falls
    # to low 105 -> stop at 108. The bar that MAKES the high must not also be the
    # bar saved by it: bar2 low is 99 but the stop entering bar2 is 90 (from the
    # entry seed=100), so bar2 does NOT stop out on its own 99 low.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 120, 99, 118),
        _c(t0, 3, 118, 119, 105, 106),
    ]
    risk = RiskConfig(StopSpec("trailPct", value=10.0), TargetSpec("none"))
    res = _run(candles, long_risk=risk)
    assert len(res.trades) == 1
    assert res.trades[0].exit_time == candles[3].time
    assert res.trades[0].exit_price == 108.0  # 120 * 0.90
    assert res.trades[0].reason_out == "trail"


def test_atr_stop_reads_posted_series_at_entry_bar():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry at bar2 open=100, ATR at bar2 = 4, mult 2 -> stop = 92.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 91, 99),
        _c(t0, 3, 99, 99, 99, 99),
    ]
    risk = RiskConfig(StopSpec("atr", mult=2.0, length=14), TargetSpec("none"))
    series = {"ATR_14": [1.0, 2.0, 4.0, 4.0]}
    res = _run(candles, long_risk=risk, series=series)
    assert res.trades[0].exit_price == 92.0


def test_no_risk_config_reproduces_baseline():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    candles = [_c(t0, i, 100, 100, 100, 100) for i in range(4)]
    base = _run(candles)                              # risks default None
    assert base.trades == []                          # BuyOnBar1 never exits by rule
    assert base.n_trades == 0


class SellOnBar1(Strategy):
    """Open one short on bar index 1 (fills at bar 2's open), never exit by rule."""

    def on_bar(self, ctx: Context):
        return [Signal(Side.SELL, 1.0, "enter", leg="short")] if len(ctx.history) == 2 else []


def _run_short(candles, *, short_risk=None, series=None):
    return BacktestEngine(
        SellOnBar1(), long_risk=None, short_risk=short_risk, series=series or {}
    ).run(candles)


def test_short_pct_stop_fills_at_level_when_high_pierces():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry fills at bar2 open=100; short stop = 102. Bar2 high 103 -> stop at 102.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 103, 99, 101),
        _c(t0, 3, 101, 101, 101, 101),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("none"))
    res = _run_short(candles, short_risk=risk)
    assert len(res.trades) == 1
    tr = res.trades[0]
    assert tr.entry_price == 100.0 and tr.exit_price == 102.0
    assert tr.reason_out == "stop"
    assert tr.pnl == -2.0


def test_short_stop_gap_up_fills_at_open_not_level():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry 100, stop 102; bar3 gaps to open=105 (above stop) -> fill 105 = max(open, stop).
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 99, 100),
        _c(t0, 3, 105, 108, 104, 107),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("none"))
    res = _run_short(candles, short_risk=risk)
    assert res.trades[0].exit_price == 105.0


def test_short_target_fills_exactly_at_level():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry 100, target = 95; bar3 gaps down open=90 -> still fill exactly at 95.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 99, 100),
        _c(t0, 3, 90, 92, 88, 89),
    ]
    risk = RiskConfig(StopSpec("none"), TargetSpec("pct", value=5.0))
    res = _run_short(candles, short_risk=risk)
    assert res.trades[0].exit_price == 95.0
    assert res.trades[0].reason_out == "target"


def test_short_trailing_stop_ratchets_down_no_self_lookahead():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry 100, trail 10%. Seed stop = 110. Bar2 falls to low 80 (stop -> 88);
    # bar2's own high 101 is tested against the PRE-update stop 110 (no self-stop).
    # Bar3 high 95 >= 88 -> stop; fill = max(open 90, 88) = 90.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 101, 80, 82),
        _c(t0, 3, 90, 95, 85, 93),
    ]
    risk = RiskConfig(StopSpec("trailPct", value=10.0), TargetSpec("none"))
    res = _run_short(candles, short_risk=risk)
    assert len(res.trades) == 1
    assert res.trades[0].exit_time == candles[3].time
    assert res.trades[0].exit_price == 90.0
    assert res.trades[0].reason_out == "trail"


def test_long_open_gaps_past_target_books_target_not_stop():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # entry at bar2 open=100; stop 98, target 105. Bar3 OPENS at 110 (already
    # past the target) then dips to low 97 (through the stop). The open proves
    # the target filled first -> a target WIN, not a stop loss.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 100, 100, 100),
        _c(t0, 3, 110, 112, 97, 99),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("pct", value=5.0))
    res = _run(candles, long_risk=risk)
    assert len(res.trades) == 1
    assert res.trades[0].reason_out == "target"
    assert res.trades[0].exit_price == 105.0
    assert res.trades[0].pnl == 5.0


def test_short_open_gaps_past_target_books_target_not_stop():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # mirror: entry short at bar2 open=100; stop 102, target 95. Bar3 OPENS at 90
    # (past the target) then spikes to high 103 (through the stop). Target wins.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 100, 100, 100),
        _c(t0, 3, 90, 103, 88, 91),
    ]
    risk = RiskConfig(StopSpec("pct", value=2.0), TargetSpec("pct", value=5.0))
    res = _run_short(candles, short_risk=risk)
    assert len(res.trades) == 1
    assert res.trades[0].reason_out == "target"
    assert res.trades[0].exit_price == 95.0
    assert res.trades[0].pnl == 5.0


def test_trailatr_stop_never_loosens_on_atr_spike():
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    # trailAtr mult=1. Stop ratchets to 108 by bar3 (extreme 110, ATR 2). Bar4's
    # ATR spikes to 20 -> naive stop would drop to 90 (looser); the clamp holds
    # it at 108. Bar5 low 100 <= 108 -> trail exit at min(open 107, 108) = 107.
    # Without the clamp, stop 90 would let bar5 through and no trail would fire.
    candles = [
        _c(t0, 0, 100, 100, 100, 100),
        _c(t0, 1, 100, 100, 100, 100),
        _c(t0, 2, 100, 100, 100, 100),
        _c(t0, 3, 100, 110, 99, 109),
        _c(t0, 4, 109, 110, 109, 110),
        _c(t0, 5, 107, 107, 100, 101),
    ]
    series = {"ATR_5": [2.0, 2.0, 2.0, 2.0, 20.0, 20.0]}
    risk = RiskConfig(StopSpec("trailAtr", mult=1.0, length=5), TargetSpec("none"))
    res = _run(candles, long_risk=risk, series=series)
    assert len(res.trades) == 1
    assert res.trades[0].reason_out == "trail"
    assert res.trades[0].exit_price == 107.0
    assert res.trades[0].pnl == 7.0

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Side, Trade
from auto_trader.engine.backtest import EquityPoint
from auto_trader.engine.metrics import compute_metrics

T0 = datetime(2024, 1, 1, tzinfo=timezone.utc)


def _trade(pnl, i=0, dur_min=5):
    entry = T0 + timedelta(minutes=i)
    return Trade(
        side=Side.BUY, quantity=1.0, entry_time=entry, entry_price=100.0,
        exit_time=entry + timedelta(minutes=dur_min), exit_price=100.0 + pnl,
        pnl=pnl, leg="long", reason_in="in", reason_out="out",
    )


def test_basic_metrics_hand_computed():
    # pnls: +10, -4, +6, -2  -> gross win 16, gross loss 6
    trades = [_trade(10, 0), _trade(-4, 1), _trade(6, 2), _trade(-2, 3)]
    eq = [EquityPoint(T0, 10_000), EquityPoint(T0 + timedelta(minutes=1), 10_010)]
    m = compute_metrics(trades, eq, net_pnl=10.0, starting_cash=10_000.0, res_seconds=300)
    assert m["profit_factor"] == 16 / 6
    assert m["expectancy"] == (10 - 4 + 6 - 2) / 4
    assert m["avg_win"] == 8.0        # (10+6)/2
    assert m["avg_loss"] == -3.0      # (-4-2)/2
    assert m["avg_win_loss_ratio"] == 8.0 / 3.0
    assert m["largest_win"] == 10.0
    assert m["largest_loss"] == -4.0
    assert m["return_pct"] == 10.0 / 10_000 * 100
    assert m["avg_duration_bars"] == 1.0   # 5 min / 300s = 1 bar


def test_consecutive_streaks():
    # W W L W L L L W  -> max wins 2, max losses 3
    pnls = [1, 1, -1, 1, -1, -1, -1, 1]
    trades = [_trade(p, i) for i, p in enumerate(pnls)]
    m = compute_metrics(trades, [], net_pnl=0.0, starting_cash=1000.0, res_seconds=60)
    assert m["max_consec_wins"] == 2
    assert m["max_consec_losses"] == 3


def test_drawdown_pct_from_equity():
    # peak 10_000 -> trough 9_500 => 5% drawdown
    eq = [
        EquityPoint(T0, 10_000),
        EquityPoint(T0 + timedelta(minutes=1), 9_500),
        EquityPoint(T0 + timedelta(minutes=2), 9_800),
    ]
    m = compute_metrics([], eq, net_pnl=-200.0, starting_cash=10_000.0, res_seconds=60)
    assert m["max_drawdown_pct"] == 5.0


def test_no_losers_profit_factor_none():
    trades = [_trade(5, 0), _trade(3, 1)]
    m = compute_metrics(trades, [], net_pnl=8.0, starting_cash=1000.0, res_seconds=60)
    assert m["profit_factor"] is None
    assert m["avg_win_loss_ratio"] is None
    assert m["avg_loss"] == 0.0


def test_empty_trades_no_divide_by_zero():
    m = compute_metrics([], [], net_pnl=0.0, starting_cash=10_000.0, res_seconds=60)
    assert m["expectancy"] == 0.0
    assert m["avg_win"] == 0.0 and m["avg_loss"] == 0.0
    assert m["profit_factor"] is None
    assert m["max_consec_wins"] == 0 and m["max_consec_losses"] == 0
    assert m["avg_duration_bars"] == 0.0
    assert m["max_drawdown_pct"] == 0.0

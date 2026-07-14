from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Side, Trade
from auto_trader.engine.backtest import EquityPoint
from auto_trader.engine.metrics import compute_metrics, leg_metrics

T0 = datetime(2024, 1, 1, tzinfo=timezone.utc)


def _trade(pnl, i=0, dur_min=5, leg="long"):
    entry = T0 + timedelta(minutes=i)
    return Trade(
        side=Side.BUY if leg == "long" else Side.SELL,
        quantity=1.0, entry_time=entry, entry_price=100.0,
        exit_time=entry + timedelta(minutes=dur_min), exit_price=100.0 + pnl,
        pnl=pnl, leg=leg, reason_in="in", reason_out="out",
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


# --- leg_metrics (per-direction breakdown) ---------------------------------


def test_leg_metrics_hand_computed():
    # long pnls: +10, -4 ; short pnls: +6, -2
    trades = [_trade(10, 0, leg="long"), _trade(6, 1, leg="short")]
    m = leg_metrics(trades, res_seconds=300, round_trip_cost=0.0)
    assert m["n_trades"] == 2
    assert m["net_pnl"] == 16.0
    assert m["win_rate"] == 1.0
    assert m["profit_factor"] is None      # no losers
    assert m["avg_win"] == 8.0             # (10+6)/2
    assert m["largest_win"] == 10.0
    assert m["avg_duration_bars"] == 1.0   # 5 min / 300s


def test_leg_metrics_win_rate_uses_round_trip_cost():
    # pnl 1.0 is a "win" for pnl>0 but NOT for pnl>2 (commission threshold)
    trades = [_trade(1.0, 0), _trade(5.0, 1)]
    m = leg_metrics(trades, res_seconds=60, round_trip_cost=2.0)
    assert m["win_rate"] == 0.5            # only the +5 clears the cost


def test_leg_metrics_loss_streak_is_within_filtered_list():
    # A caller filters to one leg; a run of 3 losing trades -> streak 3
    trades = [_trade(-1, i) for i in range(3)] + [_trade(2, 3)]
    m = leg_metrics(trades, res_seconds=60, round_trip_cost=0.0)
    assert m["max_consec_losses"] == 3


def test_leg_metrics_empty_is_zeroed():
    m = leg_metrics([], res_seconds=60, round_trip_cost=0.0)
    assert m["n_trades"] == 0
    assert m["net_pnl"] == 0.0
    assert m["win_rate"] == 0.0
    assert m["profit_factor"] is None
    assert m["avg_win_loss_ratio"] is None
    assert m["largest_win"] == 0.0 and m["largest_loss"] == 0.0
    assert m["max_consec_losses"] == 0
    assert m["avg_duration_bars"] == 0.0


def test_leg_metrics_win_rate_matches_engine_aggregate():
    # Parity: leg_metrics over all trades reproduces the engine's win_rate rule
    trades = [_trade(10, 0), _trade(-4, 1), _trade(6, 2), _trade(-2, 3)]
    m = leg_metrics(trades, res_seconds=300, round_trip_cost=0.0)
    assert m["win_rate"] == 0.5            # 2 of 4 with pnl>0


def test_leg_metrics_has_expectancy_and_consec_wins():
    # 3 trades: +10, +20, -5 -> expectancy = 25/3, max wins = 2
    trades = [_trade(10, 0), _trade(20, 1), _trade(-5, 2)]
    m = leg_metrics(trades, res_seconds=60, round_trip_cost=0.0)
    assert m["expectancy"] == (10.0 + 20.0 - 5.0) / 3
    assert m["max_consec_wins"] == 2


def test_leg_metrics_from_dicts_matches_keys():
    from auto_trader.engine.metrics import leg_metrics, leg_metrics_from_dicts
    dicts = [
        {"pnl": 5.0, "leg": "long", "entry_time": 0, "exit_time": 60},
        {"pnl": -2.0, "leg": "long", "entry_time": 0, "exit_time": 120},
    ]
    d = leg_metrics_from_dicts(dicts, res_seconds=60, round_trip_cost=0.0)
    # Same key set as the object-based helper.
    class T:
        def __init__(s, pnl, e, x):
            s.pnl, s.entry_time, s.exit_time = pnl, e, x
    from datetime import datetime, timedelta
    b = datetime(2024, 1, 1)
    o = leg_metrics([T(5.0, b, b + timedelta(minutes=1)),
                     T(-2.0, b, b + timedelta(minutes=2))],
                    res_seconds=60, round_trip_cost=0.0)
    assert set(d.keys()) == set(o.keys())
    assert d["n_trades"] == 2 and d["net_pnl"] == 3.0
    assert d["avg_duration_bars"] == 1.5  # (60/60 + 120/60) / 2

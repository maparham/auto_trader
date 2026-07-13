"""Aggregate analytics over TradeDTO-shaped dicts: SL/TP efficiency, exit-reason
breakdown, R-multiple histogram, context group-bys with low-sample flags."""

from auto_trader.engine.analysis import compute_analysis


def _t(pnl, *, entry=100.0, exit_=None, stop=95.0, target=None, leg="long",
       reason="rule", mae_r=None, mfe_r=None, context=None):
    if exit_ is None:
        exit_ = entry + pnl  # qty 1 price move == pnl for a long
    return {
        "pnl": pnl, "leg": leg, "entry_price": entry, "exit_price": exit_,
        "stop_initial": stop, "target": target, "reason": reason,
        "mae": (mae_r or 0.0) * 5.0, "mfe": (mfe_r or 0.0) * 5.0,
        "mae_r": mae_r, "mfe_r": mfe_r, "context": context,
    }


def test_empty_run_is_valid():
    a = compute_analysis([])
    assert a["n_trades"] == 0
    assert a["exit_reasons"] == []
    assert sum(a["r_hist"]["counts"]) == 0
    assert a["sl"]["winners_near_stop_pct"] is None
    assert a["tp"]["avg_winner_mfe_r"] is None


def test_sl_section():
    trades = [
        _t(10.0, mae_r=0.9, mfe_r=2.0),   # winner, nearly stopped
        _t(8.0, mae_r=0.2, mfe_r=1.8),    # winner, clean
        _t(-5.0, mae_r=1.0, mfe_r=0.1, reason="stop"),  # stopped loser
    ]
    a = compute_analysis(trades)
    assert a["sl"]["n_with_r"] == 3
    assert a["sl"]["winners_near_stop_pct"] == 0.5  # 1 of 2 winners had mae_r >= 0.8
    # winner mae_r 0.9 lands in the (0.75, 1.0] bucket = index 3
    assert a["sl"]["winners_mae_hist"]["counts"][3] == 1
    assert a["sl"]["losers_mae_hist"]["counts"][3] == 1  # 1.0 falls in (0.75, 1.0]


def test_tp_section():
    # Winner realized 2R (exit 110, risk 5) but saw 3R MFE -> 1R left on table.
    trades = [_t(10.0, exit_=110.0, mfe_r=3.0, mae_r=0.1)]
    a = compute_analysis(trades)
    assert a["tp"]["avg_winner_realized_r"] == 2.0
    assert a["tp"]["avg_winner_mfe_r"] == 3.0
    assert a["tp"]["median_left_on_table_r"] == 1.0


def test_tp_nontarget_exits_reached_target():
    # Two rule exits with a target set at 105 (5 above entry): one saw mfe 6
    # (reached), one saw mfe 2 (didn't).
    trades = [
        {**_t(3.0, target=105.0, mfe_r=1.2, mae_r=0.1), "mfe": 6.0},
        {**_t(1.0, target=105.0, mfe_r=0.4, mae_r=0.1), "mfe": 2.0},
    ]
    a = compute_analysis(trades)
    assert a["tp"]["pct_nontarget_exits_reached_target"] == 0.5


def test_exit_reasons_and_low_sample():
    trades = [_t(5.0, reason="target")] * 5 + [_t(-2.0, reason="stop")] * 2
    a = compute_analysis(trades)
    rows = {r["bucket"]: r for r in a["exit_reasons"]}
    assert rows["target"]["n"] == 5 and rows["target"]["low_sample"] is False
    assert rows["target"]["win_rate"] == 1.0
    assert rows["stop"]["n"] == 2 and rows["stop"]["low_sample"] is True
    assert rows["stop"]["net_pnl"] == -4.0


def test_r_hist_and_short_sign():
    # Short: entry 100 exit 90 with stop 105 -> +2R. Long loser -1R.
    trades = [
        _t(10.0, entry=100.0, exit_=90.0, stop=105.0, leg="short"),
        _t(-5.0, exit_=95.0),
    ]
    a = compute_analysis(trades)
    edges = a["r_hist"]["edges"]
    counts = a["r_hist"]["counts"]
    assert edges == [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5]
    # +2R -> bucket (1.5, 2.5] = index 5; -1R -> bucket (-1.5, -0.5] = index 2
    assert counts[5] == 1 and counts[2] == 1


def test_context_groupby_with_unknown():
    trades = [
        _t(5.0, context={"trend": "up", "vol_regime": "low", "session": "london",
                         "candle_pattern": "none", "day_of_week": 1}),
        _t(-3.0, context=None),
    ]
    a = compute_analysis(trades)
    trend_rows = {r["bucket"]: r for r in a["context"]["trend"]}
    assert trend_rows["up"]["n"] == 1
    assert trend_rows["unknown"]["n"] == 1


def test_hour_stats_groups_by_hour_utc():
    trades = [
        _t(5.0, context={"hour_utc": 9}),
        _t(-2.0, context={"hour_utc": 9}),
        _t(3.0, context={"hour_utc": 14}),
        _t(-1.0, context=None),          # no context -> excluded
        _t(4.0, context={"trend": "up"}),  # context present but no hour_utc -> excluded
    ]
    a = compute_analysis(trades)
    rows = {r["hour"]: r for r in a["hour_stats"]}
    assert set(rows) == {9, 14}
    assert rows[9] == {"hour": 9, "n": 2, "wins": 1, "sum_pnl": 3.0}
    assert rows[14] == {"hour": 14, "n": 1, "wins": 1, "sum_pnl": 3.0}


def test_hour_stats_sorted_and_empty():
    assert compute_analysis([])["hour_stats"] == []
    trades = [_t(1.0, context={"hour_utc": 20}), _t(1.0, context={"hour_utc": 3})]
    hours = [r["hour"] for r in compute_analysis(trades)["hour_stats"]]
    assert hours == [3, 20]

"""Aggregate analytics over TradeDTO-shaped dicts: SL/TP efficiency, exit-reason
breakdown, R-multiple histogram, context group-bys with low-sample flags."""

from auto_trader.engine.analysis import compute_analysis


def _t(pnl, *, entry=100.0, exit_=None, stop=95.0, target=None, leg="long",
       reason="rule", mae_r=None, mfe_r=None, context=None, entry_time=None, bars=None):
    if exit_ is None:
        exit_ = entry + pnl  # qty 1 price move == pnl for a long
    d = {
        "pnl": pnl, "leg": leg, "entry_price": entry, "exit_price": exit_,
        "stop_initial": stop, "target": target, "reason": reason,
        "mae": (mae_r or 0.0) * 5.0, "mfe": (mfe_r or 0.0) * 5.0,
        "mae_r": mae_r, "mfe_r": mfe_r, "context": context,
        "entry_time": entry_time,
    }
    if bars is not None:
        d.update(bars)
    return d


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


from datetime import datetime, timezone


def _ts(year, month, day=15):
    """Unix seconds at noon UTC on the given calendar day."""
    return int(datetime(year, month, day, 12, tzinfo=timezone.utc).timestamp())


def test_month_stats_groups_by_calendar_month():
    trades = [
        _t(10.0, entry_time=_ts(2026, 1)),
        _t(-4.0, entry_time=_ts(2026, 1)),
        _t(6.0, entry_time=_ts(2026, 2)),
        _t(-2.0, entry_time=_ts(2026, 2)),
        _t(3.0, entry_time=_ts(2026, 2)),
    ]
    rows = compute_analysis(trades)["month_stats"]
    # Chronological order.
    assert [r["bucket"] for r in rows] == ["2026-01", "2026-02"]
    jan, feb = rows[0], rows[1]
    assert jan["n"] == 2 and jan["net_pnl"] == 6.0
    assert jan["win_rate"] == 0.5 and jan["expectancy"] == 3.0
    assert feb["n"] == 3 and feb["net_pnl"] == 7.0


def test_month_stats_empty_when_single_month():
    trades = [_t(1.0, entry_time=_ts(2026, 3)), _t(-1.0, entry_time=_ts(2026, 3, 20))]
    assert compute_analysis(trades)["month_stats"] == []


def test_month_stats_skips_missing_entry_time_and_flags_low_sample():
    # Two Jan trades (n=2 -> low_sample), five Feb trades (n=5 -> not low),
    # one trade with no entry_time is skipped entirely.
    trades = (
        [_t(1.0, entry_time=_ts(2026, 1))] * 2
        + [_t(1.0, entry_time=_ts(2026, 2))] * 5
        + [_t(9.0)]  # entry_time None -> skipped
    )
    rows = {r["bucket"]: r for r in compute_analysis(trades)["month_stats"]}
    assert set(rows) == {"2026-01", "2026-02"}
    assert rows["2026-01"]["n"] == 2 and rows["2026-01"]["low_sample"] is True
    assert rows["2026-02"]["n"] == 5 and rows["2026-02"]["low_sample"] is False


def _bars(held, profit, loss, **extra):
    d = {"bars_held": held, "bars_in_profit": profit, "bars_in_loss": loss,
         "body_through": 0, "wick_from_profit": 0, "wick_from_loss": 0,
         "longest_profit_streak": 0, "longest_loss_streak": 0,
         "bars_to_mfe": 0, "bars_to_mae": 0, "entry_crossings": 0}
    d.update(extra)
    return d


def test_bar_dynamics_splits_winners_losers_and_averages():
    trades = [
        _t(5.0, bars=_bars(10, 8, 2, entry_crossings=1)),
        _t(3.0, bars=_bars(6, 6, 0, entry_crossings=3)),
        _t(-4.0, bars=_bars(8, 1, 7, entry_crossings=5)),
    ]
    bd = compute_analysis(trades)["bar_dynamics"]
    assert bd["n_winners"] == 2 and bd["n_losers"] == 1 and bd["n_total"] == 3
    # winners: bars_held mean (10+6)/2 = 8.0; entry_crossings (1+3)/2 = 2.0.
    assert bd["winners"]["bars_held"] == 8.0
    assert bd["winners"]["entry_crossings"] == 2.0
    # winners bars_in_profit mean (8+6)/2 = 7.0; the client derives the share of
    # bars held (7.0 / 8.0) for display, so no ratio is aggregated on the backend.
    assert bd["winners"]["bars_in_profit"] == 7.0
    assert "profit_time_pct" not in bd["winners"]
    assert bd["losers"]["bars_held"] == 8.0
    # total is the pooled average over all three trades, not winners plus losers:
    # bars_held (10+6+8)/3 = 8.0; entry_crossings (1+3+5)/3 = 3.0.
    assert bd["total"]["bars_held"] == 8.0
    assert bd["total"]["entry_crossings"] == 3.0


def test_bar_dynamics_excludes_trades_without_bar_stats():
    # A trade with no bar-stat fields (older run) is not eligible.
    trades = [_t(5.0, bars=_bars(10, 8, 2)), _t(2.0)]  # second has no bars
    bd = compute_analysis(trades)["bar_dynamics"]
    assert bd["n_winners"] == 1 and bd["n_losers"] == 0 and bd["n_total"] == 1
    assert bd["winners"]["bars_held"] == 10.0
    assert bd["total"]["bars_held"] == 10.0


def test_bar_dynamics_empty_group_is_all_none():
    bd = compute_analysis([])["bar_dynamics"]
    assert bd["n_winners"] == 0 and bd["n_losers"] == 0 and bd["n_total"] == 0
    assert bd["winners"]["bars_held"] is None
    assert bd["winners"]["entry_crossings"] is None
    assert bd["losers"]["bars_held"] is None
    assert bd["total"]["bars_held"] is None


def test_duration_hist_buckets_winners_and_losers():
    # Longest hold is 5 bars, so with <=8 trades the bucket width is 1 bar and
    # each distinct hold-length gets its own bucket (index == bars_held).
    trades = [
        _t(5.0, bars=_bars(1, 1, 0)),
        _t(3.0, bars=_bars(1, 1, 0)),
        _t(-2.0, bars=_bars(3, 0, 3)),
        _t(4.0, bars=_bars(5, 4, 1)),
        _t(-1.0, bars=_bars(5, 1, 4)),
    ]
    dh = compute_analysis(trades)["duration_hist"]
    assert dh["bar_width"] == 1
    # 6 buckets: hold lengths 0..5.
    assert dh["winners"] == [0, 2, 0, 0, 0, 1]
    assert dh["losers"] == [0, 0, 0, 1, 0, 1]


def test_duration_hist_widens_bucket_for_long_holds():
    # Longest hold is 40 bars over 8 target buckets -> raw 5 -> width 5.
    trades = [_t(1.0, bars=_bars(h, 0, 0)) for h in (0, 4, 5, 9, 40)]
    dh = compute_analysis(trades)["duration_hist"]
    assert dh["bar_width"] == 5
    assert len(dh["winners"]) == 9  # buckets 0..8 (40 // 5 + 1)
    # holds 0 and 4 -> bucket 0; 5 and 9 -> bucket 1; 40 -> bucket 8.
    assert dh["winners"][0] == 2 and dh["winners"][1] == 2 and dh["winners"][8] == 1


def test_duration_hist_none_without_bar_stats():
    assert compute_analysis([_t(1.0), _t(-1.0)])["duration_hist"] is None
    assert compute_analysis([])["duration_hist"] is None


def test_duration_hist_break_even_trades_counted_in_neither_series():
    # pnl == 0 trades carry bar stats (eligible) but land in neither winners nor
    # losers, so every bucket is zero. The dict is still returned (eligible
    # trades exist); the client hides the chart when all buckets are empty.
    trades = [_t(0.0, bars=_bars(1, 0, 0)), _t(0.0, bars=_bars(3, 0, 0))]
    dh = compute_analysis(trades)["duration_hist"]
    assert dh is not None
    assert dh["winners"] == [0, 0, 0, 0]
    assert dh["losers"] == [0, 0, 0, 0]


def test_per_leg_duration_hist_shares_all_trades_width():
    # Long trades hold up to 40 bars (own width 5); short trades hold up to 9
    # bars (own width 2). ALL's max is 40 -> width 5. The client renders the
    # x-axis from ALL's width and indexes the per-leg arrays positionally, so
    # each leg must be bucketed on ALL's width or its bars land under the wrong
    # labels. Here short's shorter holds are the ones that would be mislabeled.
    trades = (
        [_t(1.0, leg="long", bars=_bars(h, 0, 0)) for h in (0, 5, 40)]
        + [_t(1.0, leg="short", bars=_bars(h, 0, 0)) for h in (0, 4, 9)]
    )
    a = compute_analysis(trades)
    assert a["duration_hist"]["bar_width"] == 5
    assert a["by_leg"]["long"]["duration_hist"]["bar_width"] == a["duration_hist"]["bar_width"]
    assert a["by_leg"]["short"]["duration_hist"]["bar_width"] == a["duration_hist"]["bar_width"]


def test_per_leg_duration_hist_empty_leg_renders_zero_split():
    # Only long trades carry bar stats. ALL has a duration_hist (from the longs),
    # so the empty short leg must still render as a zero split at ALL's width
    # rather than collapsing to None and hiding the whole chart.
    trades = [_t(1.0, leg="long", bars=_bars(h, 0, 0)) for h in (0, 5, 40)]
    a = compute_analysis(trades)
    assert a["duration_hist"]["bar_width"] == 5
    short_dh = a["by_leg"]["short"]["duration_hist"]
    assert short_dh is not None
    assert short_dh["bar_width"] == 5
    assert short_dh["winners"] == [] and short_dh["losers"] == []


def test_compute_analysis_splits_by_leg():
    from auto_trader.engine.analysis import compute_analysis

    def trade(pnl, leg, reason):
        return {
            "pnl": pnl, "leg": leg, "reason": reason,
            "entry_price": 100.0, "exit_price": 100.0 + pnl,
            "stop_initial": 99.0, "target": None,
            "mae_r": None, "mfe_r": None, "mae": None, "mfe": None,
            "context": {}, "entry_time": None, "exit_time": None,
            "bars_held": None,
        }

    trades = [
        trade(5.0, "long", "target"),
        trade(-3.0, "long", "stop"),
        trade(7.0, "short", "target"),
    ]
    a = compute_analysis(trades)
    # Top-level unchanged: all trades.
    assert a["n_trades"] == 3
    # Split present and partitions correctly.
    assert a["by_leg"]["long"]["n_trades"] == 2
    assert a["by_leg"]["short"]["n_trades"] == 1
    # Nested payloads do not recurse.
    assert "by_leg" not in a["by_leg"]["long"]


def test_compute_analysis_missing_leg_defaults_long():
    from auto_trader.engine.analysis import compute_analysis
    t = {
        "pnl": 1.0, "reason": "target",
        "entry_price": 100.0, "exit_price": 101.0, "stop_initial": 99.0,
        "target": None, "mae_r": None, "mfe_r": None, "mae": None, "mfe": None,
        "context": {}, "entry_time": None, "exit_time": None, "bars_held": None,
    }  # no "leg" key
    a = compute_analysis([t])
    assert a["by_leg"]["long"]["n_trades"] == 1
    assert a["by_leg"]["short"]["n_trades"] == 0

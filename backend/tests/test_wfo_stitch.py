"""OOS stitching, walk-forward efficiency, and the aggregate robustness block."""
import datetime as dt

from auto_trader.api.wfo_stitch import aggregate, annualized_rate, fold_wfe, stitch

YEAR = 31_557_600


def _ts(day: int) -> int:
    return int(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp()) + day * 86400


def test_fold_wfe():
    is_m = {"return_pct": 12.0}
    oos_m = {"return_pct": 1.0}
    # 90d train at 12% vs 30d test at 1%: annualized 48.7% vs 12.2% -> ~0.25.
    w = fold_wfe(is_m, oos_m, 90 * 86400, 30 * 86400)
    assert abs(w - (annualized_rate(1.0, 30 * 86400) / annualized_rate(12.0, 90 * 86400))) < 1e-9
    assert fold_wfe({"return_pct": -5.0}, oos_m, 90 * 86400, 30 * 86400) is None


def test_stitch_offsets_segments():
    tests = [
        {"fold": {"test_from": _ts(0), "test_to": _ts(10)},
         "trades": [{"entry_time": _ts(1), "exit_time": _ts(2), "pnl": 100.0, "side": "LONG"}],
         "equity": [[_ts(0), 1000.0], [_ts(9), 1100.0]]},
        {"fold": {"test_from": _ts(10), "test_to": _ts(20)},
         "trades": [{"entry_time": _ts(11), "exit_time": _ts(12), "pnl": -50.0, "side": "SHORT"}],
         "equity": [[_ts(10), 1000.0], [_ts(19), 950.0]]},
    ]
    out = stitch(tests, 1000.0, 86400)
    # Summed: second segment offset by +100 cumulative pnl.
    assert out["equity"][-1] == [_ts(19), 1050.0]
    # Scaled: second segment scaled by 1100/1000.
    assert abs(out["equity_scaled"][-1][1] - 950.0 * 1.1) < 1e-9
    assert [t["fold"] for t in out["trades"]] == [0, 1]
    assert out["metrics"]["return_pct"] == 5.0  # 50 on 1000


def test_aggregate_block():
    folds = [
        {"wfe": 0.8, "low_sample": False,
         "oos_metrics": {"return_pct": 2.0, "net_pnl": 20.0}},
        {"wfe": 0.4, "low_sample": False,
         "oos_metrics": {"return_pct": -1.0, "net_pnl": -10.0}},
        {"wfe": None, "low_sample": True,
         "oos_metrics": {"return_pct": 1.0, "net_pnl": 10.0}},
    ]
    stitched = {"sharpe": 1.2, "max_drawdown_pct": 8.0, "profit_factor": 1.5}
    stability = {"overall": 0.9}
    out = aggregate(folds, stitched, stability, breadth=0.5,
                    oos_trades_total=120)
    assert out["wfe_median"] == 0.6
    assert out["pct_folds_profitable"] == round(2 / 3, 4)
    assert out["worst_fold_return_pct"] == -1.0
    assert out["low_sample_folds"] == 1
    assert out["n_folds"] == 3
    assert 0 <= out["robustness_score"] <= 100


def test_fold_excess_subtracts_null_return():
    from auto_trader.api.wfo_stitch import fold_excess

    assert fold_excess({"return_pct": 5.0}, {"return_pct": 3.0}) == 2.0
    assert fold_excess({"return_pct": -1.0}, {"return_pct": 2.5}) == -3.5


def test_fold_excess_none_when_either_missing():
    from auto_trader.api.wfo_stitch import fold_excess

    assert fold_excess(None, {"return_pct": 3.0}) is None
    assert fold_excess({"return_pct": 5.0}, None) is None
    assert fold_excess({"return_pct": None}, {"return_pct": 3.0}) is None
    assert fold_excess({"return_pct": 5.0}, {"return_pct": None}) is None


def test_aggregate_excess_fields():
    folds = [
        {"oos_metrics": {"return_pct": 5.0, "net_pnl": 5.0}, "wfe": None,
         "excess_return_pct": 2.0},
        {"oos_metrics": {"return_pct": -1.0, "net_pnl": -1.0}, "wfe": None,
         "excess_return_pct": -3.0},
        {"oos_metrics": {"return_pct": 1.0, "net_pnl": 1.0}, "wfe": None,
         "excess_return_pct": 4.0},
        {"oos_metrics": None, "wfe": None, "excess_return_pct": None},
    ]
    from auto_trader.api.wfo_stitch import aggregate
    block = aggregate(folds, {}, {}, None, oos_trades_total=0)
    assert block["median_fold_excess_pct"] == 2.0   # median of [2, -3, 4]
    assert block["pct_folds_beating_null"] == round(2 / 3, 4)  # None fold excluded


def test_aggregate_excess_fields_all_missing():
    folds = [{"oos_metrics": None, "wfe": None, "excess_return_pct": None}]
    from auto_trader.api.wfo_stitch import aggregate
    block = aggregate(folds, {}, {}, None, oos_trades_total=0)
    assert block["median_fold_excess_pct"] is None
    assert block["pct_folds_beating_null"] is None

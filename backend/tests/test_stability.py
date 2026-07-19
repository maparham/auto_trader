"""Parameter stability across folds and the composite robustness score."""
from auto_trader.engine.stability import parameter_stability, robustness_score

AXES = [{"kind": "range", "targets": ["param:fast"], "values": [5, 10, 15, 20]}]


def _tables(objective_by_value: dict, n_folds: int):
    combos = [{"param:fast": v} for v in [5, 10, 15, 20]]
    values = [objective_by_value[c["param:fast"]] for c in combos]
    return [(combos, values)] * n_folds


def test_constant_winner_is_fully_stable():
    chosen = [{"param:fast": 10}] * 4
    out = parameter_stability(chosen, AXES, _tables({5: 0, 10: 3, 15: 1, 20: 0}, 4))
    assert out["per_axis"]["param:fast"]["stability"] == 1.0
    assert out["adjacency"] == 1.0
    assert out["overall"] == 1.0


def test_bouncing_winner_scores_low():
    chosen = [{"param:fast": 5}, {"param:fast": 20},
              {"param:fast": 5}, {"param:fast": 20}]
    out = parameter_stability(chosen, AXES, _tables({5: 3, 10: 0, 15: 0, 20: 3}, 4))
    assert out["per_axis"]["param:fast"]["stability"] < 0.2
    assert out["adjacency"] == 0.0


def test_robustness_score_bounds_and_penalty():
    hi = robustness_score(
        wfe_median=0.9, pct_folds_profitable=1.0, oos_sharpe=2.0,
        param_stability=1.0, oos_max_dd_pct=5.0, plateau_breadth=0.8,
        oos_trades_total=300, n_folds=10)
    assert 90 <= hi <= 100
    lo = robustness_score(
        wfe_median=-0.5, pct_folds_profitable=0.0, oos_sharpe=None,
        param_stability=0.0, oos_max_dd_pct=60.0, plateau_breadth=0.0,
        oos_trades_total=300, n_folds=10)
    assert lo == 0.0
    thin = robustness_score(
        wfe_median=0.9, pct_folds_profitable=1.0, oos_sharpe=2.0,
        param_stability=1.0, oos_max_dd_pct=5.0, plateau_breadth=0.8,
        oos_trades_total=20, n_folds=3)
    assert thin < hi * 0.5  # sample penalty bites


def test_zero_drawdown_is_best_not_worst():
    zero_dd = robustness_score(
        wfe_median=0.9, pct_folds_profitable=1.0, oos_sharpe=2.0,
        param_stability=1.0, oos_max_dd_pct=0.0, plateau_breadth=0.8,
        oos_trades_total=300, n_folds=10)
    small_dd = robustness_score(
        wfe_median=0.9, pct_folds_profitable=1.0, oos_sharpe=2.0,
        param_stability=1.0, oos_max_dd_pct=5.0, plateau_breadth=0.8,
        oos_trades_total=300, n_folds=10)
    assert zero_dd >= small_dd

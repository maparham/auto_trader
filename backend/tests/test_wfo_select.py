"""Per-fold combo selection: objective evaluation, best vs plateau, breadth."""
from auto_trader.api.wfo_select import objective_values, plateau_breadth, select_fold

AXES = [{"kind": "range", "targets": ["param:fast"], "values": [5, 10, 15]}]


def _rows(metrics_list):
    return [{"combo": {"param:fast": v}, "metrics": m}
            for v, m in zip([5, 10, 15], metrics_list)]


def test_min_trades_filters_row():
    rows = _rows([{"sharpe": 2.0, "n_trades": 3},
                  {"sharpe": 1.0, "n_trades": 50},
                  None])
    vals = objective_values(rows, {"metric": "sharpe", "composite": None, "min_trades": 10})
    assert vals == [None, 1.0, None]


def test_composite_z_scores():
    rows = _rows([{"sharpe": 1.0, "max_drawdown_pct": 30.0, "n_trades": 50},
                  {"sharpe": 2.0, "max_drawdown_pct": 10.0, "n_trades": 50},
                  {"sharpe": 3.0, "max_drawdown_pct": 20.0, "n_trades": 50}])
    vals = objective_values(rows, {
        "metric": "sharpe",
        "composite": {"sharpe": 0.5, "max_drawdown_pct": -0.5},
        "min_trades": 0})
    # Row 1 has middling sharpe but the best (lowest) drawdown; row 2 best
    # sharpe but middling dd. Both must beat row 0.
    assert vals[0] < vals[1] and vals[0] < vals[2]


def test_plateau_selection_prefers_supported_cell():
    rows = _rows([{"sharpe": 1.8, "n_trades": 50},
                  {"sharpe": 2.0, "n_trades": 50},   # solid plateau center
                  {"sharpe": 0.1, "n_trades": 50}])
    spiky = _rows([{"sharpe": 0.1, "n_trades": 50},
                   {"sharpe": 5.0, "n_trades": 50},  # isolated spike
                   {"sharpe": 0.2, "n_trades": 50}])
    obj = {"metric": "sharpe", "composite": None, "min_trades": 0}
    i, _, _ = select_fold(rows, AXES, obj, "plateau")
    assert i == 1
    j, _, _ = select_fold(spiky, AXES, obj, "best")
    assert j == 1  # raw best still picks the spike


def test_select_none_when_no_eligible():
    rows = _rows([None, None, None])
    i, vals, _ = select_fold(rows, AXES, {"metric": "sharpe", "composite": None,
                                          "min_trades": 0}, "best")
    assert i is None and vals == [None, None, None]


def test_plateau_breadth():
    assert plateau_breadth([10.0, 9.0, 1.0, None]) == round(2 / 3, 4)
    assert plateau_breadth([-1.0, -2.0]) is None

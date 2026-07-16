"""Rolling expectancy series in compute_analysis."""
from auto_trader.engine.analysis import compute_analysis, rolling_expectancy


def trades_with_pnls(pnls):
    return [{"pnl": p, "entry_time": 1000 + i * 60, "exit_time": 1000 + i * 60 + 30,
             "side": "buy", "leg": "long"} for i, p in enumerate(pnls)]


def test_too_few_trades_is_none():
    assert rolling_expectancy(trades_with_pnls([1.0] * 11)) is None


def test_window_and_values():
    # 20 trades: first 10 win +10, last 10 lose -10. window = max(10, 20//5) = 10.
    r = rolling_expectancy(trades_with_pnls([10.0] * 10 + [-10.0] * 10))
    assert r["window"] == 10
    assert len(r["points"]) == 11              # positions 10..20 inclusive of first full window
    assert r["points"][0]["expectancy"] == 10.0
    assert r["points"][-1]["expectancy"] == -10.0
    assert r["points"][5]["expectancy"] == 0.0  # half wins, half losses in window


def test_points_sorted_by_entry_time_even_if_input_is_not():
    ts = trades_with_pnls([1.0] * 15)
    r = rolling_expectancy(list(reversed(ts)))
    assert [p["t"] for p in r["points"]] == sorted(p["t"] for p in r["points"])


def test_compute_analysis_carries_rolling():
    a = compute_analysis(trades_with_pnls([5.0, -5.0] * 10))
    assert a["rolling"] is not None and a["rolling"]["window"] == 10

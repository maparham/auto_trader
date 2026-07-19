"""wfo_worker: sliced grid metrics per train window and exact OOS test runs,
driven in-process (no pool) via worker_init + run_* calls."""
from auto_trader.api import wfo_worker
from tests.wfo_fixtures import H, T0, make_req_dict, write_strategy


def _init(tmp_path, n_candles, train_windows):
    write_strategy(tmp_path)
    wfo_worker.worker_init(make_req_dict(n_candles), {}, str(tmp_path), train_windows)


def test_grid_combo_slices_per_train_window(tmp_path):
    w1 = [T0 + 100 * H, T0 + 300 * H]
    w2 = [T0 + 200 * H, T0 + 400 * H]
    _init(tmp_path, 500, [w1, w2])
    row = wfo_worker.run_grid_combo({"param:fast": 5})
    assert row["error"] is None
    assert len(row["folds"]) == 2
    for fm in row["folds"]:
        assert "net_pnl" in fm and "sharpe" in fm and "n_trades" in fm


def test_bad_combo_yields_error_row(tmp_path):
    _init(tmp_path, 200, [[T0, T0 + 100 * H]])
    # fast's spec caps at max=50; an out-of-range value raises in resolve_params.
    row = wfo_worker.run_grid_combo({"param:fast": 999})
    assert row["folds"] is None and row["error"]


def test_run_test_returns_clipped_rebased_equity(tmp_path):
    _init(tmp_path, 500, [[T0, T0 + 100 * H]])
    out = wfo_worker.run_test({"key": "s0f0", "combo": {"param:fast": 5},
                               "test_from": T0 + 300 * H, "test_to": T0 + 400 * H})
    assert out["error"] is None
    assert out["key"] == "s0f0"
    ts = [p[0] for p in out["equity"]]
    assert min(ts) >= T0 + 300 * H and max(ts) < T0 + 400 * H
    assert len(out["equity"]) <= 500
    assert out["equity"][0][1] == 10000.0  # rebased to starting cash
    for t in out["trades"]:
        assert set(t) >= {"entry_time", "exit_time", "pnl", "side"}

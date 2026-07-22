"""WFO exact-mode acceptance gate: run_grid_combo_exact must produce, for every
train window, metrics IDENTICAL to run_test (the exact flat-start OOS engine run)
for the same (combo, window). This is the whole point of exact mode -- exact
in-sample selection scored on the same footing as the exact OOS test.

Covers both the clean free-slice path and the boundary engine-replay path, and
asserts both paths are actually exercised."""

import math

from auto_trader.api import wfo_worker
from auto_trader.api.wfo_worker import _window_is_clean
from tests.wfo_fixtures import H, T0, make_req_dict, write_strategy


def _match(a, b) -> bool:
    """Exact for ints/None; float metrics match up to fp reassociation noise.
    The clean free-slice path rebases large full-range equity while run_test
    rebases small window equity, so equity-derived floats (drawdown, sharpe)
    can differ at ~1e-13 relative -- not a real divergence."""
    if isinstance(a, float) or isinstance(b, float):
        return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)
    return a == b


def _init(tmp_path, n_candles, train_windows):
    write_strategy(tmp_path)
    wfo_worker.worker_init(make_req_dict(n_candles), {}, str(tmp_path), train_windows)


# Fixture trades occupy bars [2,29] [48,68] [88,108] [128,148] ... with flat
# gaps between. Windows are picked to hit every branch of _window_is_clean:
#   [35,115]  clean         (starts in a flat gap, no in-window trade past 115)
#   [55,155]  left-straddle (trade [48,68] open across bar 55)
#   [75,100]  right-straddle(trade [88,108] open across bar 100)
#   [48,140]  gated-boundary(a trade enters exactly at bar 48 = window start)
#   [75,155]  clean
_WINDOWS = [
    [T0 + 35 * H, T0 + 115 * H],
    [T0 + 55 * H, T0 + 155 * H],
    [T0 + 75 * H, T0 + 100 * H],
    [T0 + 48 * H, T0 + 140 * H],
    [T0 + 75 * H, T0 + 155 * H],
]
_COMBO = {"param:fast": 5}


def test_exact_folds_match_run_test_field_by_field(tmp_path):
    _init(tmp_path, 400, _WINDOWS)
    row = wfo_worker.run_grid_combo_exact(_COMBO)
    assert row["error"] is None, row["error"]
    assert len(row["folds"]) == len(_WINDOWS)

    for i, w in enumerate(_WINDOWS):
        out = wfo_worker.run_test(
            {"key": f"w{i}", "combo": _COMBO, "test_from": w[0], "test_to": w[1]})
        assert out["error"] is None, out["error"]
        exact, ref = row["folds"][i], out["metrics"]
        assert set(exact) == set(ref), (set(exact) ^ set(ref))
        for k in ref:
            assert _match(exact[k], ref[k]), \
                f"window {i} field {k}: {exact[k]} != {ref[k]}"


def test_both_paths_are_exercised(tmp_path):
    """Guard against a vacuous parity test: the fixture+windows must produce at
    least one clean window AND at least one boundary window, so both code paths
    in _exact_window_metrics are actually validated above."""
    _init(tmp_path, 400, _WINDOWS)
    session = __import__("auto_trader.api.sweep_worker", fromlist=["build_combo_session"]) \
        .build_combo_session(wfo_worker.sweep_worker._STATE,
                             wfo_worker.sweep_worker._STATE.req, _COMBO)
    verdicts = {_window_is_clean(session.full.trades, w[0], w[1]) for w in _WINDOWS}
    assert True in verdicts, "no clean window -- free-slice path not exercised"
    assert False in verdicts, "no boundary window -- engine-replay path not exercised"

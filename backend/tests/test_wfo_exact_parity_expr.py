"""WFO exact-mode parity for the EXPRESSION surface (the primary WFO path):
run_grid_combo_exact must match run_test field-by-field for an expr strategy,
exercising the compiled-once ExprRuleStrategy replay across windows."""

import math

from auto_trader.api import wfo_worker, sweep_worker
from auto_trader.api.wfo_worker import _window_is_clean

H = 3600
T0 = 0


def _candles(n):
    # ~40-bar triangle waves: rise 20, fall 20, so an EMA-cross long opens and
    # closes repeatedly with flat gaps between (clean + boundary windows).
    out = []
    for i in range(n):
        phase = i % 40
        price = 100 + (phase if phase < 20 else 40 - phase)
        out.append({"time": T0 + i * H, "open": price, "high": price + 0.2,
                    "low": price - 0.2, "close": price + 0.05, "volume": 100.0})
    return out


def _req(n):
    return {
        "epic": "TEST", "resolution": "HOUR", "candles": _candles(n),
        "htfCandles": None,
        "longEntry": [{"expr": "EMA(5) > EMA(20)"}],
        "longExit": [{"expr": "EMA(5) < EMA(20)"}],
        "shortEntry": [], "shortExit": [],
        "longEnabled": True, "shortEnabled": False,
        "longRisk": None, "shortRisk": None, "longScaling": None, "shortScaling": None,
        "costs": {"quantity": 1, "commissionPerSide": 0.1,
                  "slippage": {"kind": "fixed", "value": 0.0}, "spread": 0.0,
                  "startingCash": 10000},
        "tradeFromTime": T0, "mask": None, "inspect": False,
    }


# Trades occupy bars [2,30] [49,69] [89,109] [129,149] ... with flat gaps.
_WINDOWS = [
    [T0 + 35 * H, T0 + 115 * H],   # clean
    [T0 + 55 * H, T0 + 150 * H],   # left-straddle (trade [49,69])
    [T0 + 75 * H, T0 + 100 * H],   # right-straddle (trade [89,109])
    [T0 + 49 * H, T0 + 140 * H],   # gated-boundary (entry at bar 49)
    [T0 + 75 * H, T0 + 155 * H],   # clean
]
_COMBO: dict = {}


def _match(a, b) -> bool:
    if isinstance(a, float) or isinstance(b, float):
        return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)
    return a == b


def _init(n, windows):
    wfo_worker.worker_init(_req(n), {}, None, windows, expr_sweep=True)


def test_expr_exact_folds_match_run_test(tmp_path):
    _init(300, _WINDOWS)
    row = wfo_worker.run_grid_combo_exact(_COMBO)
    assert row["error"] is None, row["error"]
    for i, w in enumerate(_WINDOWS):
        out = wfo_worker.run_test(
            {"key": f"w{i}", "combo": _COMBO, "test_from": w[0], "test_to": w[1]})
        assert out["error"] is None, out["error"]
        exact, ref = row["folds"][i], out["metrics"]
        assert set(exact) == set(ref)
        for k in ref:
            assert _match(exact[k], ref[k]), \
                f"window {i} field {k}: {exact[k]} != {ref[k]}"


def test_expr_both_paths_exercised():
    _init(300, _WINDOWS)
    s = sweep_worker.build_combo_session(
        sweep_worker._STATE, sweep_worker._STATE.req, _COMBO)
    entry_ts = [t.entry_time.timestamp() for t in s.full.trades]
    exit_ts = [t.exit_time.timestamp() for t in s.full.trades]
    verdicts = {_window_is_clean(entry_ts, exit_ts, w[0], w[1]) for w in _WINDOWS}
    assert verdicts == {True, False}, f"want both paths, got {verdicts}"

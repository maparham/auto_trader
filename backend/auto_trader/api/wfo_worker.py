"""ProcessPool worker for walk-forward jobs. Reuses sweep_worker's init-once
state and engine execution; adds per-train-window sliced metrics (one engine
run per combo, sliced N ways) and exact out-of-sample test runs. Spawn-safe,
zero network, no FastAPI imports."""
from __future__ import annotations

from auto_trader.api import sweep_worker
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.engine.metrics import slice_window_metrics

_TRAIN_WINDOWS: list[list[int]] | None = None
_EQUITY_CAP = 500


def worker_init(req_dict, htf_candles, strategies_dir, train_windows, expr_sweep=False) -> None:
    global _TRAIN_WINDOWS
    sweep_worker.worker_init(req_dict, htf_candles, strategies_dir, None, expr_sweep)
    _TRAIN_WINDOWS = train_windows


def run_grid_combo(combo: dict) -> dict:
    """One full-range engine run, sliced into per-train-window metrics.
    Never raises."""
    s = sweep_worker._STATE
    assert s is not None and _TRAIN_WINDOWS is not None, "worker_init not called"
    try:
        result = sweep_worker.execute_combo(s, s.req, combo)
        res_s = resolution_seconds(s.req.resolution)
        cash = s.req.costs.startingCash
        folds = [
            slice_window_metrics(result.trades, result.equity, w[0], w[1], cash, res_s)
            for w in _TRAIN_WINDOWS
        ]
        return {"combo": combo, "folds": folds, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"combo": combo, "folds": None, "error": str(e)}


def _downsample(points: list[list[float]], cap: int) -> list[list[float]]:
    if len(points) <= cap:
        return points
    step = len(points) / cap
    out = [points[int(i * step)] for i in range(cap - 1)]
    out.append(points[-1])
    return out


def run_test(payload: dict) -> dict:
    """Exact flat-start OOS run of one fold winner over its test window, via
    the period env-combo (entries gate at test_from, candles truncate at
    test_to; the warm-up prefix keeps indicators warm). Never raises."""
    s = sweep_worker._STATE
    assert s is not None, "worker_init not called"
    combo = payload["combo"]
    test_from, test_to = payload["test_from"], payload["test_to"]
    try:
        run_combo = {**combo, "period:from": test_from, "period:to": test_to}
        result = sweep_worker.execute_combo(s, s.req, run_combo)
        res_s = resolution_seconds(s.req.resolution)
        cash = s.req.costs.startingCash
        metrics = slice_window_metrics(
            result.trades, result.equity, test_from, test_to, cash, res_s)
        # Rebase equity inside the window to starting cash (same offset rule as
        # slice_window_metrics: last pre-window equity maps to cash).
        e0 = cash
        for pt in result.equity:
            if pt.time.timestamp() >= test_from:
                break
            e0 = pt.equity
        offset = cash - e0
        equity = [[int(pt.time.timestamp()), round(pt.equity + offset, 5)]
                  for pt in result.equity
                  if test_from <= pt.time.timestamp() < test_to]
        trades = [{
            "entry_time": int(t.entry_time.timestamp()),
            "exit_time": int(t.exit_time.timestamp()),
            "pnl": round(t.pnl, 5),
            "side": t.side.value,
        } for t in result.trades if test_from <= t.entry_time.timestamp() < test_to]
        return {"key": payload["key"], "combo": combo, "metrics": metrics,
                "trades": trades, "equity": _downsample(equity, _EQUITY_CAP),
                "error": None}
    except Exception as e:  # noqa: BLE001
        return {"key": payload.get("key"), "combo": combo, "metrics": None,
                "trades": None, "equity": None, "error": str(e)}

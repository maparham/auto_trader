"""ProcessPool worker for sweep combos.

State arrives ONCE via worker_init (spawn-safe: macOS has no fork, so nothing is
inherited: every worker rebuilds its state from the initializer args). Workers do
zero network: HTF candles are pre-fetched by the parent, and a coded strategy
that references an unfetched timeframe yields an error row instead of fetching.
This module deliberately imports no FastAPI app/deps: it must be importable in a
bare worker process.
"""
from __future__ import annotations

from pathlib import Path
from types import ModuleType

from auto_trader.api import sweep_apply as sa
from auto_trader.api.schemas import BacktestRequest
from auto_trader.core.models import Candle
from auto_trader.strategy import loader
from auto_trader.strategy.params import resolve_params


class _State:
    req: BacktestRequest
    candles: list[Candle]
    htf: dict[str, list[Candle]]
    module: ModuleType | None
    windows: list[int] | None


_STATE: _State | None = None


def worker_init(
    req_dict: dict,
    htf_candles: dict[str, list[Candle]],
    strategies_dir: str | None,
    windows: list[int] | None,
) -> None:
    """Pool initializer: rebuild per-worker state from the parent's args.

    `strategies_dir` is set explicitly (never inherited): tests monkeypatch
    `loader.STRATEGIES_DIR`, which a spawned worker does not see."""
    global _STATE
    s = _State()
    s.req = BacktestRequest.model_validate(req_dict)
    s.candles = [sa.candle_from_dto(c) for c in s.req.candles]
    s.htf = htf_candles
    s.windows = windows
    s.module = None
    if s.req.codedStrategy is not None:
        if strategies_dir is not None:
            loader.STRATEGIES_DIR = Path(strategies_dir)
        s.module = loader.load_strategy(s.req.codedStrategy, loader.STRATEGIES_DIR)
    _STATE = s


def run_combo(combo: dict) -> dict:
    """Run one combo against the init-once `_STATE`; return a SweepRowDTO dump.

    Never raises: any exception (a bad target, a strategy runtime error, a
    missing timeframe) becomes an error row so one combo cannot kill the worker
    or the whole chunk."""
    s = _STATE
    assert s is not None, "worker_init not called"
    # sweep_row reads req.sweep.windows: patch the pre-fetched windows onto the
    # base request so per-window robustness slices match the router's behavior.
    if s.windows is not None:
        req = s.req.model_copy(update={
            "sweep": s.req.sweep.model_copy(update={"windows": s.windows}),
        })
    else:
        req = s.req
    try:
        env, rest = sa.split_env_combo(combo)
        patched, candles = sa.apply_env_combo(req, s.candles, env)
        if s.module is None:
            patched = sa.apply_rule_combo(patched, rest)
            result = sa.run_rule_sync(patched, candles, dict(s.htf))
        else:
            params, long_risk, short_risk = sa.apply_combo(patched, rest)
            resolved = resolve_params(s.module, params)
            result, _ = sa.run_coded_sync(
                patched, candles, s.module, resolved, long_risk, short_risk, dict(s.htf),
            )
        return sa.sweep_row(req, combo, result).model_dump()
    except Exception as e:  # noqa: BLE001  one combo must never kill the worker
        return {"combo": combo, "metrics": None, "windows": None, "error": str(e)}

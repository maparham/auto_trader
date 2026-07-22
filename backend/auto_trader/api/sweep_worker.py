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
from auto_trader.api.schemas import BacktestRequest, ExprBacktestRequest
from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestResult
from auto_trader.strategy import loader
from auto_trader.strategy.params import resolve_params


class _State:
    req: BacktestRequest
    candles: list[Candle]
    htf: dict[str, list[Candle]]
    module: ModuleType | None
    windows: list[int] | None
    expr: bool = False


_STATE: _State | None = None

# Per-worker indicator-series caches, keyed by candle-list identity so an
# env-combo (period:to) truncated list never shares series with the full one.
_IND_CACHES: dict[tuple, dict] = {}


def indicator_cache_key(candles: list[Candle]) -> tuple:
    if not candles:
        return (0, 0, 0)
    return (len(candles), candles[0].time.timestamp(), candles[-1].time.timestamp())


def indicator_cache_for(candles: list[Candle]) -> dict:
    return _IND_CACHES.setdefault(indicator_cache_key(candles), {})


def worker_init(
    req_dict: dict,
    htf_candles: dict[str, list[Candle]],
    strategies_dir: str | None,
    windows: list[int] | None,
    expr_sweep: bool = False,
) -> None:
    """Pool initializer: rebuild per-worker state from the parent's args.

    `strategies_dir` is set explicitly (never inherited): tests monkeypatch
    `loader.STRATEGIES_DIR`, which a spawned worker does not see. `expr_sweep`
    switches the state to an ExprBacktestRequest (no coded strategy load)."""
    global _STATE
    _IND_CACHES.clear()
    s = _State()
    s.expr = expr_sweep
    s.module = None
    if expr_sweep:
        s.req = ExprBacktestRequest.model_validate(req_dict)
    else:
        s.req = BacktestRequest.model_validate(req_dict)
    s.candles = [sa.candle_from_dto(c) for c in s.req.candles]
    s.htf = htf_candles
    s.windows = windows
    if not expr_sweep and s.req.codedStrategy is not None:
        if strategies_dir is not None:
            loader.STRATEGIES_DIR = Path(strategies_dir)
        s.module = loader.load_strategy(s.req.codedStrategy, loader.STRATEGIES_DIR)
    _STATE = s


def execute_combo(s: _State, req: BacktestRequest, combo: dict) -> BacktestResult:
    """Apply one combo (env split + strategy patch) and run the engine over the
    worker's candles. Raises on any problem; callers own error-row semantics."""
    env, rest = sa.split_env_combo(combo)
    patched, candles = sa.apply_env_combo(req, s.candles, env)
    if getattr(s, "expr", False):
        overrides = sa.apply_lit_combo(patched, rest)
        # lit: keys are consumed by apply_lit_combo; filter to risk: so apply_combo
        # never sees a lit:/other key (it 422s on unknown targets).
        _params, long_risk, short_risk = sa.apply_combo(
            patched, {k: v for k, v in rest.items() if k.startswith("risk:")})
        return sa.run_expr_sync(
            patched, candles, dict(s.htf), overrides, long_risk, short_risk)
    params, long_risk, short_risk = sa.apply_combo(patched, rest)
    resolved = resolve_params(s.module, params)
    result, _ = sa.run_coded_sync(
        patched, candles, s.module, resolved, long_risk, short_risk, dict(s.htf),
        indicator_cache=indicator_cache_for(candles),
    )
    return result


class ComboSession:
    """One combo's full-range result plus a reusable per-window runner. Window
    runs reuse the combo's indicator series (expr: the same compiled rows;
    coded: the shared per-worker indicator cache) so WFO exact mode never
    recomputes indicators per window. `full` is the BacktestResult over the
    whole (env-applied) candle list; `run_window` runs a flat-start,
    entries-gated-at-`trade_from` run that processes only bars 0..`stop_index`
    (see BacktestEngine.stop_index) over the SAME candles."""

    def __init__(self, full, candles, run_window):
        self.full = full
        self.candles = candles
        self.run_window = run_window


def build_combo_session(s: _State, req: BacktestRequest, combo: dict) -> ComboSession:
    """Compile one combo ONCE and run its full range, returning a ComboSession
    whose run_window replays gated sub-windows without recomputing indicators.
    Raises on any problem (same contract as execute_combo); callers own error
    rows."""
    env, rest = sa.split_env_combo(combo)
    patched, candles = sa.apply_env_combo(req, s.candles, env)
    if getattr(s, "expr", False):
        overrides = sa.apply_lit_combo(patched, rest)
        _params, long_risk, short_risk = sa.apply_combo(
            patched, {k: v for k, v in rest.items() if k.startswith("risk:")})
        engine, strategy = sa.build_expr_engine(
            patched, candles, dict(s.htf), overrides, long_risk, short_risk)
        full = engine.run(candles)

        def run_window(trade_from, stop_index):
            # ExprRuleStrategy is stateless except trade_from_time; mutate it and
            # replay over the same candles (compiled rows keep their series cache).
            strategy.trade_from_time = trade_from
            return engine.run(candles, stop_index=stop_index)

        return ComboSession(full, candles, run_window)

    params, long_risk, short_risk = sa.apply_combo(patched, rest)
    resolved = resolve_params(s.module, params)
    cache = indicator_cache_for(candles)
    full, _ = sa.run_coded_sync(
        patched, candles, s.module, resolved, long_risk, short_risk, dict(s.htf),
        indicator_cache=cache)

    def run_window(trade_from, stop_index):
        # Coded strategies carry per-run mutable state, so rebuild the strategy
        # per window but share the indicator cache (keyed by the full candle
        # list) so the expensive series are computed once, not per window.
        req_w = patched.model_copy(update={"tradeFromTime": trade_from})
        res, _ = sa.run_coded_sync(
            req_w, candles, s.module, resolved, long_risk, short_risk, dict(s.htf),
            indicator_cache=cache, stop_index=stop_index)
        return res

    return ComboSession(full, candles, run_window)


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
        result = execute_combo(s, req, combo)
        return sa.sweep_row(req, combo, result).model_dump()
    except Exception as e:  # noqa: BLE001  one combo must never kill the worker
        return {"combo": combo, "metrics": None, "windows": None, "error": str(e)}

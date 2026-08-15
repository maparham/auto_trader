"""Per-combo request patching + synchronous engine-run cores.

Importable by worker processes: no FastAPI app/deps imports, no network.
The router owns HTF fetching and wraps SweepValidationError into HTTPException.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from types import ModuleType
from typing import Callable
from zoneinfo import ZoneInfo

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine, BacktestResult
from auto_trader.engine.metrics import compute_metrics, window_metrics
from auto_trader.indicators.registry import ResolvedInstance, resolve_instances
from auto_trader.strategy.base import Strategy
from auto_trader.strategy.coded import (
    CodedStrategy,
    CodedWithExprExits,
    NeedTimeframe,
)
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.literals import substitute
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.strategy import ExprRuleStrategy
from auto_trader.strategy.expr.tfs import tf_resolution
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.reversed import ReversedStrategy

from .risk_series import (
    AtrWarmupError,
    build_atr_risk_series,
    first_tradeable_index,
)
from .schemas import (
    BacktestRequest,
    CandleDTO,
    DayTimeWindowDTO,
    ExprBacktestRequest,
    RecurrenceMaskDTO,
    RiskConfigDTO,
    SweepRowDTO,
)

# Cap on fetch-retry passes for a coded strategy's ad-hoc tf= calls (Task 15):
# each pass discovers at most one new timeframe, so this bounds how many
# distinct timeframes a single run may reference before we give up.
_MAX_TF_PASSES = 5


class SweepValidationError(Exception):
    """A request-shaped problem in one combo (bad target, missing risk, ...).

    Raised in place of HTTPException so worker processes never import FastAPI
    response machinery. The router translates it back to HTTPException at the
    handler boundary."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class TimeframeNotPrefetched(Exception):
    """A coded run referenced a timeframe not present in htf_candles — either
    the strategy's own ctx.<ind>(tf=) call or one of its panel EXIT expression
    rows (an @tf token, or a reference to a pane pinned in its own settings).
    The router's async wrapper fetches it and calls run_coded_sync again; workers
    that pre-fetch the full set never see it."""

    def __init__(self, timeframe: str):
        super().__init__(f"timeframe '{timeframe}' not pre-fetched")
        self.timeframe = timeframe


def candle_from_dto(c: CandleDTO) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(c.time, tz=timezone.utc),
        open=c.open, high=c.high, low=c.low, close=c.close, volume=c.volume,
    )


def ts_seconds(dt: datetime) -> int:
    """A tz-aware datetime as whole unix seconds (the CandleDTO/trade-DTO wire form)."""
    return int(dt.timestamp())


def candle_to_dto(c: Candle) -> CandleDTO:
    return CandleDTO(
        time=ts_seconds(c.time),
        open=c.open, high=c.high, low=c.low, close=c.close, volume=c.volume,
    )


def htf_to_dto(htf: dict[str, list[Candle]]) -> dict[str, list[CandleDTO]]:
    """Serialize a fetched HTF set for shipping in BacktestRequest.htfCandles."""
    return {tf: [candle_to_dto(c) for c in bars] for tf, bars in htf.items()}


def htf_from_dto(htf: dict[str, list[CandleDTO]]) -> dict[str, list[Candle]]:
    """Decode BacktestRequest.htfCandles back into the engine's HTF set."""
    return {tf: [candle_from_dto(c) for c in bars] for tf, bars in htf.items()}


def request_instances(req) -> dict[str, ResolvedInstance]:
    """Resolve a request's `indicators` map ONCE. Call this at the top of a
    handler (or, in a pool worker, at the top of the per-combo build) and thread
    the result down — never per row.

    A ResolvedInstance holds the spec's callables, so it is NOT picklable and
    must never be put on a job payload: workers rebuild the request from
    `req_dict` (which carries the raw `indicators` map) and resolve it there."""
    return resolve_instances(
        {k: v.model_dump() for k, v in (req.indicators or {}).items()}
    )


def referenced_tfs(node: N.Node, instances=None) -> set[str]:
    """All timeframes a row's tree needs HTF candles for: the @TF tokens in the
    text, PLUS any referenced instance pinned in its own settings."""
    if isinstance(node, N.Tf):
        return {node.tf} | referenced_tfs(node.base, instances)
    if isinstance(node, N.IndicatorRef):
        # A pane pinned in its own SETTINGS needs HTF candles even though the
        # expression text carries no @tf.
        inst = (instances or {}).get(node.instance)
        pin = inst.spec.timeframe(inst.config) if inst else None
        return {pin} if pin else set()
    if isinstance(node, (N.Chain, N.BoolOp)):
        return set().union(*(referenced_tfs(p, instances) for p in node.parts))
    if isinstance(node, N.Not):
        return referenced_tfs(node.operand, instances)
    if isinstance(node, (N.Field, N.Offset)):
        return referenced_tfs(node.base, instances)
    if isinstance(node, N.Unary):
        return referenced_tfs(node.operand, instances)
    if isinstance(node, N.Call):
        return (set().union(*(referenced_tfs(a, instances) for a in node.args))
                if node.args else set())
    if isinstance(node, (N.Binary, N.Compare)):
        return referenced_tfs(node.left, instances) | referenced_tfs(node.right, instances)
    if isinstance(node, N.Cross):
        return referenced_tfs(node.a, instances) | referenced_tfs(node.b, instances)
    if isinstance(node, N.Predicate):
        return referenced_tfs(node.base, instances)
    if isinstance(node, N.Count):
        return referenced_tfs(node.cond, instances) | referenced_tfs(node.window, instances)
    return set()


def _compile_expr_exits(rows, candles, resolution, htf, instances=None):
    """Parse+validate+compile enabled, non-blank expression exit rows. Isolation:
    a parse/validate problem raises SweepValidationError(422) so one sweep combo
    fails to its own error row (matches run_expr_sync)."""
    compiled = []
    for row in rows:
        if not row.enabled or not row.expr.strip():
            continue
        try:
            node = parse(row.expr)
            validate(node, is_exit=True, instances=instances)
        except ExprError as e:
            raise SweepValidationError(422, e.message)
        # A CODED run reaches here with whatever htf the request shipped, and the
        # only thing that ever asked for more was CodedStrategy's own tf= call —
        # never an expression row. So a panel exit needing a higher timeframe (an
        # @tf token, or a reference to a pane pinned in its own settings) compiled
        # to all-None and the position simply never exited, silently. The
        # expression ROUTES avoid this with api/expr_exec.py::_ensure_htf; this path has no
        # equivalent.
        #
        # Report it the SAME way the strategy's own tf= call does, rather than
        # erroring outright: `_run_coded` catches TimeframeNotPrefetched, fetches
        # that timeframe, and calls again (bounded by _MAX_TF_PASSES), so an
        # expression row now pulls its timeframe in exactly like ctx.ema(tf=)
        # does. Erroring here instead would BREAK a working combination — a
        # strategy calling ctx.ema(tf="4H") alongside a panel exit on @4H gets
        # its HOUR_4 bars from that same loop, and that fetch happens only after
        # this point on the first pass. A timeframe that genuinely cannot be
        # fetched still surfaces as `_run_coded`'s "no candles for timeframe" 422.
        for tf in sorted(referenced_tfs(node, instances)):
            res = tf_resolution(tf) or tf
            if not (htf.get(res) or htf.get(tf)):
                raise TimeframeNotPrefetched(res)
        compiled.append(compile_row(node, candles, resolution, htf, instances))
    return compiled


def run_coded_sync(
    req: BacktestRequest, candles: list[Candle], module: ModuleType,
    resolved_params: dict, long_risk_dto: RiskConfigDTO | None,
    short_risk_dto: RiskConfigDTO | None, htf_candles: dict[str, list[Candle]],
    indicator_cache: dict | None = None,
    start_index: int | None = None,
    stop_index: int | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> tuple[BacktestResult, Strategy]:
    """One coded engine run over the already-fetched `htf_candles`: risk DTOs
    are passed explicitly (the sweep patches them per combo). When the strategy
    references a timeframe not in `htf_candles`, raises `TimeframeNotPrefetched`
    so the router can fetch it and call again; when the tf is already present it
    retries locally. A `StrategyRuntimeError` from the strategy itself is NOT
    caught here: it propagates so callers can choose how to surface it (a single
    request 422s; a sweep isolates it to one row)."""
    panel_risk_legs = frozenset(
        leg for leg, r in (("long", long_risk_dto), ("short", short_risk_dto))
        if r is not None and r.is_configured()
    )
    # Once per run, not once per tf-retry pass: the coded path's panel exits are
    # expressions and may reference a chart instance.
    instances = request_instances(req)
    for _ in range(_MAX_TF_PASSES):
        strategy: Strategy = CodedStrategy(
            module, candles, quantity=req.costs.quantity,
            trade_from_time=req.tradeFromTime, htf_candles=htf_candles,
            base_timeframe=req.resolution, params=resolved_params,
            panel_risk_legs=panel_risk_legs,
            indicator_cache=indicator_cache,
        )
        long_exit = _compile_expr_exits(req.exprLongExit, candles, req.resolution, htf_candles, instances)
        short_exit = _compile_expr_exits(req.exprShortExit, candles, req.resolution, htf_candles, instances)
        if long_exit or short_exit:
            strategy = CodedWithExprExits(strategy, ExprRuleStrategy(
                [], long_exit, [], short_exit,
                quantity=req.costs.quantity,
                long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
                long_exit_combine=req.exprLongExitCombine,
                short_exit_combine=req.exprShortExitCombine,
            ))
        # Reversed baseline: wrap the WHOLE stack (coded module + panel expr
        # exits) so everything above the wrapper keeps reasoning in original
        # long/short space (panel_risk_legs and the exit compilation included);
        # only the engine sees flipped legs. The side-level configs the engine
        # applies swap below, so a flipped leg keeps the risk/scaling that
        # governed it in the original run. Costs (incl. per-side financing)
        # deliberately do NOT swap: the reversed run really holds the other
        # side and pays that side's carry.
        eng_long_risk, eng_short_risk = long_risk_dto, short_risk_dto
        eng_long_scaling, eng_short_scaling = req.longScaling, req.shortScaling
        if getattr(req, "reverse", False):
            strategy = ReversedStrategy(strategy)
            eng_long_risk, eng_short_risk = short_risk_dto, long_risk_dto
            eng_long_scaling, eng_short_scaling = req.shortScaling, req.longScaling
        engine = BacktestEngine(
            strategy,
            starting_cash=req.costs.startingCash,
            commission_per_side=req.costs.commissionPerSide,
            slippage=req.costs.slippage.value,
            slippage_atr_mult=req.costs.slippage.atrMult if req.costs.slippage.kind == "atr" else 0.0,
            spread=req.costs.spread,
            fin_long_daily_pct=req.costs.finLongDailyPct,
            fin_short_daily_pct=req.costs.finShortDailyPct,
            long_risk=eng_long_risk.to_risk() if eng_long_risk else None,
            short_risk=eng_short_risk.to_risk() if eng_short_risk else None,
            long_scaling=eng_long_scaling.to_scaling() if eng_long_scaling else None,
            short_scaling=eng_short_scaling.to_scaling() if eng_short_scaling else None,
            series=req.series,
            mask=req.mask.to_mask() if req.mask else None,
        )
        try:
            result = engine.run(candles, start_index=start_index,
                                stop_index=stop_index, on_progress=on_progress)
            return result, strategy
        except NeedTimeframe as need:
            if need.timeframe not in htf_candles:
                raise TimeframeNotPrefetched(need.timeframe)
            # Already present but still raised: retry locally (defensive).
    raise SweepValidationError(422, "strategy needs too many timeframes (max 5)")


def build_expr_engine(
    req: ExprBacktestRequest, candles: list[Candle],
    htf_candles: dict[str, list[Candle]],
    overrides: dict[tuple[str, str, int], "N.Row"],
    long_risk: RiskConfigDTO | None, short_risk: RiskConfigDTO | None,
) -> tuple[BacktestEngine, ExprRuleStrategy]:
    """Compile one expression combo into a (engine, strategy) pair WITHOUT
    running it. Split out of run_expr_sync so WFO exact mode can build the
    compiled strategy ONCE per combo and replay it over many gated sub-windows
    (its CompiledRows cache the indicator series, so windows reuse them). Same
    validation/config as run_expr_sync; raises SweepValidationError(422) the
    same way."""
    # I4 (expr): ATR-kind panel risk / scaling spacing execute against
    # series["ATR_{length}"], which the expr wire format never carries — compute
    # them here or the engine reads None and runs stop-less. Built from the
    # combo's PATCHED risk DTOs, not req's (a risk: target may have moved
    # value/mult; .length is not sweepable, so one build per combo is enough).
    try:
        atr_risk = build_atr_risk_series(
            candles, (long_risk, short_risk),
            (req.longScaling, req.shortScaling),
            first_tradeable_index(candles, req.tradeFromTime),
        )
    except AtrWarmupError as e:
        raise SweepValidationError(422, e.message)
    # Resolved ONCE per combo, above the four compile_group calls: this runs in
    # a pool worker, which rebuilt `req` (and its raw `indicators` map) from the
    # job payload — a ResolvedInstance itself could never have been pickled.
    instances = request_instances(req)
    group_map = {
        ("long", "entry"): req.longEntry,
        ("long", "exit"): req.longExit,
        ("short", "entry"): req.shortEntry,
        ("short", "exit"): req.shortExit,
    }

    def compile_group(side: str, grp: str, *, is_exit: bool) -> list:
        compiled = []
        for idx, row in enumerate(group_map[(side, grp)]):
            # Disabled and blank rows are not rules (a blank row never carries a
            # lit override, so index alignment with lit: targets is preserved).
            if not row.enabled or not row.expr.strip():
                continue
            node = overrides.get((side, grp, idx))
            try:
                if node is None:
                    node = parse(row.expr)
                validate(node, is_exit=is_exit, instances=instances)
            except ExprError as e:
                raise SweepValidationError(422, e.message)
            compiled.append(compile_row(node, candles, req.resolution, htf_candles, instances))
        return compiled

    strategy = ExprRuleStrategy(
        compile_group("long", "entry", is_exit=False),
        compile_group("long", "exit", is_exit=True),
        compile_group("short", "entry", is_exit=False),
        compile_group("short", "exit", is_exit=True),
        quantity=req.costs.quantity,
        trade_from_time=req.tradeFromTime,
        long_enabled=req.longEnabled,
        short_enabled=req.shortEnabled,
        long_entry_combine=req.longEntryCombine,
        long_exit_combine=req.longExitCombine,
        short_entry_combine=req.shortEntryCombine,
        short_exit_combine=req.shortExitCombine,
    )
    engine = BacktestEngine(
        strategy,
        starting_cash=req.costs.startingCash,
        commission_per_side=req.costs.commissionPerSide,
        slippage=req.costs.slippage.value,
        slippage_atr_mult=(
            req.costs.slippage.atrMult if req.costs.slippage.kind == "atr" else 0.0
        ),
        spread=req.costs.spread,
        fin_long_daily_pct=req.costs.finLongDailyPct,
        fin_short_daily_pct=req.costs.finShortDailyPct,
        long_risk=long_risk.to_risk() if long_risk else None,
        short_risk=short_risk.to_risk() if short_risk else None,
        long_scaling=req.longScaling.to_scaling() if req.longScaling else None,
        short_scaling=req.shortScaling.to_scaling() if req.shortScaling else None,
        series=atr_risk,
        mask=req.mask.to_mask() if req.mask else None,
    )
    return engine, strategy


def run_expr_sync(
    req: ExprBacktestRequest, candles: list[Candle],
    htf_candles: dict[str, list[Candle]],
    overrides: dict[tuple[str, str, int], "N.Row"],
    long_risk: RiskConfigDTO | None, short_risk: RiskConfigDTO | None,
    start_index: int | None = None,
) -> BacktestResult:
    """One expression engine run for a sweep combo (build + run). See
    build_expr_engine for the compile step."""
    engine, _strategy = build_expr_engine(
        req, candles, htf_candles, overrides, long_risk, short_risk)
    return engine.run(candles, start_index=start_index)


# --- parameter/risk sweep combo application ----------------------------------

_RISK_TARGET = re.compile(r"^risk:(long|short)\.(stop|target)\.(value|mult)$")
# Expression-literal sweep target: lit:<side>.<entry|exit>.<rowIdx>.<ordinal>.
# rowIdx addresses the FULL group row list (disabled rows included), matching
# the structured rule:/op: convention and _compile_group's enumerate; ordinal is
# the literal position from expr.literals.literals(). Emitted by the frontend's
# Task 12 sweepLiteralTarget. Applied against the expression request only.
_LIT_TARGET = re.compile(r"^lit:(long|short)\.(entry|exit)\.(\d+)\.(\d+)$")


def apply_combo(
    req: BacktestRequest, combo: dict,
) -> tuple[dict, RiskConfigDTO | None, RiskConfigDTO | None]:
    """Split one combo into codedParams overrides + patched risk DTOs.
    Raises SweepValidationError(422) on a malformed target key."""
    # ExprBacktestRequest carries no codedParams; getattr keeps this helper usable
    # by the expr sweep branch (which passes only risk: keys) without a change to
    # the structured BacktestRequest behavior.
    params = dict(getattr(req, "codedParams", None) or {})
    risks = {"long": req.longRisk, "short": req.shortRisk}
    for target, value in combo.items():
        if target.startswith("param:"):
            name = target[len("param:"):]
            if not name.isidentifier():
                raise SweepValidationError(422, f"bad sweep target '{target}'")
            params[name] = value
            continue
        m = _RISK_TARGET.match(target)
        if not m:
            raise SweepValidationError(422, f"bad sweep target '{target}'")
        side, spec_name, field = m.groups()
        risk = risks[side]
        if risk is None:
            raise SweepValidationError(422, f"sweep target '{target}' but no {side} risk configured")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise SweepValidationError(422, f"sweep target '{target}' needs a numeric value")
        spec = getattr(risk, spec_name).model_copy(update={field: float(value)})
        risks[side] = risk.model_copy(update={spec_name: spec})
    return params, risks["long"], risks["short"]


def apply_lit_combo(
    req: ExprBacktestRequest, combo: dict,
) -> dict[tuple[str, str, int], N.Row]:
    """Parse + substitute every expression row a `lit:` target addresses.

    Target form `lit:<side>.<entry|exit>.<rowIdx>.<ordinal>`: locate the addressed
    expression row (side/group by full-list rowIdx), parse its expr, and
    `substitute` the combo value into the literal at `ordinal`. Multiple `lit:`
    targets on the same row are merged into one substitute pass. Returns a map
    {(side, group, rowIdx): substituted AST} for the addressed rows only; non-
    `lit:` keys are ignored (risk:/param: are applied separately).

    422s a malformed key, an out-of-range rowIdx, a non-numeric value, or a row
    whose expr fails to parse, so a stale axis can't silently no-op.

    Stage B ships the addressing + substitution as a standalone, testable unit.
    Stage C wires it into an expr sweep run: it must parse the un-addressed
    enabled rows itself, merge this override map in, then compile every row
    (compile_row) into an ExprRuleStrategy for the combo, with risk:/param:
    handled as they are today.
    """
    group_map: dict[tuple[str, str], list] = {
        ("long", "entry"): req.longEntry,
        ("long", "exit"): req.longExit,
        ("short", "entry"): req.shortEntry,
        ("short", "exit"): req.shortExit,
    }
    overrides: dict[tuple[str, str, int], dict[int, float]] = {}
    for target, value in combo.items():
        if not target.startswith("lit:"):
            continue
        m = _LIT_TARGET.match(target)
        if not m:
            raise SweepValidationError(422, f"bad sweep target '{target}'")
        side, grp, idx_s, ord_s = m.groups()
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise SweepValidationError(422, f"sweep target '{target}' needs a numeric value")
        rows = group_map[(side, grp)]
        idx = int(idx_s)
        if idx >= len(rows):
            raise SweepValidationError(422, f"sweep target '{target}' index out of range")
        overrides.setdefault((side, grp, idx), {})[int(ord_s)] = float(value)

    out: dict[tuple[str, str, int], N.Row] = {}
    for (side, grp, idx), ov in overrides.items():
        try:
            node = parse(group_map[(side, grp)][idx].expr)
        except ExprError as e:
            raise SweepValidationError(
                422, f"sweep target 'lit:{side}.{grp}.{idx}' expr parse error: {e.message}")
        out[(side, grp, idx)] = substitute(node, ov)
    return out


# Environment combo keys: they change the RUN's candle window / session mask
# rather than a strategy knob, so they're split off and applied to the request
# + candle list before the per-combo strategy patch (apply_combo) runs.
# Shared by the coded and expr sweep branches.
_ENV_PREFIXES = ("period:", "timeWindow:")
_ENV_KEYS = {"period:from", "period:to",
             "timeWindow:startMin", "timeWindow:endMin", "timeWindow:tz"}


def split_env_combo(combo: dict) -> tuple[dict, dict]:
    env = {k: v for k, v in combo.items() if k.startswith(_ENV_PREFIXES)}
    rest = {k: v for k, v in combo.items() if not k.startswith(_ENV_PREFIXES)}
    return env, rest


def apply_env_combo(
    req: BacktestRequest, candles: list[Candle], env: dict,
) -> tuple[BacktestRequest, list[Candle]]:
    """Apply period/timeWindow keys. period: gates entries at period:from
    (tradeFromTime) and truncates candles to time <= period:to. Truncation
    only cuts the END, so the result is a PREFIX of the posted candles: the
    warm-up head survives, native series recompute correctly, and the
    browser-supplied chart-operand series (full-length, positional) stay
    index-aligned without slicing (the engine never reads past the candle
    count). timeWindow: patches the mask's timeOfDay + tz, synthesizing an
    enabled all-days mask when the request has none. Malformed keys 422 (a
    request-shaped problem fails the whole chunk)."""
    if not env:
        return req, candles
    unknown = set(env) - _ENV_KEYS
    if unknown:
        raise SweepValidationError(422, f"bad sweep target '{sorted(unknown)[0]}'")
    updates: dict = {}
    if any(k.startswith("timeWindow:") for k in env):
        try:
            start = int(env["timeWindow:startMin"])
            end = int(env["timeWindow:endMin"])
        except (KeyError, TypeError, ValueError):
            raise SweepValidationError(422, "timeWindow sweep needs integer startMin and endMin")
        base = req.mask or RecurrenceMaskDTO(enabled=True)
        tz = env.get("timeWindow:tz", base.tz)
        try:
            ZoneInfo(str(tz))
        except Exception:
            raise SweepValidationError(422, f"unknown timezone '{tz}'")
        # model_copy skips validators, so tz was checked explicitly above.
        updates["mask"] = base.model_copy(update={
            "enabled": True,
            "timeOfDay": DayTimeWindowDTO(startMin=start, endMin=end),
            "tz": str(tz),
        })
    if any(k.startswith("period:") for k in env):
        try:
            from_s = int(env["period:from"])
            to_s = int(env["period:to"])
        except (KeyError, TypeError, ValueError):
            raise SweepValidationError(422, "period sweep needs integer from and to")
        if to_s <= from_s:
            raise SweepValidationError(422, "period sweep 'to' must be after 'from'")
        updates["tradeFromTime"] = from_s
        # Candle.time is a tz-aware datetime (period:to arrives as unix seconds).
        candles = [c for c in candles if c.time.timestamp() <= to_s]
    return (req.model_copy(update=updates) if updates else req), candles


def sweep_row(req: BacktestRequest, combo: dict, result) -> SweepRowDTO:
    """Success row for one combo: the standard sweep metrics, plus per-window
    robustness slices when the request carries sweep.windows. A combo that
    patches its own period runs over a different range than the sweep's
    windows, so it gets none (windows stay None, no aggregate keys)."""
    metrics = compute_metrics(result.trades, result.equity, result.net_pnl,
                              req.costs.startingCash, resolution_seconds(req.resolution),
                              financing_total=result.financing_total)
    row_metrics = {
        "net_pnl": round(result.net_pnl, 5),
        "n_trades": result.n_trades,
        "win_rate": round(result.win_rate, 4),
        "max_drawdown": round(result.max_drawdown, 5),
        "profit_factor": metrics.get("profit_factor"),
        "avg_win_loss_ratio": metrics.get("avg_win_loss_ratio"),
        "return_pct": metrics.get("return_pct"),
        "sharpe": metrics.get("sharpe"),
        "sqn": metrics.get("sqn"),
    }
    windows = None
    if req.sweep.windows is not None and "period:from" not in combo:
        windows, agg = window_metrics(result.trades, req.sweep.windows)
        row_metrics.update(agg)
    return SweepRowDTO(combo=combo, metrics=row_metrics, windows=windows)

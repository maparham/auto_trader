"""Per-combo request patching + synchronous engine-run cores.

Importable by worker processes: no FastAPI app/deps imports, no network.
The router owns HTF fetching and wraps SweepValidationError into HTTPException.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from types import ModuleType
from zoneinfo import ZoneInfo

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine, BacktestResult
from auto_trader.engine.metrics import compute_metrics, window_metrics
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
from auto_trader.strategy.expr.validate import validate

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
    """A coded run referenced a timeframe not present in htf_candles. The
    router's async wrapper fetches it and calls run_coded_sync again; workers
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


def _compile_expr_exits(rows, candles, resolution, htf):
    """Parse+validate+compile enabled, non-blank expression exit rows. Isolation:
    a parse/validate problem raises SweepValidationError(422) so one sweep combo
    fails to its own error row (matches run_expr_sync)."""
    compiled = []
    for row in rows:
        if not row.enabled or not row.expr.strip():
            continue
        try:
            node = parse(row.expr)
            validate(node, is_exit=True)
        except ExprError as e:
            raise SweepValidationError(422, e.message)
        compiled.append(compile_row(node, candles, resolution, htf))
    return compiled


def run_coded_sync(
    req: BacktestRequest, candles: list[Candle], module: ModuleType,
    resolved_params: dict, long_risk_dto: RiskConfigDTO | None,
    short_risk_dto: RiskConfigDTO | None, htf_candles: dict[str, list[Candle]],
    indicator_cache: dict | None = None,
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
    for _ in range(_MAX_TF_PASSES):
        strategy: Strategy = CodedStrategy(
            module, candles, quantity=req.costs.quantity,
            trade_from_time=req.tradeFromTime, htf_candles=htf_candles,
            base_timeframe=req.resolution, params=resolved_params,
            panel_risk_legs=panel_risk_legs,
            indicator_cache=indicator_cache,
        )
        long_exit = _compile_expr_exits(req.exprLongExit, candles, req.resolution, htf_candles)
        short_exit = _compile_expr_exits(req.exprShortExit, candles, req.resolution, htf_candles)
        if long_exit or short_exit:
            strategy = CodedWithExprExits(strategy, ExprRuleStrategy(
                [], long_exit, [], short_exit,
                quantity=req.costs.quantity,
                long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
            ))
        engine = BacktestEngine(
            strategy,
            starting_cash=req.costs.startingCash,
            commission_per_side=req.costs.commissionPerSide,
            slippage=req.costs.slippage.value,
            slippage_atr_mult=req.costs.slippage.atrMult if req.costs.slippage.kind == "atr" else 0.0,
            spread=req.costs.spread,
            fin_long_daily_pct=req.costs.finLongDailyPct,
            fin_short_daily_pct=req.costs.finShortDailyPct,
            long_risk=long_risk_dto.to_risk() if long_risk_dto else None,
            short_risk=short_risk_dto.to_risk() if short_risk_dto else None,
            long_scaling=req.longScaling.to_scaling() if req.longScaling else None,
            short_scaling=req.shortScaling.to_scaling() if req.shortScaling else None,
            series=req.series,
            mask=req.mask.to_mask() if req.mask else None,
        )
        try:
            result = engine.run(candles)
            return result, strategy
        except NeedTimeframe as need:
            if need.timeframe not in htf_candles:
                raise TimeframeNotPrefetched(need.timeframe)
            # Already present but still raised: retry locally (defensive).
    raise SweepValidationError(422, "strategy needs too many timeframes (max 5)")


def run_expr_sync(
    req: ExprBacktestRequest, candles: list[Candle],
    htf_candles: dict[str, list[Candle]],
    overrides: dict[tuple[str, str, int], "N.Compare | N.Cross"],
    long_risk: RiskConfigDTO | None, short_risk: RiskConfigDTO | None,
) -> BacktestResult:
    """One expression engine run for a sweep combo. `overrides` maps
    (side, group, rowIdx) -> an already-substituted AST node (from
    apply_lit_combo); rows NOT in overrides are parsed+validated+compiled fresh.
    `long_risk`/`short_risk` are the combo-patched risk DTOs (mirroring
    run_coded_sync's explicit risk params). Mirrors expr_backtest's engine config
    with series={}. Raises SweepValidationError(422) on a parse/validate problem
    or unsupported ATR risk so a combo isolates to its error row."""
    # I4 (expr): the expr surface runs the engine with series={} and cannot
    # populate an ATR_{length} risk series, so an ATR stop/target would run
    # stop-less. Fail loud, mirroring expr_backtest's guard. Check the combo's
    # patched risk DTOs (risk: targets can't change kind, so this matches req).
    for risk in (long_risk, short_risk):
        if risk is not None and risk.atr_series_names():
            raise SweepValidationError(
                422,
                "ATR-based risk stops are not available for expression "
                "backtests in this version.",
            )
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
                validate(node, is_exit=is_exit)
            except ExprError as e:
                raise SweepValidationError(422, e.message)
            compiled.append(compile_row(node, candles, req.resolution, htf_candles))
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
        series={},
        mask=req.mask.to_mask() if req.mask else None,
        inspect=req.inspect,
    )
    return engine.run(candles)


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
) -> dict[tuple[str, str, int], N.Compare | N.Cross]:
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

    out: dict[tuple[str, str, int], N.Compare | N.Cross] = {}
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

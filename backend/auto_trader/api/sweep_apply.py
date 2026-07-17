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
    CodedWithRuleExits,
    NeedTimeframe,
)
from auto_trader.strategy.rule import RuleStrategy, series_name
from auto_trader.strategy.rule_series import build_rule_series

from .schemas import (
    BacktestRequest,
    CandleDTO,
    DayTimeWindowDTO,
    RecurrenceMaskDTO,
    RiskConfigDTO,
    RuleGroupDTO,
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


def _rule_operands(req: BacktestRequest) -> list:
    ops = []
    for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
        ops += [o.to_operand() for o in group.operands()]
    return ops


def _rule_atr_lengths(req: BacktestRequest) -> list[int]:
    lengths: list[int] = []
    for cfg in (req.longRisk, req.shortRisk, req.longScaling, req.shortScaling):
        if cfg is None:
            continue
        for name in cfg.atr_series_names():
            lengths.append(int(name.split("_")[1]))
    return lengths


def assemble_rule_series_sync(
    req: BacktestRequest, candles: list[Candle],
    htf_candles: dict[str, list[Candle]],
) -> dict[str, list[float | None]]:
    """Backend-owned rule series: recompute native indicators from `candles`,
    align the (already fetched) higher timeframes, and merge in the
    browser-supplied chart-operand series (kind='series', which cannot be
    recomputed server-side). On a native/chart-operand key collision the
    recomputed value wins.

    `htf_candles` is required and used as-is (no fetch): the router owns the
    fetch and passes the full set in."""
    ops = _rule_operands(req)
    computed = build_rule_series(ops, candles, req.resolution, htf_candles, _rule_atr_lengths(req))
    # Chart-operand/drawing series stay browser-supplied; native keys recompute.
    chart_series = {
        series_name(o.to_operand()): req.series.get(series_name(o.to_operand()))
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit)
        for o in group.operands()
        if o.kind == "series"
    }
    return {**{k: v for k, v in chart_series.items() if v is not None}, **computed}


def run_rule_sync(
    req: BacktestRequest, candles: list[Candle],
    htf_candles: dict[str, list[Candle]],
) -> BacktestResult:
    """Backend-recomputed rule run used by both the single-run /api/backtest
    route and the sweep. `htf_candles` is the pre-fetched, combo-shared dict
    (the router owns the fetch)."""
    series = assemble_rule_series_sync(req, candles, htf_candles)
    strategy = RuleStrategy(
        req.longEntry.to_group(), req.longExit.to_group(),
        req.shortEntry.to_group(), req.shortExit.to_group(),
        series, quantity=req.costs.quantity, trade_from_time=req.tradeFromTime,
        long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
        base_timeframe=req.resolution,
    )
    engine = BacktestEngine(
        strategy,
        starting_cash=req.costs.startingCash,
        commission_per_side=req.costs.commissionPerSide,
        slippage=req.costs.slippage.value,
        slippage_atr_mult=req.costs.slippage.atrMult if req.costs.slippage.kind == "atr" else 0.0,
        spread=req.costs.spread,
        fin_long_daily_pct=req.costs.finLongDailyPct,
        fin_short_daily_pct=req.costs.finShortDailyPct,
        long_risk=req.longRisk.to_risk() if req.longRisk else None,
        short_risk=req.shortRisk.to_risk() if req.shortRisk else None,
        long_scaling=req.longScaling.to_scaling() if req.longScaling else None,
        short_scaling=req.shortScaling.to_scaling() if req.shortScaling else None,
        series=series,
        mask=req.mask.to_mask() if req.mask else None,
        inspect=req.inspect,
    )
    return engine.run(candles)


def run_coded_sync(
    req: BacktestRequest, candles: list[Candle], module: ModuleType,
    resolved_params: dict, long_risk_dto: RiskConfigDTO | None,
    short_risk_dto: RiskConfigDTO | None, htf_candles: dict[str, list[Candle]],
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
        )
        if req.longExit.rules or req.shortExit.rules:
            empty = RuleGroupDTO(combine="AND", rules=[]).to_group()
            strategy = CodedWithRuleExits(strategy, RuleStrategy(
                empty, req.longExit.to_group(), empty, req.shortExit.to_group(),
                req.series, quantity=req.costs.quantity,
                long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
                base_timeframe=req.resolution,
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


# --- parameter/risk sweep combo application ----------------------------------

_RISK_TARGET = re.compile(r"^risk:(long|short)\.(stop|target)\.(value|mult)$")
_RULE_TARGET = re.compile(
    r"^rule:(long|short)\.(entry|exit)\.(\d+)\.(?:(left|right)\.(length|value)|(count))$"
)
_OP_TARGET = re.compile(r"^op:(long|short)\.(entry|exit)\.(\d+)$")
# RuleDTO.op's Literal set. model_copy(update=...) skips pydantic validation,
# so membership is checked explicitly before the patch.
_OPERATORS = {"crossesAbove", "crossesBelow", "crosses", "gt", "lt", "gte", "lte"}


def apply_combo(
    req: BacktestRequest, combo: dict,
) -> tuple[dict, RiskConfigDTO | None, RiskConfigDTO | None]:
    """Split one combo into codedParams overrides + patched risk DTOs.
    Raises SweepValidationError(422) on a malformed target key."""
    params = dict(req.codedParams or {})
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


def apply_rule_combo(req: BacktestRequest, combo: dict) -> BacktestRequest:
    """Return a copy of `req` with each combo target patched into the rule tree /
    risk DTO. Reuses `apply_combo` for `risk:` keys. Handles `op:` operator patches.
    422s a malformed or out-of-range path so a stale axis can't silently no-op."""
    groups = {
        ("long", "entry"): [r.model_copy(deep=True) for r in req.longEntry.rules],
        ("long", "exit"): [r.model_copy(deep=True) for r in req.longExit.rules],
        ("short", "entry"): [r.model_copy(deep=True) for r in req.shortEntry.rules],
        ("short", "exit"): [r.model_copy(deep=True) for r in req.shortExit.rules],
    }
    risk_combo: dict = {}
    for target, value in combo.items():
        if target.startswith("risk:"):
            risk_combo[target] = value
            continue
        m = _OP_TARGET.match(target)
        if m:
            side, grp, idx_s = m.groups()
            rules = groups[(side, grp)]
            idx = int(idx_s)
            if idx >= len(rules):
                raise SweepValidationError(422, f"sweep target '{target}' index out of range")
            if value not in _OPERATORS:
                raise SweepValidationError(
                    422, f"sweep target '{target}' needs one of {sorted(_OPERATORS)}")
            rules[idx] = rules[idx].model_copy(update={"op": value})
            continue
        m = _RULE_TARGET.match(target)
        if not m:
            raise SweepValidationError(422, f"bad sweep target '{target}'")
        side, grp, idx_s, operand, field, count = m.groups()
        rules = groups[(side, grp)]
        idx = int(idx_s)
        if idx >= len(rules):
            raise SweepValidationError(422, f"sweep target '{target}' index out of range")
        rule = rules[idx]
        if count:
            rules[idx] = rule.model_copy(update={"count": int(value)})
        else:
            op = getattr(rule, operand)
            rules[idx] = rule.model_copy(update={
                operand: op.model_copy(update={field: value})})
    _, long_risk, short_risk = apply_combo(req, risk_combo)  # risk-only combo
    return req.model_copy(update={
        "longEntry": req.longEntry.model_copy(update={"rules": groups[("long", "entry")]}),
        "longExit": req.longExit.model_copy(update={"rules": groups[("long", "exit")]}),
        "shortEntry": req.shortEntry.model_copy(update={"rules": groups[("short", "entry")]}),
        "shortExit": req.shortExit.model_copy(update={"rules": groups[("short", "exit")]}),
        "longRisk": long_risk, "shortRisk": short_risk,
    })


# Environment combo keys: they change the RUN's candle window / session mask
# rather than a strategy knob, so they're split off and applied to the request
# + candle list before the per-combo strategy patch (apply_rule_combo /
# apply_combo) runs. Shared by the rule and coded sweep branches.
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

"""The rule-based backtest route."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from types import ModuleType

from fastapi import APIRouter, HTTPException

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine, BacktestResult
from auto_trader.engine.metrics import compute_metrics
from auto_trader.strategy import loader
from auto_trader.strategy.coded import (
    CodedStrategy,
    CodedWithRuleExits,
    NeedTimeframe,
    StrategyRuntimeError,
)
from auto_trader.strategy.loader import StrategyLoadError
from auto_trader.strategy.base import Strategy
from auto_trader.strategy.params import resolve_params, validate_params_schema
from auto_trader.strategy.rule import RuleStrategy, series_name

from .. import deps
from ..schemas import (
    BacktestRequest,
    BacktestResponse,
    CandleDTO,
    EquityDTO,
    MarkerDTO,
    RiskConfigDTO,
    RuleGroupDTO,
    SweepResponse,
    SweepRowDTO,
    TermDTO,
    TradeDTO,
)
from .charts import _ts

# Cap on fetch-retry passes for a coded strategy's ad-hoc tf= calls (Task 15):
# each pass discovers at most one new timeframe, so this bounds how many
# distinct timeframes a single run may reference before we give up.
_MAX_TF_PASSES = 5

# Extra HTF bars to fetch BEFORE the base window's start so ad-hoc tf= indicators
# warm up. Without it an HTF EMA/SMA seeds from the first in-window bar and reports
# a wrong (but non-None) value — silently diverging from the chart and from the
# same strategy in a longer-windowed run. Generous enough to converge any
# reasonable length; the align step still gates each HTF bar to its close (no
# lookahead), so over-fetching older bars only helps warm-up, never leaks future.
_HTF_WARMUP_BARS = 300

router = APIRouter()


def _candle_from_dto(c: CandleDTO) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(c.time, tz=timezone.utc),
        open=c.open, high=c.high, low=c.low, close=c.close, volume=c.volume,
    )


async def _run_coded(
    req: BacktestRequest, candles: list[Candle], module: ModuleType,
    resolved_params: dict, long_risk_dto: RiskConfigDTO | None,
    short_risk_dto: RiskConfigDTO | None, htf_candles: dict[str, list[Candle]],
) -> tuple[BacktestResult, Strategy]:
    """One coded engine run: NeedTimeframe retry included; risk DTOs are
    passed explicitly (the sweep patches them per combo). Mutates htf_candles
    so repeat combos skip the fetch. A `StrategyRuntimeError` from the strategy
    itself is NOT caught here — it propagates so callers can choose how to
    surface it (a single request 422s; a sweep isolates it to one row)."""
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
            slippage=req.costs.slippage,
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
            warmup_from = (
                req.candles[0].time
                - _HTF_WARMUP_BARS * resolution_seconds(need.timeframe)
            )
            fetched = await deps._fetch_symbol_candles(
                req.broker, req.epic, need.timeframe, 1000,
                warmup_from, req.candles[-1].time, req.priceSide,
            )
            if not fetched:
                raise HTTPException(
                    422, f"no candles for timeframe '{need.timeframe}'"
                )
            htf_candles[need.timeframe] = fetched
    raise HTTPException(422, "strategy needs too many timeframes (max 5)")


def _validate_coded_exit_series(req: BacktestRequest) -> None:
    """Coded run: series-shaped checks a pure rule run gets, mirrored here
    because coded runs skip the rule-mode validation block entirely (coded
    ignores the entry groups; only panel exit rules + panel risk apply).
    Covers: exit-rule-group series (length + missing-series — without the
    length check, RuleStrategy silently reads None past the array end instead
    of 422ing) and ATR-kind panel risk's missing-series guard (I4 — without
    this, a missing ATR series silently yields a stop-less trade instead of
    the 422 rule mode gets). Runs whenever codedStrategy is set, not only when
    exit rules exist. Shared by the single-run and sweep routes."""
    for name, arr in req.series.items():
        if len(arr) != len(req.candles):
            raise HTTPException(
                422, f"series '{name}' length {len(arr)} != candles length {len(req.candles)}"
            )
    for group in (req.longExit, req.shortExit):
        for op in group.operands():
            name = series_name(op.to_operand())
            if name is not None and name not in req.series:
                raise HTTPException(422, f"missing series '{name}' referenced by a rule")
    for risk in (req.longRisk, req.shortRisk):
        if risk is None:
            continue
        for name in risk.atr_series_names():
            if name not in req.series:
                raise HTTPException(422, f"missing series '{name}' referenced by a stop/target")


@router.post("/api/backtest", response_model=BacktestResponse)
async def backtest(req: BacktestRequest) -> BacktestResponse:
    """No broker call (D1): the request carries the exact candles the series were
    computed on, so re-fetching (which can shift by one forming bar) can't
    silently misalign series and candles. Indicators warm up over the full
    posted `candles`, but only bars at/after `tradeFromTime` are tradeable or
    returned (D6) — that split is what lets a long indicator be fully warm on
    the trading window's first bar."""
    if not req.candles:
        raise HTTPException(422, "candles must not be empty")

    if req.codedStrategy is None:
        for name, arr in req.series.items():
            if len(arr) != len(req.candles):
                raise HTTPException(
                    422, f"series '{name}' length {len(arr)} != candles length {len(req.candles)}"
                )

        # D4: re-derive each referenced operand's series name and make sure it's
        # actually in the payload (price/const operands have no series to check).
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
            for op in group.operands():
                name = series_name(op.to_operand())
                if name is not None and name not in req.series:
                    raise HTTPException(422, f"missing series '{name}' referenced by a rule")

        # Stop/target ATR sizing reads the same posted-series channel as rules do.
        for risk in (req.longRisk, req.shortRisk):
            if risk is None:
                continue
            for name in risk.atr_series_names():
                if name not in req.series:
                    raise HTTPException(422, f"missing series '{name}' referenced by a stop/target")

        # Scaling spacing ATR sizing reads the same posted-series channel as risk does.
        for cfg in (req.longScaling, req.shortScaling):
            if cfg is None:
                continue
            for name in cfg.atr_series_names():
                if name not in req.series:
                    raise HTTPException(422, f"missing series '{name}' referenced by spacing")
    elif req.codedStrategy is not None:
        _validate_coded_exit_series(req)

    candles = [_candle_from_dto(c) for c in req.candles]
    if req.codedStrategy is not None:
        try:
            module = loader.load_strategy(req.codedStrategy, loader.STRATEGIES_DIR)
        except StrategyLoadError as e:
            raise HTTPException(422, str(e))
        try:
            resolved_params = resolve_params(module, req.codedParams)
        except ValueError as e:
            raise HTTPException(422, str(e))
        htf_candles: dict[str, list[Candle]] = {}
        try:
            result, strategy = await _run_coded(
                req, candles, module, resolved_params, req.longRisk, req.shortRisk, htf_candles,
            )
        except StrategyRuntimeError as e:
            raise HTTPException(422, str(e))
    else:
        strategy = RuleStrategy(
            req.longEntry.to_group(), req.longExit.to_group(),
            req.shortEntry.to_group(), req.shortExit.to_group(),
            req.series, quantity=req.costs.quantity, trade_from_time=req.tradeFromTime,
            long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
            base_timeframe=req.resolution,
        )
        engine = BacktestEngine(
            strategy,
            starting_cash=req.costs.startingCash,
            commission_per_side=req.costs.commissionPerSide,
            slippage=req.costs.slippage,
            long_risk=req.longRisk.to_risk() if req.longRisk else None,
            short_risk=req.shortRisk.to_risk() if req.shortRisk else None,
            long_scaling=req.longScaling.to_scaling() if req.longScaling else None,
            short_scaling=req.shortScaling.to_scaling() if req.shortScaling else None,
            series=req.series,
            mask=req.mask.to_mask() if req.mask else None,
        )
        try:
            result = engine.run(candles)
        except StrategyRuntimeError as e:
            raise HTTPException(422, str(e))

    # Fills/trades need no >= tradeFromTime filter here: RuleStrategy gates every
    # entry to tradeFromTime-or-later (rule.py), a fill only lands on a LATER
    # bar's open, and an exit can only follow a gated entry — so every fill and
    # trade already satisfies the window by construction. Equity is the one
    # collection that isn't: the engine appends a point for every bar, including
    # warm-up, so it's the only result that still needs trimming here.
    window = [c for c in req.candles if c.time >= req.tradeFromTime]
    return BacktestResponse(
        epic=req.epic,
        resolution=req.resolution,
        candles=window,
        markers=[
            MarkerDTO(
                time=_ts(f.time), side=f.side.value, price=f.price, reason=f.reason, leg=f.leg,
                signal_time=_ts(f.signal_time) if f.signal_time is not None else None,
                terms=[
                    TermDTO(
                        left=t.left_label, lval=t.left_val, op=t.op,
                        right=t.right_label, rval=t.right_val,
                        leftTf=t.left_tf, rightTf=t.right_tf,
                    )
                    for t in f.terms
                ],
                combine=f.combine,
            )
            for f in result.fills
        ],
        trades=[
            TradeDTO(
                side=t.side.value,
                quantity=t.quantity,
                entry_time=_ts(t.entry_time),
                entry_price=t.entry_price,
                exit_time=_ts(t.exit_time),
                exit_price=t.exit_price,
                pnl=t.pnl,
                leg=t.leg,
                reason=t.reason_out,
                stop_initial=t.stop_initial,
                stop_final=t.stop_final,
                target=t.target,
            )
            for t in result.trades
        ],
        equity=[
            EquityDTO(time=_ts(p.time), value=p.equity)
            for p in result.equity
            if _ts(p.time) >= req.tradeFromTime
        ],
        summary=result.summary(),
        metrics=compute_metrics(
            result.trades, result.equity, result.net_pnl,
            req.costs.startingCash, resolution_seconds(req.resolution),
        ),
        fileBracketsOverridden=(
            strategy.file_brackets_overridden if req.codedStrategy is not None else False
        ),
    )


# --- parameter/risk sweep: N coded runs sharing one HTF fetch cache ----------

_SWEEP_MAX_COMBOS = 50
_RISK_TARGET = re.compile(r"^risk:(long|short)\.(stop|target)\.(value|mult)$")


def _apply_combo(
    req: BacktestRequest, combo: dict,
) -> tuple[dict, RiskConfigDTO | None, RiskConfigDTO | None]:
    """Split one combo into codedParams overrides + patched risk DTOs.
    Raises HTTPException(422) on a malformed target key."""
    params = dict(req.codedParams or {})
    risks = {"long": req.longRisk, "short": req.shortRisk}
    for target, value in combo.items():
        if target.startswith("param:"):
            name = target[len("param:"):]
            if not name.isidentifier():
                raise HTTPException(422, f"bad sweep target '{target}'")
            params[name] = value
            continue
        m = _RISK_TARGET.match(target)
        if not m:
            raise HTTPException(422, f"bad sweep target '{target}'")
        side, spec_name, field = m.groups()
        risk = risks[side]
        if risk is None:
            raise HTTPException(422, f"sweep target '{target}' but no {side} risk configured")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise HTTPException(422, f"sweep target '{target}' needs a numeric value")
        spec = getattr(risk, spec_name).model_copy(update={field: float(value)})
        risks[side] = risk.model_copy(update={spec_name: spec})
    return params, risks["long"], risks["short"]


@router.post("/api/backtest/sweep", response_model=SweepResponse)
async def backtest_sweep(req: BacktestRequest) -> SweepResponse:
    if req.sweep is None or not req.sweep.combos:
        raise HTTPException(422, "sweep.combos is required")
    if len(req.sweep.combos) > _SWEEP_MAX_COMBOS:
        raise HTTPException(422, f"too many combos in one request (max {_SWEEP_MAX_COMBOS})")
    if req.codedStrategy is None:
        raise HTTPException(422, "sweep requires a coded strategy")
    _validate_coded_exit_series(req)
    try:
        module = loader.load_strategy(req.codedStrategy, loader.STRATEGIES_DIR)
    except StrategyLoadError as e:
        raise HTTPException(422, str(e))
    # A sweep TARGET over an undeclared param must 422, not silently no-op:
    # resolve_params drops unknown keys by design (stale baseline codedParams
    # after a file edit are tolerated), but a swept axis whose param no longer
    # exists would return N identical default-valued rows with no error.
    meta = getattr(module, "meta", None)
    declared = {p["name"] for p in validate_params_schema(meta if isinstance(meta, dict) else None)}
    for combo in req.sweep.combos:
        for target in combo:
            if target.startswith("param:") and target[len("param:"):] not in declared:
                raise HTTPException(
                    422, f"sweep target '{target}' names a param the strategy does not declare")
    candles = [_candle_from_dto(c) for c in req.candles]
    htf_candles: dict[str, list[Candle]] = {}     # shared across every combo
    rows: list[SweepRowDTO] = []
    for combo in req.sweep.combos:
        params_sent, long_risk, short_risk = _apply_combo(req, combo)
        try:
            resolved = resolve_params(module, params_sent)
            result, _ = await _run_coded(
                req, candles, module, resolved, long_risk, short_risk, htf_candles,
            )
        except HTTPException:
            raise                                  # request-shaped problems fail the chunk
        except Exception as e:                     # noqa: BLE001 — one combo must not kill the rest
            rows.append(SweepRowDTO(combo=combo, error=str(e)))
            continue
        metrics = compute_metrics(result.trades, result.equity, result.net_pnl,
                                  req.costs.startingCash, resolution_seconds(req.resolution))
        rows.append(SweepRowDTO(combo=combo, metrics={
            "net_pnl": round(result.net_pnl, 5),
            "n_trades": result.n_trades,
            "win_rate": round(result.win_rate, 4),
            "max_drawdown": round(result.max_drawdown, 5),
            "profit_factor": metrics.get("profit_factor"),
            "return_pct": metrics.get("return_pct"),
        }))
    return SweepResponse(rows=rows)

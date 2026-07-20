"""The expression backtest surface: /api/expr/{backtest,series,literals}.

Parallel to the structured /api/backtest. Requests carry raw expression strings;
this router parses/validates/compiles them, runs the shared BacktestEngine, and
serializes with the same `_result_to_response` the structured handler uses.
Parse/validation problems return HTTP 422 with the expression span so the editor
can underline the offending characters.
"""

from __future__ import annotations

import dataclasses

from fastapi import APIRouter, HTTPException

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.evaluate import compile_row, series_of
from auto_trader.strategy.expr.literals import literals as compute_literals
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.strategy import ExprRuleStrategy
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars

from .. import deps
from ..schemas import (
    ExprBacktestRequest,
    ExprLiteralsRequest,
    ExprSeriesRequest,
)
from ..sweep_apply import candle_from_dto

router = APIRouter()


def _compile_group(rows, candles, resolution, htf, *, is_exit: bool, group: str):
    """Parse + validate + compile every ENABLED row in a group. A parse/validate
    error 422s with the expression span plus the group/row location so the
    frontend can map it back to the offending editor field. Disabled rows are
    dropped before parse (a parked, possibly-invalid draft never blocks a run)."""
    compiled = []
    for idx, row in enumerate(rows):
        if not row.enabled:
            continue
        try:
            node = parse(row.expr)
            validate(node, is_exit=is_exit)
        except ExprError as e:
            raise HTTPException(422, {
                "code": e.code, "message": e.message,
                "start": e.start, "end": e.end, "group": group, "row": idx,
            })
        compiled.append(compile_row(node, candles, resolution, htf))
    return compiled


@router.post("/api/expr/backtest")
async def expr_backtest(req: ExprBacktestRequest):
    if not req.candles:
        raise HTTPException(422, "candles must not be empty")
    # I4 (expr): the expr surface runs the engine with series={} and has no way to
    # populate an ATR_{length} risk series in v1. An ATR-kind stop/target would
    # find no series, _atr_at returns None, and the position runs with no stop —
    # silently. Fail loud instead, mirroring the structured handler's I4 guard.
    for risk in (req.longRisk, req.shortRisk):
        if risk is not None and risk.atr_series_names():
            raise HTTPException(422, {
                "code": "atr_risk_unsupported",
                "message": "ATR-based risk stops are not available for expression "
                           "backtests in this version.",
                "start": None, "end": None, "group": None, "row": None,
            })
    candles = [candle_from_dto(c) for c in req.candles]
    htf: dict[str, list[Candle]] = {
        tf: [candle_from_dto(c) for c in bars]
        for tf, bars in (req.htfCandles or {}).items()
    }
    strategy = ExprRuleStrategy(
        _compile_group(req.longEntry, candles, req.resolution, htf, is_exit=False, group="longEntry"),
        _compile_group(req.longExit, candles, req.resolution, htf, is_exit=True, group="longExit"),
        _compile_group(req.shortEntry, candles, req.resolution, htf, is_exit=False, group="shortEntry"),
        _compile_group(req.shortExit, candles, req.resolution, htf, is_exit=True, group="shortExit"),
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
        long_risk=req.longRisk.to_risk() if req.longRisk else None,
        short_risk=req.shortRisk.to_risk() if req.shortRisk else None,
        long_scaling=req.longScaling.to_scaling() if req.longScaling else None,
        short_scaling=req.shortScaling.to_scaling() if req.shortScaling else None,
        series={},
        mask=req.mask.to_mask() if req.mask else None,
        inspect=req.inspect,
    )
    result = engine.run(candles)
    # Imported lazily to avoid a router import cycle (backtest.py imports many
    # things at module load; expr.py is registered alongside it).
    from ..routers.backtest import _result_to_response
    window = [c for c in req.candles if c.time >= req.tradeFromTime]
    return _result_to_response(
        result,
        epic=req.epic,
        resolution=req.resolution,
        candles_window=window,
        trade_from_time=req.tradeFromTime,
        starting_cash=req.costs.startingCash,
        commission_per_side=req.costs.commissionPerSide,
        inspect=req.inspect,
    )


@router.post("/api/expr/series")
async def expr_series(req: ExprSeriesRequest):
    try:
        node = parse(req.expr)
        validate(node, is_exit=False)
    except ExprError as e:
        raise HTTPException(422, {
            "code": e.code, "message": e.message, "start": e.start, "end": e.end,
        })
    res_s = resolution_seconds(req.resolution)
    bars = max(1, (req.toTime - req.fromTime) // res_s + 2)
    candles = await deps._fetch_symbol_candles(
        req.broker, req.epic, req.resolution, bars, req.fromTime, req.toTime, req.priceSide,
    )
    # Plot the left operand of the comparison (Compare.left / Cross.a): the RHS is
    # usually a constant threshold; the LHS is the indicator/candle series.
    top = node.left if hasattr(node, "left") else node.a
    values = series_of(top, candles, req.resolution, {})
    return {
        "times": [int(c.time.timestamp()) for c in candles],
        "values": values,
        "warmup": warmup_bars(node),
    }


@router.post("/api/expr/literals")
async def expr_literals(req: ExprLiteralsRequest):
    try:
        node = parse(req.expr)
    except ExprError as e:
        return {"literals": [], "error": {
            "code": e.code, "message": e.message, "start": e.start, "end": e.end,
        }}
    return {
        "literals": [dataclasses.asdict(lit) for lit in compute_literals(node)],
        "error": None,
    }

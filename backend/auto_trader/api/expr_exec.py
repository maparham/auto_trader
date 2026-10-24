"""Shared expression compile-and-run pipeline. One implementation serves the
expr route's main run and every baseline run (expr and coded routes both):
whatever the main path executes, a baseline executes identically.

It lives here rather than in `routers/expr.py` so the structured backtest router
can import it without a router-to-router cycle. The @tf candle sourcing is
htf_source.py; `_ensure_htf` here is the backtest-flavoured wrapper (shipped
candles win, sufficiency judged at the trading window) that the expr router
imports back for its sweep/WFO submit paths.
"""

from __future__ import annotations

import asyncio
from typing import Callable

from fastapi import HTTPException

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine, BacktestResult
from auto_trader.engine.metrics import compute_metrics
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.lines import LineSpecError
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.strategy import ExprRuleStrategy
from auto_trader.strategy.expr.validate import validate

from .line_rebase import rebase_request_lines
from .risk_series import (
    AtrWarmupError,
    build_atr_risk_series,
    first_tradeable_index,
)
from .schemas import ExprBacktestRequest
from .sweep_apply import (
    candle_from_dto,
    request_instances,
)


def _parse_group(rows, *, is_exit: bool, group: str, instances=None) -> list[tuple[N.Row, str]]:
    """Parse + validate every ENABLED row in a group, returning (node, source)
    pairs — the source text feeds compile_row so fills can label their captured
    terms (node spans index into it). A parse/validate error 422s with the
    expression span plus the group/row location so the frontend can map it back
    to the offending editor field. Disabled rows and blank rows are dropped
    before parse (a parked or empty draft never blocks a run; an empty
    placeholder row is not a rule). Split from compilation so the route can
    collect the rows' @tf references and fetch those candles BEFORE compiling
    (compile_row precomputes series eagerly, so htf must be complete by then)."""
    nodes = []
    for idx, row in enumerate(rows):
        if not row.enabled or not row.expr.strip():
            continue
        try:
            node = parse(row.expr)
            validate(node, is_exit=is_exit, instances=instances)
        except ExprError as e:
            raise HTTPException(422, {
                "code": e.code, "message": e.message,
                "start": e.start, "end": e.end, "group": group, "row": idx,
            })
        nodes.append((node, row.expr))
    return nodes


# Re-exported: routers/expr.py and the tests import these from here.
from .htf_source import HtfShortfall, _tf_inner_warmup, _tf_span, source_htf  # noqa: E402,F401


async def _ensure_htf(
    nodes: list[N.Node], req: ExprBacktestRequest, htf: dict[str, list[Candle]],
    instances=None, *, resolution: str | None = None,
) -> None:
    """Fetch every @tf timeframe the rows reference that the request didn't ship,
    then verify each one is SUFFICIENT to warm its deepest pin before the
    trading window (htf_source.source_htf). Shipped htfCandles win: a
    compute-only host must never reach a broker. `htf` is updated in place
    because every caller keeps using the dict it passed.

    `resolution` (the rule's base timeframe) lets a picked line on that SAME
    timeframe skip the HTF fetch entirely (sweep_apply.referenced_tfs)."""
    try:
        htf.update(await source_htf(
            nodes, instances, broker=req.broker, epic=req.epic, side=req.priceSide,
            from_ts=req.candles[0].time, to_ts=req.candles[-1].time,
            cutoff_ts=req.tradeFromTime, shipped=htf, resolution=resolution,
        ))
    except HtfShortfall as e:
        if e.bars == 0:
            raise HTTPException(422, f"no candles for timeframe '{e.tf}'")
        raise HTTPException(
            422,
            f"not enough history for timeframe '{e.tf}': {e.closed} of {e.need} "
            f"closed bars before the trading window. Indicators pinned to "
            f"@{e.tf} can't be computed correctly here, start the range "
            f"later or shorten the pinned indicator.",
        )


async def compiled_run(
    r: ExprBacktestRequest,
    *,
    on_progress: Callable[[int, int], None] | None = None,
    candles: list[Candle] | None = None,
    warnings: list[str] | None = None,
) -> tuple[BacktestResult, dict]:
    """Parse r's rule groups, compile, and run the engine over r's candles.

    Returns (BacktestResult, metrics dict). The main path and the baseline
    companion runs both go through here, so the two can never drift. Progress
    and cancel are the CALLER's concern (the route owns the registry entry
    for the whole request, main pass + baselines): a `BacktestCancelled`
    raised by the callback propagates out of here unmapped.

    `candles` short-circuits the DTO conversion when the caller already holds
    the converted list for r.candles (baseline passes reuse the main run's) —
    ~0.15s per pass on a 90k-bar request, nothing else changes.

    Before compiling, any active picked line (r.lines) with neither anchor
    inside this run's candles is rebased onto the loaded bars
    (line_rebase.rebase_request_lines, which validates r.lines first),
    mutating r's PickedLineDTOs in place: the DTOs are what request_instances
    (right below) and a worker's req_dict rebuild both read. `warnings`
    collects rebase notices for the caller that owns the HTTP response (the main /api/expr/backtest pass);
    baseline/companion passes reuse the same (already-rebased, now a no-op)
    DTOs and don't bother collecting them.
    """
    if candles is None:
        candles = [candle_from_dto(c) for c in r.candles]
    try:
        rebase_warnings = await rebase_request_lines(
            r, first_ms=int(candles[0].time.timestamp() * 1000),
            last_ms=int(candles[-1].time.timestamp() * 1000))
    except LineSpecError as e:
        raise HTTPException(422, {
            "code": e.code, "message": e.message,
            "start": None, "end": None, "group": None, "row": None,
        })
    if warnings is not None:
        warnings.extend(rebase_warnings)
    # I4 (expr): panel risk of kind atr/trailAtr and atr scaling spacing execute
    # against series["ATR_{length}"]. The expr wire format has no series field, so
    # we compute them here — without this the engine reads None and the position
    # runs stop-less, silently (which is what the old atr_risk_unsupported 422
    # was standing in for).
    try:
        atr_risk = build_atr_risk_series(
            candles,
            (r.longRisk, r.shortRisk),
            (r.longScaling, r.shortScaling),
            first_tradeable_index(candles, r.tradeFromTime),
        )
    except AtrWarmupError as e:
        raise HTTPException(422, {
            "code": "atr_warmup", "message": e.message,
            "start": None, "end": None, "group": None, "row": None,
        })
    htf: dict[str, list[Candle]] = {
        tf: [candle_from_dto(c) for c in bars]
        for tf, bars in (r.htfCandles or {}).items()
    }
    groups = [
        (r.longEntry, False, "longEntry"), (r.longExit, True, "longExit"),
        (r.shortEntry, False, "shortEntry"), (r.shortExit, True, "shortExit"),
    ]
    # Resolved ONCE per request, then threaded into validate/compile/warm-up.
    try:
        instances = request_instances(r)
    except LineSpecError as e:
        raise HTTPException(422, {
            "code": e.code, "message": e.message,
            "start": None, "end": None, "group": None, "row": None,
        })
    parsed = [_parse_group(rows, is_exit=ex, group=g, instances=instances) for rows, ex, g in groups]
    # @tf rows need their higher-timeframe candles in hand before compile_row
    # precomputes series; fetch whatever the request didn't ship.
    await _ensure_htf([n for nodes in parsed for n, _ in nodes], r, htf, instances, resolution=r.resolution)
    strategy = ExprRuleStrategy(
        *[[compile_row(n, candles, r.resolution, htf, instances, source=src)
           for n, src in nodes] for nodes in parsed],
        quantity=r.costs.quantity,
        trade_from_time=r.tradeFromTime,
        long_enabled=r.longEnabled,
        short_enabled=r.shortEnabled,
        long_entry_combine=r.longEntryCombine,
        long_exit_combine=r.longExitCombine,
        short_entry_combine=r.shortEntryCombine,
        short_exit_combine=r.shortExitCombine,
        epochs=[c.time.timestamp() for c in candles],
    )
    engine = BacktestEngine(
        strategy,
        starting_cash=r.costs.startingCash,
        commission_per_side=r.costs.commissionPerSide,
        slippage=r.costs.slippage.value,
        slippage_atr_mult=(
            r.costs.slippage.atrMult if r.costs.slippage.kind == "atr" else 0.0
        ),
        spread=r.costs.spread,
        fin_long_daily_pct=r.costs.finLongDailyPct,
        fin_short_daily_pct=r.costs.finShortDailyPct,
        long_risk=r.longRisk.to_risk() if r.longRisk else None,
        short_risk=r.shortRisk.to_risk() if r.shortRisk else None,
        long_scaling=r.longScaling.to_scaling() if r.longScaling else None,
        short_scaling=r.shortScaling.to_scaling() if r.shortScaling else None,
        series=atr_risk,
        mask=r.mask.to_mask() if r.mask else None,
    )
    # to_thread: the engine is CPU-bound sync; on the loop thread it would
    # starve every other request — including the progress polls the caller's
    # callback exists to feed.
    result = await asyncio.to_thread(engine.run, candles, on_progress=on_progress)
    # compute_metrics carries return_pct/sharpe/drawdown but NOT the headline
    # net_pnl / n_trades / win_rate — those live on the run summary. Baseline
    # consumers want both in one blob, so merge (the main path ignores this dict
    # and re-derives its own inside _result_to_response, unchanged).
    metrics = compute_metrics(
        result.trades, result.equity, result.net_pnl, r.costs.startingCash,
        resolution_seconds(r.resolution), financing_total=result.financing_total,
    ) | result.summary()
    return result, metrics

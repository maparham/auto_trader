"""The expression backtest surface: /api/expr/{backtest,series,literals}.

Parallel to the structured /api/backtest. Requests carry raw expression strings;
compiling and running them is `expr_exec.compiled_run`'s job (shared with the
structured router's baselines), so this module owns the HTTP surface: request
shape, the 422s, the sweep/WFO job submits, and serializing with the same
`_result_to_response` the structured handler uses. Parse/validation problems
return HTTP 422 with the expression span so the editor can underline the
offending characters.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Callable

from fastapi import APIRouter, HTTPException

from auto_trader.core import progress as pr
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.closeness import (
    Norm,
    aggregate_to_display,
    group_closeness,
)
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.evaluate import series_of
from auto_trader.strategy.expr.literals import literals as compute_literals
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars

from .. import deps
# The compile-and-run pipeline lives in expr_exec so the structured backtest
# router can share it without a router-to-router cycle. The @tf warm-up helpers
# moved with it (the pipeline needs them) and are imported back here for the
# sweep/WFO submit paths and the series/closeness fetch loops.
from ..expr_exec import (
    _ensure_htf,
    _tf_inner_warmup,
    _tf_span,
    compiled_run,
)
from ..schemas import (
    ExprBacktestRequest,
    ExprClosenessRequest,
    ExprLiteralsRequest,
    ExprSeriesRequest,
    SweepJobSubmitResponse,
    WfoJobSubmitResponse,
    axis_dicts,
)
from ..sweep_apply import (
    SweepValidationError,
    apply_combo,
    apply_env_combo,
    apply_lit_combo,
    candle_from_dto,
    htf_from_dto,
    request_instances,
    referenced_tfs as _referenced_tfs,
    split_env_combo,
)
from ..sweep_jobs import JOBS
from ..wfo_jobs import WFO_JOBS

router = APIRouter()
log = logging.getLogger(__name__)


def _all_row_nodes(req: ExprBacktestRequest, instances=None) -> list[N.Node]:
    """Every enabled row of every group, parsed — for @tf collection at sweep/WFO
    submit. Parse/validate errors are skipped, not raised: target dry-validation
    owns 422ing malformed rows; here an unparseable row simply references no
    timeframe."""
    nodes: list[N.Node] = []
    for rows, is_exit in ((req.longEntry, False), (req.longExit, True),
                          (req.shortEntry, False), (req.shortExit, True)):
        for row in rows:
            if not row.enabled or not row.expr.strip():
                continue
            try:
                node = parse(row.expr)
                validate(node, is_exit=is_exit, instances=instances)
            except ExprError:
                continue
            nodes.append(node)
    return nodes


@router.post("/api/expr/backtest")
async def expr_backtest(req: ExprBacktestRequest):
    if not req.candles:
        raise HTTPException(422, "candles must not be empty")
    # Progress + cancel lifecycle for the WHOLE request lives here, not in
    # compiled_run: registered before compiled_run's HTF prefetch (that await
    # is the one multi-second suspension before the engine starts, and a cancel
    # landing during it must find an entry to flag instead of 404ing), and
    # cleared only after the baseline passes, which reuse the same callback so
    # a cancel reaches them too. The finally covers compiled_run's validation
    # 422s, so no entry can leak.
    on_progress: Callable[[int, int], None] | None = None
    if req.progressId:
        pid = req.progressId
        pr.set_progress(pid, stage="simulate")

        def on_progress(done: int, total: int) -> None:
            # Cooperative cancel: POST /api/backtest/cancel/{id} flips the
            # entry's flag; the next engine progress beat lands here and aborts.
            if pr.is_cancelled(pid):
                raise pr.BacktestCancelled()
            pr.update_progress(pid, done, total)
    try:
        result, _metrics = await compiled_run(req, on_progress=on_progress)
        # Imported lazily to avoid a router import cycle (backtest.py imports many
        # things at module load; expr.py is registered alongside it).
        from ..routers.backtest import _result_to_response
        window = [c for c in req.candles if c.time >= req.tradeFromTime]
        response = _result_to_response(
            result,
            epic=req.epic,
            resolution=req.resolution,
            candles_window=window,
            trade_from_time=req.tradeFromTime,
            starting_cash=req.costs.startingCash,
            commission_per_side=req.costs.commissionPerSide,
        )
        # Companion runs: the same candles/costs with synthesized entry rules, so
        # the frontend can show what the signal added over "always in" and over
        # the raw market. Sequential (each is a full engine run) and best-effort —
        # a baseline that blows up reports None rather than failing the real run.
        baselines_out = None
        if req.baselines:
            from auto_trader.api.baselines import hold_request, null_request
            synth = {"null": null_request, "hold": hold_request}
            baselines_out = {"null": None, "hold": None}
            # Relabel so the wire payload stays honest: these beats are baseline
            # passes, not the main simulate (mirrors the coded handler's
            # exit-times / cost-sensitivity stage relabels).
            if req.progressId:
                pr.set_progress(req.progressId, stage="baselines")
            for kind in req.baselines:
                try:
                    _res, m = await compiled_run(synth[kind](req), on_progress=on_progress)
                    baselines_out[kind] = m
                except pr.BacktestCancelled:
                    # A user cancel outranks best-effort: stop the remaining
                    # passes instead of burning through them.
                    raise
                except Exception:  # noqa: BLE001  a baseline must never fail the run
                    # Swallowed by design, but not silently: without this the only
                    # symptom of a broken baseline is a null in the response.
                    log.warning("baseline run %r failed", kind, exc_info=True)
                    baselines_out[kind] = None
        response.baselines = baselines_out
        return response
    except pr.BacktestCancelled:
        # Client asked to stop; 499 is distinct from any engine/validation error.
        raise HTTPException(499, "backtest cancelled")
    finally:
        if req.progressId:
            pr.clear_progress(req.progressId)


@router.post("/api/expr/sweep/jobs", response_model=SweepJobSubmitResponse)
async def submit_expr_sweep_job(req: ExprBacktestRequest):
    """Submit an expression sweep as one job over the shared process pool. The
    frontend polls the SAME GET /api/backtest/sweep/jobs/{job_id} route (JOBS is
    a shared singleton), so there is no separate expr poll/cancel route. HTF is
    combo-invariant for a lit: sweep (timeframes are name tokens, never sweepable
    number literals), so req.htfCandles ships to the workers as-is."""
    if req.sweep is None or not req.sweep.combos:
        raise HTTPException(422, "sweep.combos is required")
    bounds = req.sweep.windows
    if bounds is not None and (len(bounds) < 2 or any(b <= a for a, b in zip(bounds, bounds[1:]))):
        raise HTTPException(422, "sweep.windows must be >= 2 ascending epoch seconds")
    if not req.candles:
        raise HTTPException(422, "candles must not be empty")
    candles = [candle_from_dto(c) for c in req.candles]
    # Dry-validate every combo's targets so a malformed target 422s at submit
    # (matches the structured sweep). apply_lit_combo covers lit: (parse+range);
    # apply_combo covers risk:; apply_env_combo covers period:/timeWindow:.
    try:
        for combo in req.sweep.combos:
            env, rest = split_env_combo(combo)
            patched, _ = apply_env_combo(req, candles, env)
            apply_lit_combo(patched, rest)
            apply_combo(patched, {k: v for k, v in rest.items() if k.startswith("risk:")})
    except SweepValidationError as e:
        raise HTTPException(e.status_code, e.detail)
    htf_candles = htf_from_dto(req.htfCandles) if req.htfCandles is not None else {}
    # Pool workers do zero network: fetch the rows' @tf set here so they inherit
    # a complete dict (HTF is combo-invariant — timeframes are name tokens,
    # never sweepable literals). Shipped htfCandles ride along untouched.
    instances = request_instances(req)
    await _ensure_htf(_all_row_nodes(req, instances), req, htf_candles, instances)
    job = JOBS.submit(
        req_dict=req.model_dump(mode="json", exclude={"htfCandles"}),
        htf_candles=htf_candles,
        strategies_dir=None,
        windows=req.sweep.windows,
        combos=req.sweep.combos,
        epic=req.epic,
        timeframe=req.resolution,
        probe_row=None,
        expr_sweep=True,
    )
    return SweepJobSubmitResponse(jobId=job.job_id, total=job.total)


@router.post("/api/expr/walkforward/jobs", response_model=WfoJobSubmitResponse)
async def submit_expr_wfo_job(req: ExprBacktestRequest):
    """Walk-forward over expression rules. Combos carry lit:/risk: targets; the
    fold windows own the period. Polled via the shared GET
    /api/backtest/walkforward/jobs/{id} route (WFO_JOBS is a singleton)."""
    # Imported lazily to match the _result_to_response pattern above: backtest.py
    # loads many things at module time and both routers are registered together.
    # There is no cycle (backtest.py does not import this module), so this is a
    # convention choice, not a hard requirement.
    from ..routers.backtest import (
        _persist_wfo, _plan_wfo_schemes, _validate_wfo_combo_hygiene,
    )
    wf = req.walkforward
    if wf is None or not wf.combos:
        raise HTTPException(422, "walkforward.combos is required")
    if not req.candles:
        raise HTTPException(422, "candles are required")
    res_s = resolution_seconds(req.resolution)
    candles = [candle_from_dto(c) for c in req.candles]
    schemes = _plan_wfo_schemes(wf, res_s, req.tradeFromTime, req.candles[-1].time,
                                req.candles[0].time)
    _validate_wfo_combo_hygiene(wf)
    # Dry-validate every combo's targets (lit:/risk:) like the expr sweep, so a
    # malformed target 422s at submit rather than failing every worker row.
    try:
        for combo in wf.combos:
            env, rest = split_env_combo(combo)
            patched, _ = apply_env_combo(req, candles, env)
            apply_lit_combo(patched, rest)
            apply_combo(patched, {k: v for k, v in rest.items() if k.startswith("risk:")})
    except SweepValidationError as e:
        raise HTTPException(e.status_code, e.detail)
    htf_candles = htf_from_dto(req.htfCandles) if req.htfCandles is not None else {}
    # Same as the sweep submit: workers never fetch, so the @tf set must be
    # complete before dispatch.
    instances = request_instances(req)
    await _ensure_htf(_all_row_nodes(req, instances), req, htf_candles, instances)
    job = WFO_JOBS.submit(
        req_dict=req.model_dump(mode="json", exclude={"htfCandles"}),
        htf_candles=htf_candles,
        strategies_dir=None,
        schemes=schemes,
        axes=axis_dicts(wf.axes),
        combos=wf.combos,
        objective={"metric": wf.objective.metric,
                   "composite": wf.objective.composite,
                   "selection": wf.objective.selection,
                   "min_trades": wf.schedule.minTrainTrades},
        schedule_meta=wf.schedule.model_dump(),
        epic=req.epic,
        timeframe=req.resolution,
        expr=True,
        eval_mode=wf.evalMode,
        baselines=wf.baselines,
        on_complete=_persist_wfo(req),
    )
    return WfoJobSubmitResponse(
        jobId=job.job_id, total=job.total,
        schemes=[{"trainSpan": s["train_span"],
                  "folds": [{k: f[k] for k in
                             ("train_from", "train_to", "test_from", "test_to")}
                            for f in s["folds"]]}
                 for s in schemes])


@router.post("/api/expr/series")
async def expr_series(req: ExprSeriesRequest):
    instances = request_instances(req)
    try:
        node = parse(req.expr)
        validate(node, is_exit=False, instances=instances)
    except ExprError as e:
        raise HTTPException(422, {
            "code": e.code, "message": e.message, "start": e.start, "end": e.end,
        })
    # A bare bullish(...)/bearish(...) row is a boolean predicate with no numeric
    # series to plot at all — reject before fetching any candles.
    if isinstance(node, N.Predicate):
        raise HTTPException(422, {
            "code": "predicate_not_plottable",
            "message": "bullish/bearish rows have no numeric series to plot.",
            "start": node.start, "end": node.end,
        })
    # An and/or/not row combines conditions; there is no single operand to plot
    # (the picker below would reach for `node.a` and 500 on a public endpoint).
    if isinstance(node, (N.BoolOp, N.Not)):
        raise HTTPException(422, {
            "code": "boolean_not_plottable",
            "message": "An and/or/not row has no single series to plot.",
            "start": node.start, "end": node.end,
        })
    res_s = resolution_seconds(req.resolution)
    bars = max(1, (req.toTime - req.fromTime) // res_s + 2)
    candles = await deps._fetch_symbol_candles(
        req.broker, req.epic, req.resolution, bars, req.fromTime, req.toTime, req.priceSide,
    )
    # Plot the left operand of the comparison (Compare.left / Cross.a): the RHS is
    # usually a constant threshold; the LHS is the indicator/candle series. For a
    # chain, plot the first link's left operand (the primary series).
    if isinstance(node, N.Chain):
        top = N.part_operands(node.parts[0])[0]
    elif isinstance(node, N.Compare):
        top = node.left
    else:
        top = node.a
    # An @tf term needs its higher-timeframe candles (with warm-up room before
    # the plotted window, or the pinned series is None over the visible span).
    htf: dict[str, list[Candle]] = {}
    for tf in _referenced_tfs(top, instances):
        tf_s, res = _tf_span(tf, instances)
        need = _tf_inner_warmup(top, tf, instances) + 1
        tf_from = req.fromTime - need * tf_s
        tf_bars = max(1, (req.toTime - tf_from) // tf_s + 2)
        htf[res] = await deps._fetch_symbol_candles(
            req.broker, req.epic, res, tf_bars, tf_from, req.toTime, req.priceSide,
        )
    values = series_of(top, candles, req.resolution, htf, instances)
    return {
        "times": [int(c.time.timestamp()) for c in candles],
        "values": values,
        "warmup": warmup_bars(node, req.resolution, instances),
    }


@router.post("/api/expr/closeness")
async def expr_closeness(req: ExprClosenessRequest):
    instances = request_instances(req)
    try:
        nodes = [parse(expr) for expr in req.rows]
        for node in nodes:
            validate(node, is_exit=False, instances=instances)
    except ExprError as e:
        raise HTTPException(422, {
            "code": e.code, "message": e.message, "start": e.start, "end": e.end,
        })

    base_s = resolution_seconds(req.baseResolution)
    display_s = resolution_seconds(req.displayResolution)
    if display_s < base_s:
        # below the authored timeframe there is no finer signal to show
        return {"times": [], "values": []}

    bars = max(1, (req.toTime - req.fromTime) // base_s + 2)
    candles = await deps._fetch_symbol_candles(
        req.broker, req.epic, req.baseResolution, bars, req.fromTime, req.toTime, req.priceSide,
    )

    tfs: set[str] = set()
    for node in nodes:
        tfs |= _referenced_tfs(node, instances)
    htf: dict[str, list[Candle]] = {}
    for tf in tfs:
        # canonical: '1H' -> 'HOUR' (fetch + dict key); an instance's own pin is
        # alias-checked here because validate() never saw it.
        tf_s, res = _tf_span(tf, instances)
        tf_bars = max(1, (req.toTime - req.fromTime) // tf_s + 2)
        htf[res] = await deps._fetch_symbol_candles(
            req.broker, req.epic, res, tf_bars, req.fromTime, req.toTime, req.priceSide,
        )

    # Display-bar opens for bucketing: at the base timeframe the base bars ARE the
    # display bars; on a higher timeframe fetch the display candles so week/month/
    # session-anchored bars align to the chart exactly (never guessed by modulo).
    base_times = [int(c.time.timestamp()) for c in candles]
    if req.displayResolution == req.baseResolution:
        display_opens = base_times
    else:
        disp_bars = max(1, (req.toTime - req.fromTime) // display_s + 2)
        disp_candles = await deps._fetch_symbol_candles(
            req.broker, req.epic, req.displayResolution, disp_bars,
            req.fromTime, req.toTime, req.priceSide,
        )
        display_opens = [int(c.time.timestamp()) for c in disp_candles]

    norm = Norm(
        basis=req.norm.basis, width=req.norm.width,
        window=req.norm.window, atr_length=req.norm.atrLength,
    )
    base_vals = group_closeness(nodes, req.combine, candles, req.baseResolution,
                                htf, norm, instances)
    times, values = aggregate_to_display(base_times, base_vals, display_opens, req.agg)
    return {"times": times, "values": values}


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

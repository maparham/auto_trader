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
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.closeness import (
    Norm,
    aggregate_to_display,
    group_closeness,
)
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.evaluate import compile_row, series_of
from auto_trader.strategy.expr.literals import literals as compute_literals
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.strategy import ExprRuleStrategy
from auto_trader.strategy.expr.tfs import tf_resolution
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.warmup import warmup_bars

from .. import deps
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
    split_env_combo,
)
from ..sweep_jobs import JOBS
from ..wfo_jobs import WFO_JOBS

router = APIRouter()


def _parse_group(rows, *, is_exit: bool, group: str) -> list[N.Row]:
    """Parse + validate every ENABLED row in a group. A parse/validate error 422s
    with the expression span plus the group/row location so the frontend can map
    it back to the offending editor field. Disabled rows and blank rows are
    dropped before parse (a parked or empty draft never blocks a run; an empty
    placeholder row is not a rule). Split from compilation so the route can
    collect the rows' @tf references and fetch those candles BEFORE compiling
    (compile_row precomputes series eagerly, so htf must be complete by then)."""
    nodes = []
    for idx, row in enumerate(rows):
        if not row.enabled or not row.expr.strip():
            continue
        try:
            node = parse(row.expr)
            validate(node, is_exit=is_exit)
        except ExprError as e:
            raise HTTPException(422, {
                "code": e.code, "message": e.message,
                "start": e.start, "end": e.end, "group": group, "row": idx,
            })
        nodes.append(node)
    return nodes


def _tf_inner_warmup(node: N.Node, tf: str) -> int:
    """Deepest warm-up (in the PIN's own bars) any @`tf` pin in `node` needs."""
    if isinstance(node, N.Tf):
        return warmup_bars(node.base, tf_resolution(node.tf)) if node.tf == tf else 0
    if isinstance(node, N.Chain):
        return max((_tf_inner_warmup(p, tf) for p in node.parts), default=0)
    if isinstance(node, (N.Compare, N.Binary)):
        return max(_tf_inner_warmup(node.left, tf), _tf_inner_warmup(node.right, tf))
    if isinstance(node, N.Cross):
        return max(_tf_inner_warmup(node.a, tf), _tf_inner_warmup(node.b, tf))
    if isinstance(node, (N.Field, N.Offset)):
        return _tf_inner_warmup(node.base, tf)
    if isinstance(node, N.Unary):
        return _tf_inner_warmup(node.operand, tf)
    if isinstance(node, N.Call):
        return max((_tf_inner_warmup(a, tf) for a in node.args), default=0)
    if isinstance(node, N.Predicate):
        return _tf_inner_warmup(node.base, tf)
    if isinstance(node, N.Count):
        return max(_tf_inner_warmup(node.cond, tf), _tf_inner_warmup(node.window, tf))
    return 0


def _all_row_nodes(req: ExprBacktestRequest) -> list[N.Node]:
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
                validate(node, is_exit=is_exit)
            except ExprError:
                continue
            nodes.append(node)
    return nodes


async def _ensure_htf(
    nodes: list[N.Node], req: ExprBacktestRequest, htf: dict[str, list[Candle]],
) -> None:
    """Fetch every @tf timeframe the rows reference that the request didn't ship,
    then verify each one is actually SUFFICIENT to warm its deepest pin.

    Shipped htfCandles win (a compute-only host must never reach a broker — its
    proxy pre-ships the set); anything else is fetched over the request's
    broker/priceSide so the bars match the base candles' source. The dict is
    keyed by the CANONICAL resolution ("HOUR", not "1H").

    Sufficiency, not just presence: an EMA(50)@1H seeded from 20 hourly bars
    isn't a less-accurate EMA — it's a different series that crosses where the
    real one doesn't, and those phantom crosses become trades (the same reason
    the frontend hard-fails a short BASE warm-up). The pin's value at the
    trading window's first bar comes from the last CLOSED HTF bar before it, so
    that bar — and `inner` closed bars before it — must exist. Both fetched and
    shipped sets are checked; a shortfall is a 422, never a silent misrun.

    The fetch asks 2x the need (+ slack) in calendar time: an HTF bar count only
    maps to a span while the market is open, and a weekend/holiday can eat most
    of an exact ask. Proportional, unlike the coded path's flat 300-bar floor,
    which over-asks absurdly for coarse pins (300 @W bars is ~6 years — brokers
    just 400 on that)."""
    tfs: set[str] = set()
    for node in nodes:
        tfs |= _referenced_tfs(node)
    for tf in sorted(tfs):
        res = tf_resolution(tf) or tf  # unknown aliases were rejected by validate()
        tf_s = resolution_seconds(res)
        # inner closed bars to warm the deepest pin, +1 = the closed bar whose
        # value the window's first base bar actually reads.
        need = max((_tf_inner_warmup(n, tf) for n in nodes), default=0) + 1
        bars = htf.get(res) or htf.get(tf)
        if not bars:
            from_ts = req.candles[0].time - (need * 2 + 10) * tf_s
            to_ts = req.candles[-1].time
            span_bars = max(1, (to_ts - from_ts) // tf_s + 2)
            bars = await deps._fetch_symbol_candles(
                req.broker, req.epic, res, span_bars, from_ts, to_ts, req.priceSide,
            )
            if not bars:
                raise HTTPException(422, f"no candles for timeframe '{tf}'")
            htf[res] = bars
        closed = sum(
            1 for c in bars
            if int(c.time.timestamp()) + tf_s <= req.tradeFromTime
        )
        if closed < need:
            raise HTTPException(
                422,
                f"not enough history for timeframe '{tf}': {closed} of {need} "
                f"closed bars before the trading window. Indicators pinned to "
                f"@{tf} can't be computed correctly here — start the range "
                f"later or shorten the pinned indicator.",
            )


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
    groups = [
        (req.longEntry, False, "longEntry"), (req.longExit, True, "longExit"),
        (req.shortEntry, False, "shortEntry"), (req.shortExit, True, "shortExit"),
    ]
    parsed = [_parse_group(rows, is_exit=ex, group=g) for rows, ex, g in groups]
    # @tf rows need their higher-timeframe candles in hand before compile_row
    # precomputes series; fetch whatever the request didn't ship.
    await _ensure_htf([n for nodes in parsed for n in nodes], req, htf)
    strategy = ExprRuleStrategy(
        *[[compile_row(n, candles, req.resolution, htf) for n in nodes] for nodes in parsed],
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
    )


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
    await _ensure_htf(_all_row_nodes(req), req, htf_candles)
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
    await _ensure_htf(_all_row_nodes(req), req, htf_candles)
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
    try:
        node = parse(req.expr)
        validate(node, is_exit=False)
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
    res_s = resolution_seconds(req.resolution)
    bars = max(1, (req.toTime - req.fromTime) // res_s + 2)
    candles = await deps._fetch_symbol_candles(
        req.broker, req.epic, req.resolution, bars, req.fromTime, req.toTime, req.priceSide,
    )
    # Plot the left operand of the comparison (Compare.left / Cross.a): the RHS is
    # usually a constant threshold; the LHS is the indicator/candle series. For a
    # chain, plot the first link's left operand (the primary series).
    if isinstance(node, N.Chain):
        top = node.parts[0].left
    elif isinstance(node, N.Compare):
        top = node.left
    else:
        top = node.a
    # An @tf term needs its higher-timeframe candles (with warm-up room before
    # the plotted window, or the pinned series is None over the visible span).
    htf: dict[str, list[Candle]] = {}
    for tf in _referenced_tfs(top):
        res = tf_resolution(tf) or tf
        tf_s = resolution_seconds(res)
        need = _tf_inner_warmup(top, tf) + 1
        tf_from = req.fromTime - need * tf_s
        tf_bars = max(1, (req.toTime - tf_from) // tf_s + 2)
        htf[res] = await deps._fetch_symbol_candles(
            req.broker, req.epic, res, tf_bars, tf_from, req.toTime, req.priceSide,
        )
    values = series_of(top, candles, req.resolution, htf)
    return {
        "times": [int(c.time.timestamp()) for c in candles],
        "values": values,
        "warmup": warmup_bars(node, req.resolution),
    }


def _referenced_tfs(node: N.Node) -> set[str]:
    """All @TF timeframes referenced anywhere in a row's tree."""
    if isinstance(node, N.Tf):
        return {node.tf} | _referenced_tfs(node.base)
    if isinstance(node, N.Chain):
        return set().union(*(_referenced_tfs(p) for p in node.parts))
    if isinstance(node, (N.Field, N.Offset)):
        return _referenced_tfs(node.base)
    if isinstance(node, N.Unary):
        return _referenced_tfs(node.operand)
    if isinstance(node, N.Call):
        return set().union(*(_referenced_tfs(a) for a in node.args)) if node.args else set()
    if isinstance(node, (N.Binary, N.Compare)):
        return _referenced_tfs(node.left) | _referenced_tfs(node.right)
    if isinstance(node, N.Cross):
        return _referenced_tfs(node.a) | _referenced_tfs(node.b)
    if isinstance(node, N.Predicate):
        return _referenced_tfs(node.base)
    if isinstance(node, N.Count):
        return _referenced_tfs(node.cond) | _referenced_tfs(node.window)
    return set()


@router.post("/api/expr/closeness")
async def expr_closeness(req: ExprClosenessRequest):
    try:
        nodes = [parse(expr) for expr in req.rows]
        for node in nodes:
            validate(node, is_exit=False)
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
        tfs |= _referenced_tfs(node)
    htf: dict[str, list[Candle]] = {}
    for tf in tfs:
        res = tf_resolution(tf) or tf  # canonical: '1H' -> 'HOUR' (fetch + dict key)
        tf_bars = max(1, (req.toTime - req.fromTime) // resolution_seconds(res) + 2)
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
    base_vals = group_closeness(nodes, req.combine, candles, req.baseResolution, htf, norm)
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

"""Shared expression compile-and-run pipeline. One implementation serves the
expr route's main run and every baseline run (expr and coded routes both):
whatever the main path executes, a baseline executes identically.

It lives here rather than in `routers/expr.py` so the structured backtest router
can import it without a router-to-router cycle. The @tf warm-up helpers came
along because the pipeline needs them; the expr router imports them back for its
sweep/WFO submit paths, so each is still defined in exactly one place.
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
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.strategy import ExprRuleStrategy
from auto_trader.strategy.expr.tfs import tf_resolution
from auto_trader.strategy.expr.validate import validate
from auto_trader.strategy.expr.registry import PATTERN_FN_NAMES
from auto_trader.strategy.expr.warmup import PATTERN_WARMUP, warmup_bars

from . import deps
from .risk_series import (
    AtrWarmupError,
    build_atr_risk_series,
    first_tradeable_index,
)
from .schemas import ExprBacktestRequest
from .sweep_apply import (
    candle_from_dto,
    request_instances,
    referenced_tfs as _referenced_tfs,
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


def _pin_owner(tf: str, instances) -> str | None:
    """The instance whose OWN settings pin names `tf`, if any."""
    return next((i for i, inst in (instances or {}).items()
                 if inst.spec.timeframe(inst.config) == tf), None)


def _tf_span(tf: str, instances=None) -> tuple[int, str]:
    """(nominal bar seconds, canonical resolution) for a referenced timeframe.

    An @tf TOKEN was already alias-checked by validate(). An instance's own pin
    was NOT: it never passes through the parser, so validate() has never seen
    it, and the chart's timeframe vocabulary is a strict superset of this
    backend's Resolution enum (SECOND, SECOND_5/10/15/30/45, ...). Without this
    guard such a pin reaches resolution_seconds() and 500s on an uncaught
    ValueError. Name the offending pane so the user can fix the pane, not guess.
    """
    res = tf_resolution(tf) or tf
    try:
        return resolution_seconds(res), res
    except (ValueError, KeyError):
        owner = _pin_owner(tf, instances)
        where = (f"{owner} is pinned to timeframe '{tf}'" if owner
                 else f"timeframe '{tf}' is not supported")
        raise HTTPException(422, {
            "code": "unsupported_timeframe",
            "message": f"{where}, which backtests cannot compute. Change that "
                       f"indicator's timeframe or unpin it.",
            "start": None, "end": None, "group": None, "row": None,
        })


def _same_tf(a: str, b: str) -> bool:
    """Two timeframe spellings naming the same resolution. An instance's own pin
    is whatever its pane settings hold ("1H"), while an @tf token may be either
    the alias or the canonical form ("HOUR") — compare canonically."""
    return (tf_resolution(a) or a) == (tf_resolution(b) or b)


def _tf_inner_warmup(node: N.Node, tf: str, instances=None) -> int:
    """Deepest warm-up (in the PIN's own bars) any @`tf` pin in `node` needs."""
    if isinstance(node, N.Tf):
        return warmup_bars(node.base, tf_resolution(node.tf), instances) if node.tf == tf else 0
    if isinstance(node, N.IndicatorRef):
        # An instance pinned in its OWN SETTINGS is an @tf pin with no @tf in the
        # text: it is computed on `pin`'s bars, so it needs its full warm-up in
        # THOSE bars. Charging only the +1 the caller adds would let the
        # sufficiency check pass on a single closed HTF bar and warm the series
        # from nothing — a silently wrong number, not an error.
        inst = (instances or {}).get(node.instance)
        pin = inst.spec.timeframe(inst.config) if inst else None
        if pin and _same_tf(pin, tf):
            return inst.spec.warmup(inst.config, node.output)
        return 0
    if isinstance(node, (N.Chain, N.BoolOp)):
        return max((_tf_inner_warmup(p, tf, instances) for p in node.parts), default=0)
    if isinstance(node, N.Not):
        return _tf_inner_warmup(node.operand, tf, instances)
    if isinstance(node, (N.Compare, N.Binary)):
        return max(_tf_inner_warmup(node.left, tf, instances), _tf_inner_warmup(node.right, tf, instances))
    if isinstance(node, N.Cross):
        return max(_tf_inner_warmup(node.a, tf, instances), _tf_inner_warmup(node.b, tf, instances))
    if isinstance(node, (N.Field, N.Offset)):
        return _tf_inner_warmup(node.base, tf, instances)
    if isinstance(node, N.Unary):
        return _tf_inner_warmup(node.operand, tf, instances)
    if isinstance(node, N.Call):
        return max((_tf_inner_warmup(a, tf, instances) for a in node.args), default=0)
    if isinstance(node, N.Predicate):
        # A pattern pinned to @`tf` needs PATTERN_WARMUP bars of THAT timeframe
        # before its first honest value. Charge it only when this predicate is
        # actually pinned to `tf`: callers max this across every row for every
        # referenced timeframe, so charging it unconditionally would let an
        # UNPINNED pattern row inflate an unrelated pin's ask (and spuriously
        # 422 on the `closed < need` check below).
        pinned_here = node.fn in PATTERN_FN_NAMES and tf in _referenced_tfs(node.base, instances)
        return (PATTERN_WARMUP if pinned_here else 0) + _tf_inner_warmup(node.base, tf, instances)
    if isinstance(node, N.Count):
        return max(_tf_inner_warmup(node.cond, tf, instances), _tf_inner_warmup(node.window, tf, instances))
    return 0


async def _ensure_htf(
    nodes: list[N.Node], req: ExprBacktestRequest, htf: dict[str, list[Candle]],
    instances=None,
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
        tfs |= _referenced_tfs(node, instances)
    for tf in sorted(tfs):
        # An @tf token's alias was rejected by validate(); an instance's own
        # pin was never parsed, so _tf_span is what checks THAT one.
        tf_s, res = _tf_span(tf, instances)
        # inner closed bars to warm the deepest pin, +1 = the closed bar whose
        # value the window's first base bar actually reads.
        need = max((_tf_inner_warmup(n, tf, instances) for n in nodes), default=0) + 1
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


async def compiled_run(
    r: ExprBacktestRequest,
    *,
    on_progress: Callable[[int, int], None] | None = None,
    candles: list[Candle] | None = None,
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
    """
    if candles is None:
        candles = [candle_from_dto(c) for c in r.candles]
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
    instances = request_instances(r)
    parsed = [_parse_group(rows, is_exit=ex, group=g, instances=instances) for rows, ex, g in groups]
    # @tf rows need their higher-timeframe candles in hand before compile_row
    # precomputes series; fetch whatever the request didn't ship.
    await _ensure_htf([n for nodes in parsed for n, _ in nodes], r, htf, instances)
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

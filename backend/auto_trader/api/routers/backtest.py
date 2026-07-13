"""The rule-based backtest route."""

from __future__ import annotations

import logging
import re
import time
import uuid
from datetime import datetime, timezone
from types import ModuleType

from fastapi import APIRouter, HTTPException

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.core.run_store import RUN_STORE
from auto_trader.engine.analysis import compute_analysis
from auto_trader.engine.backtest import BacktestEngine, BacktestResult
from auto_trader.engine.context_features import enrich_trades
from auto_trader.engine.metrics import compute_metrics, leg_metrics
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
from auto_trader.strategy.rule_series import build_rule_series, htf_timeframes

from .. import deps
from ..schemas import (
    BacktestRequest,
    BacktestResponse,
    BarGroupTraceDTO,
    BarTraceDTO,
    CandleDTO,
    EquityDTO,
    InspectorTermDTO,
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

logger = logging.getLogger(__name__)

router = APIRouter()


def _candle_from_dto(c: CandleDTO) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(c.time, tz=timezone.utc),
        open=c.open, high=c.high, low=c.low, close=c.close, volume=c.volume,
    )


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


async def _assemble_rule_series(
    req: BacktestRequest, candles: list[Candle],
    htf_candles: dict[str, list[Candle]] | None = None,
) -> dict[str, list[float | None]]:
    """Backend-owned rule series: recompute native indicators from `candles`,
    fetch+align any higher timeframes, and merge in the browser-supplied
    chart-operand series (kind='series', which cannot be recomputed server-side).
    On a native/chart-operand key collision the recomputed value wins.

    `htf_candles`, when passed, is used as-is (no fetch) — callers that already
    fetched the HTF set once (e.g. the sweep, which reuses it across every combo
    since combos never sweep `timeframe`) pass it in. When None (the single-run
    call sites), the HTF set is fetched here as before."""
    ops = _rule_operands(req)
    if htf_candles is None:
        htf_candles = {}
        for tf in htf_timeframes(ops, req.resolution):
            warmup_from = req.candles[0].time - _HTF_WARMUP_BARS * resolution_seconds(tf)
            fetched = await deps._fetch_symbol_candles(
                req.broker, req.epic, tf, 1000, warmup_from, req.candles[-1].time, req.priceSide,
            )
            if not fetched:
                raise HTTPException(422, f"no candles for timeframe '{tf}'")
            htf_candles[tf] = fetched
    computed = build_rule_series(ops, candles, req.resolution, htf_candles, _rule_atr_lengths(req))
    # Chart-operand/drawing series stay browser-supplied; native keys recompute.
    chart_series = {
        series_name(o.to_operand()): req.series.get(series_name(o.to_operand()))
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit)
        for o in group.operands()
        if o.kind == "series"
    }
    return {**{k: v for k, v in chart_series.items() if v is not None}, **computed}


async def _run_rule(
    req: BacktestRequest, candles: list[Candle],
    htf_candles: dict[str, list[Candle]] | None = None,
) -> BacktestResult:
    """Backend-recomputed rule run used by both the single-run /api/backtest
    route and the sweep. `htf_candles`: see `_assemble_rule_series` — sweep
    callers pass a pre-fetched, combo-shared dict; single-run callers omit it."""
    series = await _assemble_rule_series(req, candles, htf_candles)
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
        slippage=req.costs.slippage,
        long_risk=req.longRisk.to_risk() if req.longRisk else None,
        short_risk=req.shortRisk.to_risk() if req.shortRisk else None,
        long_scaling=req.longScaling.to_scaling() if req.longScaling else None,
        short_scaling=req.shortScaling.to_scaling() if req.shortScaling else None,
        series=series,
        mask=req.mask.to_mask() if req.mask else None,
        inspect=req.inspect,
    )
    return engine.run(candles)


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
        # Native indicators/ATR are recomputed server-side, so only chart-operand
        # (kind=='series') keys — which cannot be recomputed — are required from
        # the request's posted `series`.
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
            for op in group.operands():
                if op.kind != "series":
                    continue
                name = series_name(op.to_operand())
                arr = req.series.get(name)
                if arr is None:
                    raise HTTPException(422, f"missing series '{name}' referenced by a rule")
                if len(arr) != len(req.candles):
                    raise HTTPException(
                        422, f"series '{name}' length {len(arr)} != candles length {len(req.candles)}")
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
        try:
            result = await _run_rule(req, candles)
        except StrategyRuntimeError as e:
            raise HTTPException(422, str(e))

    # Fills/trades need no >= tradeFromTime filter here: RuleStrategy gates every
    # entry to tradeFromTime-or-later (rule.py), a fill only lands on a LATER
    # bar's open, and an exit can only follow a gated entry — so every fill and
    # trade already satisfies the window by construction. Equity is the one
    # collection that isn't: the engine appends a point for every bar, including
    # warm-up, so it's the only result that still needs trimming here.
    window = [c for c in req.candles if c.time >= req.tradeFromTime]

    # Post-run enrichment over the FULL candle list (not `window`): a trade's
    # signal bar can sit in the warm-up span before tradeFromTime.
    enrich_trades(result.trades, candles)

    trades_dto = [
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
            mae=t.mae, mfe=t.mfe, mae_r=t.mae_r, mfe_r=t.mfe_r, context=t.context,
        )
        for t in result.trades
    ]
    summary = result.summary()
    metrics = compute_metrics(
        result.trades, result.equity, result.net_pnl,
        req.costs.startingCash, resolution_seconds(req.resolution),
    )

    # Aggregate analytics from the DTO dicts, computed BEFORE the store write so a
    # store failure still returns analysis (with run_id=None). Sweep child runs are
    # NOT persisted: the sweep drives the engine via _run_rule/_run_coded directly
    # and never calls this handler, so this block only runs for normal runs.
    trade_dicts = [t.model_dump() for t in trades_dto]
    analysis = compute_analysis(trade_dicts)

    run_id: str | None = uuid.uuid4().hex
    try:
        await RUN_STORE.insert({
            "id": run_id,
            "created_at": int(time.time()),
            "epic": req.epic,
            "timeframe": req.resolution,
            "range_from": int(candles[0].time.timestamp()) if candles else 0,
            "range_to": int(candles[-1].time.timestamp()) if candles else 0,
            "strategy_kind": "coded" if req.codedStrategy is not None else "rules",
            "strategy_name": req.codedStrategy,
            "request": req.model_dump(),
            "summary": {**summary, **metrics},
            "trades": trade_dicts,
        })
    except Exception:
        logger.warning("run-store write failed; continuing without run_id", exc_info=True)
        run_id = None

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
        trades=trades_dto,
        equity=[
            EquityDTO(time=_ts(p.time), value=p.equity)
            for p in result.equity
            if _ts(p.time) >= req.tradeFromTime
        ],
        summary=summary,
        metrics=metrics,
        by_leg={
            leg: leg_metrics(
                [t for t in result.trades if t.leg == leg],
                resolution_seconds(req.resolution),
                2 * req.costs.commissionPerSide,
            )
            for leg in ("long", "short")
        },
        fileBracketsOverridden=(
            strategy.file_brackets_overridden if req.codedStrategy is not None else False
        ),
        bar_traces=_bar_traces_dto(result, req.tradeFromTime) if req.inspect else None,
        run_id=run_id,
        analysis=analysis,
    )


# --- runs read API: list/get/delete persisted runs (see run_store.py) --------
# `GET /runs` is declared BEFORE `GET /runs/{run_id}` so the literal `/runs`
# path can't be shadowed by the path-param route.


@router.get("/api/backtest/runs")
async def list_runs(limit: int = 50, epic: str | None = None) -> list[dict]:
    """Recent persisted runs, newest first (summaries only — no trades)."""
    return await RUN_STORE.list(limit=limit, epic=epic)


@router.get("/api/backtest/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    """One stored run: config + trades (incl. MAE/MFE + context) + recomputed analysis."""
    rec = await RUN_STORE.get(run_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="run not found")
    rec["analysis"] = compute_analysis(rec["trades"])
    return rec


@router.delete("/api/backtest/runs/{run_id}")
async def delete_run(run_id: str) -> dict:
    """Remove one stored run (housekeeping)."""
    await RUN_STORE.delete(run_id)
    return {"ok": True}


def _bar_traces_dto(result: BacktestResult, trade_from_time: int) -> list[BarTraceDTO] | None:
    """Map the engine's per-bar traces to DTOs, keeping only bars in the trading
    window (time >= tradeFromTime, matching equity/markers). Returns None when the
    run produced no traces (e.g. a coded strategy, which has no rule groups)."""
    traces = [
        BarTraceDTO(
            time=t.time,
            groups=[
                BarGroupTraceDTO(
                    group=g.group,
                    combine=g.combine,
                    terms=[
                        InspectorTermDTO(
                            left=term.left_label, lval=term.left_val, op=term.op,
                            right=term.right_label, rval=term.right_val,
                            leftTf=term.left_tf, rightTf=term.right_tf, passed=term.passed,
                        )
                        for term in g.terms
                    ],
                    passed=g.passed,
                )
                for g in t.groups
            ],
            action=t.action,
            reason=t.reason,
            inPositionLong=t.in_position_long,
            inPositionShort=t.in_position_short,
            windowActive=t.window_active,
            warmedUp=t.warmed_up,
            spacingOk=t.spacing_ok,
        )
        for t in result.bar_traces
        if t.time >= trade_from_time
    ]
    return traces or None


# --- parameter/risk sweep: N coded runs sharing one HTF fetch cache ----------

_SWEEP_MAX_COMBOS = 50
_RISK_TARGET = re.compile(r"^risk:(long|short)\.(stop|target)\.(value|mult)$")
_RULE_TARGET = re.compile(
    r"^rule:(long|short)\.(entry|exit)\.(\d+)\.(?:(left|right)\.(length|value)|(count))$"
)


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


def _apply_rule_combo(req: BacktestRequest, combo: dict) -> BacktestRequest:
    """Return a copy of `req` with each combo target patched into the rule tree /
    risk DTO. Reuses `_apply_combo` for `risk:` keys. 422s a malformed or
    out-of-range path so a stale axis can't silently no-op."""
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
        m = _RULE_TARGET.match(target)
        if not m:
            raise HTTPException(422, f"bad sweep target '{target}'")
        side, grp, idx_s, operand, field, count = m.groups()
        rules = groups[(side, grp)]
        idx = int(idx_s)
        if idx >= len(rules):
            raise HTTPException(422, f"sweep target '{target}' index out of range")
        rule = rules[idx]
        if count:
            rules[idx] = rule.model_copy(update={"count": int(value)})
        else:
            op = getattr(rule, operand)
            rules[idx] = rule.model_copy(update={
                operand: op.model_copy(update={field: value})})
    _, long_risk, short_risk = _apply_combo(req, risk_combo)  # risk-only combo
    return req.model_copy(update={
        "longEntry": req.longEntry.model_copy(update={"rules": groups[("long", "entry")]}),
        "longExit": req.longExit.model_copy(update={"rules": groups[("long", "exit")]}),
        "shortEntry": req.shortEntry.model_copy(update={"rules": groups[("short", "entry")]}),
        "shortExit": req.shortExit.model_copy(update={"rules": groups[("short", "exit")]}),
        "longRisk": long_risk, "shortRisk": short_risk,
    })


@router.post("/api/backtest/sweep", response_model=SweepResponse)
async def backtest_sweep(req: BacktestRequest) -> SweepResponse:
    if req.sweep is None or not req.sweep.combos:
        raise HTTPException(422, "sweep.combos is required")
    if len(req.sweep.combos) > _SWEEP_MAX_COMBOS:
        raise HTTPException(422, f"too many combos in one request (max {_SWEEP_MAX_COMBOS})")

    candles = [_candle_from_dto(c) for c in req.candles]

    if req.codedStrategy is None:
        # Rule sweep: chart-operand (kind='series') keys are browser-supplied and
        # can't be recomputed server-side, so validate they're present once,
        # up front — then patch + recompute the whole series map per combo.
        # Un-swept native series (e.g. an EMA nobody is sweeping) still recompute
        # on every combo (build_rule_series dedupes only WITHIN one call's ops,
        # not across combos) — that's accepted for now; see task-7-brief note.
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
            for op in group.operands():
                if op.kind == "series" and series_name(op.to_operand()) not in req.series:
                    raise HTTPException(422, f"missing series '{series_name(op.to_operand())}'")
        # HTF set is combo-invariant (combos never sweep `timeframe`), so fetch
        # it once here and reuse for every combo — mirrors the coded branch's
        # shared htf_candles below.
        rule_htf_candles: dict[str, list[Candle]] = {}
        for tf in htf_timeframes(_rule_operands(req), req.resolution):
            warmup_from = req.candles[0].time - _HTF_WARMUP_BARS * resolution_seconds(tf)
            fetched = await deps._fetch_symbol_candles(
                req.broker, req.epic, tf, 1000, warmup_from, req.candles[-1].time, req.priceSide,
            )
            if not fetched:
                raise HTTPException(422, f"no candles for timeframe '{tf}'")
            rule_htf_candles[tf] = fetched
        rows: list[SweepRowDTO] = []
        for combo in req.sweep.combos:
            try:
                patched = _apply_rule_combo(req, combo)
                result = await _run_rule(patched, candles, htf_candles=rule_htf_candles)
            except HTTPException:
                raise                              # request-shaped problems fail the chunk
            except Exception as e:                 # noqa: BLE001 — one combo must not kill the rest
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

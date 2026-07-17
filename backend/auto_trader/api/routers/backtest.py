"""The rule-based backtest route."""

from __future__ import annotations

import logging
import time
import uuid
from types import ModuleType

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.core.run_store import RUN_STORE
from auto_trader.core.sweep_store import SWEEP_STORE
from auto_trader.engine.analysis import compute_analysis
from auto_trader.engine.backtest import BacktestResult
from auto_trader.engine.context_features import enrich_trades
from auto_trader.engine.cost_sense import breakeven_multiple
from auto_trader.engine.exit_time import attach_exit_times
from auto_trader.engine.whatif import enrich_trades_whatif
from auto_trader.engine.metrics import (
    compute_metrics, leg_metrics, leg_metrics_from_dicts,
)
from auto_trader.strategy import loader
from auto_trader.strategy.coded import StrategyRuntimeError
from auto_trader.strategy.loader import StrategyLoadError
from auto_trader.strategy.base import Strategy
from auto_trader.strategy.params import resolve_params, validate_params_schema
from auto_trader.strategy.rule import series_name
from auto_trader.strategy.rule_series import htf_timeframes

from .. import deps
from . import compute
from ..schemas import (
    BacktestRequest,
    BacktestResponse,
    BarGroupTraceDTO,
    BarTraceDTO,
    EquityDTO,
    InspectorTermDTO,
    MarkerDTO,
    RiskConfigDTO,
    SweepJobInfoDTO,
    SweepJobStatusResponse,
    SweepJobSubmitResponse,
    SweepRowDTO,
    TermDTO,
    TradeDTO,
)
from ..sweep_apply import (
    SweepValidationError,
    TimeframeNotPrefetched,
    apply_combo,
    apply_env_combo,
    apply_rule_combo,
    candle_from_dto,
    run_coded_sync,
    run_rule_sync,
    split_env_combo,
    sweep_row,
    _MAX_TF_PASSES,
    _rule_operands,
)
from ..sweep_jobs import JOBS
from .charts import _ts

# Extra HTF bars to fetch BEFORE the base window's start so ad-hoc tf= indicators
# warm up. Without it an HTF EMA/SMA seeds from the first in-window bar and reports
# a wrong (but non-None) value — silently diverging from the chart and from the
# same strategy in a longer-windowed run. Generous enough to converge any
# reasonable length; the align step still gates each HTF bar to its close (no
# lookahead), so over-fetching older bars only helps warm-up, never leaks future.
_HTF_WARMUP_BARS = 300

logger = logging.getLogger(__name__)

router = APIRouter()


async def _fetch_rule_htf(req: BacktestRequest) -> dict[str, list[Candle]]:
    """Fetch the higher-timeframe candle set a rule run references (combo-
    invariant: combos never sweep `timeframe`). 422s when a needed tf has no
    candles. The pure series assembly lives in `assemble_rule_series_sync`."""
    htf_candles: dict[str, list[Candle]] = {}
    for tf in htf_timeframes(_rule_operands(req), req.resolution):
        warmup_from = req.candles[0].time - _HTF_WARMUP_BARS * resolution_seconds(tf)
        fetched = await deps._fetch_symbol_candles(
            req.broker, req.epic, tf, 1000, warmup_from, req.candles[-1].time, req.priceSide,
        )
        if not fetched:
            raise HTTPException(422, f"no candles for timeframe '{tf}'")
        htf_candles[tf] = fetched
    return htf_candles


async def _run_rule(
    req: BacktestRequest, candles: list[Candle],
    htf_candles: dict[str, list[Candle]] | None = None,
) -> BacktestResult:
    """Thin async wrapper: own the HTF fetch (single-run callers omit
    `htf_candles`; sweep callers pass a pre-fetched, combo-shared dict), then
    run the pure `run_rule_sync` core."""
    if htf_candles is None:
        htf_candles = await _fetch_rule_htf(req)
    return run_rule_sync(req, candles, htf_candles)


async def _run_coded(
    req: BacktestRequest, candles: list[Candle], module: ModuleType,
    resolved_params: dict, long_risk_dto: RiskConfigDTO | None,
    short_risk_dto: RiskConfigDTO | None, htf_candles: dict[str, list[Candle]],
) -> tuple[BacktestResult, Strategy]:
    """Thin async wrapper: run the pure `run_coded_sync` core, fetching each
    timeframe it reports missing and calling again (mutating htf_candles so
    repeat combos skip the fetch). Bounded to `_MAX_TF_PASSES` fetches, matching
    the old in-loop cap. A `StrategyRuntimeError` from the strategy itself is NOT
    caught here: it propagates so callers can choose how to surface it (a single
    request 422s; a sweep isolates it to one row)."""
    for _ in range(_MAX_TF_PASSES):
        try:
            return run_coded_sync(
                req, candles, module, resolved_params,
                long_risk_dto, short_risk_dto, htf_candles,
            )
        except TimeframeNotPrefetched as need:
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

    candles = [candle_from_dto(c) for c in req.candles]
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

    # Resolve the sub-bar exit time of intra-bar stop/target exits from the run's
    # own 1-minute candles. Display only; best-effort (a fetch failure or missing
    # minute data just leaves exit_time_exact None).
    run_s = resolution_seconds(req.resolution)

    async def _load_minutes(from_s: int, to_s: int) -> list[Candle]:
        return await deps._fetch_symbol_candles(
            req.broker, req.epic, "MINUTE", (to_s - from_s) // 60 + 2, from_s, to_s,
            req.priceSide,
        )

    try:
        await attach_exit_times(result.trades, run_tf_seconds=run_s, load_minutes=_load_minutes)
    except Exception:
        logger.warning("exit-time resolution failed; continuing without it", exc_info=True)

    try:
        enrich_trades_whatif(result.trades, candles)
    except Exception:
        logger.warning("what-if enrichment failed; continuing without it",
                       exc_info=True)

    # Cost sensitivity (single runs only): re-run the engine at 0x/2x/3x costs.
    # The 1x point is the run we already have. Slippage and per-side commission
    # scale together; breakeven_multiple interpolates the zero crossing.
    cost_sensitivity = None
    if req.costSensitivity and req.sweep is None:
        multiples = [0.0, 1.0, 2.0, 3.0]
        # Nothing to scale (zero assumed costs) or no trades: every multiple
        # lands on the same net, so skip the re-runs entirely.
        # atrMult only bites when the slippage model is in "atr" mode, mirroring
        # the engine wiring (slippage_atr_mult=... if kind == "atr" else 0.0). A
        # stale atrMult on a "fixed" model contributes nothing, so it must not
        # make an otherwise-zero cost profile look non-zero.
        eff_atr_mult = req.costs.slippage.atrMult if req.costs.slippage.kind == "atr" else 0.0
        zero_costs = (
            req.costs.slippage.value == 0 and eff_atr_mult == 0
            and req.costs.commissionPerSide == 0 and req.costs.spread == 0
            and req.costs.finLongDailyPct == 0 and req.costs.finShortDailyPct == 0
        )
        if zero_costs or result.n_trades == 0:
            nets: list[float] = [result.net_pnl] * 4
        else:
            nets = []
            for m in multiples:
                if m == 1.0:
                    nets.append(result.net_pnl)
                    continue
                scaled = req.model_copy(update={
                    "inspect": False,
                    "costs": req.costs.model_copy(update={
                        "slippage": req.costs.slippage.model_copy(update={
                            "value": req.costs.slippage.value * m,
                            "atrMult": req.costs.slippage.atrMult * m,
                        }),
                        "commissionPerSide": req.costs.commissionPerSide * m,
                        "spread": req.costs.spread * m,
                        "finLongDailyPct": req.costs.finLongDailyPct * m,
                        "finShortDailyPct": req.costs.finShortDailyPct * m,
                    }),
                })
                if req.codedStrategy is not None:
                    r, _ = await _run_coded(scaled, candles, module, resolved_params,
                                            req.longRisk, req.shortRisk, dict(htf_candles))
                else:
                    r = await _run_rule(scaled, candles)
                nets.append(r.net_pnl)
        cost_sensitivity = {
            "multiples": multiples,
            "net_pnl": [round(n, 5) for n in nets],
            "breakeven_multiple": breakeven_multiple(multiples, nets),
        }

    trades_dto = [
        TradeDTO(
            side=t.side.value,
            quantity=t.quantity,
            entry_time=_ts(t.entry_time),
            entry_price=t.entry_price,
            exit_time=_ts(t.exit_time),
            exit_time_exact=_ts(t.exit_time_exact) if t.exit_time_exact is not None else None,
            exit_price=t.exit_price,
            pnl=t.pnl,
            leg=t.leg,
            reason=t.reason_out,
            stop_initial=t.stop_initial,
            stop_final=t.stop_final,
            target=t.target,
            mae=t.mae, mfe=t.mfe, mae_r=t.mae_r, mfe_r=t.mfe_r, context=t.context,
            bars_held=t.bars_held, bars_in_profit=t.bars_in_profit,
            bars_in_loss=t.bars_in_loss, body_through=t.body_through,
            wick_from_profit=t.wick_from_profit, wick_from_loss=t.wick_from_loss,
            longest_profit_streak=t.longest_profit_streak,
            longest_loss_streak=t.longest_loss_streak,
            bars_to_mfe=t.bars_to_mfe, bars_to_mae=t.bars_to_mae,
            entry_crossings=t.entry_crossings,
            whatif=t.whatif,
            financing=t.financing,
        )
        for t in result.trades
    ]
    summary = result.summary()
    metrics = compute_metrics(
        result.trades, result.equity, result.net_pnl,
        req.costs.startingCash, resolution_seconds(req.resolution),
        financing_total=result.financing_total,
    )

    # Aggregate analytics from the DTO dicts, computed BEFORE the store write so a
    # store failure still returns analysis (with run_id=None). Sweep child runs are
    # NOT persisted: the sweep drives the engine via _run_rule/_run_coded directly
    # and never calls this handler, so this block only runs for normal runs.
    trade_dicts = [t.model_dump() for t in trades_dto]
    analysis = compute_analysis(trade_dicts)

    # Re-derivable market data stays out of the store — epic/timeframe/range
    # columns suffice to re-fetch it, and the raw candles + indicator series are
    # bulky. A sweep-shaped request should never reach this single-run handler,
    # but if one does, don't persist it as a normal run.
    request_dump = req.model_dump()
    for bulky in ("candles", "series", "sweep"):
        request_dump.pop(bulky, None)

    run_id: str | None = None if req.sweep is not None else uuid.uuid4().hex
    if run_id is not None:
        try:
            await RUN_STORE.insert({
                "id": run_id,
                "created_at": int(time.time()),
                "epic": req.epic,
                "timeframe": req.resolution,
                "range_from": int(candles[0].time.timestamp()),
                "range_to": int(candles[-1].time.timestamp()),
                "strategy_kind": "coded" if req.codedStrategy is not None else "rules",
                "strategy_name": req.codedStrategy,
                "request": request_dump,
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
        cost_sensitivity=cost_sensitivity,
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
    res_seconds = resolution_seconds(rec["timeframe"])
    commission = (rec.get("request") or {}).get("costs", {}).get("commissionPerSide", 0.0)
    rec["by_leg"] = {
        leg: leg_metrics_from_dicts(
            [t for t in rec["trades"] if (t.get("leg") or "long") == leg],
            res_seconds, 2 * commission,
        )
        for leg in ("long", "short")
    }
    return rec


@router.delete("/api/backtest/runs/{run_id}")
async def delete_run(run_id: str) -> dict:
    """Remove one stored run (housekeeping)."""
    await RUN_STORE.delete(run_id)
    return {"ok": True}


# --- sweep archive API: persist/list/get/delete completed sweeps -------------
# The frontend posts the finished result set (axes + rows + windows) explicitly,
# so this works identically for local and remote jobs. `GET /sweeps` is declared
# BEFORE `GET /sweeps/{sweep_id}` so the literal path can't be shadowed.


class SweepArchiveIn(BaseModel):
    epic: str
    timeframe: str
    name: str | None = None
    axes: list[dict]
    rows: list[dict]
    windows: list[int] | None = None


@router.post("/api/backtest/sweeps")
async def save_sweep(body: SweepArchiveIn) -> dict:
    """Archive a completed sweep (axes verbatim + rows + optional windows)."""
    sweep_id = uuid.uuid4().hex
    await SWEEP_STORE.insert({
        "id": sweep_id, "created_at": int(time.time()),
        "epic": body.epic, "timeframe": body.timeframe, "name": body.name,
        "axes": body.axes, "rows": body.rows, "windows": body.windows,
    })
    return {"id": sweep_id}


@router.get("/api/backtest/sweeps")
async def list_sweeps(limit: int = 50, epic: str | None = None) -> list[dict]:
    """Recent archived sweeps, newest first (summaries only — no rows/axes)."""
    return await SWEEP_STORE.list(limit=limit, epic=epic)


@router.get("/api/backtest/sweeps/{sweep_id}")
async def get_sweep(sweep_id: str) -> dict:
    """One archived sweep: axes + rows + windows, ready to reopen."""
    rec = await SWEEP_STORE.get(sweep_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="sweep not found")
    return rec


@router.delete("/api/backtest/sweeps/{sweep_id}")
async def delete_sweep(sweep_id: str) -> dict:
    """Remove one archived sweep (housekeeping)."""
    await SWEEP_STORE.delete(sweep_id)
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


# --- parameter/risk sweep jobs: submit / poll / cancel / list -----------------
# The whole combo grid is submitted as ONE background job (sweep_jobs.JOBS); the
# frontend polls for rows with a cursor. All request-shaped problems 422 at
# submit; per-combo failures become error rows inside the job.


def _validate_combo_targets(
    req: BacktestRequest, candles: list[Candle], coded: bool,
) -> None:
    """Dry-apply every combo's patches (no engine run) so a malformed target on
    ANY combo 422s the submit synchronously, matching the old chunk endpoint
    where a bad target failed the whole chunk. Cheap: pydantic model copies
    only. Combo VALUES the engine rejects later (e.g. an out-of-range param)
    are not checked here; they isolate to their row's error."""
    try:
        for combo in req.sweep.combos:
            env, rest = split_env_combo(combo)
            patched, _ = apply_env_combo(req, candles, env)
            if coded:
                apply_combo(patched, rest)
            else:
                apply_rule_combo(patched, rest)
    except SweepValidationError as e:
        raise HTTPException(e.status_code, e.detail)


@router.post("/api/backtest/sweep/jobs", response_model=SweepJobSubmitResponse)
async def submit_sweep_job(req: BacktestRequest, target: str = "local"):
    # target=remote forwards the raw request to the remote compute host BEFORE any
    # local validation/probe/job creation: the remote host owns all of that.
    if target == "remote":
        return await compute.forward(
            "POST", "/api/backtest/sweep/jobs", json_body=req.model_dump(mode="json"),
        )
    if req.sweep is None or not req.sweep.combos:
        raise HTTPException(422, "sweep.combos is required")
    bounds = req.sweep.windows
    if bounds is not None and (
        len(bounds) < 2 or any(b <= a for a, b in zip(bounds, bounds[1:]))
    ):
        raise HTTPException(422, "sweep.windows must be >= 2 ascending epoch seconds")

    candles = [candle_from_dto(c) for c in req.candles]
    combos = req.sweep.combos
    coded = req.codedStrategy is not None

    if not coded:
        # Rule sweep: chart-operand (kind='series') keys are browser-supplied
        # and can't be recomputed server-side, so validate they're present
        # (and aligned to the candles, same as the single-run route) once,
        # up front — a short series would silently stop rules firing mid-run.
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
            for op in group.operands():
                if op.kind != "series":
                    continue
                name = series_name(op.to_operand())
                arr = req.series.get(name)
                if arr is None:
                    raise HTTPException(422, f"missing series '{name}'")
                if len(arr) != len(req.candles):
                    raise HTTPException(
                        422, f"series '{name}' length {len(arr)} != candles length {len(req.candles)}")
    else:
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
        for combo in combos:
            for target in combo:
                if target.startswith("param:") and target[len("param:"):] not in declared:
                    raise HTTPException(
                        422, f"sweep target '{target}' names a param the strategy does not declare")

    _validate_combo_targets(req, candles, coded)

    if coded:
        # Probe: run combos[0] in-request with a fresh HTF cache. It discovers
        # and fetches every NeedTimeframe tf the strategy asks for, so the pool
        # workers (which do zero network) inherit a fully-populated dict. A
        # request-shaped failure 422s the submit; anything else becomes the
        # probe combo's error row and the job carries on with the rest.
        htf_candles: dict[str, list[Candle]] = {}
        probe_combo = combos[0]
        try:
            env, rest = split_env_combo(probe_combo)
            patched_req, combo_candles = apply_env_combo(req, candles, env)
            params_sent, long_risk, short_risk = apply_combo(patched_req, rest)
            resolved = resolve_params(module, params_sent)
            result, _ = await _run_coded(
                patched_req, combo_candles, module, resolved, long_risk, short_risk, htf_candles,
            )
            probe_row = sweep_row(req, probe_combo, result).model_dump()
        except HTTPException:
            raise
        except SweepValidationError as e:
            raise HTTPException(e.status_code, e.detail)
        except Exception as e:  # noqa: BLE001  one combo must not kill the job
            probe_row = SweepRowDTO(combo=probe_combo, error=str(e)).model_dump()
        pool_combos = combos[1:]
        mode = "coded"
    else:
        # HTF set is combo-invariant (combos never sweep `timeframe`): fetch it
        # once here and ship it to every worker.
        htf_candles = await _fetch_rule_htf(req)
        probe_row = None
        pool_combos = combos
        mode = "rule"

    logger.info("sweep %s %s: %d combos (%s mode)",
                req.epic, req.resolution, len(combos), mode)
    job = JOBS.submit(
        req_dict=req.model_dump(mode="json"),
        htf_candles=htf_candles,
        strategies_dir=str(loader.STRATEGIES_DIR) if coded else None,
        windows=req.sweep.windows,
        combos=pool_combos,
        epic=req.epic,
        timeframe=req.resolution,
        probe_row=probe_row,
    )
    return SweepJobSubmitResponse(jobId=job.job_id, total=job.total)


# Declared BEFORE the {job_id} route so the literal `/jobs` path can't be
# shadowed by the path-param route.
@router.get("/api/backtest/sweep/jobs", response_model=list[SweepJobInfoDTO])
async def list_sweep_jobs() -> list[SweepJobInfoDTO]:
    return [
        SweepJobInfoDTO(
            jobId=j.job_id, epic=j.epic, timeframe=j.timeframe,
            done=j.done, total=j.total, running=j.running, createdAt=j.created_at,
        )
        for j in JOBS.list()
    ]


@router.get("/api/backtest/sweep/jobs/{job_id}", response_model=SweepJobStatusResponse)
async def sweep_job_status(job_id: str, cursor: int = 0, target: str = "local"):
    if target == "remote":
        return await compute.forward(
            "GET", f"/api/backtest/sweep/jobs/{job_id}", params={"cursor": cursor},
        )
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "sweep job not found")
    cursor = max(0, cursor)  # a cursor past the end just yields no rows
    return SweepJobStatusResponse(
        rows=job.rows[cursor:],
        done=job.done,
        total=job.total,
        running=job.running,
        cancelled=job.cancelled,
        error=job.error,
        etaSeconds=job.eta_seconds,
    )


@router.post("/api/backtest/sweep/jobs/{job_id}/cancel")
async def cancel_sweep_job(job_id: str, target: str = "local"):
    if target == "remote":
        return await compute.forward(
            "POST", f"/api/backtest/sweep/jobs/{job_id}/cancel",
        )
    if JOBS.get(job_id) is None:
        raise HTTPException(404, "sweep job not found")
    JOBS.cancel(job_id)  # idempotent: cancelling a finished job is a no-op
    return {"ok": True}

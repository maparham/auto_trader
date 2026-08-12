"""The rule-based backtest route."""

from __future__ import annotations

import asyncio
import dataclasses
import datetime as dt
import logging
import time
import uuid
from types import ModuleType
from typing import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.core import progress as pr
from auto_trader.core.run_store import RUN_STORE
from auto_trader.core.sweep_store import SWEEP_STORE
from auto_trader.core.wfo_store import WFO_STORE
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

from .. import deps
from . import compute
from ..schemas import (
    BacktestRequest,
    BacktestResponse,
    EquityDTO,
    MarkerDTO,
    RiskConfigDTO,
    SweepJobInfoDTO,
    SweepJobStatusResponse,
    SweepJobSubmitResponse,
    SweepRowDTO,
    TermDTO,
    TradeDTO,
    WfoJobStatusResponse,
    WfoJobSubmitResponse,
    axis_dicts,
)
from ..sweep_apply import (
    SweepValidationError,
    TimeframeNotPrefetched,
    apply_combo,
    apply_env_combo,
    candle_from_dto,
    htf_from_dto,
    htf_to_dto,
    run_coded_sync,
    split_env_combo,
    sweep_row,
    ts_seconds as _ts,
    _MAX_TF_PASSES,
)
from ..sweep_jobs import JOBS
from ..wfo_jobs import WFO_JOBS
from ..wfo_plan import WfoPlanError, parse_span, plan as wfo_plan

# Extra HTF bars to fetch BEFORE the base window's start so ad-hoc tf= indicators
# warm up. Without it an HTF EMA/SMA seeds from the first in-window bar and reports
# a wrong (but non-None) value — silently diverging from the chart and from the
# same strategy in a longer-windowed run. Generous enough to converge any
# reasonable length; the align step still gates each HTF bar to its close (no
# lookahead), so over-fetching older bars only helps warm-up, never leaks future.
_HTF_WARMUP_BARS = 300

logger = logging.getLogger(__name__)

router = APIRouter()


async def _run_coded(
    req: BacktestRequest, candles: list[Candle], module: ModuleType,
    resolved_params: dict, long_risk_dto: RiskConfigDTO | None,
    short_risk_dto: RiskConfigDTO | None, htf_candles: dict[str, list[Candle]],
    on_progress: Callable[[int, int], None] | None = None,
) -> tuple[BacktestResult, Strategy]:
    """Thin async wrapper: run the pure `run_coded_sync` core, fetching each
    timeframe it reports missing and calling again (mutating htf_candles so
    repeat combos skip the fetch). Bounded to `_MAX_TF_PASSES` fetches, matching
    the old in-loop cap. A `StrategyRuntimeError` from the strategy itself is NOT
    caught here: it propagates so callers can choose how to surface it (a single
    request 422s; a sweep isolates it to one row)."""
    for _ in range(_MAX_TF_PASSES):
        try:
            # to_thread: the engine is CPU-bound sync; on the loop thread it
            # would starve every other request — including the progress polls
            # this callback exists to feed.
            return await asyncio.to_thread(
                run_coded_sync, req, candles, module, resolved_params,
                long_risk_dto, short_risk_dto, htf_candles,
                on_progress=on_progress,
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
    ignores the entry groups; only panel risk applies for series checks).
    Covers: posted-series length (without the length check, a series shorter
    than the candles silently reads None past the array end instead of 422ing)
    and ATR-kind panel risk's missing-series guard (I4 — without this, a
    missing ATR series silently yields a stop-less trade instead of the 422
    rule mode gets). Coded exit rules are now expressions validated at compile
    time (expr parse/validate), so their operand series are no longer checked
    here. Runs whenever codedStrategy is set. Shared by the single-run and
    sweep routes."""
    for name, arr in req.series.items():
        if len(arr) != len(req.candles):
            raise HTTPException(
                422, f"series '{name}' length {len(arr)} != candles length {len(req.candles)}"
            )
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

    _validate_coded_exit_series(req)

    candles = [candle_from_dto(c) for c in req.candles]
    try:
        module = loader.load_strategy(req.codedStrategy, loader.STRATEGIES_DIR)
    except StrategyLoadError as e:
        raise HTTPException(422, str(e))
    try:
        resolved_params = resolve_params(module, req.codedParams)
    except ValueError as e:
        raise HTTPException(422, str(e))
    htf_candles: dict[str, list[Candle]] = {}

    # Cosmetic progress reporting: the frontend polls
    # GET /api/backtest/progress/{id} while this POST is in flight. Registered
    # only once the run is about to start, so the validation 422s above (which
    # the finally below doesn't cover) can't leak an entry.
    on_progress: Callable[[int, int], None] | None = None
    if req.progressId:
        pid = req.progressId
        pr.set_progress(pid, stage="simulate")
        on_progress = lambda done, total: pr.update_progress(pid, done, total)
    try:
        try:
            result, strategy = await _run_coded(
                req, candles, module, resolved_params, req.longRisk, req.shortRisk, htf_candles,
                on_progress=on_progress,
            )
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
                # Re-runs are engine passes too: relabel the stage so it stays
                # distinguishable in the wire payload (GET /api/backtest/progress/{id}).
                if req.progressId:
                    pr.set_progress(req.progressId, stage="cost-sensitivity")
                nets = []
                for m in multiples:
                    if m == 1.0:
                        nets.append(result.net_pnl)
                        continue
                    scaled = req.model_copy(update={
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
                    r, _ = await _run_coded(scaled, candles, module, resolved_params,
                                            req.longRisk, req.shortRisk, dict(htf_candles),
                                            on_progress=on_progress)
                    nets.append(r.net_pnl)
            cost_sensitivity = {
                "multiples": multiples,
                "net_pnl": [round(n, 5) for n in nets],
                "breakeven_multiple": breakeven_multiple(multiples, nets),
            }

        trades_dto = _trades_to_dto(result)
        summary = result.summary()
        metrics = compute_metrics(
            result.trades, result.equity, result.net_pnl,
            req.costs.startingCash, resolution_seconds(req.resolution),
            financing_total=result.financing_total,
        )

        # Aggregate analytics from the DTO dicts, computed BEFORE the store write so a
        # store failure still returns analysis (with run_id=None). Sweep child runs are
        # NOT persisted: the sweep drives the engine via _run_coded directly
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
        # Per-run ephemeral: the client's progress id means nothing to a stored run.
        request_dump.pop("progressId", None)

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

        return _result_to_response(
            result,
            epic=req.epic,
            resolution=req.resolution,
            candles_window=window,
            trade_from_time=req.tradeFromTime,
            starting_cash=req.costs.startingCash,
            commission_per_side=req.costs.commissionPerSide,
            file_brackets_overridden=(
                strategy.file_brackets_overridden if req.codedStrategy is not None else False
            ),
            run_id=run_id,
            analysis=analysis,
            cost_sensitivity=cost_sensitivity,
            trades_dto=trades_dto,
            summary=summary,
            metrics=metrics,
        )
    finally:
        if req.progressId:
            pr.clear_progress(req.progressId)


def _trades_to_dto(result: BacktestResult) -> list[TradeDTO]:
    """Map engine Trades to wire DTOs. Pure; shared by the structured and expr
    serializers (and by the structured handler's store/analysis step)."""
    return [
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


def _result_to_response(
    result: BacktestResult,
    *,
    epic: str,
    resolution: str,
    candles_window: list,
    trade_from_time: int,
    starting_cash: float,
    commission_per_side: float,
    file_brackets_overridden: bool = False,
    run_id: str | None = None,
    analysis: dict | None = None,
    cost_sensitivity: dict | None = None,
    trades_dto: list[TradeDTO] | None = None,
    summary: dict | None = None,
    metrics: dict | None = None,
) -> BacktestResponse:
    """Serialize a BacktestResult into a BacktestResponse. Shared by the
    structured `/api/backtest` handler and the expression `/api/expr/backtest`
    handler. `trades_dto`/`summary`/`metrics` may be passed in when the caller
    already computed them (the structured handler needs them for the run-store
    write); otherwise they are computed here."""
    if trades_dto is None:
        trades_dto = _trades_to_dto(result)
    if summary is None:
        summary = result.summary()
    if metrics is None:
        metrics = compute_metrics(
            result.trades, result.equity, result.net_pnl,
            starting_cash, resolution_seconds(resolution),
            financing_total=result.financing_total,
        )
    return BacktestResponse(
        epic=epic,
        resolution=resolution,
        candles=candles_window,
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
            if _ts(p.time) >= trade_from_time
        ],
        summary=summary,
        metrics=metrics,
        by_leg={
            leg: leg_metrics(
                [t for t in result.trades if t.leg == leg],
                resolution_seconds(resolution),
                2 * commission_per_side,
            )
            for leg in ("long", "short")
        },
        fileBracketsOverridden=file_brackets_overridden,
        run_id=run_id,
        analysis=analysis,
        cost_sensitivity=cost_sensitivity,
    )


# --- runs read API: list/get/delete persisted runs (see run_store.py) --------
# `GET /runs` is declared BEFORE `GET /runs/{run_id}` so the literal `/runs`
# path can't be shadowed by the path-param route.


@router.get("/api/backtest/progress/{progress_id}")
async def backtest_progress(progress_id: str) -> dict:
    """Simulate-phase progress for an in-flight POST /api/backtest run. 404
    once the run finishes (the handler clears its entry in a finally)."""
    entry = pr.get_progress(progress_id)
    if entry is None:
        raise HTTPException(404, "no such run")
    return entry


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


# --- parameter/risk sweep jobs: submit / poll / cancel / list -----------------
# The whole combo grid is submitted as ONE background job (sweep_jobs.JOBS); the
# frontend polls for rows with a cursor. All request-shaped problems 422 at
# submit; per-combo failures become error rows inside the job.


def _validate_combo_targets(
    req: BacktestRequest, candles: list[Candle], coded: bool,
    combos: list[dict] | None = None,
) -> None:
    """Dry-apply every combo's patches (no engine run) so a malformed target on
    ANY combo 422s the submit synchronously, matching the old chunk endpoint
    where a bad target failed the whole chunk. Cheap: pydantic model copies
    only. Combo VALUES the engine rejects later (e.g. an out-of-range param)
    are not checked here; they isolate to their row's error. `combos` defaults
    to the sweep's list; the WFO submit passes its own."""
    combos = combos if combos is not None else req.sweep.combos
    try:
        for combo in combos:
            env, rest = split_env_combo(combo)
            patched, _ = apply_env_combo(req, candles, env)
            apply_combo(patched, rest)
    except SweepValidationError as e:
        raise HTTPException(e.status_code, e.detail)


async def _prefetch_sweep_htf(
    req: BacktestRequest, candles: list[Candle], coded: bool,
    combos: list[dict] | None = None,
) -> dict[str, list[Candle]]:
    """Fetch (through the local cache) the full higher-timeframe set a sweep needs,
    so it can be SHIPPED to the remote compute host in req.htfCandles — the remote
    then runs on provided bars and never calls a broker. Rule mode: the combo-
    invariant HTF set. Coded mode: run combos[0] as a discovery probe, letting its
    tf= calls pull each referenced timeframe into the dict (best-effort — if that
    probe combo errors mid-run we ship what it gathered; the remote re-validates
    and any still-missing tf trips the compute-host guard loudly). `combos`
    defaults to the sweep's list; the WFO remote path passes its own."""
    combos = combos if combos is not None else req.sweep.combos
    try:
        module = loader.load_strategy(req.codedStrategy, loader.STRATEGIES_DIR)
    except StrategyLoadError as e:
        raise HTTPException(422, str(e))
    htf: dict[str, list[Candle]] = {}
    env, rest = split_env_combo(combos[0])
    patched_req, combo_candles = apply_env_combo(req, candles, env)
    try:
        params_sent, long_risk, short_risk = apply_combo(patched_req, rest)
        resolved = resolve_params(module, params_sent)
        await _run_coded(
            patched_req, combo_candles, module, resolved, long_risk, short_risk, htf,
        )
    except HTTPException:
        raise
    except SweepValidationError as e:
        raise HTTPException(e.status_code, e.detail)
    except Exception:  # noqa: BLE001  discovery is best-effort; ship what we gathered
        pass
    return htf


@router.post("/api/backtest/sweep/jobs", response_model=SweepJobSubmitResponse)
async def submit_sweep_job(req: BacktestRequest, target: str = "local"):
    # target=remote: the remote compute host owns validation/probe/job creation, but
    # it must never fetch bars from a broker (COMPUTE_ONLY blocks that). So the local
    # backend fills req.htfCandles from ITS cache here, THEN forwards; the remote runs
    # purely on shipped data. Bars the request already carries (base candles, chart
    # series, and htfCandles if a client pre-shipped) ride along untouched.
    if target == "remote":
        if req.sweep is not None and req.sweep.combos and req.htfCandles is None:
            candles = [candle_from_dto(c) for c in req.candles]
            htf = await _prefetch_sweep_htf(req, candles, req.codedStrategy is not None)
            req = req.model_copy(update={"htfCandles": htf_to_dto(htf)})
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

    # Shipped by the local proxy for a remote run (req.htfCandles): use those bars
    # verbatim and never fetch — on a COMPUTE_ONLY host a fetch would be blocked
    # anyway. None on a normal local run: acquire the set below as before.
    shipped_htf = htf_from_dto(req.htfCandles) if req.htfCandles is not None else None

    # Probe: run combos[0] in-request. With shipped HTF it uses those bars; else
    # it discovers and fetches every NeedTimeframe tf the strategy asks for, so
    # the pool workers (which do zero network) inherit a fully-populated dict. A
    # request-shaped failure 422s the submit; anything else becomes the probe
    # combo's error row and the job carries on with the rest.
    htf_candles: dict[str, list[Candle]] = shipped_htf if shipped_htf is not None else {}
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

    logger.info("sweep %s %s: %d combos (coded mode)",
                req.epic, req.resolution, len(combos))
    job = JOBS.submit(
        # htfCandles ships to workers via htf_candles= below; excluding it from the
        # per-worker req_dict avoids pickling the whole HTF set twice into every
        # worker's init payload (the worker reads s.htf, never req.htfCandles).
        req_dict=req.model_dump(mode="json", exclude={"htfCandles"}),
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


# --- walk-forward optimization jobs: submit / poll / cancel / fold / archive ---
# One WFO run is submitted as ONE background meta-job (wfo_jobs.WFO_JOBS): phase
# 1 runs the combo grid, phase 2 tests each fold's selected winner, phase 3
# aggregates. All request-shaped problems 422 at submit; the frontend polls
# status (streamed winner rows via a cursor) and fetches per-fold ranking
# tables lazily. A completed job auto-persists to WFO_STORE for the archive.


async def _prefetch_wfo_htf(
    req: BacktestRequest, candles: list[Candle]
) -> dict[str, list[Candle]]:
    """HTF prefetch for a remote WFO submit: same discovery as the sweep path but
    over the walkforward combo list, so the shipped set covers combos[0]'s tf=
    calls (rule mode fetches the combo-invariant set)."""
    return await _prefetch_sweep_htf(
        req, candles, req.codedStrategy is not None, combos=req.walkforward.combos,
    )


def _persist_wfo(req: BacktestRequest):
    """Build the on_complete callback that archives a finished WFO job. Slimmed
    like run_store: bulky re-derivable market data (candles/series/htfCandles)
    stays out of the stored request. Wrapped in try/except so a store failure
    can never mark a completed job as errored."""
    slim = req.model_dump(mode="json", exclude={"candles", "series", "htfCandles"})

    def _cb(job) -> None:
        try:
            WFO_STORE.insert_sync({
                "id": job.job_id, "created_at": int(job.created_at),
                "epic": job.epic, "timeframe": job.timeframe, "name": None,
                "request": slim, "result": job.result,
                "fold_tables": job.fold_tables,
            })
        except Exception:  # noqa: BLE001  persistence must not kill the job thread
            logger.exception("wfo persist failed for %s", job.job_id)

    return _cb


def _plan_wfo_schemes(wf, res_s: int, range_from: int, range_to: int,
                      first_candle: int) -> list[dict]:
    """Plan every scheme's folds and verify history reaches the earliest train
    window. 422s (HTTPException) on a plan error or insufficient history. Shared
    by the structured and expression WFO submit endpoints."""
    spans = [wf.schedule.trainSpan, *wf.matrixTrainSpans]
    seen: set[str] = set()
    schemes: list[dict] = []
    try:
        test_s = parse_span(wf.schedule.testSpan, res_s)
        step_s = parse_span(wf.schedule.step, res_s) if wf.schedule.step else test_s
        for span in spans:
            if span in seen:
                continue
            seen.add(span)
            train_s = parse_span(span, res_s)
            folds = wfo_plan(range_from, range_to, wf.schedule.mode, train_s, test_s, step_s)
            schemes.append({
                "train_span": span,
                "folds": [dataclasses.asdict(f) for f in folds],
                "min_train_trades": wf.schedule.minTrainTrades,
                "min_test_trades": wf.schedule.minTestTrades,
            })
    except WfoPlanError as e:
        raise HTTPException(422, str(e))
    for sc in schemes:
        earliest = min(f["train_from"] for f in sc["folds"])
        if first_candle > earliest:
            needs = dt.datetime.fromtimestamp(earliest, dt.timezone.utc).date().isoformat()
            raise HTTPException(
                422, f"not enough history for the {sc['train_span']} scheme: "
                     f"needs data from {needs}")
    return schemes


def _validate_wfo_combo_hygiene(wf) -> None:
    """Reject a range axis with no ordered values, and any period:/timeWindow:
    target in a combo (fold windows own the period). Shared, mode-agnostic."""
    for ax in wf.axes:
        if ax.kind == "range" and not ax.values:
            raise HTTPException(
                422, f"range axis '{ax.targets[0] if ax.targets else ''}' "
                     "needs its ordered values")
    for combo in wf.combos:
        for tgt in combo:
            if tgt.startswith("period:") or tgt.startswith("timeWindow:"):
                raise HTTPException(
                    422, "walk-forward combos must not contain period:/timeWindow: "
                         "targets (fold windows own the period)")


@router.post("/api/backtest/walkforward/jobs", response_model=WfoJobSubmitResponse)
async def submit_wfo_job(req: BacktestRequest, target: str = "local"):
    # target=remote: fill req.htfCandles from the LOCAL cache, then forward
    # verbatim — the COMPUTE_ONLY remote host runs on shipped bars and never
    # fetches from a broker (mirrors submit_sweep_job).
    if target == "remote":
        if (req.walkforward is not None and req.walkforward.combos
                and req.htfCandles is None):
            candles = [candle_from_dto(c) for c in req.candles]
            htf = await _prefetch_wfo_htf(req, candles)
            req = req.model_copy(update={"htfCandles": htf_to_dto(htf)})
        return await compute.forward(
            "POST", "/api/backtest/walkforward/jobs", json_body=req.model_dump(mode="json"),
        )

    wf = req.walkforward
    if wf is None or not wf.combos:
        raise HTTPException(422, "walkforward.combos is required")
    if not req.candles:
        raise HTTPException(422, "candles are required")

    # Plan every scheme's folds from the request's own date range, then verify the
    # posted candles reach back to the earliest train window. `plan()` is only ever
    # fed parse_span outputs (always > 0), so its no-step<=0-guard is never tripped
    # from here.
    res_s = resolution_seconds(req.resolution)
    schemes = _plan_wfo_schemes(wf, res_s, req.tradeFromTime, req.candles[-1].time,
                                req.candles[0].time)

    candles = [candle_from_dto(c) for c in req.candles]
    coded = req.codedStrategy is not None

    # Same per-mode validation as the sweep submit.
    _validate_coded_exit_series(req)
    try:
        module = loader.load_strategy(req.codedStrategy, loader.STRATEGIES_DIR)
    except StrategyLoadError as e:
        raise HTTPException(422, str(e))
    meta = getattr(module, "meta", None)
    declared = {p["name"] for p in validate_params_schema(meta if isinstance(meta, dict) else None)}
    for combo in wf.combos:
        for tgt in combo:
            if tgt.startswith("param:") and tgt[len("param:"):] not in declared:
                raise HTTPException(
                    422, f"sweep target '{tgt}' names a param the strategy does not declare")

    # A range axis with no ordered values would crash at aggregate time, and a
    # period:/timeWindow: combo target would silently fight the test-window slicing
    # (the fold windows own the period). Reject both up front.
    _validate_wfo_combo_hygiene(wf)

    _validate_combo_targets(req, candles, coded, combos=wf.combos)

    # HTF acquisition mirrors submit_sweep_job. Coded mode runs combos[0] as an
    # in-request discovery probe to populate htf_candles (result discarded — WFO
    # has no probe row); rule mode fetches the combo-invariant set once.
    shipped_htf = htf_from_dto(req.htfCandles) if req.htfCandles is not None else None
    htf_candles: dict[str, list[Candle]] = shipped_htf if shipped_htf is not None else {}
    try:
        env, rest = split_env_combo(wf.combos[0])
        patched_req, combo_candles = apply_env_combo(req, candles, env)
        params_sent, long_risk, short_risk = apply_combo(patched_req, rest)
        resolved = resolve_params(module, params_sent)
        await _run_coded(
            patched_req, combo_candles, module, resolved,
            long_risk, short_risk, htf_candles,
        )
    except HTTPException:
        raise
    except SweepValidationError as e:
        raise HTTPException(e.status_code, e.detail)
    except Exception:  # noqa: BLE001  discovery is best-effort; workers re-raise per row
        pass

    logger.info("wfo %s %s: %d combos, %d scheme(s) (coded mode)",
                req.epic, req.resolution, len(wf.combos), len(schemes))
    job = WFO_JOBS.submit(
        req_dict=req.model_dump(mode="json", exclude={"htfCandles"}),
        htf_candles=htf_candles,
        strategies_dir=str(loader.STRATEGIES_DIR) if coded else None,
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
        eval_mode=wf.evalMode,
        on_complete=_persist_wfo(req),
    )
    # Build the response from OUR pre-submit scheme copy, selecting only the 4
    # window keys — the orchestrator mutates the passed fold dicts (adds a "_w"
    # union index), so never echo those dicts wholesale.
    return WfoJobSubmitResponse(
        jobId=job.job_id, total=job.total,
        schemes=[{"trainSpan": s["train_span"],
                  "folds": [{k: f[k] for k in
                             ("train_from", "train_to", "test_from", "test_to")}
                            for f in s["folds"]]}
                 for s in schemes])


# Declared BEFORE the {job_id} route so the literal `/jobs` sub-paths can't be
# shadowed by the path-param route.
@router.get("/api/backtest/walkforward/jobs/{job_id}", response_model=WfoJobStatusResponse)
async def wfo_job_status(job_id: str, cursor: int = 0, target: str = "local"):
    if target == "remote":
        return await compute.forward(
            "GET", f"/api/backtest/walkforward/jobs/{job_id}", params={"cursor": cursor},
        )
    job = WFO_JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "wfo job not found")
    cursor = max(0, cursor)  # a cursor past the end just yields no rows
    return WfoJobStatusResponse(
        phase=job.phase,
        done=job.done,
        total=job.total,
        running=job.running,
        cancelled=job.cancelled,
        error=job.error,
        etaSeconds=job.eta_seconds,
        foldRows=job.fold_rows[cursor:],
        result=job.result if job.phase == "done" else None,
    )


@router.post("/api/backtest/walkforward/jobs/{job_id}/cancel")
async def cancel_wfo_job(job_id: str, target: str = "local"):
    if target == "remote":
        return await compute.forward(
            "POST", f"/api/backtest/walkforward/jobs/{job_id}/cancel",
        )
    if WFO_JOBS.get(job_id) is None:
        raise HTTPException(404, "wfo job not found")
    WFO_JOBS.cancel(job_id)  # idempotent: cancelling a finished job is a no-op
    return {"ok": True}


@router.get("/api/backtest/walkforward/jobs/{job_id}/fold")
async def wfo_job_fold(job_id: str, key: str, target: str = "local"):
    """Lazy per-fold ranking table (key like 's0/f1'). Query param avoids the
    slash a path segment would choke on."""
    if target == "remote":
        return await compute.forward(
            "GET", f"/api/backtest/walkforward/jobs/{job_id}/fold", params={"key": key},
        )
    job = WFO_JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "wfo job not found")
    rows = job.fold_tables.get(key)
    if rows is None:
        raise HTTPException(404, "fold table not found")
    return {"rows": rows}


# --- walk-forward archive: list/get/tables/delete persisted jobs -------------
# Archive endpoints are local-only (no remote forwarding): a completed job
# auto-persists on whichever host ran it, matching the sweep-archive split.
# `GET /archive` is declared BEFORE `/archive/{wfo_id}` so the literal path
# can't be shadowed.


@router.get("/api/backtest/walkforward/archive")
async def list_wfo(limit: int = 50, epic: str | None = None) -> list[dict]:
    """Recent archived WFO jobs, newest first (summaries only)."""
    return await WFO_STORE.list(limit=limit, epic=epic)


@router.get("/api/backtest/walkforward/archive/{wfo_id}")
async def get_wfo(wfo_id: str) -> dict:
    """One archived WFO job: request config + full result."""
    rec = await WFO_STORE.get(wfo_id)
    if rec is None:
        raise HTTPException(404, "wfo job not found")
    return rec


@router.get("/api/backtest/walkforward/archive/{wfo_id}/tables")
async def get_wfo_tables(wfo_id: str) -> dict:
    """The per-fold ranking tables for an archived job (lazy, bulky)."""
    tables = await WFO_STORE.get_fold_tables(wfo_id)
    if tables is None:
        raise HTTPException(404, "wfo job not found")
    return tables


@router.delete("/api/backtest/walkforward/archive/{wfo_id}")
async def delete_wfo(wfo_id: str) -> dict:
    """Remove one archived WFO job (housekeeping)."""
    await WFO_STORE.delete(wfo_id)
    return {"ok": True}

"""The rule-based backtest route."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.engine.metrics import compute_metrics
from auto_trader.strategy import loader
from auto_trader.strategy.coded import CodedStrategy, NeedTimeframe, StrategyRuntimeError
from auto_trader.strategy.loader import StrategyLoadError
from auto_trader.strategy.rule import RuleStrategy, series_name

from .. import deps
from ..schemas import (
    BacktestRequest,
    BacktestResponse,
    CandleDTO,
    EquityDTO,
    MarkerDTO,
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

    candles = [_candle_from_dto(c) for c in req.candles]
    if req.codedStrategy is not None:
        try:
            module = loader.load_strategy(req.codedStrategy, loader.STRATEGIES_DIR)
        except StrategyLoadError as e:
            raise HTTPException(422, str(e))
        htf_candles: dict[str, list[Candle]] = {}
        for _ in range(_MAX_TF_PASSES):
            strategy = CodedStrategy(
                module, candles, quantity=req.costs.quantity,
                trade_from_time=req.tradeFromTime, htf_candles=htf_candles,
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
                break
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
            except StrategyRuntimeError as e:
                raise HTTPException(422, str(e))
        else:
            raise HTTPException(422, "strategy needs too many timeframes (max 5)")
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
    )

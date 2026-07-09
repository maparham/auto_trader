"""POST /api/strategy/evaluate — one-bar live decision layer.

Reuses RuleStrategy for signals and engine.risk for bracket levels. RuleStrategy
emits an entry every bar its rule holds (the open/reject gate lives in the
backtest engine, which live does not run), so this layer gates entries against
the reconciled netted position: entry+flat -> open, entry+held -> skip (no
scale-in), exit -> close. One position per side (netted); no hedging.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle, Side
from auto_trader.engine.risk import stop_level, target_level
from auto_trader.strategy.base import Context, Strategy
from auto_trader.strategy.coded import (
    CodedStrategy,
    CodedWithRuleExits,
    NeedTimeframe,
    StrategyRuntimeError,
)
from auto_trader.strategy.params import resolve_params
from auto_trader.strategy.rule import RuleStrategy, series_name
from auto_trader.strategy import loader
from auto_trader.strategy.loader import StrategyLoadError

from .. import deps
from ..schemas import ActionDTO, EvaluateRequest, EvaluateResponse, RuleGroupDTO

router = APIRouter()

# Cap on fetch-retry passes for a coded strategy's ad-hoc tf= calls (Task 15).
_MAX_TF_PASSES = 5

# Extra HTF bars to fetch BEFORE the base window's start so ad-hoc tf= indicators
# warm up. The live loop seeds only ~500 base bars, so on a low base TF the raw
# tf= window can be a handful of HTF bars — an EMA/SMA would seed from those and
# report a wrong (non-None) value fed straight into a live decision. Matches the
# backtest route's warm-up; the align step still gates each HTF bar to its close
# (no lookahead), so older bars only help warm-up.
_HTF_WARMUP_BARS = 300


def _candle(c) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(c.time, tz=timezone.utc),
        open=c.open, high=c.high, low=c.low, close=c.close, volume=c.volume,
    )


def _atr(spec, series: dict[str, list[float | None]], i: int) -> float | None:
    """Latest ATR value for an atr/trailAtr spec, or None."""
    if spec.kind not in ("atr", "trailAtr") or spec.length is None:
        return None
    arr = series.get(f"ATR_{spec.length}", [])
    return arr[i] if 0 <= i < len(arr) else None


@router.post("/api/strategy/evaluate", response_model=EvaluateResponse)
async def evaluate_strategy(req: EvaluateRequest) -> EvaluateResponse:
    if not req.candles:
        raise HTTPException(422, "candles must not be empty")
    for name, arr in req.series.items():
        if len(arr) != len(req.candles):
            raise HTTPException(
                422, f"series '{name}' length {len(arr)} != candles length {len(req.candles)}"
            )

    if req.codedStrategy is None:
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
            for op in group.operands():
                name = series_name(op.to_operand())
                if name is not None and name not in req.series:
                    raise HTTPException(422, f"missing series '{name}' referenced by a rule")
    else:
        # Coded run: series-shaped checks a pure rule run gets, mirrored here
        # because coded runs skip the rule-mode validation block above (coded
        # ignores the entry groups; only panel exit rules + panel risk apply).
        # Runs whenever codedStrategy is set, not only when exit rules exist
        # (I4 — ATR-kind panel risk with a missing ATR series must 422 too).
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

    candles = [_candle(c) for c in req.candles]
    i = len(candles) - 1

    # Netted position -> at most one side held.
    pos_long = req.position.quantity if req.position and req.position.side == "buy" else 0.0
    pos_short = req.position.quantity if req.position and req.position.side == "sell" else 0.0

    if req.codedStrategy is not None:
        try:
            module = loader.load_strategy(req.codedStrategy, loader.STRATEGIES_DIR)
        except StrategyLoadError as e:
            raise HTTPException(422, str(e))
        meta = getattr(module, "meta", None)
        if isinstance(meta, dict) and meta.get("hedged"):
            raise HTTPException(
                422, f"'{req.codedStrategy}' is hedged — backtest-only, refused for live"
            )
        try:
            resolved_params = resolve_params(module, req.codedParams)
        except ValueError as e:
            raise HTTPException(422, str(e))
    else:
        strategy = RuleStrategy(
            req.longEntry.to_group(), req.longExit.to_group(),
            req.shortEntry.to_group(), req.shortExit.to_group(),
            req.series, quantity=1.0, trade_from_time=None,
            long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
        )

    ctx = Context()
    ctx.history = candles
    ctx.position_long = pos_long
    ctx.position_short = pos_short
    # Seed the held side's entry price + open time so exit rules can reference the
    # `entry` operand and count occurrences since entry (mirrors the backtest
    # engine). Entry price is the position's open level.
    if req.position is not None:
        entry_price = req.position.open_level
        entry_time = (
            datetime.fromtimestamp(req.position.open_time, tz=timezone.utc)
            if req.position.open_time is not None
            else None
        )
        if pos_long > 0:
            ctx.long_entry_price = entry_price
            ctx.long_entry_time = entry_time
        elif pos_short > 0:
            ctx.short_entry_price = entry_price
            ctx.short_entry_time = entry_time

    if req.codedStrategy is not None:
        panel_risk_legs = frozenset(
            leg for leg, r in (("long", req.longRisk), ("short", req.shortRisk))
            if r is not None and r.is_configured()
        )
        htf_candles: dict[str, list[Candle]] = {}
        for _ in range(_MAX_TF_PASSES):
            strategy: Strategy = CodedStrategy(
                module, candles, quantity=1.0, htf_candles=htf_candles,
                base_timeframe=req.resolution, params=resolved_params,
                panel_risk_legs=panel_risk_legs,
            )
            if req.longExit.rules or req.shortExit.rules:
                empty = RuleGroupDTO(combine="AND", rules=[]).to_group()
                strategy = CodedWithRuleExits(strategy, RuleStrategy(
                    empty, req.longExit.to_group(), empty, req.shortExit.to_group(),
                    req.series, quantity=1.0,
                    long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
                    base_timeframe=req.resolution,
                ))
            try:
                signals = strategy.on_bar(ctx)
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
        try:
            signals = strategy.on_bar(ctx)
        except StrategyRuntimeError as e:
            raise HTTPException(422, str(e))

    close = candles[-1].close
    any_held = pos_long > 0 or pos_short > 0

    # Netted, single position per epic+account: emit AT MOST ONE book-changing
    # action. A close (exit of the held side) takes priority — it flattens the
    # book this bar; any entry then waits until the next bar when flat. While flat,
    # only the FIRST entry opens (if both long and short fire, the other is a
    # no-op until flat again — no hedging, no scale-in).
    open_action: ActionDTO | None = None
    close_action: ActionDTO | None = None
    for sig in signals:
        is_open = (
            (sig.leg == "long" and sig.side == Side.BUY)
            or (sig.leg == "short" and sig.side == Side.SELL)
        )
        if is_open:
            if any_held or open_action is not None:
                continue  # already holding (no scale-in) or already opening this bar
            risk = req.longRisk if sig.leg == "long" else req.shortRisk
            stop = tp = None
            if sig.stop_level is not None or sig.target_level is not None:
                stop, tp = sig.stop_level, sig.target_level
            elif risk is not None:
                stop = stop_level(
                    risk.stop.to_spec(), close, sig.leg, _atr(risk.stop, req.series, i), close
                )
                tp = target_level(
                    risk.target.to_spec(), close, sig.leg, _atr(risk.target, req.series, i)
                )
            open_action = ActionDTO(
                kind="open", leg=sig.leg, side=sig.side.value, reason=sig.reason,
                stop_level=stop, take_profit_level=tp,
                quantity=sig.quantity if sig.quantity_explicit else None,
            )
        else:
            held = pos_long if sig.leg == "long" else pos_short
            if held > 0 and close_action is None:
                close_action = ActionDTO(
                    kind="close", leg=sig.leg, side=sig.side.value, reason=sig.reason,
                )

    if close_action is not None:
        return EvaluateResponse(actions=[close_action])
    if open_action is not None:
        return EvaluateResponse(actions=[open_action])
    return EvaluateResponse(actions=[])

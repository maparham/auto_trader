"""Baseline variants of an expression backtest request.

Coded strategy runs convert to expr requests first via expr_request_from_structured,
then synthesize null/hold baselines using the same machinery.

Null: entry rules replaced by `1==1` on each ENABLED side; everything else
(exits, risk, scaling, session mask, costs, sides) identical. Isolates what
the entry signal contributes over "always in". Note: baselines use the
request's base risk/exit settings; a sweep's per-combo risk or exit values are
not mirrored, so excess vs a swept winner also reflects those parameter
differences.

Hold: `1==1` entries with exits, risk, scaling, and mask stripped, so each
enabled side enters once and the engine's hold-until-window-end behavior
carries the position to the end. Measures the raw market through the same
cost model.

Both strip sweep/walkforward sub-objects: a baseline is always a single run.

model_copy is shallow on purpose: every field a baseline changes is replaced
wholesale via `update=`, and nothing downstream mutates the request in place,
so the candle payloads are shared rather than deep-copied per baseline kind.
"""
from __future__ import annotations

from auto_trader.api.schemas import BacktestRequest, ExprBacktestRequest, ExprRowDTO

_ALWAYS = [ExprRowDTO(expr="1==1", enabled=True)]


def null_request(req: ExprBacktestRequest) -> ExprBacktestRequest:
    up: dict = {"sweep": None, "walkforward": None, "progressId": None}
    if req.longEnabled:
        up["longEntry"] = list(_ALWAYS)
    if req.shortEnabled:
        up["shortEntry"] = list(_ALWAYS)
    return req.model_copy(update=up)


def hold_request(req: ExprBacktestRequest) -> ExprBacktestRequest:
    up: dict = {
        "sweep": None, "walkforward": None, "progressId": None,
        "longExit": [], "shortExit": [],
        "longRisk": None, "shortRisk": None,
        "longScaling": None, "shortScaling": None,
        "mask": None,
    }
    if req.longEnabled:
        up["longEntry"] = list(_ALWAYS)
    if req.shortEnabled:
        up["shortEntry"] = list(_ALWAYS)
    return req.model_copy(update=up)


def expr_request_from_structured(req: BacktestRequest) -> ExprBacktestRequest:
    """Panel-level expr equivalent of a structured (coded) request: same
    candles, costs, risk, scaling, mask, sides, brokers, indicators, and the
    panel exit rules; EMPTY entry groups (null/hold synthesizers fill them).
    Logic inside the coded strategy file (on_bar exits, dynamic sizing) is
    not represented: that is exactly the point of the coded null baseline.
    `series` is dropped (the expr pipeline computes its own risk series)."""
    return ExprBacktestRequest(
        epic=req.epic, resolution=req.resolution, candles=req.candles,
        htfCandles=req.htfCandles, broker=req.broker, priceSide=req.priceSide,
        longEntry=[], shortEntry=[],
        longExit=req.exprLongExit, shortExit=req.exprShortExit,
        longExitCombine=req.exprLongExitCombine,
        shortExitCombine=req.exprShortExitCombine,
        longEnabled=req.longEnabled, shortEnabled=req.shortEnabled,
        longRisk=req.longRisk, shortRisk=req.shortRisk,
        longScaling=req.longScaling, shortScaling=req.shortScaling,
        costs=req.costs, tradeFromTime=req.tradeFromTime, mask=req.mask,
        indicators=req.indicators,
    )

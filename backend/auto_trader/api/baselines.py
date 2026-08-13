"""Baseline variants of an expression backtest request.

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

from auto_trader.api.schemas import ExprBacktestRequest, ExprRowDTO

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

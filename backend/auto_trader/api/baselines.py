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

Reversed: the mirror-image strategy. Every side-specific field swaps
wholesale (entries, exits, combines, risk, scaling, enabled flags), so each
long decision becomes the corresponding short decision and vice versa, still
governed by its own risk/exit config. A long-only strategy reversed is
short-only. If Reversed materially beats the real run the signal is
anti-predictive; if both lose, costs/timing are the problem, not direction.

Null and hold run PER SIDE (see side_request): with both sides enabled, a
1==1 entry on each side is always-in long AND short at once — a hedge worth
exactly minus the costs whatever the market did, useless as a reference. Each
enabled side runs alone instead ("null_long"/"hold_short"...); the engine's
legs are independent buckets, so the per-side runs' returns sum to what the
combined hedged run would have reported.

All strip sweep/walkforward sub-objects: a baseline is always a single run.

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


# Every slot a baseline-aware response carries; unrun slots stay None.
EMPTY_BASELINES: dict = {
    "null_long": None, "null_short": None,
    "hold_long": None, "hold_short": None,
    "reversed": None,
    "oracle_entries": None,
}

# Kinds that are one whole run rather than a per-side pair: reversed flips the
# strategy wholesale; oracle_entries mixes directions by design (the planner
# corrects each trade's leg with hindsight), so a hedge can't arise from either.
_SINGLE_RUN_KINDS = frozenset({"reversed", "oracle_entries"})


def baseline_runs(kinds, long_on: bool, short_on: bool) -> list[tuple[str, str, str | None]]:
    """Expand requested kinds into concrete engine passes as
    (slot, kind, leg): null/hold run once per active side ("null_long", ...);
    reversed/oracle_entries are one run each (leg None). De-dupes
    repeated kinds."""
    out: list[tuple[str, str, str | None]] = []
    for kind in dict.fromkeys(kinds):
        if kind in _SINGLE_RUN_KINDS:
            out.append((kind, kind, None))
        else:
            for leg, on in (("long", long_on), ("short", short_on)):
                if on:
                    out.append((f"{kind}_{leg}", kind, leg))
    return out


def oracle_blob(
    candles, trades, costs, *, res_seconds: int, on_progress=None,
) -> dict:
    """Plan and replay the oracle_entries baseline, returning the same
    metrics-blob shape as the other baselines (compute_metrics merged with
    summary()).

    The plan reuses the run's own trade entries with direction and exit
    corrected by hindsight (see engine/oracle.py). `candles` are core Candle
    objects; `trades` the main run's engine trades. Replaying through the real
    engine keeps the cost model, equity curve, and metrics identical to every
    other baseline."""
    from auto_trader.engine.metrics import compute_metrics
    from auto_trader.engine.oracle import plan_corrected, replay_planned

    slip = costs.slippage.value
    plans = plan_corrected(
        trades, candles, commission_per_side=costs.commissionPerSide,
        spread=costs.spread, slippage=slip)
    res = replay_planned(
        plans, candles,
        starting_cash=costs.startingCash,
        commission_per_side=costs.commissionPerSide,
        spread=costs.spread, slippage=slip,
        slippage_atr_mult=costs.slippage.atrMult if costs.slippage.kind == "atr" else 0.0,
        fin_long_daily_pct=costs.finLongDailyPct,
        fin_short_daily_pct=costs.finShortDailyPct,
        on_progress=on_progress,
    )
    return compute_metrics(
        res.trades, res.equity, res.net_pnl, costs.startingCash, res_seconds,
        financing_total=res.financing_total,
    ) | res.summary()


def side_request(req: ExprBacktestRequest, leg: str) -> ExprBacktestRequest:
    """Limit a request to one side, for per-side null/hold synthesis: only
    `leg` ("long" | "short") stays enabled. Compose as null_request(
    side_request(req, leg)) — the synthesizers fill enabled sides only."""
    return req.model_copy(update={
        "longEnabled": leg == "long", "shortEnabled": leg == "short",
    })


_SIDE_FIELDS = [
    ("longEntry", "shortEntry"), ("longExit", "shortExit"),
    ("longEntryCombine", "shortEntryCombine"),
    ("longExitCombine", "shortExitCombine"),
    ("longEnabled", "shortEnabled"),
    ("longRisk", "shortRisk"), ("longScaling", "shortScaling"),
]


def reversed_request(req: ExprBacktestRequest) -> ExprBacktestRequest:
    up: dict = {"sweep": None, "walkforward": None, "progressId": None}
    for long_f, short_f in _SIDE_FIELDS:
        up[long_f] = getattr(req, short_f)
        up[short_f] = getattr(req, long_f)
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

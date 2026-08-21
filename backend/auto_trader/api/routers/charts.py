"""Candle routes: native/synthetic candles and candle-cache stats."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from auto_trader.brokers.capital_stream import SECONDS_INTERVALS
from auto_trader.core.candle_aggregate import DERIVED, is_derived
from auto_trader.core.candle_cache import CANDLE_CACHE, active_backfills
from auto_trader.core.models import Candle, Resolution
from auto_trader.core.synthetic import SyntheticError, combine, symbols, parse

from .. import deps
from ..deps import _parse_resolution, broker_query
from ..schemas import (
    BackfillProgressDTO,
    CandleCacheGlobalStatsDTO,
    CandleCacheStatsDTO,
    CandleDTO,
)
from ..sweep_apply import candle_to_dto as _candle_dto

router = APIRouter()


# How long an interactive chart read may spend FILLING history before it serves
# what it has (see CandleCache.window). Coverage is contiguous, so a window
# deeper than the cache means a chunked download of everything in between: a year
# of 1m candles is ~175 sequential broker calls, minutes of them, holding that
# series' lock against every other read of it. The chart can ask again, and the
# chunks that landed are kept, so the cost of stopping early is a repeat request
# rather than lost work. Kept under the frontend's own 10s read deadline so a
# client that gives up first never sees the marker it could have acted on.
CHART_FILL_BUDGET_S = 8.0

# Deep-window pass-through cap for interactive chart reads: a window this many
# chunks (x 3000 bars) below cached coverage is served straight from the broker
# without the contiguous fill. 8 chunks = 24k bars (~80 days of 5m): nearer
# gaps are cheap to fill and keep the cache growing; deeper asks are peeks and
# should cost seconds, not a year of downloads.
CHART_PASSTHROUGH_MAX_FILL_CHUNKS = 8


def _mark_partial(response: Response, partial: dict) -> None:
    """Stamp the still-filling marker: the fill ran out of time, not out of luck.
    A separate header from X-Candles-Degraded on purpose. Degraded means the
    broker could not be reached and the payload may be permanently short; this
    means the download is simply unfinished and asking again gets more. Reading
    them as the same thing puts "Broker unreachable" in front of a user whose
    only problem is that they asked for a lot of history.

    The value is "<done>/<total>" chunks, not a sentence: the client turns it
    into progress, and a number it has to parse out of prose is a number that
    breaks the day the prose is reworded."""
    done = int(partial.get("done_chunks") or 0)
    total = int(partial.get("total_chunks") or 0)
    response.headers["X-Candles-Partial"] = f"{done}/{total}"


def _mark_degraded(response: Response, degraded: dict) -> None:
    """Stamp the degraded-serve marker header: the broker fetch failed but the
    cache served bars anyway, so the payload may be missing the unreachable
    portion (usually the most recent tail). Structural signal like
    X-Broker-Blocked — clients key off presence, the value is a debug hint.
    Header values must be latin-1: replace anything outside printable ASCII."""
    reason = degraded.get("reason") or "broker fetch failed"
    response.headers["X-Candles-Degraded"] = (
        "".join(ch if " " <= ch <= "~" else "?" for ch in reason)[:200] or "1"
    )


@router.get("/api/candles", response_model=list[CandleDTO])
async def candles(
    epic: str = Query("EURUSD"),
    resolution: str = Query(Resolution.MINUTE_5.value),
    bars: int = Query(500, ge=1, le=1000),
    from_ts: int | None = Query(None, description="window start, unix seconds"),
    to_ts: int | None = Query(None, description="window end, unix seconds"),
    price_side: str = Query("mid", alias="priceSide", pattern="^(bid|mid|ask)$"),
    broker_id: str = Depends(broker_query),
    response: Response = None,
) -> list[CandleDTO]:
    """Candles for an epic. With from_ts/to_ts -> that date window (used by the
    chart's scroll-back). Without -> most-recent `bars` (weekend-proof).

    Sub-minute (seconds) intervals have no history endpoint upstream, so they're
    served from our own tick recorder (warmed while the epic is streamed) and
    extended live over the socket. Scroll-back (from_ts/to_ts) isn't supported
    for them — the chart disables it for live-only intervals."""
    degraded: dict = {}
    partial: dict = {}
    loaded = await deps._fetch_symbol_candles(
        broker_id, epic, resolution, bars, from_ts, to_ts, price_side,
        degraded=degraded, budget_s=CHART_FILL_BUDGET_S, partial=partial,
        max_fill_chunks=CHART_PASSTHROUGH_MAX_FILL_CHUNKS,
    )
    if degraded and response is not None:
        _mark_degraded(response, degraded)
    if partial and response is not None:
        _mark_partial(response, partial)
    # A date window may legitimately be empty (market closed); only 404 when no
    # window was requested at all (likely a bad epic). Seconds resolutions are
    # exempt: an epic that isn't currently streamed has no tick history yet, and
    # that's a legitimate empty chart (200 []), not a 404 — the original seconds
    # branch never raised here.
    if not loaded and from_ts is None and resolution not in SECONDS_INTERVALS:
        raise HTTPException(404, f"no data for epic '{epic}' (unknown epic or no history)")
    return [_candle_dto(c) for c in loaded]


@router.get("/api/candles/synthetic", response_model=list[CandleDTO])
async def candles_synthetic(
    expr: str = Query(..., description="arithmetic expression, e.g. OIL_CRUDE/DXY"),
    resolution: str = Query(Resolution.MINUTE_5.value),
    bars: int = Query(500, ge=1, le=1000),
    from_ts: int | None = Query(None),
    to_ts: int | None = Query(None),
    price_side: str = Query("mid", alias="priceSide", pattern="^(bid|mid|ask)$"),
    broker_id: str = Depends(broker_query),
    response: Response = None,
) -> list[CandleDTO]:
    """Candles for a synthetic (arithmetic-combination) chart. Stateless: the raw
    expression is parsed here, each symbol is fetched via the shared candle path
    against the same broker, and the symbols are combined element-wise."""
    try:
        node = parse(expr)
    except SyntheticError as e:
        raise HTTPException(422, f"bad expression: {e}") from e
    names = symbols(node)
    if not names:
        raise HTTPException(422, "expression has no instruments")

    per_symbol: dict[str, list[Candle]] = {}
    degraded: dict = {}
    partial: dict = {}
    for name in names:
        # Reuse the native/derived/cache path per symbol; a symbol-level HTTPException
        # (unknown broker, IG-derived block) propagates unchanged. One shared
        # degraded dict: ANY symbol served short from cache marks the combined
        # result (the last reason wins — presence is the signal).
        per_symbol[name] = await deps._fetch_symbol_candles(
            broker_id, name, resolution, bars, from_ts, to_ts, price_side,
            degraded=degraded, budget_s=CHART_FILL_BUDGET_S, partial=partial,
        )
    if degraded and response is not None:
        _mark_degraded(response, degraded)
    # Per SYMBOL, one shared budget's worth each: a combination of three symbols
    # may take three budgets to answer. Bounding the request as a whole would mean
    # the last symbol never fills, and a synthetic series is only as deep as its
    # shallowest leg.
    if partial and response is not None:
        _mark_partial(response, partial)

    result = combine(node, per_symbol)
    if not result and from_ts is None:
        raise HTTPException(
            404, f"no data for synthetic '{expr}' (unknown symbol or no overlapping history)"
        )
    return [_candle_dto(c) for c in result]


@router.get("/api/candle-cache/stats", response_model=CandleCacheStatsDTO)
async def candle_cache_stats(
    epic: str = Query(...),
    resolution: str = Query(...),
    price_side: str = Query("mid", alias="priceSide", pattern="^(bid|mid|ask)$"),
    broker_id: str = Depends(broker_query),
) -> CandleCacheStatsDTO:
    """Read-only cache introspection for the chart's cache-stats badge/popover.
    Never touches the broker or mutates cache state."""
    if resolution in SECONDS_INTERVALS:
        # Sub-minute intervals are served from TICK_STORE, not CANDLE_CACHE.
        return CandleCacheStatsDTO(
            oldest_ts=None, newest_ts=None, cached_bar_count=0,
            hits=0, misses=0, last_fetch_ts=None,
        )
    if is_derived(resolution):
        rule = DERIVED.get(resolution)
        if rule is None:
            raise HTTPException(422, f"unknown resolution '{resolution}'")
        # The cache only ever stores base-resolution bars (derived views are folded
        # on read, see candle_aggregate.fold) — so a derived timeframe's stats
        # intentionally report the base series' coverage/hits, not a per-derived-view
        # figure. Every derived view over the same base reports identical numbers.
        res_value = rule.base.value
    else:
        res_value = _parse_resolution(resolution).value
    key = (broker_id, epic, res_value, price_side)
    stats = await asyncio.to_thread(CANDLE_CACHE.stats, key)
    return CandleCacheStatsDTO(**stats)


@router.get("/api/candle-cache/stats/global", response_model=CandleCacheGlobalStatsDTO)
async def candle_cache_global_stats() -> CandleCacheGlobalStatsDTO:
    """Cache-wide introspection (all series) for the cache-stats popover."""
    stats = await asyncio.to_thread(CANDLE_CACHE.global_stats)
    return CandleCacheGlobalStatsDTO(**stats)


@router.get("/api/candle-cache/backfill/active", response_model=list[BackfillProgressDTO])
async def active_backfill_progress() -> list[BackfillProgressDTO]:
    """In-flight multi-chunk backfills (the 'downloading data' phase of a
    backtest run). Cosmetic, best-effort: entries appear only for multi-chunk
    walks and vanish when the walk ends."""
    return [
        BackfillProgressDTO(
            label=e["label"], doneChunks=e["done_chunks"],
            totalChunks=e["total_chunks"], bars=e["bars"],
            elapsedS=e["elapsed_s"], etaS=e["eta_s"], at=e["at"],
        )
        for e in active_backfills()
    ]

"""Candle routes: native/synthetic candles and candle-cache stats."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

from auto_trader.brokers.capital_stream import SECONDS_INTERVALS
from auto_trader.core.candle_aggregate import DERIVED, is_derived
from auto_trader.core.candle_cache import CANDLE_CACHE
from auto_trader.core.models import Candle, Resolution
from auto_trader.core.synthetic import SyntheticError, combine, legs, parse

from .. import deps
from ..deps import _parse_resolution
from ..schemas import (
    CandleCacheGlobalStatsDTO,
    CandleCacheStatsDTO,
    CandleDTO,
)

router = APIRouter()


def _ts(dt: datetime) -> int:
    return int(dt.timestamp())


def _candle_dto(c: Candle) -> CandleDTO:
    return CandleDTO(
        time=_ts(c.time),
        open=c.open,
        high=c.high,
        low=c.low,
        close=c.close,
        volume=c.volume,
    )


@router.get("/api/candles", response_model=list[CandleDTO])
async def candles(
    epic: str = Query("EURUSD"),
    resolution: str = Query(Resolution.MINUTE_5.value),
    bars: int = Query(500, ge=1, le=1000),
    from_ts: int | None = Query(None, description="window start, unix seconds"),
    to_ts: int | None = Query(None, description="window end, unix seconds"),
    price_side: str = Query("mid", alias="priceSide", pattern="^(bid|mid|ask)$"),
    broker_id: str = Query("capital", alias="broker"),
) -> list[CandleDTO]:
    """Candles for an epic. With from_ts/to_ts -> that date window (used by the
    chart's scroll-back). Without -> most-recent `bars` (weekend-proof).

    Sub-minute (seconds) intervals have no history endpoint upstream, so they're
    served from our own tick recorder (warmed while the epic is streamed) and
    extended live over the socket. Scroll-back (from_ts/to_ts) isn't supported
    for them — the chart disables it for live-only intervals."""
    loaded = await deps._fetch_leg_candles(broker_id, epic, resolution, bars, from_ts, to_ts, price_side)
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
    broker_id: str = Query("capital", alias="broker"),
) -> list[CandleDTO]:
    """Candles for a synthetic (arithmetic-combination) chart. Stateless: the raw
    expression is parsed here, each leg is fetched via the shared candle path
    against the same broker, and the legs are combined element-wise."""
    try:
        node = parse(expr)
    except SyntheticError as e:
        raise HTTPException(422, f"bad expression: {e}") from e
    names = legs(node)
    if not names:
        raise HTTPException(422, "expression has no instruments")

    per_leg: dict[str, list[Candle]] = {}
    for name in names:
        # Reuse the native/derived/cache path per leg; a leg-level HTTPException
        # (unknown broker, IG-derived block) propagates unchanged.
        per_leg[name] = await deps._fetch_leg_candles(
            broker_id, name, resolution, bars, from_ts, to_ts, price_side
        )

    result = combine(node, per_leg)
    if not result and from_ts is None:
        raise HTTPException(
            404, f"no data for synthetic '{expr}' (unknown leg or no overlapping history)"
        )
    return [_candle_dto(c) for c in result]


@router.get("/api/candle-cache/stats", response_model=CandleCacheStatsDTO)
async def candle_cache_stats(
    epic: str = Query(...),
    resolution: str = Query(...),
    price_side: str = Query("mid", alias="priceSide", pattern="^(bid|mid|ask)$"),
    broker_id: str = Query("capital", alias="broker"),
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

"""Preset pattern scan and user-preset CRUD. The scan walks the charts the
FRONTEND enumerates (it knows the open tabs; the server does not), reporting
per-chart status so an empty chart is never silent. Built-in families run
the pivot-grammar detector; "user:<id>" families run the shipped similarity
pipeline with the saved selection as the query."""

from __future__ import annotations

import asyncio
import time

import numpy as np
from fastapi import APIRouter, HTTPException, Request

from auto_trader.core.pattern_matchers import MATCHERS
from auto_trader.core.pattern_presets import (
    FAMILIES, PARAM_SCHEMAS, Hit, resolve_params, scan_series,
)
from auto_trader.core.pattern_preset_store import PRESET_STORE
from auto_trader.core.pattern_series import PATTERN_SERIES

from .. import deps
from ..schemas import (
    PatternHitDTO, PatternPresetCreateBody,
    PatternPresetRenameBody, PatternScanChartResultDTO, PatternScanRequest,
    PatternScanResponse,
)
from .patterns import _bars, _search_mode

router = APIRouter()

_TITLES = {"hns": "Head & Shoulders", "double": "Double Top / Bottom",
           "broadening": "Broadening / Megaphone", "triangle": "Triangles & Wedges"}
# One scan at a time, like backtests and sweeps: a second request while one
# runs is a client bug or an impatient double-click, not a queueing need.
_scan_lock = asyncio.Lock()

# How near the live edge a similarity hit must end to badge as forming, and
# how many matches per chart a user preset reports.
_EDGE_BARS = 2
_USER_TOP_K = 3
_USER_MAX_DISTANCE = 1.6


@router.get("/api/patterns/families")
async def list_families() -> dict:
    return {"families": [
        {"family": f, "title": _TITLES[f], "params": PARAM_SCHEMAS[f]}
        for f in FAMILIES
    ]}


def _hit_dto(h: Hit, series, offset: float) -> PatternHitDTO:
    inst = h.instance
    rows = _bars(series, inst.start, inst.end - inst.start + 1, offset)
    return PatternHitDTO(
        family=inst.family, variant=inst.variant, forming=inst.forming,
        ts=rows[0].ts, end_ts=rows[-1].ts, distance=h.distance,
        direction=inst.direction, breakout_up_pct=h.breakout_up_pct,
        # scan_series ran on UN-centred prices, so the target is already at
        # real price level — do not add the offset again.
        target=h.target,
        tell=inst.tell, source=h.source, bars=rows,
    )


async def _scan_chart(broker: str, side: str, epic: str, resolution: str,
                      builtins: list[tuple[str, dict]],
                      presets: list[dict]) -> PatternScanChartResultDTO:
    series = await PATTERN_SERIES.get(broker, epic, resolution, side)
    if series is None:
        return PatternScanChartResultDTO(epic=epic, resolution=resolution,
                                         status="no-history")
    if series.bars < 30:
        return PatternScanChartResultDTO(epic=epic, resolution=resolution,
                                         status="too-few-bars")
    hits: list[PatternHitDTO] = []
    if builtins:
        raw = await asyncio.to_thread(scan_series, series.ohlc + series.offset, builtins)
        hits += [_hit_dto(h, series, series.offset) for h in raw]
    for preset in presets:
        query = np.array([[b["o"], b["h"], b["l"], b["c"]] for b in preset["bars"]],
                         dtype=np.float64)
        if len(query) > series.bars or query[:, 3].std() <= 1e-12:
            continue
        span = float(preset["bars"][-1]["ts"] - preset["bars"][0]["ts"])
        # Cross-timeframe rescale, mirroring routers/patterns.py's own
        # search endpoint (~lines 170-186): a preset saved off one chart's
        # timeframe scanned against a COARSER series naturally spans more
        # wall clock per window, which is a property of the timeframe, not
        # a gap for the span rule to reject — unscaled it zeroes out every
        # coarser series. Scale by the bar-interval ratio (medians, so a
        # weekend gap on either side doesn't skew it); coarser only, since a
        # finer series is already forgiven by the rule as-is.
        p_steps = np.diff(np.array([b["ts"] for b in preset["bars"]], dtype=np.float64))
        p_steps = p_steps[p_steps > 0]
        if len(p_steps) and series.bars > 1:
            origin_step = float(np.median(p_steps))
            target_step = float(np.median(np.diff(series.ts)))
            if target_step > origin_step > 0:
                span *= target_step / origin_step
        found, _ = await asyncio.to_thread(
            _search_mode, MATCHERS["shape"], series, query,
            query_span=span, top_k=_USER_TOP_K, forward_bars=0,
        )
        for m in found:
            if m.distance > _USER_MAX_DISTANCE:
                continue
            rows = _bars(series, m.start, m.length, series.offset)
            forming = m.start + m.length >= series.bars - _EDGE_BARS
            hits.append(PatternHitDTO(
                family=f"user:{preset['id']}", variant=preset["name"],
                forming=forming, ts=rows[0].ts, end_ts=rows[-1].ts,
                distance=m.distance, direction=0, bars=rows,
            ))
    hits.sort(key=lambda h: (not h.forming, h.ts))
    return PatternScanChartResultDTO(epic=epic, resolution=resolution,
                                     status="ok", hits=hits)


@router.post("/api/patterns/scan", response_model=PatternScanResponse)
async def scan_patterns(req: PatternScanRequest, request: Request) -> PatternScanResponse:
    t0 = time.perf_counter()
    broker = deps.resolve_broker(request, req.broker)
    user = deps.current_user(request)

    builtins: list[tuple[str, dict]] = []
    presets: list[dict] = []
    for fam in req.families:
        if fam.family.startswith("user:"):
            preset = await PRESET_STORE.get(user, fam.family[5:])
            if preset is None:
                raise HTTPException(404, f"no saved preset '{fam.family[5:]}'")
            presets.append(preset)
        else:
            try:
                builtins.append((fam.family, resolve_params(fam.family, fam.params)))
            except ValueError as e:
                raise HTTPException(400, str(e))

    # Non-blocking check-and-acquire, restructured from the previous
    # `if locked(): 409` / `async with lock:` pair for explicitness rather
    # than a behavior change: `_scan_lock.locked()` and `acquire()` below run
    # back to back with NO `await` between them, and `Lock.acquire()` on an
    # UNLOCKED lock resolves synchronously (no internal suspension) — so
    # asyncio's cooperative scheduler has no point at which it could switch
    # to another request's coroutine between the check and the acquire; the
    # pair is already atomic as written. (This is a real property to protect
    # by keeping the two lines adjacent with nothing async between them —
    # NOT by reaching for `asyncio.wait_for(_scan_lock.acquire(), timeout=0)`,
    # which looks more "explicitly atomic" but is broken: CPython's wait_for
    # special-cases timeout<=0 by wrapping the awaitable in a fresh Task and
    # cancelling it before it ever runs its first step, so it raises
    # TimeoutError unconditionally, even when the lock is completely free.
    # Verified empirically — do not reintroduce it.) The tests below cover
    # the held-lock 409 path and an overlapping-call path so a future change
    # that inserts an `await` here (logging, a metrics call, anything) and
    # reopens a real race gets caught.
    if _scan_lock.locked():
        raise HTTPException(409, "a pattern scan is already running")
    await _scan_lock.acquire()
    try:
        # Bounded concurrency: cold series loads hit sqlite; four at a time
        # matches the frontend's own similarity fan-out pool.
        sem = asyncio.Semaphore(4)

        async def one(c) -> PatternScanChartResultDTO:
            async with sem:
                try:
                    return await _scan_chart(broker, req.price_side,
                                             c.epic, c.resolution, builtins, presets)
                except Exception as e:  # one bad chart must not kill the sweep
                    return PatternScanChartResultDTO(
                        epic=c.epic, resolution=c.resolution,
                        status="error", error=str(e))

        charts = await asyncio.gather(*(one(c) for c in req.charts))
    finally:
        _scan_lock.release()
    return PatternScanResponse(charts=list(charts),
                               elapsed_ms=int((time.perf_counter() - t0) * 1000))


@router.get("/api/patterns/presets")
async def list_presets(request: Request) -> dict:
    return {"presets": await PRESET_STORE.list(deps.current_user(request))}


@router.post("/api/patterns/presets")
async def create_preset(request: Request, body: PatternPresetCreateBody) -> dict:
    return await PRESET_STORE.create(
        deps.current_user(request), body.name, body.epic, body.resolution,
        [b.model_dump() for b in body.bars],
    )


@router.patch("/api/patterns/presets/{preset_id}", status_code=204)
async def rename_preset(request: Request, preset_id: str,
                        body: PatternPresetRenameBody) -> None:
    if not await PRESET_STORE.rename(deps.current_user(request), preset_id, body.name):
        raise HTTPException(404, "no such preset")


@router.delete("/api/patterns/presets/{preset_id}", status_code=204)
async def delete_preset(request: Request, preset_id: str) -> None:
    if not await PRESET_STORE.delete(deps.current_user(request), preset_id):
        raise HTTPException(404, "no such preset")

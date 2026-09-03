"""Pattern search: find historical windows shaped like a user-selected sequence.

The client sends the query BARS, not just a time range, because a selection
routinely includes right-edge candles that live only in the stream and are not
in candle_history.db yet. The timestamps measure the selection's own wall-clock
span, and mark the row that IS the selection when it comes back as a match."""

from __future__ import annotations

import asyncio
import sqlite3
import time

import numpy as np
from fastapi import APIRouter, HTTPException, Request

from auto_trader.core.pattern_combine import MODE_ORDER, CombinedMatch, combine
from auto_trader.core.pattern_matchers import MATCHERS, Matcher
from auto_trader.core.pattern_scan import DEFAULT_SCALES, Match, prefix_sums, scan
from auto_trader.core.pattern_shape import query_kernel, smooth_close
from auto_trader.core.pattern_series import PATTERN_SERIES, Series

from .. import deps
from ..schemas import (
    PatternBarDTO,
    PatternMatchDTO,
    PatternModeDistancesDTO,
    PatternSearchRequest,
    PatternSearchResponse,
    PatternSeriesDTO,
)

router = APIRouter()


def _search_mode(
    matcher: Matcher,
    series: Series,
    query: np.ndarray,
    *,
    query_span: float,
    top_k: int,
    forward_bars: int,
) -> tuple[list[Match], int]:
    """One matcher's whole pipeline, synchronously: pick the scan arrays, run
    the exact scan over the scale ladder, refine if the matcher has a second
    stage, and truncate to what the caller wants to see. `query` is the full
    (m, 4) OHLC selection; the close column is sliced here so mode "all" can
    reuse one query array across matchers.

    The cache holds the 4-column centred array and its prefix sums; the close
    column, its smoothed copy and their prefix sums are request-local (tens of
    ms on the largest series against a 4.5 s cold load, and the smoothed
    array's kernel follows the query's length so it could not be cached)."""
    if matcher.scan == "ohlc":
        scan_arr, s1, s2 = series.ohlc, series.s1, series.s2
        scan_query = query
        close_arr = scan_arr  # unused: no ohlc matcher refines on close
    else:
        close_arr = np.ascontiguousarray(series.ohlc[:, 3:4])
        query = np.ascontiguousarray(query[:, 3:4])
        if matcher.scan == "smooth":
            kernel = query_kernel(len(query))
            scan_arr = smooth_close(close_arr, kernel)
            scan_query = smooth_close(query, kernel)
        else:
            scan_arr, scan_query = close_arr, query
        s1, s2 = prefix_sums(scan_arr)

    hits, candidates = scan(
        scan_arr,
        s1,
        s2,
        series.ts,
        scan_query,
        query_span=query_span,
        # A refining matcher re-ranks a pool much deeper than the panel
        # shows, so a warped recurrence the rigid scan puts at rank 80 can
        # still surface in the visible top rows.
        top_k=max(top_k, matcher.candidate_pool),
        forward_bars=forward_bars,
        # The same shape recurring faster or slower than the selection: scan a
        # ladder of window lengths, not just the selection's own.
        scales=DEFAULT_SCALES,
    )
    if matcher.refine is not None:
        # Stage two: re-score the survivors with the matcher's own metric and
        # keep only what the caller asked to see. The centred series is fine
        # here: the refine metric z-normalizes, so the removed mean drops out.
        # A refine_on="close" matcher judges the RAW close path even when
        # stage one scanned a smoothed copy: what surfaces is decided on the
        # smoothed trajectory, what the user sees is ranked on real candles.
        if matcher.refine_on == "close":
            refine_arr, refine_query = close_arr, query
        else:
            refine_arr, refine_query = scan_arr, scan_query
        hits = matcher.refine(refine_arr, refine_query, hits)
    return hits[:top_k], candidates


def _bars(series: Series, start: int, count: int, offset: float) -> list[PatternBarDTO]:
    """Slice bars back out at their real price level: the cached OHLC is centred,
    so the mean that was removed at load has to go back on."""
    rows = series.ohlc[start : start + count] + offset
    ts = series.ts[start : start + count]
    return [
        PatternBarDTO(ts=int(t), o=float(r[0]), h=float(r[1]), l=float(r[2]), c=float(r[3]))
        for t, r in zip(ts, rows)
    ]


@router.post("/api/patterns/search", response_model=PatternSearchResponse)
async def search_patterns(req: PatternSearchRequest, request: Request) -> PatternSearchResponse:
    t0 = time.perf_counter()
    # The broker is a cache KEY here, not a routed connection: this endpoint
    # reads sqlite and never touches a broker object, but the id still gates
    # data by broker (restricted brokers keep their own cached series), so it
    # goes through the same admin gate as every other broker-carrying route.
    broker = deps.resolve_broker(request, req.broker)

    query = np.array([[b.o, b.h, b.l, b.c] for b in req.query], dtype=np.float64)
    if not np.isfinite(query).all():
        raise HTTPException(400, "the selection contains a non-numeric price")
    # Every mode but ohlc scans (a transform of) the close column alone, so
    # the flatness check has to run on the column the scan will actually
    # normalize. A selection with moving wicks and identical closes passes the
    # OHLC check and is flat in close mode; checking the whole array here
    # would let it reach zflat and raise. Mode "all" runs close-scanning
    # matchers, so it needs the close column healthy too.
    flat_check = query if req.mode == "ohlc" else query[:, 3:4]
    if flat_check.std() <= 1e-12:
        raise HTTPException(400, "the selection has no price movement to match on")

    cold = not PATTERN_SERIES.is_cached(broker, req.epic, req.resolution, req.price_side)
    try:
        series = await PATTERN_SERIES.get(broker, req.epic, req.resolution, req.price_side)
    except sqlite3.Error as e:
        # A missing database is not a missing series: sqlite3.connect CREATES an
        # empty file, so a wrong working directory surfaces as "no such table:
        # coverage". That is a server misconfiguration, and the raw sqlite text
        # is not an answer the caller can act on.
        raise HTTPException(
            503,
            "pattern search is unavailable: the candle history database could not"
            " be read on the server",
        ) from e
    if series is None:
        raise HTTPException(
            404,
            f"no stored history for '{req.epic}' {req.resolution} on {broker}"
            f" ({req.price_side})",
        )
    m = len(req.query)
    if series.bars < m:
        raise HTTPException(
            404, f"stored history for '{req.epic}' is shorter than the selection"
        )

    # The cached OHLC is centred; the query arrives at real prices. The distance
    # is level-invariant so that costs nothing, but the bars handed back must be
    # un-centred, or every result reads as a price near zero.
    offset = series.offset

    # Seconds, matching Series.ts: the bars table stores int(time.timestamp())
    # and the DTO convention is unix seconds. The client knows the selection's
    # span even when it sits in the live tail and has no counterpart in the
    # stored series to measure it from.
    query_span = float(req.query_to_ts - req.query_from_ts)

    # Cross-timeframe queries (the panel's all-charts scope searches every open
    # chart): on a series COARSER than the selection's own timeframe, every
    # window inherently spans more wall clock than the selection did — a
    # property of the timeframe, not a gap for the span rule to reject, and
    # unscaled it zeroes out every coarse series. Scale the cap by the
    # bar-interval ratio (medians, so weekend gaps on either side don't skew
    # it). Coarser only: on a FINER series windows are tighter than the cap
    # anyway, and the rule already forgives tight windows by design. Same
    # timeframe gives a ratio of ~1 and the historical behaviour, and query
    # bars without timestamps (ts is optional in the DTO) leave it unscaled.
    q_steps = np.diff(np.array([b.ts for b in req.query], dtype=np.float64))
    q_steps = q_steps[q_steps > 0]
    if len(q_steps) and series.bars > 1:
        origin_step = float(np.median(q_steps))
        target_step = float(np.median(np.diff(series.ts)))
        if target_step > origin_step > 0:
            query_span *= target_step / origin_step

    if req.mode == "all":
        # Every formula's search, then one list of distinct events, each
        # scored by every formula and ordered by mean rank across them. The
        # heavy numpy work releases the GIL poorly through the DTW Python
        # loop, so the modes run one after another off the event loop rather
        # than pretending to parallelism.
        hits_by_mode: dict[str, list[Match]] = {}
        candidates = 0
        for key in MODE_ORDER:
            mode_hits, mode_candidates = await asyncio.to_thread(
                _search_mode,
                MATCHERS[key],
                series,
                query,
                query_span=query_span,
                top_k=req.top_k,
                forward_bars=req.forward_bars,
            )
            hits_by_mode[key] = mode_hits
            # The modes scan the same windows through different transforms;
            # the honest "windows ranked" figure is the widest single scan,
            # not a quadruple count of the same history.
            candidates = max(candidates, mode_candidates)
        # The whole merged union, NOT truncated to top_k: mean rank orders the
        # list, it does not eliminate. A window one formula liked stays even
        # when the other three score it poorly — their scores are context.
        hits: list[Match] | list[CombinedMatch] = await asyncio.to_thread(
            combine, series.ohlc, query, hits_by_mode
        )
    else:
        hits, candidates = await asyncio.to_thread(
            _search_mode,
            MATCHERS[req.mode],
            series,
            query,
            query_span=query_span,
            top_k=req.top_k,
            forward_bars=req.forward_bars,
        )

    matches: list[PatternMatchDTO] = []
    for hit in hits:
        # hit.length, not len(req.query): a hit found on another rung of the
        # scale ladder covers its own number of bars.
        bars = _bars(series, hit.start, hit.length, offset)
        forward = _bars(series, hit.start + hit.length, hit.forward_len, offset)
        pct = None
        # `!= 0`, not a truthiness test: the guard exists because a zero close
        # makes the percentage undefined, and only because of that. A falsy
        # check says the same thing for these instruments while reading as
        # "if there is a close", which is a different claim.
        if forward and bars[-1].c != 0:
            pct = (forward[-1].c - bars[-1].c) / bars[-1].c * 100.0
        if isinstance(hit, CombinedMatch):
            # No single distance exists in mode "all": the field carries the
            # mean rank the row was ordered by, and the panel shows the
            # per-formula distances instead. None where a formula could not
            # score the window — JSON has no Infinity.
            distance = hit.mean_rank
            distances = PatternModeDistancesDTO(
                **{
                    k: (v if np.isfinite(v) else None)
                    for k, v in hit.distances.items()
                }
            )
        else:
            distance, distances = hit.distance, None
        matches.append(
            PatternMatchDTO(
                ts=bars[0].ts,
                end_ts=bars[-1].ts,
                distance=distance,
                distances=distances,
                bars=bars,
                forward=forward,
                forward_complete=hit.forward_len >= req.forward_bars,
                forward_pct=pct,
                # The user's own window is deliberately scanned and ranked, so
                # the top row is usually it, at distance ~0. Flag it here rather
                # than letting the panel guess from the distance.
                is_selection=bars[0].ts == req.query_from_ts,
            )
        )

    return PatternSearchResponse(
        matches=matches,
        # What scan actually ranked, after the span and flat filters, so the
        # number reconciles with its label.
        scanned=candidates,
        series=PatternSeriesDTO(
            oldest_ts=series.oldest_ts, newest_ts=series.newest_ts, bars=series.bars
        ),
        elapsed_ms=int((time.perf_counter() - t0) * 1000),
        cold=cold,
    )

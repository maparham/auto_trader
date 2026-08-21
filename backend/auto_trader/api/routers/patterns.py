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
from fastapi import APIRouter, HTTPException

from auto_trader.core.pattern_matchers import MATCHERS
from auto_trader.core.pattern_scan import DEFAULT_SCALES, prefix_sums, scan
from auto_trader.core.pattern_shape import query_kernel, smooth_close
from auto_trader.core.pattern_series import PATTERN_SERIES, Series

from .. import deps
from ..schemas import (
    PatternBarDTO,
    PatternMatchDTO,
    PatternSearchRequest,
    PatternSearchResponse,
    PatternSeriesDTO,
)

router = APIRouter()


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
async def search_patterns(req: PatternSearchRequest) -> PatternSearchResponse:
    t0 = time.perf_counter()
    # The broker is a cache KEY here, not a routed connection: this endpoint
    # reads sqlite and never touches a broker object. So resolve it lazily,
    # only when the client named none — asking the registry unconditionally
    # would make the route depend on a live broker registry it has no use for.
    broker = req.broker or deps.default_broker_id()
    matcher = MATCHERS[req.mode]

    query = np.array([[b.o, b.h, b.l, b.c] for b in req.query], dtype=np.float64)
    if not np.isfinite(query).all():
        raise HTTPException(400, "the selection contains a non-numeric price")
    # Every mode but ohlc scans (a transform of) the close column alone, so
    # the flatness check has to run on the column the scan will actually
    # normalize. A selection with moving wicks and identical closes passes the
    # OHLC check and is flat in close mode; checking the whole array here
    # would let it reach zflat and raise.
    if matcher.scan != "ohlc":
        query = np.ascontiguousarray(query[:, 3:4])
    if query.std() <= 1e-12:
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

    # Scan input only. The cache holds the 4-column centred array and its prefix
    # sums, and `_bars` below still slices its response candles out of
    # series.ohlc: the close column, its smoothed copy and their prefix sums
    # are request-local and nothing here writes back. Building them costs tens
    # of ms on the largest series against a 4.5 s cold load, which is not
    # worth threading more cached pairs through the cache's incremental-extend
    # path — and the smoothed array cannot be cached anyway, because its
    # kernel follows the query's length.
    if matcher.scan == "ohlc":
        scan_arr, s1, s2 = series.ohlc, series.s1, series.s2
        scan_query = query
    else:
        close_arr = np.ascontiguousarray(series.ohlc[:, 3:4])
        if matcher.scan == "smooth":
            kernel = query_kernel(len(query))
            scan_arr = smooth_close(close_arr, kernel)
            scan_query = smooth_close(query, kernel)
        else:
            scan_arr, scan_query = close_arr, query
        s1, s2 = prefix_sums(scan_arr)
    hits, candidates = await asyncio.to_thread(
        scan,
        scan_arr,
        s1,
        s2,
        series.ts,
        scan_query,
        # Seconds, matching Series.ts: the bars table stores int(time.timestamp())
        # and the DTO convention is unix seconds. The client knows the selection's
        # span even when it sits in the live tail and has no counterpart in the
        # stored series to measure it from.
        query_span=float(req.query_to_ts - req.query_from_ts),
        # A refining matcher re-ranks a pool much deeper than the panel
        # shows, so a warped recurrence the rigid scan puts at rank 80 can
        # still surface in the visible top rows.
        top_k=max(req.top_k, matcher.candidate_pool),
        forward_bars=req.forward_bars,
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
        hits = (await asyncio.to_thread(matcher.refine, refine_arr, refine_query, hits))[
            : req.top_k
        ]

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
        matches.append(
            PatternMatchDTO(
                ts=bars[0].ts,
                end_ts=bars[-1].ts,
                distance=hit.distance,
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

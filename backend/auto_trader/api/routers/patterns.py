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

from auto_trader.core.pattern_scan import prefix_sums, scan
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

    query = np.array([[b.o, b.h, b.l, b.c] for b in req.query], dtype=np.float64)
    if not np.isfinite(query).all():
        raise HTTPException(400, "the selection contains a non-numeric price")
    # Close mode scans the close column alone, so the flatness check has to run
    # on the column the scan will actually normalize. A selection with moving
    # wicks and identical closes passes the OHLC check and is flat in close
    # mode; checking the whole array here would let it reach zflat and raise.
    if req.mode == "close":
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
    # series.ohlc: the close column and its two prefix sums are request-local
    # and nothing here writes back. Building them costs 13 ms on the largest
    # series against a 4.5 s cold load, which is not worth threading a second
    # cached pair through the cache's incremental-extend path.
    if req.mode == "close":
        scan_arr = np.ascontiguousarray(series.ohlc[:, 3:4])
        s1, s2 = prefix_sums(scan_arr)
    else:
        scan_arr, s1, s2 = series.ohlc, series.s1, series.s2
    hits, candidates = await asyncio.to_thread(
        scan,
        scan_arr,
        s1,
        s2,
        series.ts,
        query,
        # Seconds, matching Series.ts: the bars table stores int(time.timestamp())
        # and the DTO convention is unix seconds. The client knows the selection's
        # span even when it sits in the live tail and has no counterpart in the
        # stored series to measure it from.
        query_span=float(req.query_to_ts - req.query_from_ts),
        top_k=req.top_k,
        forward_bars=req.forward_bars,
    )

    matches: list[PatternMatchDTO] = []
    for hit in hits:
        bars = _bars(series, hit.start, m, offset)
        forward = _bars(series, hit.start + m, hit.forward_len, offset)
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

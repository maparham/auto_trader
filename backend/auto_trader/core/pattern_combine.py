"""The combined pattern-search mode: every formula's verdict on one list.

The four single modes each rank history their own way, and the panel's tabs
invite comparing them — but comparing four separate top-20 lists by eye means
hunting for the same event under four different rows. This module folds the
per-mode results into ONE list of distinct events, and scores every event
under every formula, so a row reads "this window: shape 0.61, candles 0.78,
close 0.66, DTW 0.55" regardless of which mode originally surfaced it.

Ordering is by mean rank across the formulas, not by any distance: the four
metrics live on similar scales but are not calibrated against each other, so
averaging raw distances would quietly weight whichever formula spreads its
scores widest. A rank is a rank in all four."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .pattern_dtw import dtw_distance
from .pattern_scan import Match, stretch, zflat
from .pattern_shape import (
    ACTIVITY_WEIGHT,
    PIVOT_WEIGHT,
    activity_distance,
    multires_distance,
    pivot_distance,
)

# The mode keys this module combines, in the order clustering consumes them.
# Shape first: when two modes surface overlapping windows for the same event,
# the representative geometry comes from the earlier mode in this tuple, and
# shape's picks are the default tab's.
MODE_ORDER: tuple[str, ...] = ("shape", "ohlc", "close", "dtw")


@dataclass(frozen=True)
class CombinedMatch:
    """One distinct event with every formula's distance to the query. Same
    window fields as Match; `distances` is keyed by MODE_ORDER, values may be
    inf when a formula cannot score the window (flat under its transform)."""

    start: int
    length: int
    forward_len: int
    distances: dict[str, float]
    mean_rank: float


def _rigid_distance(query: np.ndarray, window: np.ndarray) -> float:
    """The exact scan's metric for one arbitrary window: z-normalize both and
    RMS the gap, query resampled to the window's length. Works on whatever
    column count both arrays share."""
    q = stretch(query, len(window)) if len(query) != len(window) else query
    try:
        zq, zw = zflat(q), zflat(window)
    except ValueError:
        return float(np.inf)
    return float(np.linalg.norm(zq - zw) / np.sqrt(window.size))


def score_window(query_ohlc: np.ndarray, window_ohlc: np.ndarray) -> dict[str, float]:
    """Every formula's distance from the query to one window, both given as
    (m, 4) OHLC at any price level (each formula normalizes internally)."""
    q_close = np.ascontiguousarray(query_ohlc[:, 3:4])
    w_close = np.ascontiguousarray(window_ohlc[:, 3:4])
    return {
        "shape": multires_distance(q_close, w_close)
        + ACTIVITY_WEIGHT * activity_distance(q_close, w_close)
        + PIVOT_WEIGHT * pivot_distance(q_close, w_close),
        "ohlc": _rigid_distance(query_ohlc, window_ohlc),
        "close": _rigid_distance(q_close, w_close),
        "dtw": dtw_distance(query_ohlc, window_ohlc),
    }


def _overlaps(a: Match, b: Match) -> bool:
    return a.start < b.start + b.length and b.start < a.start + a.length


def combine(
    series_ohlc: np.ndarray,
    query_ohlc: np.ndarray,
    hits_by_mode: dict[str, list[Match]],
) -> list[CombinedMatch]:
    """Fold per-mode result lists into one list of distinct events, each scored
    under every formula and ordered by mean rank across them.

    EVERY event survives: the mean rank orders the list and nothing more. A
    window that only one formula surfaced still appears, however the other
    three score it — those scores are context for the reader, not grounds
    for elimination.

    Clustering is round-robin by rank across the modes: each mode's next-best
    hit becomes a new event unless its window overlaps one already taken, in
    which case it IS that event, seen through another formula, and is dropped.
    Within one mode the scan's greedy blanking already guarantees disjoint
    windows, so any cross-mode overlap is the same event on a nearby rung or
    offset, never two events."""
    reps: list[Match] = []
    queues = [list(hits_by_mode.get(k, [])) for k in MODE_ORDER]
    while any(queues):
        for q in queues:
            if not q:
                continue
            h = q.pop(0)
            if not any(_overlaps(h, r) for r in reps):
                reps.append(h)

    if not reps:
        return []

    scored = [
        (r, score_window(query_ohlc, series_ohlc[r.start : r.start + r.length]))
        for r in reps
    ]

    # Rank per formula, 1-based, inf naturally last (argsort is stable, so
    # ties keep clustering order). Mean rank is the combined order.
    n = len(scored)
    mean_ranks = np.zeros(n)
    for key in MODE_ORDER:
        col = np.array([d[key] for _, d in scored])
        order = np.argsort(col, kind="stable")
        ranks = np.empty(n)
        ranks[order] = np.arange(1, n + 1)
        mean_ranks += ranks
    mean_ranks /= len(MODE_ORDER)

    out = [
        CombinedMatch(
            start=r.start,
            length=r.length,
            forward_len=r.forward_len,
            distances=d,
            mean_rank=float(mr),
        )
        for (r, d), mr in zip(scored, mean_ranks)
    ]
    out.sort(key=lambda c: (c.mean_rank, min(c.distances.values()), c.start))
    return out

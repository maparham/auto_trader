"""Banded dynamic time warping: the optional second stage of pattern search.

The exact scan (pattern_scan) is rigid: bar i of the query is compared to bar
i of the window, so a recurrence that runs fast early and slow late scores as
noise even when the scale ladder finds its average tempo. DTW lets the time
axis flex inside a Sakoe-Chiba band and re-scores only the exact scan's top
candidates, so the O(m^2) cost is paid tens of times, never per window.

The cost convention deliberately mirrors the rigid metric: both windows get
the same one-mean-one-sd z-normalization, local costs are squared bar
differences, and the total is path-length-averaged and square-rooted. On the
no-warp diagonal the two metrics are the identical number, so DTW distances
read on the familiar scale: 0 identical, about 2 an exact inversion."""

from __future__ import annotations

import numpy as np

from .pattern_scan import Match, stretch, zflat

# Half-width of the warp corridor as a fraction of the longer window. +-20%
# absorbs real tempo drift; wider starts matching shapes that merely share a
# bag of moves.
_BAND_FRAC = 0.2

# Windows longer than this are resampled down to it before the DTW pass: the
# banded fill below is a Python loop, quadratic-ish in length, and at the
# 1024-bar query cap a 2x rung would cost seconds PER CANDIDATE. DTW is a
# tempo judgement on the macro path, which survives resampling; bar-level
# texture is the rigid stage's business, not this one's.
_DTW_MAX_LEN = 128


def dtw_distance(query: np.ndarray, window: np.ndarray, band_frac: float = _BAND_FRAC) -> float:
    """DTW distance between two (m, C) windows, unequal lengths compared
    natively. The band is centred on the length-scaled diagonal, so a uniform
    stretch is always inside it; `band_frac` of the LONGER length sets its
    half-width. A flat window has no defined shape and scores infinity."""
    q = np.asarray(query, dtype=np.float64)
    w = np.asarray(window, dtype=np.float64)
    if len(q) > _DTW_MAX_LEN:
        q = stretch(q, _DTW_MAX_LEN)
    if len(w) > _DTW_MAX_LEN:
        w = stretch(w, _DTW_MAX_LEN)
    try:
        zq = zflat(q).reshape(q.shape)
        zw = zflat(w).reshape(w.shape)
    except ValueError:
        return float(np.inf)

    n, m, c = len(zq), len(zw), q.shape[1]
    # All pairwise squared bar costs at once: n and m are at most 128 here
    # (longer inputs were resampled above), so the (n, m) matrix is small.
    local = np.square(zq[:, None, :] - zw[None, :, :]).sum(axis=2)

    half = int(round(band_frac * max(n, m)))
    if n != m:
        # The scaled diagonal shifts by up to (m-1)/(n-1) per row; a corridor
        # this wide is always connectable for the ladder's 2x length ratio.
        half = max(half, 1)

    inf = np.inf
    cost = np.full((n, m), inf)
    steps = np.zeros((n, m), dtype=np.int64)
    centre = (
        np.arange(n) * (m - 1) / (n - 1) if n > 1 else np.zeros(1)
    )
    for i in range(n):
        lo = max(0, int(np.floor(centre[i])) - half)
        hi = min(m - 1, int(np.ceil(centre[i])) + half)
        for j in range(lo, hi + 1):
            if i == 0 and j == 0:
                cost[0, 0] = local[0, 0]
                steps[0, 0] = 1
                continue
            best = inf
            best_steps = 0
            for pi, pj in ((i - 1, j - 1), (i - 1, j), (i, j - 1)):
                if pi >= 0 and pj >= 0 and cost[pi, pj] < best:
                    best = cost[pi, pj]
                    best_steps = steps[pi, pj]
            if best < inf:
                cost[i, j] = best + local[i, j]
                steps[i, j] = best_steps + 1
    total = cost[n - 1, m - 1]
    if not np.isfinite(total):
        return float(np.inf)
    return float(np.sqrt(total / (steps[n - 1, m - 1] * c)))


def refine(
    series: np.ndarray,
    query: np.ndarray,
    hits: list[Match],
    band_frac: float = _BAND_FRAC,
) -> list[Match]:
    """Re-score the exact scan's picks with DTW and re-rank. Everything about
    each Match survives except the distance, which becomes the DTW score."""
    out = [
        Match(
            start=h.start,
            length=h.length,
            distance=dtw_distance(query, series[h.start : h.start + h.length], band_frac),
            forward_len=h.forward_len,
        )
        for h in hits
    ]
    out.sort(key=lambda h: h.distance)
    return out

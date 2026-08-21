"""Shape-first scoring for pattern search: the pieces behind the "shape" mode.

Two stages, benchmarked against the alternatives in scripts/pattern_bench
before landing here. Stage one hands the exact scan a SMOOTHED close path, so
candidate selection ranks by macro trajectory: the bar-to-bar noise that
dominates a full-resolution pointwise distance is simply not in the data the
scan sees. Stage two re-ranks the survivors by a multi-resolution distance on
the RAW close path, coarsest level weighted highest, so the visible ordering
agrees with what a human reads first (the big swings) and uses fine detail
only to break ties.

Kept out on benchmark evidence, not oversight: a swing-count penalty (its
reversal threshold flips on borderline swings and drops true tempo-warped
matches) and DTW-after-smoothing (warping on an already-smoothed path
over-forgives, mean rank 6.7 against 2.7 for this pipeline)."""

from __future__ import annotations

import numpy as np

from .pattern_scan import Match, stretch, zflat

# Smoothing width as a fraction of the query length. m/8 beat m/16 and a
# fixed 3-bar kernel on pool recall in the benchmark: heavy enough that a
# noisy recurrence of the query's trajectory survives into the candidate
# pool, not so heavy that neighbouring shapes blur together.
KERNEL_FRAC = 1 / 8

# Coarse comparison lengths and their weights, plus the full-resolution
# term's weight. 8 points carry the macro trajectory, 16 the swing
# proportions; the window's own resolution only breaks ties.
RESOLUTIONS: tuple[int, ...] = (8, 16)
WEIGHTS: tuple[float, ...] = (0.5, 0.3)
FULL_WEIGHT = 0.2


def query_kernel(m: int, frac: float = KERNEL_FRAC) -> int:
    """Smoothing width for an m-bar query: a fraction of its length, never so
    wide that a short selection is flattened to a line."""
    return max(1, min(int(round(m * frac)), max(1, m // 4)))


def smooth_close(close: np.ndarray, kernel: int) -> np.ndarray:
    """Centred moving average of an (n, 1) close array, padded by odd reflection
    (the boundary value anchored, the slope continued) so a trend's ends are
    not bent toward the interior. kernel <= 1 is the identity."""
    if kernel <= 1:
        return close
    x = np.asarray(close, dtype=np.float64).ravel()
    pad = kernel // 2
    padded = np.concatenate(
        [2 * x[0] - x[pad:0:-1], x, 2 * x[-1] - x[-2 : -pad - 2 : -1]]
    )
    out = np.convolve(padded, np.ones(kernel) / kernel, mode="valid")
    # An even kernel leaves one extra sample; trim to n.
    return np.ascontiguousarray(out[: len(x)].reshape(-1, 1))


def _shape_distance(a: np.ndarray, b: np.ndarray) -> float:
    """RMS distance between two z-normalized equal-length 1-col paths, on the
    scan's scale: 0 identical, ~2 an exact inversion."""
    try:
        za, zb = zflat(a), zflat(b)
    except ValueError:
        return float(np.inf)
    return float(np.linalg.norm(za - zb) / np.sqrt(a.size))


def multires_distance(query_close: np.ndarray, window_close: np.ndarray) -> float:
    """Coarse-to-fine shape distance between two close paths of any lengths:
    both are resampled to each coarse resolution and compared there, then once
    at the window's own length. Weighted so agreement on the macro trajectory
    dominates and bar-level texture only breaks ties."""
    q = np.asarray(query_close, dtype=np.float64).reshape(-1, 1)
    w = np.asarray(window_close, dtype=np.float64).reshape(-1, 1)
    total = 0.0
    for k, wt in zip(RESOLUTIONS, WEIGHTS):
        total += wt * _shape_distance(stretch(q, k), stretch(w, k))
    total += FULL_WEIGHT * _shape_distance(stretch(q, len(w)), w)
    return total / (sum(WEIGHTS) + FULL_WEIGHT)


def refine(series_close: np.ndarray, query_close: np.ndarray, hits: list[Match]) -> list[Match]:
    """Re-score the scan's picks with the multi-resolution distance and
    re-rank. Everything about each Match survives except the distance.

    `series_close` is the RAW close column, not the smoothed scan array:
    stage one decides what surfaces, this stage ranks what the user sees."""
    out = [
        Match(
            start=h.start,
            length=h.length,
            distance=multires_distance(query_close, series_close[h.start : h.start + h.length]),
            forward_len=h.forward_len,
        )
        for h in hits
    ]
    out.sort(key=lambda h: h.distance)
    return out

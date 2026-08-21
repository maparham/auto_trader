"""Shape-first scoring for pattern search: the pieces behind the "shape" mode.

Two stages, benchmarked against the alternatives in scripts/pattern_bench
before landing here. Stage one hands the exact scan a SMOOTHED close path, so
candidate selection ranks by macro trajectory: the bar-to-bar noise that
dominates a full-resolution pointwise distance is simply not in the data the
scan sees. Stage two re-ranks the survivors by a multi-resolution distance on
the RAW close path, coarsest level weighted highest, so the visible ordering
agrees with what a human reads first (the big swings) and uses fine detail
only to break ties.

Stage two carries one auxiliary term, the local-activity profile: global
z-normalization makes a low-amplitude lead (a rounded top before a big
decline) numerically near-flat, so pure shape distance returns matches with
genuinely flat leads the query does not have. The profile compares where the
STRUCTURE lives along the two paths and penalizes windows that are dead
where the query has shape; on the benchmark's flat-lead-trap case it moves
the flat decoy off rank 1 and the structured recurrences to ranks 1-2, with
no regression elsewhere (weight 0.25 bought nothing more and hurt short
queries, hence 0.15).

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


# Weight of the activity term against the multi-resolution distance, and the
# profile's granularity. Spread is measured on the SMOOTHED z-normed path:
# per-bar steps would measure jitter, and a noisy flat drift has plenty of
# jitter while having no shape. Logged so small-amplitude structure (0.07 vs
# 0.01 of the range) separates as strongly as large, and mean-centred so a
# uniform tempo stretch or an overall noisier texture drops out.
ACTIVITY_WEIGHT = 0.15
_ACT_SEGMENTS = 8
_ACT_EPS = 1e-3
# QUERIES below this many bars turn the term off: their segments would hold
# 2-3 points each, whose log-spread is noise — and a lead short enough to not
# exist cannot be mismatched. (A 6-bar query's stretched recurrence scored
# 0.21 ungated.) The gate reads the QUERY only, never the window: gating per
# window would let sub-threshold ladder rungs skip a penalty their longer
# rivals pay, which inverted a benchmark case's ranking.
_ACT_MIN_BARS = 16


def activity_profile(close: np.ndarray, segments: int = _ACT_SEGMENTS) -> np.ndarray:
    """Centred log per-segment spread of a close path's smoothed z-normed
    form: where along the path its structure lives."""
    x = np.asarray(close, dtype=np.float64).ravel()
    k = min(segments, max(2, len(x) // 2))
    try:
        z = zflat(smooth_close(x.reshape(-1, 1), query_kernel(len(x))))
    except ValueError:
        return np.zeros(k)
    edges = np.linspace(0, len(z), k + 1).round().astype(int)
    act = np.array([z[a:b].std() if b - a > 1 else 0.0 for a, b in zip(edges, edges[1:])])
    prof = np.log(act + _ACT_EPS)
    return prof - prof.mean()


def activity_distance(query_close: np.ndarray, window_close: np.ndarray) -> float:
    """RMS gap between two activity profiles: 0 when structure is spread the
    same way along both paths, ~1 when one has shape where the other is dead.
    Segment counts are fixed, so unequal lengths compare fine."""
    if np.asarray(query_close).size < _ACT_MIN_BARS:
        return 0.0
    pq = activity_profile(query_close)
    pw = activity_profile(window_close)
    k = min(len(pq), len(pw))
    return float(np.linalg.norm(pq[:k] - pw[:k]) / np.sqrt(k))


def refine(series_close: np.ndarray, query_close: np.ndarray, hits: list[Match]) -> list[Match]:
    """Re-score the scan's picks with the multi-resolution distance and
    re-rank. Everything about each Match survives except the distance.

    `series_close` is the RAW close column, not the smoothed scan array:
    stage one decides what surfaces, this stage ranks what the user sees."""
    out = [
        Match(
            start=h.start,
            length=h.length,
            distance=(
                multires_distance(query_close, win := series_close[h.start : h.start + h.length])
                + ACTIVITY_WEIGHT * activity_distance(query_close, win)
            ),
            forward_len=h.forward_len,
        )
        for h in hits
    ]
    out.sort(key=lambda h: h.distance)
    return out

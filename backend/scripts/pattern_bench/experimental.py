"""Experimental scoring pieces the benchmark compares against production.

The winners of the first benchmark round (query-relative smoothing and the
multi-resolution distance) were promoted to `auto_trader.core.pattern_shape`
and are imported from there, so the benchmark keeps measuring the exact code
production runs. What stays here is what the benchmark rejected (the swing
penalty: its reversal threshold flips on borderline swings and drops true
tempo-warped matches) and the composable `rescore` wrapper the variant
registry drives."""

from __future__ import annotations

import numpy as np

from auto_trader.core.pattern_scan import Match
from auto_trader.core.pattern_shape import (  # noqa: F401  (re-exported for variants/tests)
    activity_distance,
    activity_profile,
    multires_distance,
    pivot_distance,
    query_kernel,
    smooth_close,
)

# Reversal threshold for swing extraction, as a fraction of the path's range.
# Below this a wiggle is texture; above it, a swing a human would count.
_SWING_FRAC = 0.25


def swing_directions(close: np.ndarray, frac: float = _SWING_FRAC) -> list[int]:
    """The sequence of major swing directions (+1 up, -1 down) of a close
    path, zigzag-style: a leg counts as a swing once price reverses from its
    running extreme by more than `frac` of the path's total range."""
    x = np.asarray(close, dtype=np.float64).ravel()
    rng = float(x.max() - x.min())
    if rng <= 0.0 or len(x) < 2:
        return []
    thresh = frac * rng
    dirs: list[int] = []
    trend = 0  # unknown until the first move clears the threshold
    ext = x[0]  # running extreme of the current leg (start point while trend=0)
    for v in x[1:]:
        if trend == 0:
            if v - ext > thresh:
                trend = 1
                ext = v
            elif ext - v > thresh:
                trend = -1
                ext = v
        elif trend == 1:
            if v > ext:
                ext = v
            elif ext - v > thresh:
                dirs.append(1)
                trend = -1
                ext = v
        else:
            if v < ext:
                ext = v
            elif v - ext > thresh:
                dirs.append(-1)
                trend = 1
                ext = v
    if trend != 0:
        dirs.append(trend)
    return dirs


def swing_penalty(query_close: np.ndarray, window_close: np.ndarray) -> float:
    """Additive penalty for mismatched swing structure, on the distance scale
    (a whole missing or extra swing costs 0.25, roughly the gap between a
    good and a mediocre match)."""
    dq = swing_directions(query_close)
    dw = swing_directions(window_close)
    penalty = 0.25 * abs(len(dq) - len(dw))
    for a, b in zip(dq, dw):
        if a != b:
            penalty += 0.25
    return penalty


def rescore(
    series_close: np.ndarray,
    query_close: np.ndarray,
    hits: list[Match],
    *,
    use_multires: bool = True,
    use_swing: bool = False,
    activity_weight: float = 0.0,
    pivot_weight: float = 0.0,
) -> list[Match]:
    """Re-rank scan candidates by multi-resolution shape (optionally plus the
    swing penalty), mirroring pattern_dtw.refine's contract: every field of a
    Match survives except the distance."""
    out = []
    for h in hits:
        win = series_close[h.start : h.start + h.length]
        d = multires_distance(query_close, win) if use_multires else h.distance
        if use_swing:
            d += swing_penalty(query_close, win)
        if activity_weight > 0.0:
            d += activity_weight * activity_distance(query_close, win)
        if pivot_weight > 0.0:
            d += pivot_weight * pivot_distance(query_close, win)
        out.append(Match(start=h.start, length=h.length, distance=float(d), forward_len=h.forward_len))
    out.sort(key=lambda h: h.distance)
    return out

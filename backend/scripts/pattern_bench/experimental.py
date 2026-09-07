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
    _light_z,
    activity_distance,
    activity_profile,
    envelope_divergence_distance,
    multires_distance,
    pivot_distance,
    query_kernel,
    query_pivots,
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


# --- expanding-tops candidates (Sept 7 2026 session) -------------------------
#
# The envelope-divergence term WON (promoted to pattern_shape, imported
# above): expanding-tops' endorsed EURUSD window unfound -> rank 3, all other
# cases byte-identical. The wiggle term below (total-variation-over-range
# log-ratio, a threshold-free pivot-density stand-in) is the recorded
# negative: it never moved the case on its own or on top of the envelope
# term — the oscillation rhythm the user pointed at is already carried by the
# envelope pivots once they are detected on the light kernel.

_TV_MIN_BARS = 16


def _wiggle(close: np.ndarray) -> float:
    """A path's oscillation budget: total variation of its lightly smoothed
    z form over its z range. ~1 for a monotone move, growing with every
    traversal — a continuous stand-in for 'how many swings', with no
    reversal threshold to flip."""
    z = _light_z(close)
    rng = float(z.max() - z.min()) or 1e-9
    return float(np.abs(np.diff(z, axis=0)).sum() / rng)


def wiggle_distance(query_close: np.ndarray, window_close: np.ndarray) -> float:
    """Log-ratio gap between the two paths' oscillation budgets: 0 when the
    window is as busy as the query, ~0.7 when it has half or double the
    traversal. The pivot-density complaint ('matches must share the query's
    swing rhythm') as a threshold-free number."""
    q = np.asarray(query_close, dtype=np.float64).ravel()
    if q.size < _TV_MIN_BARS:
        return 0.0
    try:
        tq = _wiggle(q)
        tw = _wiggle(window_close)
    except ValueError:
        return float(np.inf)
    return abs(float(np.log((tw + 1e-9) / (tq + 1e-9))))


def rescore(
    series_close: np.ndarray,
    query_close: np.ndarray,
    hits: list[Match],
    *,
    use_multires: bool = True,
    use_swing: bool = False,
    activity_weight: float = 0.0,
    pivot_weight: float = 0.0,
    envelope_weight: float = 0.0,
    wiggle_weight: float = 0.0,
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
        if envelope_weight > 0.0:
            d += envelope_weight * envelope_divergence_distance(query_close, win)
        if wiggle_weight > 0.0:
            d += wiggle_weight * wiggle_distance(query_close, win)
        out.append(Match(start=h.start, length=h.length, distance=float(d), forward_len=h.forward_len))
    out.sort(key=lambda h: h.distance)
    return out

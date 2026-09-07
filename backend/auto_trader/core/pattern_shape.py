"""Shape-first scoring for pattern search: the pieces behind the "shape" mode.

Two stages, benchmarked against the alternatives in scripts/pattern_bench
before landing here. Stage one hands the exact scan a SMOOTHED close path, so
candidate selection ranks by macro trajectory: the bar-to-bar noise that
dominates a full-resolution pointwise distance is simply not in the data the
scan sees. Stage two re-ranks the survivors by a multi-resolution distance on
the RAW close path, coarsest level weighted highest, so the visible ordering
agrees with what a human reads first (the big swings) and uses fine detail
only to break ties.

Stage two carries two auxiliary terms. The pivot-level term compares the
heights of the query's swing extremes against the window's at the same
relative positions: a second top 15% lower moves a pointwise distance by a
few points' worth of error, while a chartist reads a different pattern (a
lower high, not a double top). Only the QUERY's pivots are ever detected —
each comparison is a continuous level difference on the window's smoothed
path — which is what the rejected swing-count penalty lacked (its per-window
reversal threshold flipped on borderline swings). On the benchmark's
pivot-trap case it moves the moved-peak decoys below every true recurrence,
with no regression elsewhere and near-identical results across weights
0.05-0.25.

The third is the envelope-divergence term: trendlines through the query's
high pivots and low pivots (on a LIGHT fixed 3-bar smoothing — an
oscillation-rich query's swings vanish under the m/8 kernel) against the
window's extremes at the same positions. It reads what no pointwise or
per-pivot-level distance can: whether the consolidation EXPANDS (tops rising
over a lagging floor) or is a staircase/channel with the same silhouette.
Ground truth came from a real user-labelled case (expanding-tops, Sept 2026);
the term lifts its endorsed match from unfound to rank 3 with every other
benchmark case byte-identical.

The second is the local-activity profile: global
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
matches); DTW-after-smoothing (warping on an already-smoothed path
over-forgives, mean rank 6.7 against 2.7 for this pipeline); and a per-rung
query kernel for the exact scan (smoothing the query with kernel * m0/m
before stretching, so both sides of a distant rung carry equal absolute
smoothing — measured WORSE at both extremes of the ladder: the extra query
noise it preserves helps every window, noise included, so the true
recurrence's rank drops even as its distance narrows)."""

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


# Weight of the pivot-level term against the multi-resolution distance. The
# term compares WHERE the query's swing extremes sit in height: a pointwise
# path distance barely notices a second top 15% lower (a few points, each a
# little off), while a chartist reads it as a different pattern (lower high,
# not double top).
PIVOT_WEIGHT = 0.1
# Reversal threshold for the query's zigzag, as a fraction of its smoothed
# z-range: below this a wiggle is texture, not a swing. The threshold gates
# only which QUERY swings are compared; every comparison itself is a
# continuous level difference, so a borderline swing cannot flip the score
# the way the rejected swing-count penalty could. 0.15 over 0.2 on evidence:
# a real shallow-valley double top (valley at 0.3 of the range, shrunk
# further by smoothing) confirmed only one pivot at 0.2 so the term gated
# off, engagement on random real windows rises 51% -> 57%, and the benchmark
# strictly improves (meanrank 2.56 -> 2.33, recall 0.84 -> 0.88, nothing
# worse). 0.12 bought no further benchmark gain while engaging on 68% of
# random windows — the start of counting texture as structure.
_PIVOT_REV_FRAC = 0.15
# Half-width of the window neighbourhood searched for each pivot's extreme,
# as a fraction of the window length: local tempo drift moves an extreme
# without changing what it is. Capped per pivot at half the gap to its
# neighbours so one window swing cannot satisfy two query pivots.
_PIVOT_TOL_FRAC = 0.1
# Same gate rationale as the activity term, on the QUERY only: a short
# selection's smoothed path carries too few points for its zigzag extremes
# to be meaningful levels.
_PIVOT_MIN_BARS = 16


def _smooth_z(close: np.ndarray) -> np.ndarray:
    """A close path's smoothed, z-normalized form: the curve the macro terms
    (pivots, activity) measure on. Raises ValueError on a flat path."""
    x = np.asarray(close, dtype=np.float64).ravel()
    return zflat(smooth_close(x.reshape(-1, 1), query_kernel(len(x))))


def query_pivots(close: np.ndarray) -> list[tuple[float, float, int]]:
    """Interior swing extremes of a close path's smoothed z-normed form:
    (fractional position, z level, +1 high / -1 low) per confirmed pivot.
    Zigzag: an extreme becomes a pivot once the path reverses from it by more
    than _PIVOT_REV_FRAC of the total range. The trailing extreme is never
    confirmed and endpoints are dropped: interior structure only."""
    return _zigzag_pivots(_smooth_z(close), _PIVOT_REV_FRAC)


def _zigzag_pivots(z: np.ndarray, rev_frac: float) -> list[tuple[float, float, int]]:
    """The zigzag itself, on an already-prepared path: query_pivots' engine,
    shared with the envelope term (which runs it on a lighter smoothing)."""
    n = len(z)
    thresh = rev_frac * float(z.max() - z.min())
    piv: list[tuple[float, float, int]] = []
    trend = 0
    ext_i, ext_v = 0, float(z[0])
    lo_i = hi_i = 0
    lo_v = hi_v = float(z[0])
    for i in range(1, n):
        v = float(z[i])
        if trend == 0:
            if v > hi_v:
                hi_i, hi_v = i, v
            if v < lo_v:
                lo_i, lo_v = i, v
            if v - lo_v > thresh:
                trend = 1
                seg = lo_i + int(np.argmax(z[lo_i : i + 1]))
                ext_i, ext_v = seg, float(z[seg])
            elif hi_v - v > thresh:
                trend = -1
                seg = hi_i + int(np.argmin(z[hi_i : i + 1]))
                ext_i, ext_v = seg, float(z[seg])
        elif trend == 1:
            if v > ext_v:
                ext_i, ext_v = i, v
            elif ext_v - v > thresh:
                if 0 < ext_i < n - 1:
                    piv.append((ext_i / (n - 1), ext_v, 1))
                trend, ext_i, ext_v = -1, i, v
        else:
            if v < ext_v:
                ext_i, ext_v = i, v
            elif v - ext_v > thresh:
                if 0 < ext_i < n - 1:
                    piv.append((ext_i / (n - 1), ext_v, -1))
                trend, ext_i, ext_v = 1, i, v
    return piv


def pivot_distance(query_close: np.ndarray, window_close: np.ndarray) -> float:
    """RMS gap between the query's pivot levels and the window's extremes at
    the same relative positions, both in smoothed z units: 0 when every swing
    extreme sits at matching height, growing continuously as any of them
    drifts. Positions are the QUERY's only — the window never needs its own
    pivots detected, which is what keeps the term free of threshold flips."""
    q = np.asarray(query_close, dtype=np.float64).ravel()
    if q.size < _PIVOT_MIN_BARS:
        return 0.0
    try:
        piv = query_pivots(q)
    except ValueError:
        return 0.0
    if len(piv) < 2:
        # One lone extreme is macro trajectory, which multires already scores;
        # relative heights need at least two.
        return 0.0
    try:
        zw = _smooth_z(window_close)
    except ValueError:
        return float(np.inf)
    exts = _window_extremes_at(piv, zw)
    diffs = [ext - level for ext, (_, level, _) in zip(exts, piv)]
    return float(np.sqrt(np.mean(np.square(diffs))))


def _window_extremes_at(piv: list[tuple[float, float, int]], zw: np.ndarray) -> list[float]:
    """The window's local extreme level at each query pivot's relative
    position: max for a high pivot, min for a low, read from a neighbourhood
    of _PIVOT_TOL_FRAC (capped at half the gap to the neighbouring pivots so
    one window swing cannot satisfy two query pivots)."""
    n = len(zw)
    positions = [p for p, _, _ in piv]
    out = []
    for k, (pos, _, d) in enumerate(piv):
        gap_prev = pos - positions[k - 1] if k > 0 else 1.0
        gap_next = positions[k + 1] - pos if k + 1 < len(piv) else 1.0
        half_frac = min(_PIVOT_TOL_FRAC, 0.5 * min(gap_prev, gap_next))
        c = pos * (n - 1)
        half = max(1.0, half_frac * (n - 1))
        lo = max(0, int(np.floor(c - half)))
        hi = min(n - 1, int(np.ceil(c + half)))
        seg = zw[lo : hi + 1]
        out.append(float(seg.max() if d > 0 else seg.min()))
    return out


# Weight of the envelope-divergence term against the multi-resolution
# distance. The term compares how the two paths' top and floor envelopes
# TREND: trendline through the query's high pivots, another through its low
# pivots, the window's extremes at the same positions get theirs, and the
# distance is the mean absolute slope gap. It separates what pointwise and
# pivot-level distances cannot: an expanding consolidation (tops rising, floor
# flat — the Sept 2026 expanding-tops case) from a staircase or parallel
# channel with a near-identical silhouette. On the benchmark it lifts that
# case's user-endorsed EURUSD window from unfound to rank 3 with every other
# case's ranks byte-identical; 0.2 over 0.1 ranks it 3 vs 4, nothing else
# moves.
ENVELOPE_WEIGHT = 0.2
# The envelope reads a LIGHTLY smoothed path (fixed 3-bar kernel), not the
# query-relative m/8 kernel the other macro terms use: an oscillation-rich
# query's swing structure (~10 pivots in 60 bars) lives below the m/8 scale —
# after that smoothing only 2 pivots survive and the term could never engage
# (needs two per side). Pivots are still detected on the QUERY only; the
# window side is the same continuous extremes-read as the pivot term, so the
# rejected swing-count penalty's threshold flips stay impossible.
_ENV_LIGHT_KERNEL = 3
_ENV_REV_FRAC = 0.15
_ENV_MIN_BARS = 16


def _light_z(close: np.ndarray) -> np.ndarray:
    """A close path's lightly smoothed, z-normalized form — the curve the
    envelope term measures on. Raises ValueError on a flat path."""
    x = np.asarray(close, dtype=np.float64).ravel()
    return zflat(smooth_close(x.reshape(-1, 1), _ENV_LIGHT_KERNEL))


def _slope(pts: list[tuple[float, float]]) -> float:
    """Least-squares slope of (position, level) points, per unit position."""
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])
    denom = float(((xs - xs.mean()) ** 2).sum()) or 1e-9
    return float(((xs - xs.mean()) * (ys - ys.mean())).sum() / denom)


def envelope_divergence_distance(query_close: np.ndarray, window_close: np.ndarray) -> float:
    """Mean absolute gap between the query's and window's envelope trendline
    slopes (tops fitted through high pivots, floor through low pivots, both
    in light-smoothed z per unit position): 0 when both envelopes trend the
    same way, growing continuously as either diverges. Gates off (0.0) when
    the query lacks two pivots per side — a sparse query's envelopes are its
    macro trajectory, which multires already scores."""
    q = np.asarray(query_close, dtype=np.float64).ravel()
    if q.size < _ENV_MIN_BARS:
        return 0.0
    try:
        piv = _zigzag_pivots(_light_z(q), _ENV_REV_FRAC)
    except ValueError:
        return 0.0
    highs = [(p, lv) for p, lv, d in piv if d > 0]
    lows = [(p, lv) for p, lv, d in piv if d < 0]
    if len(highs) < 2 or len(lows) < 2:
        return 0.0
    try:
        zw = _light_z(window_close)
    except ValueError:
        return float(np.inf)
    exts = _window_extremes_at(piv, zw)
    w_highs = [(p, exts[i]) for i, (p, _, d) in enumerate(piv) if d > 0]
    w_lows = [(p, exts[i]) for i, (p, _, d) in enumerate(piv) if d < 0]
    dh = abs(_slope(highs) - _slope(w_highs))
    dl = abs(_slope(lows) - _slope(w_lows))
    return 0.5 * (dh + dl)


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
                + PIVOT_WEIGHT * pivot_distance(query_close, win)
                + ENVELOPE_WEIGHT * envelope_divergence_distance(query_close, win)
            ),
            forward_len=h.forward_len,
        )
        for h in hits
    ]
    out.sort(key=lambda h: h.distance)
    return out

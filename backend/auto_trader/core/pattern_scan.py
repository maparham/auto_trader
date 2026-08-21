"""Shape-matching maths for pattern search: how close is a window of candles to
a query window, computed for every offset in a series at once.

Pure numpy. No I/O, no database, no FastAPI — the caller supplies arrays, which
is what lets the fast path be checked against a brute-force reference in tests.

The distance is a per-component RMS over the z-normalized vector, so it is
comparable across query lengths: 0 is an identical shape, 2 an exact inversion.
Price level and volatility scale drop out by construction.

Column count is whatever the arrays carry, never a mode flag: 4 columns compare
whole candles, 1 column compares closes only. The caller decides which array to
hand over, which keeps this module honest and testable either way."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Below this the window has no meaningful shape and no defined normalization.
_FLAT_EPS = 1e-12

# A window's prefix-sum variance is the difference of two large nearly-equal
# numbers, so it cancels badly when the true variance is small relative to the
# values' magnitude. Below this ratio the computed variance is noise, and the
# distance built from it is meaningless: a frozen 2012 window scored an exact
# 0.000 against a healthy query that brute force put at 0.61. Surviving windows
# have a relative variance error of roughly eps / _VAR_REL_EPS, about 2e-6.
_VAR_REL_EPS = 1e-10


def zflat(win: np.ndarray) -> np.ndarray:
    """Flatten an (M, C) window bar-major and z-normalize it.

    ONE mean and ONE sd over all M*C values, never per-column: that is what keeps
    body height, wick length and the gap to the previous bar in proportion to
    each other. Normalizing open/high/low/close separately would flatten exactly
    the traits this feature exists to match.

    C is whatever the caller passes: 4 for full candles, 1 for a close-only
    array. Nothing here is told which it is, and nothing here needs to be."""
    flat = np.asarray(win, dtype=np.float64).ravel()
    sd = flat.std()
    if sd <= _FLAT_EPS:
        raise ValueError("flat window: no price movement to normalize")
    return (flat - flat.mean()) / sd


def prefix_sums(ohlc: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Prefix sums of the row sums and row sums of squares, each length n+1.

    Independent of the query length, so the 4-column pair is computed once per
    series and reused by every search. The close-only pair is cheap enough
    (13 ms on the largest series, against a 4.5 s cold load) that the endpoint
    builds it per request rather than caching a second one. Pass the CENTRED
    series: see the module note in pattern_series on why."""
    x = np.asarray(ohlc, dtype=np.float64)
    s1 = np.concatenate([[0.0], np.cumsum(x.sum(axis=1))])
    s2 = np.concatenate([[0.0], np.cumsum(np.square(x).sum(axis=1))])
    return s1, s2


def brute_distances(ohlc: np.ndarray, query: np.ndarray) -> np.ndarray:
    """Reference implementation: normalize every window and subtract. Obviously
    correct, far too slow for a real series. Exists so the fast path has
    something to be verified against."""
    x = np.asarray(ohlc, dtype=np.float64)
    qz = zflat(query)
    m = len(query)
    cols = x.shape[1]
    out = np.empty(len(x) - m + 1)
    for i in range(len(out)):
        flat = x[i : i + m].ravel()
        sd = flat.std()
        if sd <= _FLAT_EPS:
            out[i] = np.inf
            continue
        out[i] = np.linalg.norm((flat - flat.mean()) / sd - qz)
    return out / np.sqrt(cols * m)


# Queries at or above this length compute the sliding dot product via FFT.
# np.correlate is O(n*m): fine at m=64, ~2 GFLOP per rung at m=1024 on the
# largest series. The FFT path is O(n log n) INDEPENDENT of m, and the series
# transform is computed once per scan and shared by every rung.
_FFT_MIN_M = 96


def series_fft(ohlc: np.ndarray, max_m: int) -> tuple[list[np.ndarray], int]:
    """Per-column rFFT of the series, padded for 'valid' correlation against
    queries up to max_m bars. Computed once per scan, reused across rungs."""
    x = np.asarray(ohlc, dtype=np.float64)
    fft_len = 1 << (len(x) + max_m - 1).bit_length()
    return [np.fft.rfft(x[:, k], fft_len) for k in range(x.shape[1])], fft_len


def _corr_valid(
    x_col: np.ndarray, q_col: np.ndarray, xf: np.ndarray | None, fft_len: int
) -> np.ndarray:
    """correlate(x, q, 'valid'), via the precomputed series FFT when given."""
    if xf is None:
        return np.correlate(x_col, q_col, mode="valid")
    m, n = len(q_col), len(x_col)
    qf = np.fft.rfft(q_col[::-1], fft_len)
    return np.fft.irfft(xf * qf, fft_len)[m - 1 : n]


def window_distances(
    ohlc: np.ndarray,
    s1: np.ndarray,
    s2: np.ndarray,
    query: np.ndarray,
    xfft: tuple[list[np.ndarray], int] | None = None,
) -> np.ndarray:
    """Distance from `query` to every window of the same length, all at once.

    Expanding the norm turns this into terms that need no windowed copy:

        ||z(W) - z(q)||^2 = 2*cnt - 2 * (dot(W, qz) - mu_W * sum(qz)) / sd_W

    The window mean and sd come from the prefix sums differenced at lag M, and
    the dot product from a valid-mode correlation per column. Materialising the
    windows instead (sliding_window_view + reshape) copies 490 MB and takes 1.6 s
    on the largest series; this takes ~120 ms.

    sum(qz) is zero by construction, but the term stays in the expression so the
    identity holds under float error rather than by luck."""
    x = np.asarray(ohlc, dtype=np.float64)
    qz = zflat(query)
    m = len(query)
    # Read off the array rather than assumed: the same maths ranks a 4-column
    # candle array and a 1-column close-only one, and the function is never told
    # which it was handed.
    cols = x.shape[1]
    cnt = cols * m

    mu = (s1[m:] - s1[:-m]) / cnt
    var = np.maximum((s2[m:] - s2[:-m]) / cnt - mu * mu, 0.0)
    sd = np.sqrt(var)

    qcols = qz.reshape(m, cols)
    dot = np.zeros(len(x) - m + 1)
    cols_fft, fft_len = xfft if xfft is not None else ([None] * cols, 0)
    for k in range(cols):
        dot += _corr_valid(x[:, k], qcols[:, k], cols_fft[k], fft_len)

    untrustworthy = var <= _VAR_REL_EPS * mu * mu
    safe_sd = np.where(untrustworthy | (sd <= 0.0), 1.0, sd)

    d2 = 2.0 * cnt - 2.0 * (dot - mu * qz.sum()) / safe_sd
    d = np.sqrt(np.maximum(d2, 0.0)) / np.sqrt(cnt)
    return np.where(untrustworthy, np.inf, d)


# A candidate whose wall-clock span exceeds the query's by more than this has a
# weekend or a data gap inside it that the query does not have.
_SPAN_FACTOR = 3.0


@dataclass(frozen=True)
class Match:
    """One accepted window: where it starts, how many bars it covers (the query
    length times whichever scale won there), how close it is, and how many bars
    of aftermath were available (which can be fewer than requested near the
    right edge)."""

    start: int
    length: int
    distance: float
    forward_len: int


# The time-scale ladder the endpoint searches: the same shape often recurs
# compressed or stretched in time, and a fixed-length window scores such a
# recurrence as noise (an OIL_CRUDE pattern at 0.6x the duration measured 1.19
# against 0.59 once rescaled). Geometric with ratio ~2^(1/3), so neighbouring
# rungs are close enough that a true match between them still scores well.
DEFAULT_SCALES: tuple[float, ...] = (0.5, 0.63, 0.79, 1.0, 1.26, 1.59, 2.0)


def stretch(query: np.ndarray, m: int) -> np.ndarray:
    """Resample an (n, C) query onto m bars, per column, linearly. Linear is
    enough: the metric z-normalizes, so only the path's shape matters."""
    q = np.asarray(query, dtype=np.float64)
    xi = np.linspace(0.0, len(q) - 1.0, m)
    xp = np.arange(len(q), dtype=np.float64)
    return np.stack([np.interp(xi, xp, q[:, k]) for k in range(q.shape[1])], axis=1)


def scan(
    ohlc: np.ndarray,
    s1: np.ndarray,
    s2: np.ndarray,
    ts: np.ndarray,
    query: np.ndarray,
    *,
    query_span: float,
    top_k: int,
    forward_bars: int,
    scales: tuple[float, ...] = (1.0,),
) -> tuple[list[Match], int]:
    """Rank every window against `query` — at every length in `scales` times the
    query's own — and return the best `top_k`, separated, with the number of
    candidate offsets that survived the filters (summed across scales).

    Rules, in order: drop windows with no defined shape, drop windows that
    straddle a gap the query does not, then take minima greedily across all
    scales at once, blanking everything that overlaps each pick so one event
    comes back once, at its best scale. `query_span` is the selection's own
    wall-clock span in seconds, supplied by the caller: a live-tail selection
    has no counterpart in the stored series to measure it from.

    The selection's own window is NOT removed. It comes back at distance ~0,
    which is the plainest evidence available that the matcher is working, and
    the greedy overlap blanking below is what keeps the list free of the
    query shifted by a bar or two: for a single scale it blanks exactly the
    range the old exclusion did."""
    m0 = len(query)
    n = len(ohlc)

    # One distance array per usable scale. A rescaled rung below 8 bars is
    # dropped: with so few z-normed values, near-perfect scores are spurious
    # and would crowd out real matches. The query's OWN length is exempt — a
    # short selection still scans at scale 1, as it always did. A scale that
    # stretches past the series contributes nothing rather than raising.
    lengths: list[int] = []
    dists: list[np.ndarray] = []
    usable = [
        m for f in scales
        if not ((m := int(round(m0 * f))) < 8 and m != m0) and 3 <= m <= n
    ]
    # One series transform shared by every rung, when any rung is long enough
    # for the FFT path to win.
    xfft = series_fft(ohlc, max(usable)) if usable and max(usable) >= _FFT_MIN_M else None
    for f in scales:
        m = int(round(m0 * f))
        if (m < 8 and m != m0) or m < 3 or m > n or m in lengths:
            continue
        q = query if m == m0 else stretch(query, m)
        d = window_distances(ohlc, s1, s2, q, xfft=xfft)

        # Rule 1 is already applied: window_distances returns inf for a flat
        # window.

        # Rule 2: span, scaled to this rung's bar count. One-directional on
        # purpose — a candidate tighter than the query is never the problem,
        # and rejecting those too would leave a weekend-straddling query
        # matching only other weekend-straddlers.
        if query_span > 0:
            spans = ts[m - 1 :] - ts[: len(ts) - m + 1]
            d[spans > query_span * (m / m0) * _SPAN_FACTOR] = np.inf
        lengths.append(m)
        dists.append(d)

    # Counted here: after the filters, before the greedy pass starts blanking.
    # This is what the endpoint reports as `scanned`.
    candidates = int(sum(np.isfinite(d).sum() for d in dists))

    # Rule 3: greedy over all scales at once, blanking every window (at every
    # scale) that overlaps the pick, so the list is distinct events rather
    # than one event shifted by a bar or found again a rung away.
    out: list[Match] = []
    for _ in range(top_k):
        k = min(range(len(dists)), key=lambda j: dists[j].min(), default=-1)
        if k < 0:
            break
        i = int(np.argmin(dists[k]))
        if not np.isfinite(dists[k][i]):
            break
        m = lengths[k]
        forward_len = min(forward_bars, n - (i + m))
        out.append(
            Match(start=i, length=m, distance=float(dists[k][i]), forward_len=max(0, forward_len))
        )
        for mk, d in zip(lengths, dists):
            d[max(0, i - mk + 1) : i + m] = np.inf
    return out, candidates

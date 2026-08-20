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


def window_distances(
    ohlc: np.ndarray, s1: np.ndarray, s2: np.ndarray, query: np.ndarray
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
    for k in range(cols):
        dot += np.correlate(x[:, k], qcols[:, k], mode="valid")

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
    """One accepted window: where it starts, how close it is, and how many bars
    of aftermath were available (which can be fewer than requested near the
    right edge)."""

    start: int
    distance: float
    forward_len: int


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
) -> tuple[list[Match], int]:
    """Rank every window against `query` and return the best `top_k`, separated,
    with the number of candidate offsets that survived the filters.

    Rules, in order: drop windows with no defined shape, drop windows that
    straddle a gap the query does not, then take minima greedily, blanking a
    query-length neighbourhood around each. `query_span` is the selection's own
    wall-clock span in seconds, supplied by the caller: a live-tail selection
    has no counterpart in the stored series to measure it from.

    The selection's own window is NOT removed. It comes back at distance ~0,
    which is the plainest evidence available that the matcher is working, and
    the greedy neighbourhood blanking below is what keeps the list free of the
    query shifted by a bar or two: it blanks exactly the range the old
    exclusion did."""
    m = len(query)
    d = window_distances(ohlc, s1, s2, query)

    # Rule 1 is already applied: window_distances returns inf for a flat window.

    # Rule 2: span. One-directional on purpose — a candidate tighter than the
    # query is never the problem, and rejecting those too would leave a
    # weekend-straddling query matching only other weekend-straddlers.
    if query_span > 0:
        spans = ts[m - 1 :] - ts[: len(ts) - m + 1]
        d[spans > query_span * _SPAN_FACTOR] = np.inf

    # Rule 3: greedy, blanking a query-length neighbourhood around each pick so
    # the list is distinct events rather than one event shifted by a bar.
    n = len(ohlc)
    # Counted here: after the three filters, before the greedy pass starts
    # blanking neighbourhoods. This is what the endpoint reports as `scanned`.
    candidates = int(np.isfinite(d).sum())
    out: list[Match] = []
    for _ in range(top_k):
        i = int(np.argmin(d))
        if not np.isfinite(d[i]):
            break
        forward_len = min(forward_bars, n - (i + m))
        out.append(Match(start=i, distance=float(d[i]), forward_len=max(0, forward_len)))
        d[max(0, i - m + 1) : i + m] = np.inf
    return out, candidates

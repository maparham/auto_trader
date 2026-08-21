"""Pattern scan maths. The fast path is checked against a naive reference on
every test that matters: the reference is obviously correct by inspection, the
fast one is not."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from auto_trader.core.pattern_scan import (
    Match,
    brute_distances,
    prefix_sums,
    scan,
    window_distances,
    zflat,
)


def _series(n: int, seed: int = 0) -> np.ndarray:
    """Random-walk OHLC at an index-like price level."""
    rng = np.random.default_rng(seed)
    close = 21000 + np.cumsum(rng.normal(0, 3, n))
    open_ = np.concatenate([[close[0] - 1], close[:-1]])
    span = np.abs(rng.normal(0, 4, n)) + 0.5
    high = np.maximum(open_, close) + span
    low = np.minimum(open_, close) - span
    return np.stack([open_, high, low, close], axis=1)


def test_zflat_shares_one_mean_and_sd_across_all_components():
    win = np.array([[1.0, 4.0, 0.0, 3.0], [3.0, 5.0, 2.0, 4.0]])
    z = zflat(win)
    assert z.shape == (8,)
    assert z.mean() == pytest.approx(0.0, abs=1e-12)
    assert z.std() == pytest.approx(1.0, abs=1e-12)
    # Ordering is bar-major: bar 0's o,h,l,c then bar 1's.
    assert np.argmin(z) == 2  # the 0.0 in bar 0's low


def test_zflat_rejects_a_flat_window():
    with pytest.raises(ValueError, match="flat window"):
        zflat(np.full((3, 4), 7.0))


def test_fast_path_matches_brute_force():
    ohlc = _series(500, seed=1)
    query = ohlc[123:131]
    s1, s2 = prefix_sums(ohlc - ohlc.mean())
    fast = window_distances(ohlc - ohlc.mean(), s1, s2, query)
    slow = brute_distances(ohlc, query)
    assert fast.shape == slow.shape == (500 - 8 + 1,)
    np.testing.assert_allclose(fast, slow, atol=1e-9)


def test_one_column_windows_are_scored_like_four_column_ones():
    """The close-only search hands the same functions a 1-column array. Nothing
    in the maths may assume 4: the column count comes off the array, so this is
    checked the same way the 4-column path is, against a direct normalization."""
    ohlc = _series(400, seed=7)
    closes = np.ascontiguousarray(ohlc[:, 3:4])
    query = closes[210:218]
    centred = closes - closes.mean()
    s1, s2 = prefix_sums(centred)
    fast = window_distances(centred, s1, s2, query)
    slow = brute_distances(closes, query)
    assert fast.shape == slow.shape == (400 - 8 + 1,)
    np.testing.assert_allclose(fast, slow, atol=1e-9)
    # And the direct definition, spelled out: one mean and one sd over the 8
    # close values, divided by sqrt(1 * 8) so lengths stay comparable.
    qz = (query.ravel() - query.ravel().mean()) / query.ravel().std()
    for i in (0, 137, 300):
        w = closes[i : i + 8].ravel()
        exact = np.linalg.norm((w - w.mean()) / w.std() - qz) / np.sqrt(8)
        assert fast[i] == pytest.approx(exact, abs=1e-6)


def test_a_window_matches_itself():
    """Exact in theory. In practice the expanded-norm identity has a float floor
    around 1e-7, so this asserts the floor rather than pretending it is not
    there. `brute_distances` is the exact one."""
    ohlc = _series(500, seed=2)
    query = ohlc[300:308]
    s1, s2 = prefix_sums(ohlc - ohlc.mean())
    d = window_distances(ohlc - ohlc.mean(), s1, s2, query)
    assert d[300] == pytest.approx(0.0, abs=1e-6)
    assert int(np.argmin(d)) == 300


def test_centring_cuts_the_cancellation_error():
    """Pins Global Constraint 2.

    Aggregated across many query positions on purpose. At a single offset the
    error can land either side of the max(d2, 0) clamp and read as exactly 0.0
    in BOTH modes, which proves nothing either way. Measured ratio here is ~36x;
    10x leaves room for platform float differences while still failing an
    uncentred implementation."""
    ohlc = _series(500_000, seed=3)
    centred = ohlc - ohlc.mean()
    s1c, s2c = prefix_sums(centred)
    s1r, s2r = prefix_sums(ohlc)

    centred_err, raw_err = [], []
    for p in np.linspace(1_000, len(ohlc) - 1_000, 15).astype(int):
        query = ohlc[p : p + 8]
        centred_err.append(window_distances(centred, s1c, s2c, query)[p])
        raw_err.append(window_distances(ohlc, s1r, s2r, query)[p])

    # A window against itself is 0 by definition, so what is left is pure float error.
    assert np.mean(raw_err) > 10 * np.mean(centred_err), (
        f"centred {np.mean(centred_err):.2e} vs uncentred {np.mean(raw_err):.2e}"
    )


def test_distance_is_scale_and_level_invariant():
    ohlc = _series(200, seed=4)
    query = ohlc[50:58]
    scaled = (query - query.mean()) * 0.1 + 4400.0
    s1, s2 = prefix_sums(ohlc - ohlc.mean())
    d_self = window_distances(ohlc - ohlc.mean(), s1, s2, query)[50]
    d_scaled = window_distances(ohlc - ohlc.mean(), s1, s2, scaled)[50]
    assert d_scaled == pytest.approx(d_self, abs=1e-9)


def test_distance_is_a_per_component_rms_so_lengths_compare():
    """An inverted window scores 2 regardless of M."""
    ohlc = _series(200, seed=5)
    for m in (4, 8, 20):
        query = ohlc[60 : 60 + m]
        inverted = -query
        s1, s2 = prefix_sums(ohlc - ohlc.mean())
        d = window_distances(ohlc - ohlc.mean(), s1, s2, inverted)[60]
        assert d == pytest.approx(2.0, abs=1e-9)


def _motif_series(reps: int, gap: int, seed: int = 9) -> tuple[np.ndarray, np.ndarray]:
    """A fixed 6-bar motif repeated `reps` times, separated by random filler, plus
    a matching 60-second timestamp axis."""
    rng = np.random.default_rng(seed)
    motif = np.array(
        [
            [10.0, 12.0, 9.5, 11.0],
            [11.0, 11.5, 10.0, 10.2],
            [10.2, 13.0, 10.1, 12.8],
            [12.8, 13.2, 12.0, 12.1],
            [12.1, 12.3, 11.0, 11.2],
            [11.2, 14.0, 11.1, 13.9],
        ]
    )
    blocks = []
    for _ in range(reps):
        blocks.append(motif + rng.normal(0, 0.01, motif.shape))
        blocks.append(rng.normal(30, 2, (gap, 4)))
    ohlc = np.concatenate(blocks)
    ts = np.arange(len(ohlc), dtype=np.int64) * 60
    return ohlc, ts


def _prep(ohlc):
    centred = ohlc - ohlc.mean()
    s1, s2 = prefix_sums(centred)
    return centred, s1, s2


def test_scan_finds_the_repeated_motif():
    """The query is the motif at index 0, so index 0 is itself one of the hits:
    the selection is scanned like any other window."""
    ohlc, ts = _motif_series(reps=4, gap=40)
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, top_k=5, forward_bars=10)
    starts = sorted(h.start for h in hits[:4])
    assert starts == [0, 46, 92, 138]
    assert all(h.distance < 0.05 for h in hits[:4])


def test_the_query_window_itself_is_returned_at_distance_zero():
    """The selection is deliberately not removed: it is the plainest evidence
    that the matcher is working, and greedy suppression (below) is what keeps
    its one-bar shifts out of the list."""
    ohlc, ts = _motif_series(reps=6, gap=40)
    centred, s1, s2 = _prep(ohlc)
    q_start = 92
    query = ohlc[q_start : q_start + 6]

    hits, candidates = scan(
        centred, s1, s2, ts, query,
        query_span=300.0, top_k=10, forward_bars=5,
    )
    assert hits[0].start == q_start
    # Not exactly 0: the prefix-sum path differences large near-equal numbers,
    # so an identical window scores at float noise, not at a hard zero.
    assert hits[0].distance == pytest.approx(0.0, abs=1e-5)
    # Every offset survives: nothing here is flat, gapped, or blanked.
    assert candidates == len(ohlc) - 6 + 1


def test_the_hits_never_include_the_query_shifted_by_a_bar_or_two():
    """The property the old exclusion rule used to be credited with. With the
    self-match present and picked first, greedy blanking is the only thing
    keeping q-1, q+1, q+2 out of the list, so removing `d[...] = np.inf` from
    the greedy pass fails here."""
    ohlc, ts = _motif_series(reps=6, gap=40)
    centred, s1, s2 = _prep(ohlc)
    q_start = 92
    hits, _ = scan(
        centred, s1, s2, ts, ohlc[q_start : q_start + 6],
        query_span=300.0, top_k=10, forward_bars=5,
    )
    assert q_start in {h.start for h in hits}, "fixture check: the self-match must be present"
    starts = sorted(h.start for h in hits)
    assert all(b - a >= 6 for a, b in zip(starts, starts[1:])), starts


def test_overlap_suppression_separates_the_hits():
    """Without it, the top-k is one event shifted by one bar, k times."""
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, top_k=6, forward_bars=5)
    starts = sorted(h.start for h in hits)
    assert all(b - a >= 6 for a, b in zip(starts, starts[1:]))


def test_span_rule_rejects_a_gap_straddling_window():
    """Non-vacuous by construction: the SAME window is a top hit without the gap
    and absent with it, on identical prices. Only the span rule can explain the
    difference, so deleting the rule fails this test.

    Putting the gap INSIDE the second motif matters. Putting it just before one
    would prove nothing: greedy suppression already blanks a query-length
    neighbourhood around every accepted hit, so the offsets either side of a
    match are absent whether or not the span rule exists."""
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)

    intact, _ = scan(
        centred, s1, s2, ts, ohlc[0:6],
        query_span=300.0, top_k=6, forward_bars=5,
    )
    assert 46 in {h.start for h in intact}, "fixture check: the motif at 46 should match"

    gapped = ts.copy()
    gapped[49:] += 3 * 86_400  # a weekend opens up in the MIDDLE of that motif
    hits, _ = scan(
        centred, s1, s2, gapped, ohlc[0:6],
        query_span=300.0, top_k=6, forward_bars=5,
    )
    starts = {h.start for h in hits}
    assert 46 not in starts  # same prices, same shape, now spanning three days
    assert 92 in starts      # the third motif is untouched and still found


def test_span_rule_is_one_directional():
    """A query that itself straddles a weekend must still find ordinary windows.

    The candidate count is what discriminates here, not the hit list: a
    symmetric rule would reject every ordinary 300-second window as ~865x too
    tight, collapsing the count to a handful of fellow straddlers. Asserting
    only that the motif is found would pass under either rule."""
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    gapped = ts.copy()
    gapped[3:] += 3 * 86_400  # the gap now falls inside the query itself
    span = float(gapped[5] - gapped[0])  # about three days

    hits, candidates = scan(
        centred, s1, s2, gapped, ohlc[0:6],
        query_span=span, top_k=6, forward_bars=5,
    )
    assert any(h.start == 46 for h in hits)
    # 133 offsets, essentially all of them surviving. A symmetric rule would
    # leave single digits.
    assert candidates >= 110


def test_forward_window_is_truncated_not_dropped_at_the_right_edge():
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    n = len(ohlc)
    q_start = n - 60
    hits, _ = scan(
        centred, s1, s2, ts, ohlc[q_start : q_start + 6],
        query_span=300.0, top_k=20, forward_bars=1000,
    )
    assert hits
    last = max(hits, key=lambda h: h.start)
    assert last.forward_len == n - (last.start + 6)
    assert last.forward_len < 1000


def test_scan_returns_matches_ranked_by_distance():
    ohlc, ts = _motif_series(reps=4, gap=40)
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, top_k=5, forward_bars=5)
    assert isinstance(hits[0], Match)
    assert [h.distance for h in hits] == sorted(h.distance for h in hits)


def test_scan_reports_how_many_candidates_survived_the_filters():
    """The endpoint reports this as `scanned`, so it has to mean offsets actually
    ranked, not offsets that exist."""
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    _, everything = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, top_k=1, forward_bars=5)
    assert everything == len(ohlc) - 6 + 1


def test_a_live_tail_selection_with_no_stored_counterpart_still_scans():
    """A selection sitting entirely in the live tail matches nothing at distance
    0, which is normal, not an error: the scan just ranks real history."""
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    unseen = ohlc[0:6] * np.array([[1.0, 1.0, 1.0, 1.0]]) + np.linspace(0, 4, 6)[:, None]
    hits, _ = scan(centred, s1, s2, ts, unseen, query_span=300.0, top_k=3, forward_bars=5)
    assert hits and all(h.distance > 0.0 for h in hits)


def _series_with_stale_stretch(n: int = 40_000, seed: int = 11) -> np.ndarray:
    """A normal walk preceded by a frozen stretch at a much lower historical
    price, which is what a stale feed actually looks like in this database:
    10.67% of dukascopy US100 5m's 8-bar windows are completely frozen, and the
    oldest of them sit near 2,783 while the series mean is near 21,000."""
    rng = np.random.default_rng(seed)
    close = 21_000 + np.cumsum(rng.normal(0, 3, n))
    close[:1_000] = 2783.399902
    close[1_000:2_000] = 2783.419922
    open_ = np.concatenate([[close[0]], close[:-1]])
    span = np.abs(rng.normal(0, 4, n)) + 0.5
    span[:2_000] = 0.0  # frozen bars have no wicks either
    high = np.maximum(open_, close) + span
    low = np.minimum(open_, close) - span
    return np.stack([open_, high, low, close], axis=1)


def _exact(window: np.ndarray, query: np.ndarray) -> float:
    """One window, normalized directly. The reference, with no prefix sums."""
    w, q = window.ravel(), query.ravel()
    zw = (w - w.mean()) / w.std()
    zq = (q - q.mean()) / q.std()
    return float(np.linalg.norm(zw - zq) / np.sqrt(len(w)))


def test_a_stale_flat_window_is_not_scored_as_a_perfect_match():
    """Found by running the real endpoint, never by the synthetic fixtures.

    On dukascopy US100 5m the top three hits were frozen 2012 and 2013 windows
    with a 0.01 point range scoring an exact 0.000, where brute force puts them
    at 0.61 to 1.08. The prefix-sum variance cancels catastrophically for a
    near-flat window far from the series mean (4.31e-05 computed against a true
    9.40e-05), the tiny sd blows up the dot product, d2 goes hugely negative,
    and max(d2, 0) turns the garbage into a perfect score."""
    ohlc = _series_with_stale_stretch()
    query = ohlc[30_000:30_008]
    centred = ohlc - ohlc.mean()
    s1, s2 = prefix_sums(centred)

    d = window_distances(centred, s1, s2, query)

    frozen = d[:1_990]
    assert np.all(np.isinf(frozen)), (
        f"{np.isfinite(frozen).sum()} frozen windows were scored instead of excluded; "
        f"best was {np.nanmin(frozen)}"
    )
    assert np.isfinite(d[30_000]) and d[30_000] == pytest.approx(0.0, abs=1e-6)


def test_every_surviving_window_agrees_with_the_direct_computation():
    """The guard must not merely hide the bad windows: whatever it lets through
    has to be right. Samples the live stretch and compares against a direct
    normalization with no prefix sums involved."""
    ohlc = _series_with_stale_stretch()
    query = ohlc[30_000:30_008]
    centred = ohlc - ohlc.mean()
    s1, s2 = prefix_sums(centred)
    d = window_distances(centred, s1, s2, query)

    live = np.flatnonzero(np.isfinite(d))
    assert len(live) > 30_000, "the guard rejected far too much"
    for i in live[:: max(1, len(live) // 300)]:
        assert d[i] == pytest.approx(_exact(ohlc[i : i + 8], query), abs=1e-5), (
            f"fast path disagrees with the direct computation at window {i}"
        )


def test_ghost_parity_fixture() -> None:
    """The chart's pattern-overlay ("ghost") scores candles against a pasted
    shape in the browser, in TypeScript, with its own copy of this metric
    (frontend/src/lib/patternGhost.ts). The two must never disagree about what
    a good match is, so both sides assert against this one fixture — a
    frontend-only change to the maths fails there, a backend one fails here."""
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "pattern_ghost_golden.json").read_text()
    )
    query = np.array(fixture["query"], dtype=np.float64)
    window = np.array(fixture["window"], dtype=np.float64)
    for i, expected in enumerate(fixture["prefixDistances"]):
        k = i + 2  # the fixture starts at a 2-bar prefix: one bar is not a shape
        d = np.linalg.norm(zflat(query[:k]) - zflat(window[:k])) / np.sqrt(4 * k)
        assert d == pytest.approx(expected, abs=1e-9)


# ---------------------------------------------------------------- multi-scale


def _wiggle(m: int = 12, seed: int = 5) -> np.ndarray:
    """A 12-bar shape with real structure: a sine leg with noise, as OHLC."""
    rng = np.random.default_rng(seed)
    c = 20 + 3 * np.sin(np.linspace(0, 2.5 * np.pi, m)) + rng.normal(0, 0.15, m)
    o = np.concatenate([[c[0]], c[:-1]])
    h = np.maximum(o, c) + 0.3
    l = np.minimum(o, c) - 0.3
    return np.stack([o, h, l, c], axis=1)


def _compress(win: np.ndarray, m: int) -> np.ndarray:
    """The obviously-correct reference resample: per-column linear interp."""
    xi = np.linspace(0, len(win) - 1, m)
    return np.stack([np.interp(xi, np.arange(len(win)), win[:, k]) for k in range(4)], axis=1)


def _scaled_series(seed: int = 7) -> tuple[np.ndarray, np.ndarray, int]:
    """The wiggle at index 0 full length, and compressed to 8 bars at `where`."""
    rng = np.random.default_rng(seed)
    motif = _wiggle()
    small = _compress(motif, 8)
    filler = lambda n: rng.normal(30, 2, (n, 4))  # noqa: E731
    ohlc = np.concatenate([motif, filler(48), small, filler(48)])
    ts = np.arange(len(ohlc), dtype=np.int64) * 60
    where = len(motif) + 48
    return ohlc, ts, where


def test_matches_carry_their_own_window_length():
    ohlc, ts = _motif_series(reps=3, gap=40)
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(centred, s1, s2, ts, ohlc[0:6], query_span=300.0, top_k=3, forward_bars=5)
    assert all(h.length == 6 for h in hits)


def test_scales_find_a_time_compressed_recurrence():
    """The same shape squeezed into 8 bars instead of 12. At the query's own
    length it is nowhere near the top (which is the bug this exists to fix);
    with scales it comes back as a near-exact hit at its own length."""
    ohlc, ts, where = _scaled_series()
    centred, s1, s2 = _prep(ohlc)
    query = ohlc[0:12]

    flat, _ = scan(centred, s1, s2, ts, query, query_span=660.0, top_k=10, forward_bars=0)
    assert not any(h.start == where and h.distance < 0.2 for h in flat)

    hits, _ = scan(
        centred, s1, s2, ts, query,
        query_span=660.0, top_k=10, forward_bars=0,
        scales=(0.5, 8 / 12, 1.0),
    )
    hit = next(h for h in hits if h.start == where)
    assert hit.length == 8
    assert hit.distance == pytest.approx(0.0, abs=1e-5)


def test_hits_from_different_scales_never_overlap():
    """One event must come back once, at its best scale, not once per scale."""
    ohlc, ts, _ = _scaled_series()
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(
        centred, s1, s2, ts, ohlc[0:12],
        query_span=660.0, top_k=30, forward_bars=0,
        scales=(0.5, 8 / 12, 1.0, 1.5),
    )
    spans = sorted((h.start, h.start + h.length) for h in hits)
    assert all(b0 >= a1 for (_, a1), (b0, _) in zip(spans, spans[1:])), spans


def test_degenerate_scales_are_skipped_not_fatal():
    """A scale that stretches past the series (or collapses the query to fewer
    than 3 bars) contributes nothing rather than raising."""
    ohlc, ts, where = _scaled_series()
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(
        centred, s1, s2, ts, ohlc[0:12],
        query_span=660.0, top_k=5, forward_bars=0,
        scales=(0.1, 1.0, 50.0),
    )
    assert hits[0].start == 0 and hits[0].distance == pytest.approx(0.0, abs=1e-5)


def test_rungs_below_eight_bars_are_not_scanned():
    """A 3-to-7-bar window has so few z-normed values that near-perfect scores
    are spurious; they would crowd out real matches. The query's OWN length is
    exempt: a short selection still scans at scale 1."""
    ohlc, ts, where = _scaled_series()
    centred, s1, s2 = _prep(ohlc)
    hits, _ = scan(
        centred, s1, s2, ts, ohlc[0:12],
        query_span=660.0, top_k=30, forward_bars=0, scales=(0.5, 1.0),
    )
    assert all(h.length != 6 for h in hits)

    short = ohlc[0:6]
    hits, _ = scan(
        centred, s1, s2, ts, short,
        query_span=300.0, top_k=3, forward_bars=0, scales=(0.5, 1.0),
    )
    assert hits[0].start == 0 and hits[0].length == 6


def test_scanned_counts_windows_across_all_scales():
    ohlc, ts, _ = _scaled_series()
    centred, s1, s2 = _prep(ohlc)
    _, one = scan(centred, s1, s2, ts, ohlc[0:12], query_span=660.0, top_k=1, forward_bars=0)
    _, both = scan(
        centred, s1, s2, ts, ohlc[0:12],
        query_span=660.0, top_k=1, forward_bars=0, scales=(8 / 12, 1.0),
    )
    n = len(ohlc)
    assert one == n - 12 + 1
    assert both == (n - 12 + 1) + (n - 8 + 1)

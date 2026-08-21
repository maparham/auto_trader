"""Banded DTW refinement: the second-stage matcher that re-scores the exact
scan's candidates, tolerating non-uniform time warping the rigid metric cannot.

The cost convention mirrors the rigid metric on purpose: squared local costs,
path-length-averaged, square-rooted, over the SAME one-mean-one-sd
z-normalization. On the diagonal path (no warping allowed, equal lengths) the
two metrics are the identical number, so a DTW distance reads on the familiar
0-to-2 scale."""

import numpy as np
import pytest

from auto_trader.core.pattern_dtw import dtw_distance, refine
from auto_trader.core.pattern_scan import Match, brute_distances


def _curve(n: int, seed: int = 7) -> np.ndarray:
    """A wiggly (n, 4) candle array with distinct O/H/L/C structure."""
    rng = np.random.default_rng(seed)
    c = np.cumsum(rng.normal(0, 1.0, n)) + 100.0
    o = np.concatenate([[c[0]], c[:-1]])
    h = np.maximum(o, c) + rng.uniform(0.1, 0.5, n)
    l = np.minimum(o, c) - rng.uniform(0.1, 0.5, n)
    return np.stack([o, h, l, c], axis=1)


def _warp_nonuniform(q: np.ndarray) -> np.ndarray:
    """Same length as q, but time runs slow in the first half and fast in the
    second: a warp no uniform rescale (scale ladder rung) can undo. Built by
    repeating and skipping REAL bars (a quadratic integer time map), so a
    perfect warp alignment exists for DTW to find."""
    n = len(q)
    idx = np.minimum(np.round((np.linspace(0.0, 1.0, n) ** 2) * (n - 1)).astype(int), n - 1)
    return q[idx]


class TestDtwDistance:
    def test_identical_windows_score_zero(self):
        q = _curve(20)
        assert dtw_distance(q, q.copy()) == pytest.approx(0.0, abs=1e-9)

    def test_level_and_scale_drop_out(self):
        q = _curve(20)
        assert dtw_distance(q, q * 3.0 + 500.0) == pytest.approx(0.0, abs=1e-9)

    def test_exact_inversion_scores_near_the_top_of_the_scale(self):
        # Warping can shave a little off the diagonal's exact 2.0, but an
        # inverted shape must still land near the top of the scale.
        q = _curve(20)
        assert dtw_distance(q, -q) > 1.5

    def test_zero_band_on_equal_lengths_is_the_rigid_distance(self):
        # With no warping allowed the only path is the diagonal, and the cost
        # convention makes that exactly the exact-scan distance.
        q = _curve(16, seed=1)
        w = _curve(16, seed=2)
        rigid = brute_distances(w, q)[0]
        assert dtw_distance(q, w, band_frac=0.0) == pytest.approx(rigid, rel=1e-9)

    def test_unequal_lengths_compare_natively(self):
        # 12 bars against a 19-bar copy that duplicates 7 of them: a legal
        # warp path exists, and no resampling happens on our side.
        q = _curve(12, seed=3)
        idx = np.sort(
            np.concatenate([np.arange(12), np.random.default_rng(1).choice(12, 7, replace=False)])
        )
        assert dtw_distance(q, q[idx]) < 0.15

    def test_band_constrains_the_warp(self):
        # The nonuniform warp needs a wide corridor: a generous band absorbs
        # it, a tight band cannot, so the tight score must be worse.
        q = _curve(30, seed=4)
        w = _warp_nonuniform(q)
        loose = dtw_distance(q, w, band_frac=0.5)
        tight = dtw_distance(q, w, band_frac=0.05)
        assert loose < tight

    def test_beats_the_rigid_metric_on_a_nonuniform_warp(self):
        q = _curve(30, seed=5)
        w = _warp_nonuniform(q)
        rigid = brute_distances(w, q)[0]
        assert dtw_distance(q, w) < rigid

    def test_flat_window_is_infinite_not_fatal(self):
        q = _curve(10)
        flat = np.full((10, 4), 42.0)
        assert dtw_distance(q, flat) == np.inf


class TestRefine:
    def test_reranks_a_warped_recurrence_above_a_rigidly_closer_one(self):
        # Candidate A: mild noise on q, rigidly closest. Candidate B: the same
        # shape nonuniformly warped, rigidly worse but a near-perfect warp
        # match. DTW must put B first.
        q = _curve(30, seed=6)
        rng = np.random.default_rng(0)
        a = q + rng.normal(0, 2.0, q.shape)
        b = _warp_nonuniform(q)
        series = np.concatenate([a, _curve(30, seed=9) + 50.0, b], axis=0)
        hits = [
            Match(start=0, length=30, distance=0.4, forward_len=0),
            Match(start=60, length=30, distance=0.9, forward_len=0),
        ]
        out = refine(series, q, hits)
        assert [h.start for h in out] == [60, 0]
        # Distances are replaced by the DTW score, still sorted ascending.
        assert out[0].distance < out[1].distance

    def test_everything_but_the_distance_survives(self):
        q = _curve(12, seed=8)
        series = np.concatenate([q, q], axis=0)
        hits = [Match(start=12, length=12, distance=0.0, forward_len=5)]
        out = refine(series, q, hits)
        assert out[0].start == 12 and out[0].length == 12 and out[0].forward_len == 5
        assert out[0].distance == pytest.approx(0.0, abs=1e-9)


class TestMatcherRegistry:
    """The mode string picks a matcher; the existing modes wrap unchanged."""

    def test_the_three_modes_are_registered(self):
        from auto_trader.core.pattern_matchers import MATCHERS

        assert set(MATCHERS) == {"ohlc", "close", "dtw"}

    def test_existing_modes_have_no_refine_stage(self):
        from auto_trader.core.pattern_matchers import MATCHERS

        assert MATCHERS["ohlc"].refine is None
        assert MATCHERS["close"].refine is None
        assert MATCHERS["ohlc"].close_only is False
        assert MATCHERS["close"].close_only is True

    def test_dtw_refines_full_candles_from_a_deep_candidate_pool(self):
        from auto_trader.core.pattern_matchers import MATCHERS

        m = MATCHERS["dtw"]
        assert m.close_only is False
        assert m.refine is refine
        # The panel shows ~20 rows; DTW re-ranks a much deeper pool so a
        # warped recurrence the rigid scan puts at rank 80 can still surface.
        assert m.candidate_pool >= 100

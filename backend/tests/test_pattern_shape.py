"""Shape-mode scoring: query-relative smoothing, the multi-resolution
distance, and the refine stage's contract."""

import numpy as np
import pytest

from auto_trader.core.pattern_scan import Match
from auto_trader.core.pattern_shape import (
    multires_distance,
    query_kernel,
    refine,
    smooth_close,
)


class TestQueryKernel:
    def test_scales_with_query_length(self):
        assert query_kernel(48) == 6
        assert query_kernel(64) == 8

    def test_short_queries_stay_almost_raw(self):
        # A 16-bar selection gets a 2-bar kernel; below that the identity.
        assert query_kernel(16) == 2
        assert query_kernel(8) == 1

    def test_never_wider_than_a_quarter_of_the_query(self):
        for m in range(3, 65):
            assert query_kernel(m) <= max(1, m // 4)


class TestSmoothClose:
    def test_kernel_one_is_the_identity(self):
        x = np.random.default_rng(1).normal(size=(50, 1))
        assert smooth_close(x, 1) is x

    def test_preserves_length_and_attenuates_noise(self):
        rng = np.random.default_rng(2)
        n = 400
        macro = np.sin(np.linspace(0, 3 * np.pi, n)) * 10
        noisy = (macro + rng.normal(0, 1.0, n)).reshape(-1, 1)
        sm = smooth_close(noisy, 7)
        assert sm.shape == (n, 1)
        assert np.abs(sm.ravel() - macro).mean() < np.abs(noisy.ravel() - macro).mean() * 0.6

    def test_even_kernel_still_preserves_length(self):
        x = np.random.default_rng(3).normal(size=(41, 1))
        assert smooth_close(x, 6).shape == (41, 1)

    def test_ends_stay_near_the_data(self):
        # Reflect padding: a rising line smooths to itself, ends included.
        x = np.linspace(0.0, 10.0, 30).reshape(-1, 1)
        sm = smooth_close(x, 5)
        assert np.allclose(sm, x, atol=1e-9)


class TestMultiresDistance:
    def test_identical_paths_score_zero(self):
        x = np.cumsum(np.random.default_rng(4).normal(size=64))
        assert multires_distance(x, x.copy()) == pytest.approx(0.0, abs=1e-9)

    def test_level_and_scale_drop_out(self):
        x = np.cumsum(np.random.default_rng(5).normal(size=48))
        assert multires_distance(x, x * 3.0 + 500.0) == pytest.approx(0.0, abs=1e-9)

    def test_inversion_scores_near_the_top_of_the_scale(self):
        x = np.cumsum(np.random.default_rng(6).normal(size=48))
        assert multires_distance(x, -x) > 1.5

    def test_macro_agreement_beats_texture_agreement(self):
        # The perceptual ordering this mode exists for: the same macro under
        # heavy bar noise must beat a different macro carrying the query's
        # own bar noise.
        rng = np.random.default_rng(7)
        n = 48
        v = np.abs(np.linspace(-1, 1, n)) * 30
        trend = np.linspace(0, 30, n)
        query = v + rng.normal(0, 1.0, n)
        same_macro = v + rng.normal(0, 2.0, n)
        texture_clone = trend + (query - v)
        assert multires_distance(query, same_macro) < multires_distance(query, texture_clone)

    def test_unequal_lengths_compare_natively(self):
        x = np.cumsum(np.random.default_rng(8).normal(size=48))
        stretched = np.interp(np.linspace(0, 47, 64), np.arange(48), x)
        assert multires_distance(x, stretched) < 0.2

    def test_flat_window_scores_infinity(self):
        x = np.cumsum(np.random.default_rng(9).normal(size=32))
        assert multires_distance(x, np.zeros(32)) == np.inf


class TestRefine:
    def test_rescores_and_reranks_keeping_everything_else(self):
        rng = np.random.default_rng(10)
        n = 300
        v = np.abs(np.linspace(-1, 1, 40)) * 30
        close = np.cumsum(rng.normal(0, 1.0, n)) + 100
        close[50:90] = v + rng.normal(0, 2.0, 40) + close[49]     # same macro, noisy
        close[200:240] = np.linspace(0, 30, 40) + (v - v) + close[199]  # trend decoy
        series = close.reshape(-1, 1)
        query = (v + rng.normal(0, 1.0, 40)).reshape(-1, 1)
        hits = [
            Match(start=200, length=40, distance=0.1, forward_len=7),
            Match(start=50, length=40, distance=0.9, forward_len=3),
        ]
        out = refine(series, query, hits)
        assert [h.start for h in out] == [50, 200]
        by_start = {h.start: h for h in out}
        assert by_start[50].forward_len == 3
        assert by_start[200].forward_len == 7
        assert by_start[50].distance < by_start[200].distance

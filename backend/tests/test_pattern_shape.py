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


def _knot_path(knots, m, amplitude=30.0):
    """Close path from (t, value) knots in the unit square, like the bench
    archetypes: np.interp over m bars, scaled to `amplitude`."""
    t = np.array([k[0] for k in knots])
    v = np.array([k[1] for k in knots])
    return np.interp(np.linspace(0.0, 1.0, m), t, v) * amplitude


_DOUBLE_TOP = ((0.0, 0.0), (0.25, 1.0), (0.5, 0.55), (0.75, 0.97), (1.0, 0.15))
_LOWER_HIGH = ((0.0, 0.0), (0.25, 1.0), (0.5, 0.55), (0.75, 0.72), (1.0, 0.15))


class TestPivotDistance:
    """The pivot-level term: swing extremes must sit at the same relative
    heights in the window as in the query — the 'second top clearly lower'
    decoy a pointwise path distance barely notices."""

    def test_identical_path_scores_near_zero(self):
        from auto_trader.core.pattern_shape import pivot_distance

        rng = np.random.default_rng(20)
        q = _knot_path(_DOUBLE_TOP, 48) + rng.normal(0, 0.5, 48)
        assert pivot_distance(q, q.copy()) == pytest.approx(0.0, abs=1e-9)

    def test_level_and_scale_drop_out(self):
        from auto_trader.core.pattern_shape import pivot_distance

        rng = np.random.default_rng(21)
        q = _knot_path(_DOUBLE_TOP, 48) + rng.normal(0, 0.5, 48)
        assert pivot_distance(q, q * 3.0 + 500.0) == pytest.approx(0.0, abs=1e-9)

    def test_lower_second_peak_scores_worse_than_true_recurrence(self):
        from auto_trader.core.pattern_shape import pivot_distance

        rng = np.random.default_rng(22)
        q = _knot_path(_DOUBLE_TOP, 48) + rng.normal(0, 0.5, 48)
        true_rec = _knot_path(_DOUBLE_TOP, 48) + rng.normal(0, 1.0, 48)
        lower = _knot_path(_LOWER_HIGH, 48) + rng.normal(0, 0.5, 48)
        assert pivot_distance(q, true_rec) < pivot_distance(q, lower)
        assert pivot_distance(q, lower) > 0.15

    def test_uniform_stretch_stays_small(self):
        from auto_trader.core.pattern_shape import pivot_distance

        rng = np.random.default_rng(23)
        q = _knot_path(_DOUBLE_TOP, 48) + rng.normal(0, 0.5, 48)
        for m in (38, 61, 96):
            stretched = np.interp(np.linspace(0, 47, m), np.arange(48), q)
            assert pivot_distance(q, stretched) < 0.1

    def test_trend_query_without_swings_scores_zero(self):
        from auto_trader.core.pattern_shape import pivot_distance

        rng = np.random.default_rng(24)
        q = np.linspace(0.0, 30.0, 48) + rng.normal(0, 0.4, 48)
        w = np.linspace(0.0, 30.0, 48) + rng.normal(0, 1.5, 48)
        assert pivot_distance(q, w) == 0.0

    def test_short_query_gated_off(self):
        from auto_trader.core.pattern_shape import pivot_distance

        rng = np.random.default_rng(25)
        q = _knot_path(_DOUBLE_TOP, 12) + rng.normal(0, 0.3, 12)
        w = _knot_path(_LOWER_HIGH, 12) + rng.normal(0, 0.3, 12)
        assert pivot_distance(q, w) == 0.0

    def test_shallow_double_top_still_confirms_its_pivots(self):
        # A double top with a shallow valley (0.3 of the range) is still a
        # double top to a chartist; the zigzag threshold must confirm both
        # peaks and the valley so the term engages rather than gating off.
        # A real US100 selection with this geometry got 1 pivot at the old
        # 0.2 threshold and the term contributed nothing.
        from auto_trader.core.pattern_shape import query_pivots

        shallow = ((0.0, 0.0), (0.25, 1.0), (0.5, 0.7), (0.75, 0.97), (1.0, 0.15))
        rng = np.random.default_rng(30)
        q = _knot_path(shallow, 48) + rng.normal(0, 0.5, 48)
        piv = query_pivots(q)
        assert len(piv) >= 3
        assert [d for _, _, d in piv[:3]] == [1, -1, 1]

    def test_refine_demotes_lower_high_decoy(self):
        # End-to-end: a clean lower-high decoy that the pointwise metric
        # slightly prefers over a noisy true double top must lose the
        # re-rank once pivot levels are compared.
        from auto_trader.core.pattern_shape import refine

        rng = np.random.default_rng(26)
        q = _knot_path(_DOUBLE_TOP, 48) + rng.normal(0, 0.5, 48)
        rng2 = np.random.default_rng(126)
        true_rec = _knot_path(_DOUBLE_TOP, 48) + rng2.normal(0, 2.4, 48)
        decoy = _knot_path(_LOWER_HIGH, 48) + rng2.normal(0, 0.4, 48)
        series = np.concatenate(
            [np.full(10, q[0]), true_rec, np.full(10, q[0]), decoy]
        ).reshape(-1, 1)
        hits = [
            Match(start=10 + 48 + 10, length=48, distance=0.1, forward_len=0),
            Match(start=10, length=48, distance=0.2, forward_len=0),
        ]
        out = refine(series, q.reshape(-1, 1), hits)
        assert out[0].start == 10  # matching peak levels win


class TestActivityProfile:
    """The auxiliary term of shape refinement: WHERE structure lives along the
    path, on a scale the amplitude hierarchy cannot squash."""

    def _top_lead(self, rng, wiggle=2.0, noise=0.5):
        n = 64
        t = np.linspace(0, 1, n)
        main = np.where(t < 0.35, 1.0, np.where(t < 0.55, 1 - (t - 0.35) / 0.2 * 0.9,
                                                0.1 + (t - 0.55) / 0.45 * 0.5)) * 30
        lead = np.where(t < 0.35, np.sin(t * 40) * wiggle, 0.0)
        return main + lead + rng.normal(0, noise, n)

    def test_flat_lead_scores_far_from_structured_lead(self):
        from auto_trader.core.pattern_shape import activity_distance

        rng = np.random.default_rng(1)
        q = self._top_lead(rng)
        structured = self._top_lead(rng)
        flat = self._top_lead(rng, wiggle=0.0, noise=0.15)
        assert activity_distance(q, structured) < 0.35
        assert activity_distance(q, flat) > 0.5

    def test_uniform_stretch_stays_well_inside_the_match_band(self):
        # Not exactly zero: resampling smooths the noise floor non-uniformly
        # and the kernel width steps with length. The property that matters is
        # that a stretched copy stays far below the flat-lead separation.
        from auto_trader.core.pattern_shape import activity_distance

        q = self._top_lead(np.random.default_rng(2))
        for m in (81, 101, 128):
            stretched = np.interp(np.linspace(0, 63, m), np.arange(64), q)
            assert activity_distance(q, stretched) < 0.35

    def test_overall_noise_level_drops_out(self):
        # Mean-centring: a uniformly noisier texture shifts every segment's
        # activity together and must not read as a different structure.
        from auto_trader.core.pattern_shape import activity_distance

        rng = np.random.default_rng(3)
        q = self._top_lead(rng, noise=0.5)
        noisy = self._top_lead(rng, noise=1.2)
        flat = self._top_lead(rng, wiggle=0.0, noise=0.15)
        assert activity_distance(q, noisy) < activity_distance(q, flat)

    def test_refine_prefers_structured_lead_over_flat(self):
        # The end-to-end property the term ships for: same dominant move, one
        # candidate with the query's structured lead, one dead flat — the
        # structured one must win the re-rank.
        from auto_trader.core.pattern_shape import refine

        rng = np.random.default_rng(4)
        q = self._top_lead(rng)
        structured = self._top_lead(rng)
        flat = self._top_lead(rng, wiggle=0.0, noise=0.15)
        series = np.concatenate([np.full(10, q[0]), structured, np.full(10, q[0]), flat]).reshape(-1, 1)
        hits = [
            Match(start=10 + 64 + 10, length=64, distance=0.1, forward_len=0),  # flat first
            Match(start=10, length=64, distance=0.2, forward_len=0),
        ]
        out = refine(series, q.reshape(-1, 1), hits)
        assert out[0].start == 10  # structured lead wins


# The expanding consolidation the envelope term exists for: an impulse, then
# swing highs stair-stepping upward while the swing lows hold nearly flat —
# and its two decoys: a staircase (both envelopes rising in parallel) and a
# flat channel chop (neither rising).
_EXPANDING = ((0.0, 0.0), (0.06, 0.55), (0.18, 0.72), (0.28, 0.50), (0.38, 0.80),
              (0.48, 0.52), (0.58, 0.88), (0.68, 0.54), (0.82, 1.0), (1.0, 0.78))
_STAIRCASE = ((0.0, 0.0), (0.12, 0.30), (0.24, 0.18), (0.36, 0.48), (0.48, 0.36),
              (0.60, 0.66), (0.72, 0.54), (0.84, 0.86), (1.0, 1.0))
_FLAT_CHOP = ((0.0, 0.0), (0.06, 0.6), (0.18, 0.75), (0.28, 0.45), (0.38, 0.75),
              (0.48, 0.45), (0.58, 0.75), (0.68, 0.45), (0.82, 0.75), (1.0, 0.6))


class TestEnvelopeDivergenceDistance:
    """The envelope-divergence term: the query's top and floor trendlines
    (through its light-kernel pivots) must trend the same way in the window —
    an expanding consolidation vs the staircase with the same silhouette."""

    def test_identical_path_scores_near_zero(self):
        from auto_trader.core.pattern_shape import envelope_divergence_distance

        rng = np.random.default_rng(30)
        q = _knot_path(_EXPANDING, 60) + rng.normal(0, 0.4, 60)
        assert envelope_divergence_distance(q, q.copy()) == pytest.approx(0.0, abs=1e-9)

    def test_level_and_scale_drop_out(self):
        from auto_trader.core.pattern_shape import envelope_divergence_distance

        rng = np.random.default_rng(31)
        q = _knot_path(_EXPANDING, 60) + rng.normal(0, 0.4, 60)
        assert envelope_divergence_distance(q, q * 3.0 + 500.0) == pytest.approx(0.0, abs=1e-9)

    def test_staircase_scores_worse_than_true_recurrence(self):
        from auto_trader.core.pattern_shape import envelope_divergence_distance

        rng = np.random.default_rng(32)
        q = _knot_path(_EXPANDING, 60) + rng.normal(0, 0.4, 60)
        true_rec = _knot_path(_EXPANDING, 60) + rng.normal(0, 0.8, 60)
        stair = _knot_path(_STAIRCASE, 60) + rng.normal(0, 0.4, 60)
        chop = _knot_path(_FLAT_CHOP, 60) + rng.normal(0, 0.4, 60)
        d_rec = envelope_divergence_distance(q, true_rec)
        assert d_rec < envelope_divergence_distance(q, stair)
        assert d_rec < envelope_divergence_distance(q, chop)

    def test_sparse_query_gates_off(self):
        from auto_trader.core.pattern_shape import envelope_divergence_distance

        # A clean V has at most one pivot per side: the term must not engage.
        v = _knot_path(((0.0, 1.0), (0.5, 0.0), (1.0, 0.95)), 48)
        anything = _knot_path(_STAIRCASE, 48)
        assert envelope_divergence_distance(v, anything) == 0.0

    def test_short_query_gated_off(self):
        from auto_trader.core.pattern_shape import envelope_divergence_distance

        q = _knot_path(_EXPANDING, 12)
        assert envelope_divergence_distance(q, _knot_path(_STAIRCASE, 12)) == 0.0

    def test_refine_demotes_staircase_decoy(self):
        from auto_trader.core.pattern_scan import Match
        from auto_trader.core.pattern_shape import refine

        rng = np.random.default_rng(33)
        q = _knot_path(_EXPANDING, 60) + rng.normal(0, 0.4, 60)
        true_rec = _knot_path(_EXPANDING, 60) + rng.normal(0, 0.8, 60)
        stair = _knot_path(_STAIRCASE, 60) + rng.normal(0, 0.4, 60)
        series = np.concatenate([stair, np.full(20, stair[-1]), true_rec]).reshape(-1, 1)
        hits = [
            Match(start=0, length=60, distance=0.1, forward_len=0),  # staircase first
            Match(start=80, length=60, distance=0.2, forward_len=0),
        ]
        out = refine(series, q.reshape(-1, 1), hits)
        assert out[0].start == 80  # the expanding recurrence wins

"""The benchmark harness's own correctness: hit rule, metrics, and the
experimental scoring pieces it compares. No database — everything synthetic."""

import numpy as np
import pytest

from auto_trader.core.pattern_scan import Match
from scripts.pattern_bench.experimental import (
    multires_distance,
    query_kernel,
    smooth_close,
    swing_directions,
    swing_penalty,
)
from scripts.pattern_bench.metrics import Region, is_bad_hit, is_hit, score_case
from scripts.pattern_bench.planting import (
    bar_scale,
    build_pattern,
    gapless_sites,
    invert,
    macro_path,
    plant,
)


def _match(start: int, length: int, distance: float = 0.5) -> Match:
    return Match(start=start, length=length, distance=distance, forward_len=0)


class TestHitRule:
    def test_exact_start_and_length_hits(self):
        assert is_hit(_match(100, 48), Region(100, 48))

    def test_start_within_two_bars_hits(self):
        assert is_hit(_match(98, 48), Region(100, 48))
        assert is_hit(_match(102, 48), Region(100, 48))

    def test_start_three_bars_off_misses(self):
        assert not is_hit(_match(97, 48), Region(100, 48))

    def test_start_tolerance_scales_with_region_length(self):
        # A 4-bar offset on a 120-bar window is the same event to the eye;
        # on a 48-bar window it is a different start. The smoothed scan's
        # best offset lands a few bars wide of a long plant, and a fixed
        # +-2 was scoring those finds as misses.
        assert is_hit(_match(105, 120), Region(100, 120))
        assert not is_hit(_match(107, 120), Region(100, 120))
        assert not is_hit(_match(104, 48), Region(100, 48))

    def test_any_ladder_rung_hits(self):
        assert is_hit(_match(100, 24), Region(100, 48))  # 0.5x
        assert is_hit(_match(100, 96), Region(100, 48))  # 2.0x

    def test_beyond_ladder_bounds_misses(self):
        assert not is_hit(_match(100, 20), Region(100, 48))
        assert not is_hit(_match(100, 100), Region(100, 48))


class TestScoreCase:
    def test_ranks_skip_query_overlaps(self):
        # The selection itself comes back first; it must not count as a find.
        cands = [_match(500, 48), _match(1000, 48), _match(2000, 48)]
        s = score_case(cands, Region(500, 48), [Region(2000, 48)], [])
        assert s.ranks == (2,)

    def test_unfound_expected_is_none(self):
        s = score_case([_match(1000, 48)], Region(0, 48), [Region(5000, 48)], [])
        assert s.ranks == (None,)
        assert s.mean_rank is None
        assert s.recall_at_10 == 0.0

    def test_precision_recall_bad(self):
        cands = [_match(1000, 48), _match(3000, 48), _match(4000, 48)]
        s = score_case(
            cands,
            Region(0, 48),
            [Region(1000, 48), Region(9000, 48)],
            [Region(3000, 48)],
        )
        assert s.precision_at_10 == pytest.approx(1 / 3)
        assert s.recall_at_10 == pytest.approx(0.5)
        assert s.bad_at_10 == 1


class TestSmoothing:
    def test_kernel_one_is_identity(self):
        x = np.random.default_rng(1).normal(size=(50, 1))
        assert np.array_equal(smooth_close(x, 1), x)

    def test_preserves_length_and_kills_noise(self):
        rng = np.random.default_rng(2)
        n = 400
        macro = np.sin(np.linspace(0, 3 * np.pi, n)) * 10
        noisy = (macro + rng.normal(0, 1.0, n)).reshape(-1, 1)
        sm = smooth_close(noisy, 7)
        assert sm.shape == (n, 1)
        # Closer to the macro than the raw path is.
        assert np.abs(sm.ravel() - macro).mean() < np.abs(noisy.ravel() - macro).mean() * 0.6

    def test_query_kernel_caps_short_queries(self):
        assert query_kernel(48, 1 / 8) == 6
        assert query_kernel(16, 1 / 8) == 2
        assert query_kernel(8, 1 / 8) == 1  # never wider than m//4
        assert query_kernel(12, 1 / 8) <= 3


class TestMultires:
    def test_identical_paths_score_zero(self):
        x = np.cumsum(np.random.default_rng(3).normal(size=64))
        assert multires_distance(x, x.copy()) == pytest.approx(0.0, abs=1e-9)

    def test_macro_beats_texture(self):
        # Same macro under heavy bar noise must beat a different macro that
        # carries the query's own noise: the perceptual ordering the plain
        # full-resolution metric gets wrong.
        rng = np.random.default_rng(4)
        n = 48
        v = np.abs(np.linspace(-1, 1, n)) * 30  # V shape
        trend = np.linspace(0, 30, n)
        noise = rng.normal(0, 2.0, n)
        query = v + rng.normal(0, 1.0, n)
        same_macro = v + noise
        texture_clone = trend + (query - v)
        assert multires_distance(query, same_macro) < multires_distance(query, texture_clone)

    def test_handles_unequal_lengths(self):
        x = np.cumsum(np.random.default_rng(5).normal(size=48))
        xi = np.interp(np.linspace(0, 47, 64), np.arange(48), x)
        assert multires_distance(x, xi) < 0.2


class TestSwings:
    def test_counts_three_swings(self):
        v = np.concatenate([np.linspace(0, 1, 20), np.linspace(1, 0, 20), np.linspace(0, 1, 20)])
        assert swing_directions(v) == [1, -1, 1]

    def test_trend_is_one_swing(self):
        assert swing_directions(np.linspace(0, 1, 30)) == [1]

    def test_small_wiggles_do_not_count(self):
        rng = np.random.default_rng(6)
        path = np.linspace(0, 30, 60) + rng.normal(0, 0.5, 60)
        assert swing_directions(path) == [1]

    def test_penalty_zero_for_matching_structure(self):
        v = np.concatenate([np.linspace(0, 1, 20), np.linspace(1, 0, 20)])
        assert swing_penalty(v, v * 3 + 5) == 0.0

    def test_penalty_positive_for_extra_swing(self):
        two = np.concatenate([np.linspace(0, 1, 20), np.linspace(1, 0, 20)])
        one = np.linspace(0, 1, 40)
        assert swing_penalty(two, one) > 0.0


class TestPlanting:
    def test_macro_path_spans_unit_range(self):
        for name in ("v-bottom", "double-top", "three-swing"):
            path = macro_path(name, 50)
            assert path.max() <= 1.0 and path.min() >= 0.0
            assert path.max() - path.min() > 0.8

    def test_build_pattern_is_deterministic(self):
        a = build_pattern("v-bottom", 30, 2.0, np.random.default_rng(9))
        b = build_pattern("v-bottom", 30, 2.0, np.random.default_rng(9))
        assert np.array_equal(a, b)

    def test_build_pattern_candles_are_coherent(self):
        bars = build_pattern("double-top", 40, 1.5, np.random.default_rng(10))
        o, h, l, c = bars.T
        assert (h >= np.maximum(o, c)).all()
        assert (l <= np.minimum(o, c)).all()

    def test_invert_mirrors_and_keeps_coherence(self):
        bars = build_pattern("v-bottom", 30, 1.0, np.random.default_rng(11))
        inv = invert(bars)
        assert (inv[:, 1] >= np.maximum(inv[:, 0], inv[:, 3])).all()
        assert (inv[:, 2] <= np.minimum(inv[:, 0], inv[:, 3])).all()
        # A V becomes a peak: correlation of closes is -1ish.
        assert np.corrcoef(bars[:, 3], inv[:, 3])[0, 1] < -0.99

    def test_plant_splices_continuously(self):
        rng = np.random.default_rng(12)
        c = np.cumsum(rng.normal(size=500)) + 100
        ohlc = np.stack([c, c + 0.5, c - 0.5, c], axis=1)
        bars = build_pattern("v-bottom", 40, 1.0, rng)
        plant(ohlc, 200, bars)
        assert ohlc[200, 0] == pytest.approx(ohlc[199, 3])

    def test_gapless_sites_avoid_gaps_and_overlap(self):
        ts = np.arange(0, 60000, 60, dtype=np.int64)
        ts[30000 // 60 :] += 100000  # one big gap in the middle
        sites = gapless_sites(ts, 50, 3, min_gap_bars=10)
        assert len(sites) == 3
        gap_idx = 30000 // 60
        for s in sites:
            assert not (s <= gap_idx - 1 < s + 50)
        for a in sites:
            for b in sites:
                if a != b:
                    assert abs(a - b) >= 60

    def test_bar_scale_is_median_step(self):
        c = np.array([0.0, 1.0, 3.0, 4.0, 6.0])
        ohlc = np.stack([c, c, c, c], axis=1)
        assert bar_scale(ohlc) == pytest.approx(np.median([1, 2, 1, 2]))


class TestBadHitRule:
    def test_full_cover_counts(self):
        assert is_bad_hit(_match(100, 60), Region(100, 60))
        assert is_bad_hit(_match(98, 76), Region(100, 60))  # bigger rung, full cover

    def test_sub_window_of_decoy_does_not_count(self):
        # A 47-bar rung inside a 60-bar decoy misses the decoy's tail — the
        # part that makes it a decoy — so it must not count as a bad find.
        assert not is_bad_hit(_match(100, 47), Region(100, 60))

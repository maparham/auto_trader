"""The one-series pipeline: params, ranking, stats, dedup."""
import numpy as np
import pytest

from auto_trader.core.pattern_presets import (
    FAMILIES, PARAM_SCHEMAS, STATS, Hit, Instance, _dedup_family_overlap,
    resolve_params, scan_series,
)


def bars_from_close(c):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    return np.stack([o, np.maximum(o, c) + 0.05, np.minimum(o, c) - 0.05, c], axis=1)


def path(knots, n=240, lead=60, level=100.0, span=20.0):
    t = np.array([k[0] for k in knots]); v = np.array([k[1] for k in knots])
    body = np.interp(np.linspace(0, 1, n), t, v) * span + level
    return np.concatenate([np.full(lead, body[0]), body])


DOUBLE_TOP = ((0.0, 0.0), (0.25, 1.0), (0.5, 0.45), (0.75, 0.97), (1.0, 0.1))
HNS = ((0.0, 0.0), (0.12, 0.6), (0.25, 0.2), (0.42, 1.0),
       (0.58, 0.22), (0.72, 0.58), (0.9, 0.15), (1.0, -0.2))


class TestParams:
    def test_every_family_has_schema_with_shared_knobs(self):
        for fam in FAMILIES:
            names = {d["name"] for d in PARAM_SCHEMAS[fam]}
            assert {"k", "min_bars", "max_bars", "strictness"} <= names

    def test_defaults_fill(self):
        p = resolve_params("hns", {})
        assert p["k"] == 2.0 and p["shoulder_tol"] == 0.35

    def test_unknown_param_rejected(self):
        with pytest.raises(ValueError, match="nope"):
            resolve_params("hns", {"nope": 1})

    def test_out_of_range_rejected(self):
        with pytest.raises(ValueError, match="k"):
            resolve_params("hns", {"k": 99.0})


class TestScanSeries:
    def test_finds_double_top_with_stats(self):
        b = bars_from_close(path(DOUBLE_TOP, n=300))
        hits = scan_series(b, [("double", resolve_params("double", {}))])
        assert hits and hits[0].instance.family == "double"
        assert hits[0].breakout_up_pct is None  # doubles: direction is definitional
        assert hits[0].source
        # Measure rule: target = valley level minus pattern height, below it.
        assert hits[0].target is not None and hits[0].target < 100.0

    def test_strictness_cuts(self):
        b = bars_from_close(path(DOUBLE_TOP, n=300))
        loose = scan_series(b, [("double", resolve_params("double", {}))])
        tight = scan_series(b, [("double", resolve_params("double", {"strictness": 0.2}))])
        assert len(tight) <= len(loose)

    def test_hns_suppresses_contained_double(self):
        b = bars_from_close(path(HNS, n=300))
        fams = [("hns", resolve_params("hns", {})), ("double", resolve_params("double", {}))]
        hits = scan_series(b, fams)
        assert any(h.instance.family == "hns" for h in hits)
        for h in hits:
            if h.instance.family != "double":
                continue
            for g in hits:
                if g.instance.family == "hns":
                    ov = min(h.instance.end, g.instance.end) - max(h.instance.start, g.instance.start)
                    assert ov < 0.8 * (h.instance.end - h.instance.start)

    def test_length_gate(self):
        b = bars_from_close(path(DOUBLE_TOP, n=300))
        p = resolve_params("double", {"min_bars": 2000})
        assert scan_series(b, [("double", p)]) == []

    def test_stats_table_covers_every_variant(self):
        for key in [("hns", "top"), ("hns", "inverse"), ("double", "top"),
                    ("double", "bottom"), ("broadening", "megaphone"),
                    ("broadening", "ascending"), ("broadening", "descending"),
                    ("triangle", "symmetric"), ("triangle", "ascending"),
                    ("triangle", "descending"), ("triangle", "rising-wedge"),
                    ("triangle", "falling-wedge")]:
            assert key in STATS and "source" in STATS[key]


def _mk_inst(start, end, family="triangle", variant="symmetric", forming=False):
    return Instance(start, end, family, variant, forming, (), 1, end, None)


def _mk_hit(start, end, dist, family="triangle", variant="symmetric"):
    return Hit(_mk_inst(start, end, family, variant), dist, None, None, "test")


class TestDedupFamilyOverlap:
    def test_heavily_overlapping_same_family_keeps_the_better_distance(self):
        better = _mk_hit(100, 200, dist=0.9)
        worse = _mk_hit(105, 195, dist=1.4)  # contained inside `better`'s span
        kept = _dedup_family_overlap([better, worse])
        assert kept == [better]

    def test_disjoint_same_family_instances_both_survive(self):
        h1 = _mk_hit(100, 200, dist=0.9)
        h2 = _mk_hit(400, 500, dist=1.4)
        kept = _dedup_family_overlap([h1, h2])
        assert sorted(kept, key=lambda h: h.instance.start) == [h1, h2]

    def test_overlap_across_different_families_is_not_suppressed(self):
        tri = _mk_hit(100, 200, dist=0.9, family="triangle")
        brd = _mk_hit(105, 195, dist=1.4, family="broadening")
        kept = _dedup_family_overlap([tri, brd])
        assert len(kept) == 2

    def test_scan_series_applies_the_pass_and_keeps_forming_first_start_order(self):
        # Two overlapping triangle instances (one is a distance-worse subset
        # of the other) plus a disjoint, later, forming one — scan_series's
        # final ordering must still be forming-first, then start ascending,
        # after the dedup pass runs.
        kept_a = _mk_hit(50, 150, dist=0.5, family="triangle")
        dup_of_a = _mk_hit(55, 145, dist=1.0, family="triangle")
        forming = Hit(_mk_inst(300, 400, forming=True), 0.6, None, None, "test")
        hits = [dup_of_a, forming, kept_a]
        deduped = _dedup_family_overlap(hits)
        assert dup_of_a not in deduped
        assert kept_a in deduped and forming in deduped
        deduped.sort(key=lambda h: (not h.instance.forming, h.instance.start))
        assert deduped[0] is forming


# F3: an ideal planted instance of EVERY archetype variant must survive
# default strictness through the full scan_series pipeline (grammar -> rank
# -> strictness cut), or the variant silently never reports. Knots for hns/
# double/megaphone/ascending-broadening/symmetric-triangle are copied
# verbatim from their grammar test files (test_pattern_presets_hns.py's HNS,
# test_pattern_presets_double.py's DOUBLE_TOP, test_pattern_presets_
# envelope.py's MEGAPHONE/ASC_BROAD/SYM_TRI) — those files have no
# family-wide "ideal" concept, just enough geometry to exercise one variant.
# The remaining five (broadening descending, triangle ascending/descending,
# both wedges) have no grammar-test geometry to borrow at all, so their
# knots here are literally the module's own PRE-recalibration ARCHETYPES
# values (before F3's knot-trim), used as the planted "ideal" shape and
# ranked against the NOW-recalibrated ARCHETYPES — i.e. two different
# objects, not a circular self-check, but self-authored geometry rather than
# an independent source. NOTE: several pairs below are mirrors of one shape
# rather than independent geometry -- DESC_BROAD_KNOTS is a v -> 1-v mirror
# of ASC_BROAD_KNOTS, FALLING_WEDGE_KNOTS is a v -> 1-v mirror of
# RISING_WEDGE_KNOTS, and hns/double's "inverse"/"bottom" cases below reuse
# the SAME knots through a runtime price mirror (mirror=True). Each such
# pair scores identically by construction (see the measured distances in
# ARCHETYPES' recalibration comment) -- this parametrization would not catch
# one half of a mirrored pair being miscalibrated independently of the other.
HNS_KNOTS = ((0.0, 0.0), (0.12, 0.6), (0.25, 0.2), (0.42, 1.0),
             (0.58, 0.22), (0.72, 0.58), (0.9, 0.15), (1.0, -0.2))
DOUBLE_TOP_KNOTS = ((0.0, 0.0), (0.25, 1.0), (0.5, 0.45), (0.75, 0.97), (1.0, 0.1))
MEGAPHONE_KNOTS = ((0.0, 0.5), (0.12, 0.65), (0.25, 0.35), (0.4, 0.78),
                   (0.55, 0.22), (0.72, 0.9), (0.88, 0.1), (1.0, 0.6))
ASC_BROAD_KNOTS = ((0.0, 0.2), (0.12, 0.5), (0.25, 0.2), (0.4, 0.65),
                   (0.55, 0.2), (0.72, 0.8), (0.88, 0.2), (1.0, 0.55))
DESC_BROAD_KNOTS = tuple((t, 1.0 - v) for t, v in ASC_BROAD_KNOTS)  # mirror of ASC_BROAD
SYM_TRI_KNOTS = ((0.0, 0.1), (0.12, 0.9), (0.28, 0.2), (0.45, 0.75),
                 (0.62, 0.32), (0.8, 0.62), (1.0, 0.45))
ASC_TRI_KNOTS = ((0.0, 0.1), (0.15, 0.8), (0.3, 0.3), (0.5, 0.8),
                 (0.65, 0.5), (0.82, 0.8), (1.0, 0.68))
DESC_TRI_KNOTS = ((0.0, 0.9), (0.15, 0.2), (0.3, 0.7), (0.5, 0.2),
                  (0.65, 0.5), (0.82, 0.2), (1.0, 0.32))
RISING_WEDGE_KNOTS = ((0.0, 0.0), (0.15, 0.5), (0.3, 0.2), (0.5, 0.7),
                      (0.65, 0.5), (0.82, 0.85), (1.0, 0.72))
FALLING_WEDGE_KNOTS = ((0.0, 1.0), (0.15, 0.5), (0.3, 0.8), (0.5, 0.3),
                       (0.65, 0.5), (0.82, 0.15), (1.0, 0.28))

DEFAULT_STRICTNESS = 1.6


def _plant(family, variant, knots, mirror=False):
    c = path(knots)
    if mirror:
        c = 2 * 100.0 - c
    b = bars_from_close(c)
    hits = scan_series(b, [(family, resolve_params(family, {}))])
    return [h for h in hits if h.instance.variant == variant]


class TestArchetypeCalibration:
    @pytest.mark.parametrize("family,variant,knots,mirror", [
        ("hns", "top", HNS_KNOTS, False),
        ("hns", "inverse", HNS_KNOTS, True),
        ("double", "top", DOUBLE_TOP_KNOTS, False),
        ("double", "bottom", DOUBLE_TOP_KNOTS, True),
        ("broadening", "megaphone", MEGAPHONE_KNOTS, False),
        ("broadening", "ascending", ASC_BROAD_KNOTS, False),
        ("broadening", "descending", DESC_BROAD_KNOTS, False),
        ("triangle", "symmetric", SYM_TRI_KNOTS, False),
        ("triangle", "ascending", ASC_TRI_KNOTS, False),
        ("triangle", "descending", DESC_TRI_KNOTS, False),
        ("triangle", "rising-wedge", RISING_WEDGE_KNOTS, False),
        ("triangle", "falling-wedge", FALLING_WEDGE_KNOTS, False),
    ])
    def test_ideal_instance_survives_default_strictness(self, family, variant, knots, mirror):
        matches = _plant(family, variant, knots, mirror)
        assert matches, f"{family}/{variant}: grammar found no instance for its own ideal shape"
        assert matches[0].distance <= DEFAULT_STRICTNESS, (
            f"{family}/{variant}: ideal-instance distance {matches[0].distance:.4f} "
            f"exceeds default strictness {DEFAULT_STRICTNESS} -- archetype miscalibrated"
        )

"""Bench-style planted case: archetype instances dressed in bar noise inside
a long random walk. The grammar must find what was planted and stay quiet on
a planted lookalike (parallel channel) and on the raw walk itself."""
import numpy as np

from auto_trader.core.pattern_presets import resolve_params, scan_series


def bars_from_close(c, rng):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    wick = np.abs(rng.normal(0, 0.15, len(c)))
    return np.stack([o, np.maximum(o, c) + wick, np.minimum(o, c) - wick, c], axis=1)


def knot_path(knots, m):
    t = np.array([k[0] for k in knots]); v = np.array([k[1] for k in knots])
    return np.interp(np.linspace(0, 1, m), t, v)


MEGAPHONE = ((0.0, 0.5), (0.12, 0.65), (0.25, 0.35), (0.4, 0.78),
             (0.55, 0.22), (0.72, 0.9), (0.88, 0.1), (1.0, 0.6))
CHANNEL = ((0.0, 0.0), (0.12, 0.3), (0.25, 0.1), (0.4, 0.42),
           (0.55, 0.22), (0.72, 0.55), (0.88, 0.35), (1.0, 0.65))


def build_series():
    rng = np.random.default_rng(42)
    # A calm random walk: sigma 0.3 keeps organic swings well under the
    # planted patterns' 15-unit span, so ground truth stays by-construction.
    walk = np.cumsum(rng.normal(0, 0.3, 3000)) + 500
    span = 15.0
    mega = knot_path(MEGAPHONE, 90) * span
    chan = knot_path(CHANNEL, 90) * span
    for site, body in ((600, mega), (1800, chan)):
        base = walk[site]
        walk[site : site + len(body)] = base + body - body[0]
        # Reconnect the tail so the plant doesn't create a phantom cliff.
        walk[site + len(body):] += (base + body[-1] - body[0]) - walk[site + len(body)]
    return bars_from_close(walk + rng.normal(0, 0.1, len(walk)), rng), 600, 90


class TestPlanted:
    def test_planted_megaphone_found_channel_ignored(self):
        ohlc, site, m = build_series()
        hits = scan_series(ohlc, [("broadening", resolve_params("broadening", {}))])
        # The planted megaphone: some hit overlapping the planted site.
        assert any(h.instance.start < site + m and h.instance.end > site
                   for h in hits), "planted megaphone not found"
        # The planted channel at 1800 must NOT report as broadening.
        assert not any(1800 < h.instance.start < 1890 for h in hits), \
            "parallel channel misread as broadening"

    def test_bare_walk_is_mostly_quiet(self):
        rng = np.random.default_rng(7)
        walk = np.cumsum(rng.normal(0, 0.3, 3000)) + 500
        ohlc = bars_from_close(walk, rng)
        fams = [(f, resolve_params(f, {})) for f in ("hns", "double", "broadening", "triangle")]
        hits = scan_series(ohlc, fams)
        # Random walks do produce occasional real-looking formations; the
        # gate is against noise-level spam, not perfection. scan_series now
        # runs a same-family overlap dedup pass (F2: keeps the better-distance
        # hit when one hit's span is >=70% covered by another of the same
        # family) — the same swing pair re-reported at multiple pivot
        # windows collapses to one hit instead of several. Measured post-dedup
        # counts across seeds 1/2/3/7/11/13: 21, 21, 25, 23, 22, 21 (was
        # 25-39 pre-dedup). The bound below (30) sits above that measured
        # spread with headroom.
        assert len(hits) < 30

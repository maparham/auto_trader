"""The benchmark's seven cases, each stressing one kind of visual similarity.

All construction is seeded and pinned to fixed wall-clock ranges of the real
candle database, so every run scores the same arrays. The query itself is
planted (except in real-recurrence, where it is a real window), the
expected-good windows share its macro trajectory under noise / tempo /
amplitude changes, and the known-bad windows share its texture while telling
a different price story.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .metrics import Region
from .planting import (
    amplify,
    bar_scale,
    build_pattern,
    gapless_sites,
    invert,
    jitter,
    load_segment,
    plant,
    residuals_of,
    reverse,
    tempo,
)

DB_PATH = "candle_history.db"


@dataclass
class Case:
    name: str
    description: str
    ts: np.ndarray
    ohlc: np.ndarray
    query_bars: np.ndarray
    query: Region
    expected: list[Region] = field(default_factory=list)
    known_bad: list[Region] = field(default_factory=list)

    @property
    def query_span(self) -> float:
        return float(self.ts[self.query.end - 1] - self.ts[self.query.start])


def _assemble(
    name: str,
    description: str,
    ts: np.ndarray,
    ohlc: np.ndarray,
    query_bars: np.ndarray,
    goods: list[np.ndarray],
    bads: list[np.ndarray],
) -> Case:
    """Plant query + labelled windows at spread-out gapless sites."""
    ohlc = ohlc.copy()
    windows = [query_bars] + goods + bads
    max_len = max(len(w) for w in windows)
    sites = gapless_sites(ts, max_len, len(windows))
    regions: list[Region] = []
    for site, bars in zip(sites, windows):
        plant(ohlc, site, bars)
        regions.append(Region(site, len(bars)))
    q = regions[0]
    return Case(
        name=name,
        description=description,
        ts=ts,
        ohlc=ohlc,
        # Read back post-plant, so the level shift is included like a real
        # selection would be.
        query_bars=ohlc[q.start : q.end].copy(),
        query=q,
        expected=regions[1 : 1 + len(goods)],
        known_bad=regions[1 + len(goods) :],
    )


def case_v_bottom_noise() -> Case:
    ts, ohlc = load_segment(DB_PATH, "dukascopy", "US100", "MINUTE_5", 1735000000, 1747000000)
    scale = bar_scale(ohlc)
    rng = np.random.default_rng(101)
    query = build_pattern("v-bottom", 48, scale, rng, amplitude=30, noise=1.0)
    goods = [build_pattern("v-bottom", 48, scale, rng, amplitude=30, noise=n) for n in (1.5, 2.5, 1.0, 2.0)]
    bads = [build_pattern("inv-v", 48, scale, rng, amplitude=30, noise=1.0) for _ in range(2)]
    resid = residuals_of(query, "v-bottom", 30, scale)
    bads.append(build_pattern("up-trend", 48, scale, rng, amplitude=30, residuals=resid))
    bads.append(build_pattern("down-trend", 48, scale, rng, amplitude=30, noise=1.0))
    return _assemble(
        "v-bottom-noise",
        "A V-shaped dip recurring under different bar noise; inverted and trending decoys.",
        ts, ohlc, query, goods, bads,
    )


def case_tempo_warp() -> Case:
    ts, ohlc = load_segment(DB_PATH, "dukascopy", "US100", "MINUTE_5", 1755000000, 1767000000)
    scale = bar_scale(ohlc)
    rng = np.random.default_rng(202)
    query = build_pattern("trend-pullback", 48, scale, rng, amplitude=30, noise=1.0)
    goods = [
        tempo(build_pattern("trend-pullback", 48, scale, rng, amplitude=30, noise=1.0), f)
        for f in (0.7, 0.8, 1.3, 1.6)
    ]
    bads = [
        tempo(build_pattern("inv-trend-pullback", 48, scale, rng, amplitude=30, noise=1.0), f)
        for f in (0.8, 1.3)
    ]
    bads.append(build_pattern("down-trend", 48, scale, rng, amplitude=30, noise=1.0))
    return _assemble(
        "tempo-warp",
        "The same rally-dip-rally at faster and slower tempo; inverted warps as decoys.",
        ts, ohlc, query, goods, bads,
    )


def case_texture_trap() -> Case:
    ts, ohlc = load_segment(DB_PATH, "capital-live", "GOLD", "MINUTE_5", 1740000000, 1756000000)
    scale = bar_scale(ohlc)
    rng = np.random.default_rng(303)
    query = build_pattern("double-top", 40, scale, rng, amplitude=30, noise=1.0)
    goods = [
        build_pattern("double-top", 40, scale, rng, amplitude=30, noise=2.5),
        build_pattern("double-top", 40, scale, rng, amplitude=30, noise=3.0),
        amplify(build_pattern("double-top", 40, scale, rng, amplitude=30, noise=1.5), 0.6),
        amplify(build_pattern("double-top", 40, scale, rng, amplitude=30, noise=1.5), 1.5),
    ]
    resid = residuals_of(query, "double-top", 30, scale)
    bads = [
        # The query's EXACT bar texture pasted onto other trajectories: what a
        # texture-dominated metric loves and a human immediately rejects.
        build_pattern("up-trend", 40, scale, rng, amplitude=30, residuals=resid),
        build_pattern("flat-chop", 40, scale, rng, amplitude=30, residuals=resid),
        build_pattern("inv-double-top", 40, scale, rng, amplitude=30, residuals=resid),
    ]
    return _assemble(
        "texture-trap",
        "A double top under alien texture and amplitude; its own texture on wrong trajectories as decoys.",
        ts, ohlc, query, goods, bads,
    )


def case_swing_count() -> Case:
    ts, ohlc = load_segment(DB_PATH, "capital", "OIL_CRUDE", "MINUTE", 1770000000, 1774000000)
    scale = bar_scale(ohlc)
    rng = np.random.default_rng(404)
    query = build_pattern("three-swing", 60, scale, rng, amplitude=30, noise=1.0)
    goods = [
        build_pattern("three-swing", 60, scale, rng, amplitude=30, noise=1.8),
        build_pattern("three-swing", 60, scale, rng, amplitude=30, noise=1.0),
        amplify(build_pattern("three-swing", 60, scale, rng, amplitude=30, noise=1.2), 0.7),
    ]
    bads = [
        build_pattern("two-swing", 60, scale, rng, amplitude=30, noise=1.0),
        build_pattern("two-swing", 60, scale, rng, amplitude=30, noise=1.5),
        build_pattern("four-swing", 60, scale, rng, amplitude=30, noise=1.0),
        build_pattern("four-swing", 60, scale, rng, amplitude=30, noise=1.5),
    ]
    return _assemble(
        "swing-count",
        "A three-swing zigzag; two- and four-swing paths with the same drift as decoys.",
        ts, ohlc, query, goods, bads,
    )


def case_trend_vs_chop() -> Case:
    ts, ohlc = load_segment(DB_PATH, "dukascopy", "US500", "MINUTE_5", 1730000000, 1742000000)
    scale = bar_scale(ohlc)
    rng = np.random.default_rng(505)
    query = build_pattern("trend-pullback", 48, scale, rng, amplitude=30, noise=1.0)
    goods = [
        build_pattern("trend-pullback", 48, scale, rng, amplitude=30, noise=1.6),
        tempo(build_pattern("trend-pullback", 48, scale, rng, amplitude=30, noise=1.0), 1.26),
        build_pattern("trend-pullback", 48, scale, rng, amplitude=30, noise=2.2),
    ]
    bads = [
        build_pattern("choppy-up", 48, scale, rng, amplitude=30, noise=1.0),
        build_pattern("choppy-up", 48, scale, rng, amplitude=30, noise=1.5),
        build_pattern("up-trend", 48, scale, rng, amplitude=30, noise=3.5),
    ]
    return _assemble(
        "trend-vs-chop",
        "A clean trend with one pullback; choppy climbs with the same net return as decoys.",
        ts, ohlc, query, goods, bads,
    )


def case_real_recurrence() -> Case:
    ts, ohlc = load_segment(DB_PATH, "dukascopy", "US100", "MINUTE_5", 1720000000, 1732000000)
    scale = bar_scale(ohlc)
    rng = np.random.default_rng(606)
    # The query is a REAL window: the first gapless site names it, then the
    # variants are planted elsewhere. No synthetic macro anywhere in this case.
    site = gapless_sites(ts, 48, 12)[5]
    query = ohlc[site : site + 48].copy()
    goods = [jitter(query, scale, rng, noise=n) for n in (1.0, 1.8, 2.5)]
    goods.append(tempo(query, 1.26))
    bads = [invert(query), invert(jitter(query, scale, rng, noise=1.0)), reverse(query)]
    ohlc2 = ohlc.copy()
    windows = goods + bads
    max_len = max(len(w) for w in windows)
    sites = [s for s in gapless_sites(ts, max_len, len(windows) + 4) if abs(s - site) > 1000][: len(windows)]
    if len(sites) < len(windows):
        raise ValueError("not enough sites clear of the real query window")
    regions = []
    for s, bars in zip(sites, windows):
        plant(ohlc2, s, bars)
        regions.append(Region(s, len(bars)))
    return Case(
        name="real-recurrence",
        description="A real US100 window; noise-jittered and tempo-warped copies vs inverted/reversed decoys.",
        ts=ts,
        ohlc=ohlc2,
        query_bars=query,
        query=Region(site, 48),
        expected=regions[: len(goods)],
        known_bad=regions[len(goods) :],
    )


def case_short_query() -> Case:
    ts, ohlc = load_segment(DB_PATH, "capital-live", "GOLD", "MINUTE_5", 1758000000, 1772000000)
    scale = bar_scale(ohlc)
    rng = np.random.default_rng(707)
    query = build_pattern("v-bottom", 16, scale, rng, amplitude=14, noise=0.8)
    goods = [build_pattern("v-bottom", 16, scale, rng, amplitude=14, noise=n) for n in (1.2, 1.6, 0.8)]
    bads = [
        build_pattern("inv-v", 16, scale, rng, amplitude=14, noise=0.8),
        build_pattern("inv-v", 16, scale, rng, amplitude=14, noise=1.2),
    ]
    return _assemble(
        "short-query",
        "A 16-bar V: the short-selection path where sub-8-bar ladder rungs drop out.",
        ts, ohlc, query, goods, bads,
    )


def case_flat_lead_trap() -> Case:
    ts, ohlc = load_segment(DB_PATH, "dukascopy", "US100", "MINUTE_5", 1747000000, 1755000000)
    scale = bar_scale(ohlc)
    rng = np.random.default_rng(808)
    query = build_pattern("top-lead-v", 64, scale, rng, amplitude=30, noise=0.6)
    goods = [
        build_pattern("top-lead-v", 64, scale, rng, amplitude=30, noise=1.0),
        build_pattern("top-lead-v", 64, scale, rng, amplitude=30, noise=0.6),
        tempo(build_pattern("top-lead-v", 64, scale, rng, amplitude=30, noise=0.8), 1.26),
    ]
    bads = [
        build_pattern("flat-lead-v", 64, scale, rng, amplitude=30, noise=0.3),
        build_pattern("flat-lead-v", 64, scale, rng, amplitude=30, noise=0.3),
        build_pattern("flat-lead-v", 64, scale, rng, amplitude=30, noise=0.5),
    ]
    return _assemble(
        "flat-lead-trap",
        "A structured rounded-top lead before a big V; dead-flat leads on the same V as decoys.",
        ts, ohlc, query, goods, bads,
    )


def case_pivot_trap() -> Case:
    ts, ohlc = load_segment(DB_PATH, "dukascopy", "US100", "MINUTE_5", 1742000000, 1754000000)
    scale = bar_scale(ohlc)
    rng = np.random.default_rng(909)
    query = build_pattern("double-top", 48, scale, rng, amplitude=30, noise=1.0)
    goods = [
        build_pattern("double-top", 48, scale, rng, amplitude=30, noise=2.0),
        build_pattern("double-top", 48, scale, rng, amplitude=30, noise=2.5),
        tempo(build_pattern("double-top", 48, scale, rng, amplitude=30, noise=1.5), 1.26),
    ]
    bads = [
        # The same path with one swing extreme moved: cleaner than every good
        # (noise 1.0 vs 2.0+), so a pointwise metric is tempted to rank the
        # wrong structure above the right one under noise.
        build_pattern("lower-high-top", 48, scale, rng, amplitude=30, noise=1.0),
        build_pattern("lower-high-top", 48, scale, rng, amplitude=30, noise=1.5),
        build_pattern("higher-high-top", 48, scale, rng, amplitude=30, noise=1.0),
    ]
    return _assemble(
        "pivot-trap",
        "A double top; the same path with its second peak moved down or up as decoys.",
        ts, ohlc, query, goods, bads,
    )


ALL_CASES = (
    case_v_bottom_noise,
    case_tempo_warp,
    case_texture_trap,
    case_swing_count,
    case_trend_vs_chop,
    case_real_recurrence,
    case_short_query,
    case_flat_lead_trap,
    case_pivot_trap,
)

"""TRENDLINES (sideless): config parsing, outputs, the geometry gates and the
detector. Ported from frontend/src/lib/indicators/trendlines.test.ts so both
runtimes are pinned by the same behaviours."""

import math
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series
from auto_trader.indicators.registry import SERIES_INDICATORS, resolve_instances
from auto_trader.indicators.trendlines import (
    MAX_LIVE_MULT,
    MAX_MAX_LINES,
    MAX_PAIR_PIVOTS,
    TL_ATR_LEN,
    TL_NEAREST,
    TrendLine,
    compute_trendlines,
    has_back_clearance,
    touch_weight,
    is_major,
    eligible_lines,
    merge_lines,
    over_ceilings,
    parse_trendlines_config,
    project_at,
    rank_key,
    side_sign,
    survival_key,
    step_crossing,
    tl_output_name,
    trendlines_outputs,
    trendlines_series,
    trendlines_warmup,
)

_T0 = datetime(2020, 1, 1, tzinfo=UTC)


def bar(i: int, low: float, high: float) -> Candle:
    mid = (low + high) / 2
    return Candle(time=_T0 + timedelta(minutes=i), open=mid, high=high, low=low, close=mid, volume=1.0)


def flat(n: int, frm: int = 0) -> list[Candle]:
    return [bar(frm + k, 99.5, 100.5) for k in range(n)]


def cfg(**over):
    base = replace(parse_trendlines_config([], {}), pivot_len=2, min_span_bars=5)
    return replace(base, **over)


def _mixed() -> TrendLine:
    return TrendLine(i1=0, p1=100.0, k1="high", i2=10, p2=90.0, k2="low", touches=2,
                     last_touch_idx=10, crossings=0, last_sign=0,
                     max_touch_gap=10, min_touch_gap=10, max_touch_idx=10)


# ---------------------------------------------------------------- config

def test_defaults_from_empty_params():
    c = parse_trendlines_config([], {})
    assert (c.pivot_len, c.touch_mult, c.min_touches, c.min_span_bars, c.max_proj_bars,
            c.max_lines) == (5, 0.0, 2, 20, 250, 3)
    assert c.pierce_mult == 0.25
    assert c.min_back_bars == 0
    assert (c.max_dist_atr, c.max_dist_pct) == (0.0, 0.0)
    assert (c.merge_atr, c.max_per_pivot, c.merge_pct) == (0.25, 0, 0.0)
    assert c.pair_pivots == MAX_PAIR_PIVOTS == 40
    assert (c.min_crossings, c.max_crossings) == (0, 0)
    assert c.timeframe is None


def test_reads_every_slot_in_order():
    c = parse_trendlines_config(
        [4, 0.5, 3, 30, 100, 9, 3, 6, 25, 7, 300, 0.2, 0.01, 60, 3, 1, 4, 0.4, 12, 2.5, 1.5, 0.75, 1, 0.3], {})
    assert (c.pivot_len, c.touch_mult, c.min_touches, c.min_span_bars, c.max_proj_bars, c.max_lines,
            c.min_swing_atr, c.min_swing_reach, c.pair_pivots, c.max_touches, c.max_span_bars,
            c.max_slope_atr, c.min_slope_atr, c.max_touch_spacing, c.min_touch_spacing,
            c.min_crossings, c.max_crossings, c.pierce_mult, c.min_back_bars,
            c.max_dist_atr, c.max_dist_pct, c.merge_atr, c.max_per_pivot, c.merge_pct) == (
        4, 0.5, 3, 30, 100, 9, 3, 6, 25, 7, 300, 0.2, 0.01, 60, 3, 1, 4, 0.4, 12, 2.5, 1.5, 0.75, 1, 0.3)


def test_slope_slots_are_signed():
    c = parse_trendlines_config([0] * 11 + [-0.3, -0.6], {})
    assert (c.max_slope_atr, c.min_slope_atr) == (-0.3, -0.6)
    assert parse_trendlines_config([0] * 11 + [float("nan"), "x"], {}).min_slope_atr == 0.0


def test_render_only_merge_settings_migrate_onto_slots_21_and_22():
    assert parse_trendlines_config([], {"dedupeAtr": 2.5}).merge_atr == 2.5
    assert parse_trendlines_config([], {"dedupe": False, "dedupeAtr": 2}).merge_atr == 0.0
    assert parse_trendlines_config([], {"dedupeAtr": -1}).merge_atr == 0.25
    assert parse_trendlines_config([], {"dedupeAtr": True}).merge_atr == 0.25
    assert parse_trendlines_config([5] * 21 + [0.5], {"dedupeAtr": 2.5}).merge_atr == 0.5
    assert parse_trendlines_config([], {"declutter": "pivot"}).max_per_pivot == 1
    assert parse_trendlines_config([], {"declutter": "off"}).max_per_pivot == 0
    assert parse_trendlines_config([5] * 22 + [0], {"declutter": "pivot"}).max_per_pivot == 0
    assert parse_trendlines_config([5] * 22 + [3], {}).max_per_pivot == 3
    assert parse_trendlines_config([5] * 22 + [2.7], {}).max_per_pivot == 2
    assert parse_trendlines_config([5] * 22 + [-1], {}).max_per_pivot == 0


def test_a_saved_near_price_declutter_migrates_to_five_atr():
    # "Only lines near price" was a draw-time rule at a fixed TL_NEAR_PRICE_ATR.
    # A pane that CHOSE it keeps that cut as Max Distance; the slot being
    # present (even 0) wins over the legacy flag, and a pane that never chose
    # it stays off.
    assert parse_trendlines_config([], {"declutter": "near"}).max_dist_atr == 5.0
    assert parse_trendlines_config([], {"nearPrice": True}).max_dist_atr == 5.0
    assert parse_trendlines_config([], {"declutter": "off", "nearPrice": True}).max_dist_atr == 0.0
    assert parse_trendlines_config([], {}).max_dist_atr == 0.0
    assert parse_trendlines_config(list(range(20)), {"declutter": "near"}).max_dist_atr == 19.0
    assert parse_trendlines_config([5] * 19 + [0], {"declutter": "near"}).max_dist_atr == 0.0


def test_max_lines_is_clamped_to_the_ceiling():
    # A pane saved under the OLD calcParams layout reads its Max Projection into
    # slot 5. Each unit is a rule operand plus MAX_LIVE_MULT live lines, so the
    # parser caps it rather than minting 251 operands on a pane nobody touched.
    assert parse_trendlines_config([5, 0.75, 2, 20, 250, 250], {}).max_lines == MAX_MAX_LINES == 50
    # Anything under the ceiling is untouched, the goldens' 3 included.
    assert parse_trendlines_config([5, 0.75, 2, 20, 250, 3], {}).max_lines == 3


def test_zero_survives_on_the_ge_zero_params_and_integers_floor():
    c = parse_trendlines_config([2.9, 0, 1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], {})
    assert c.pivot_len == 2 and c.touch_mult == 0 and c.min_touches == 2
    assert c.min_span_bars == 20 and c.max_lines == 3
    assert c.min_swing_atr == 0 and c.max_touches == 0 and c.max_crossings == 0
    assert c.pierce_mult == 0


@pytest.mark.parametrize("junk", [None, "", [], "x", -1, float("nan"), float("inf")])
def test_junk_falls_back_to_the_default(junk):
    got = parse_trendlines_config([junk] * 18, {})
    want = parse_trendlines_config([], {})
    if junk == -1:
        # The two slope slots are SIGNED (mirrors TS signedAt): -1 is a real
        # Min/Max Slope, not junk, and lands as given.
        want = replace(want, max_slope_atr=-1.0, min_slope_atr=-1.0)
    assert got == want


def test_huge_int_literal_falls_back_instead_of_raising():
    assert parse_trendlines_config([10 ** 400], {}).pivot_len == 5


def test_non_list_calc_params_take_the_defaults():
    assert parse_trendlines_config("junk", {}) == parse_trendlines_config([], {})


def test_mtf_timeframe_pin():
    assert parse_trendlines_config([], {"mtf": {"timeframe": "DAY"}}).timeframe == "DAY"
    assert parse_trendlines_config([], {"mtf": {"timeframe": "chart"}}).timeframe is None


def test_outputs_are_ranked_then_nearest():
    assert trendlines_outputs(cfg(max_lines=3)) == ("tl_1", "tl_2", "tl_3", TL_NEAREST)
    assert tl_output_name(7) == "tl_7"
    assert len(trendlines_outputs(cfg(max_lines=9))) == 10


def test_warmup():
    c = parse_trendlines_config([], {})
    assert trendlines_warmup(c, "tl_1") == TL_ATR_LEN + 2 * 5 + 20
    assert trendlines_warmup(c, TL_NEAREST) == TL_ATR_LEN + 10 + 20
    assert trendlines_warmup(c, "tl_9") == 0  # not exposed at max_lines 3
    assert trendlines_warmup(c, "tl_support") == 0


# -------------------------------------------------------------- geometry

def _back_line() -> TrendLine:
    # 100@5 -> 90@15, so behind i1 the line sits at 101@4 ... 105@0.
    return TrendLine(
        i1=5, p1=100.0, k1="high", i2=15, p2=90.0, k2="low", touches=2.0,
        last_touch_idx=15, crossings=0, last_sign=0,
        max_touch_gap=10, min_touch_gap=10, max_touch_idx=15,
    )


def test_has_back_clearance_mirrors_the_ts():
    ln = _back_line()
    assert has_back_clearance(ln, [200, 0, 200, 0, 200, 100], 0)
    assert has_back_clearance(ln, [90, 90, 90, 90, 90, 100], 5)
    assert has_back_clearance(ln, [110, 110, 110, 110, 110, 100], 5)
    assert has_back_clearance(ln, [90, 104, 90, 102, 90, 100], 5)  # on the line: neutral
    assert not has_back_clearance(ln, [90, 90, 110, 90, 90, 100], 5)
    assert has_back_clearance(ln, [110, 90, 90, 90, 90, 100], 4)  # bar 0 outside the window
    assert not has_back_clearance(ln, [90, 90, 90, 90, 90, 100], 6)  # runs off the start


def test_project_at():
    l = _mixed()
    assert (project_at(l, 0), project_at(l, 10), project_at(l, 5), project_at(l, 20)) == (100, 90, 95, 80)


def test_touch_weight_scores_a_high_by_which_side_it_stops_on():
    # The line projects to 95 at bar 5. A swing HIGH tests it from below, so a
    # high AT or ABOVE the line is a pierce (1) and one below it a gap (0.5).
    l = _mixed()
    assert touch_weight(l, 5, 95.0, "high", 0.5, 0.25) == 1
    assert touch_weight(l, 5, 95.2, "high", 0.5, 0.25) == 1
    assert touch_weight(l, 5, 95.3, "high", 0.5, 0.25) == 0
    assert touch_weight(l, 5, 94.6, "high", 0.5, 0.25) == 0.5
    assert touch_weight(l, 5, 94.4, "high", 0.5, 0.25) == 0


def test_touch_weight_mirrors_the_rule_for_a_low():
    l = _mixed()
    assert touch_weight(l, 5, 95.0, "low", 0.5, 0.25) == 1
    assert touch_weight(l, 5, 94.8, "low", 0.5, 0.25) == 1
    assert touch_weight(l, 5, 94.7, "low", 0.5, 0.25) == 0
    assert touch_weight(l, 5, 95.4, "low", 0.5, 0.25) == 0.5
    assert touch_weight(l, 5, 95.6, "low", 0.5, 0.25) == 0


def test_touch_weight_at_zero_tolerances():
    l = _mixed()
    assert touch_weight(l, 5, 95.0, "high", 0, 0) == 1
    assert touch_weight(l, 5, 95.0, "low", 0, 0) == 1
    assert touch_weight(l, 5, 95.0001, "high", 0, 0) == 0
    assert touch_weight(l, 5, 94.9999, "high", 0, 0) == 0
    # The shipped Max Touch Gap: a pivot short of the line scores nothing.
    assert touch_weight(l, 5, 94.9, "high", 0, 0.25) == 0
    assert touch_weight(l, 5, 95.1, "low", 0, 0.25) == 0


def test_side_sign_and_step_crossing():
    l = _mixed()
    assert (side_sign(l, 5, 96), side_sign(l, 5, 94), side_sign(l, 5, 95)) == (1, -1, 0)
    step_crossing(l, 1, 98)
    assert (l.crossings, l.last_sign) == (0, -1)
    step_crossing(l, 3, 97)  # exactly on the line: keeps -1
    assert (l.crossings, l.last_sign) == (0, -1)
    step_crossing(l, 4, 99)
    assert (l.crossings, l.last_sign) == (1, 1)
    step_crossing(l, 5, 90)
    assert l.crossings == 2


def test_rank_key_order():
    base = _mixed()
    assert rank_key(replace(base, touches=3)) < rank_key(base)
    assert rank_key(replace(base, last_touch_idx=30)) < rank_key(base)
    assert rank_key(base) < rank_key(replace(base, crossings=2))
    a = replace(base, i1=0, last_touch_idx=20)
    b = replace(base, i1=5, last_touch_idx=25)
    assert rank_key(b) < rank_key(a)
    assert rank_key(replace(base, p1=50.0)) < rank_key(base)


def test_survival_key_order():
    """Mirrors the TS describe("survival order") block."""
    base = _mixed()
    assert survival_key(base) < survival_key(replace(base, crossings=2))
    # Fewer touches still outlives a crossed line: exactly where survival and
    # rank_key disagree.
    fewer_but_clean = replace(base, touches=2)
    many_but_crossed = replace(base, touches=9, crossings=1)
    assert survival_key(fewer_but_clean) < survival_key(many_but_crossed)
    assert rank_key(fewer_but_clean) > rank_key(many_but_crossed)
    # Equal crossings: the longer line, then the more touched one.
    assert survival_key(replace(base, last_touch_idx=30)) < survival_key(base)
    assert survival_key(replace(base, touches=3)) < survival_key(base)
    # Remaining ties: recency, origin, then anchor price.
    a = replace(base, i1=0, last_touch_idx=20)
    b = replace(base, i1=5, last_touch_idx=25)
    assert survival_key(b) < survival_key(a)
    assert survival_key(replace(base, p1=50.0)) < survival_key(base)
    assert survival_key(base) == survival_key(base)


def _walk(n: int, seed: int = 11) -> list[Candle]:
    """A deterministic random walk: unlike flat(), lines drawn through its
    pivots run THROUGH later price, so they collect crossings. Same LCG and
    seed as the TS twin, so both sides exercise the same shape."""
    s = seed
    bars: list[Candle] = []
    px = 100.0
    for i in range(n):
        s = (s * 1664525 + 1013904223) % (2**32)
        px += (s / 2**32 - 0.5) * 3
        bars.append(bar(i, px - 0.5, px + 0.5))
    return bars


def test_a_fresh_long_uncrossed_line_survives_the_cap():
    """A line is built once, at its second anchor, so losing the cap is
    permanent. Born with two touches into a crowd that already has more, it
    survives only because survival_key leads with crossings."""
    bars = _walk(240)
    floor_px = min(b.low for b in bars)
    bars[20] = bar(20, floor_px - 20, floor_px - 19)
    bars[160] = bar(160, floor_px - 10, floor_px - 9)
    c = cfg(max_lines=1, min_span_bars=5, pair_pivots=200)

    def deep(line: TrendLine) -> bool:
        return line.i1 == 20 and line.i2 == 160

    # Merge off: the emit-step merge walk is quadratic in what it keeps, and
    # this budget keeps everything.
    _, allx = compute_trendlines(bars, replace(c, max_lines=100_000, merge_atr=0))
    born = next(line for line in allx if deep(line))
    assert born.touches == 2 and born.crossings == 0
    crowd = [line for line in allx if line.touches > 2 and line.crossings > 0]
    assert len(crowd) > MAX_LIVE_MULT * c.max_lines

    _, lines = compute_trendlines(bars, c)
    assert len(lines) <= MAX_LIVE_MULT * c.max_lines
    assert any(deep(line) for line in lines), "the long uncrossed line was evicted at birth"


def test_crossings_floor_and_ceiling():
    l = replace(_mixed(), crossings=1)
    c = cfg(min_span_bars=5)
    assert not is_major(l, 12, replace(c, min_crossings=2))
    assert is_major(l, 12, replace(c, min_crossings=1))
    assert over_ceilings(replace(l, crossings=3), replace(c, max_crossings=2))
    assert not over_ceilings(replace(l, crossings=2), replace(c, max_crossings=2))


def test_coverage_ends_max_projection_past_the_last_touch():
    c = cfg()
    assert is_major(_mixed(), 10 + c.max_proj_bars, c)
    assert not is_major(_mixed(), 11 + c.max_proj_bars, c)


# -------------------------------------------------------------- detector

def test_returns_one_point_per_bar_and_emits_nothing_before_warmup():
    points, _ = compute_trendlines(flat(30), cfg())
    assert len(points) == 30 and points[0] == {}


def test_finds_a_rising_line_through_two_swing_lows():
    bars = flat(60)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    _, lines = compute_trendlines(bars, cfg())
    l = next(x for x in lines if x.i1 == 20 and x.i2 == 40)
    assert (l.k1, l.k2, l.p1, l.p2) == ("low", "low", 90, 94)


def test_connects_a_swing_high_to_a_later_swing_low():
    bars = flat(60)
    bars[20] = bar(20, 99.5, 110)
    bars[40] = bar(40, 90, 100.5)
    _, lines = compute_trendlines(bars, cfg())
    l = next(x for x in lines if x.i1 == 20 and x.i2 == 40)
    assert (l.k1, l.k2, l.p1, l.p2, l.crossings) == ("high", "low", 110, 90, 1)


def test_never_pairs_a_bars_own_high_with_its_own_low():
    bars = flat(60)
    bars[20] = bar(20, 90, 110)
    bars[40] = bar(40, 92, 108)
    _, lines = compute_trendlines(bars, cfg())
    assert all(l.i2 > l.i1 for l in lines)


def test_counts_crossings_instead_of_breaking():
    bars = flat(120)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 90, 100.5)
    for j in range(60, 70):
        bars[j] = bar(j, 80, 81)
    for j in range(70, 80):
        bars[j] = bar(j, 99.5, 100.5)
    _, lines = compute_trendlines(bars, cfg())
    l = next(x for x in lines if x.i1 == 20 and x.i2 == 40)
    assert l.crossings == 2


def test_a_later_pivot_of_either_kind_that_pierces_is_a_full_touch():
    bars = flat(100)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 90, 100.5)
    for j in range(55, 66):
        bars[j] = bar(j, 85, 86)
    bars[60] = bar(60, 85, 90.2)  # 0.2 THROUGH the flat line at 90; ATR is 1
    _, lines = compute_trendlines(bars, cfg())
    l = next(x for x in lines if x.i1 == 20 and x.i2 == 40)
    assert l.touches == 3 and l.last_touch_idx == 60


def test_a_pivot_that_stops_short_is_half_a_touch_only_if_a_gap_is_allowed():
    bars = flat(100)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 90, 100.5)
    for j in range(55, 66):
        bars[j] = bar(j, 85, 86)
    bars[60] = bar(60, 85, 89.7)  # 0.3 SHORT of the line
    _, tight = compute_trendlines(bars, cfg())
    t = next(x for x in tight if x.i1 == 20 and x.i2 == 40)
    assert t.touches == 2 and t.last_touch_idx == 40  # Max Touch Gap 0 by default
    _, loose = compute_trendlines(bars, cfg(touch_mult=0.3))
    l = next(x for x in loose if x.i1 == 20 and x.i2 == 40)
    assert l.touches == 2.5 and l.last_touch_idx == 60


def test_emits_ranked_outputs_and_the_nearest():
    bars = flat(80)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[25] = bar(25, 99.5, 108)
    bars[45] = bar(45, 99.5, 104)
    # Merge off, so the drawn set is the top max_lines majors by rank.
    c = cfg(max_lines=2, merge_atr=0)
    points, lines = compute_trendlines(bars, c)
    majors = sorted((l for l in lines if is_major(l, 79, c)), key=rank_key)
    assert len(majors) >= 3
    last = points[79]
    assert last["tl_1"] == project_at(majors[0], 79)
    assert last["tl_2"] == project_at(majors[1], 79)
    assert "tl_3" not in last
    close = bars[79].close
    # tl_nearest is the nearest AMONG THE DRAWN lines: only what is on the
    # chart takes part in a rule, and a third major ranked past the budget is
    # not on the chart.
    drawn = majors[:2]
    nearest = min(drawn, key=lambda l: (abs(project_at(l, 79) - close), rank_key(l)))
    assert last[TL_NEAREST] == project_at(nearest, 79)
    third = min(majors[2:], key=lambda l: abs(project_at(l, 79) - close))
    assert abs(project_at(third, 79) - close) < abs(project_at(nearest, 79) - close)


def _fan() -> list[Candle]:
    """Three lows at 20 (90), 40 (94) and 60 (98.5): the pairs 20-40, 20-60
    and 40-60 seed three lines that project within 1 ATR of each other at
    bar 79 and share pivots, so the merge pass keeps one (mirrors the TS)."""
    bars = flat(80)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[60] = bar(60, 98.5, 100.5)
    return bars


def test_merge_runs_in_the_emit_step():
    off = compute_trendlines(_fan(), cfg(merge_atr=0))[0][79]
    assert {"tl_1", "tl_2", "tl_3"} <= set(off)
    # The fan's lines sit ~0.74 apart at 79, past the quarter-ATR default.
    on = compute_trendlines(_fan(), cfg(merge_atr=1))[0][79]
    assert "tl_1" in on and "tl_2" not in on
    assert on[TL_NEAREST] == on["tl_1"]
    pivot = compute_trendlines(_fan(), cfg(merge_atr=0, max_per_pivot=1))[0][79]
    assert "tl_1" in pivot and "tl_2" not in pivot
    # At 2 per pivot the fan keeps two: the third shares a pivot with both.
    two = compute_trendlines(_fan(), cfg(merge_atr=0, max_per_pivot=2))[0][79]
    assert "tl_2" in two and "tl_3" not in two
    # The percent band reads the same way: 1% of 100 is the 1 ATR the fan
    # merges at; 0.1% is too tight for the 0.74 gap the wide pair has at 79.
    pct = compute_trendlines(_fan(), cfg(merge_atr=0, merge_pct=1))[0][79]
    assert "tl_1" in pct and "tl_2" not in pct
    tight = compute_trendlines(_fan(), cfg(merge_atr=0, merge_pct=0.1))[0][79]
    assert "tl_2" in tight


def test_merge_is_about_the_same_trend_not_a_shared_pivot():
    """Two parallel lines out of different swings, 0.5 apart the whole way,
    merge; two lines that only meet at the current bar do not."""
    a = TrendLine(i1=0, p1=90.0, k1="low", i2=50, p2=94.0, k2="low", touches=3,
                  last_touch_idx=50, crossings=0, last_sign=0, max_touch_gap=50,
                  min_touch_gap=50, max_touch_idx=50, touch_idxs=[0, 50])
    parallel = TrendLine(i1=10, p1=91.3, k1="low", i2=60, p2=95.3, k2="low", touches=2,
                         last_touch_idx=60, crossings=0, last_sign=0, max_touch_gap=50,
                         min_touch_gap=50, max_touch_idx=60, touch_idxs=[10, 60])
    crossing = TrendLine(i1=20, p1=70.0, k1="low", i2=60, p2=84.0, k2="low", touches=2,
                         last_touch_idx=60, crossings=0, last_sign=0, max_touch_gap=40,
                         min_touch_gap=40, max_touch_idx=60, touch_idxs=[20, 60])
    assert abs(project_at(crossing, 100) - project_at(a, 100)) < 0.01
    assert merge_lines([a, parallel, crossing], 100, 1.0) == [a, crossing]
    # One per pivot ignores distance and asks only about a shared pivot.
    twin = replace_line(a, i1=0, p1=90.0, i2=50, p2=99.0, touch_idxs=[0, 50])
    assert merge_lines([a, twin, parallel], 100, 0.0, math.inf, 1) == [a, parallel]


def test_widening_the_merge_tolerance_never_cuts_an_unrelated_line():
    """Mirrors the TS test: under a per-pivot cap the merge and the cap used
    to share one walk, so merging B away freed bar 10, let C in, which filled
    bar 60 and cut D. Cap first, then merge, and D stays."""
    def mk(i1, i2, p, touches):
        return TrendLine(i1=i1, p1=p, k1="low", i2=i2, p2=p, k2="low", touches=touches,
                         last_touch_idx=i2, crossings=0, last_sign=0, max_touch_gap=i2 - i1,
                         min_touch_gap=i2 - i1, max_touch_idx=i2, touch_idxs=[i1, i2])
    a, b_twin, c, d = mk(0, 40, 100.0, 5), mk(10, 50, 100.2, 4), mk(10, 60, 80.0, 3), mk(60, 90, 70.0, 2)
    ranked = [a, b_twin, c, d]
    assert merge_lines(ranked, 100, 0.0, math.inf, 1) == [a, b_twin, d]
    assert merge_lines(ranked, 100, 1.0, math.inf, 1) == [a, d]


def test_a_gated_line_does_not_hold_its_pivot_slots_against_a_drawable_one():
    """Mirrors the TS test. Cap 1 per pivot; A (bars 0,40) outranks D (40,90)
    and shares bar 40, but A is far from price. Capped first, A held bar 40
    and D vanished; gated first, only drawable lines count toward the cap."""
    def mk(i1, i2, p, touches):
        return TrendLine(i1=i1, p1=p, k1="low", i2=i2, p2=p, k2="low", touches=touches,
                         last_touch_idx=i2, crossings=0, last_sign=0, max_touch_gap=i2 - i1,
                         min_touch_gap=i2 - i1, max_touch_idx=i2, touch_idxs=[i1, i2])
    a, d = mk(0, 40, 150.0, 5), mk(40, 90, 101.0, 2)
    pool = [d, a]
    tight = cfg(max_per_pivot=1, max_dist_atr=2, min_span_bars=5)
    assert eligible_lines(pool, 100, 100.0, 1.0, tight) == [d]
    assert eligible_lines(pool, 100, 100.0, 1.0, replace(tight, max_dist_atr=0)) == [a]


def replace_line(line: TrendLine, **over) -> TrendLine:
    from dataclasses import replace as _replace
    return _replace(line, **over)


def test_stops_projecting_past_max_proj_bars():
    bars = flat(120)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    points, _ = compute_trendlines(bars, cfg(max_proj_bars=30))
    assert "tl_1" in points[70] and "tl_1" not in points[71]


def test_is_causal():
    bars = flat(120)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[60] = bar(60, 99.5, 108)
    full, _ = compute_trendlines(bars, cfg())
    pre, _ = compute_trendlines(bars[:80], cfg())
    assert pre == full[:80]


def test_caps_live_state_in_total():
    bars = [bar(i, 99.5 + math.sin(i / 3) * 4, 100.5 + math.sin(i / 3) * 4) for i in range(400)]
    c = cfg(max_lines=1, min_span_bars=3)
    _, lines = compute_trendlines(bars, c)
    assert len(lines) <= MAX_LIVE_MULT * c.max_lines


# ---------------------------------------------------------------- series

def test_series_returns_one_value_per_bar_and_none_for_an_unknown_output():
    bars = flat(60)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    s = trendlines_series(cfg(), "tl_1", bars, 1.0)
    assert len(s) == 60 and any(v is not None for v in s)
    assert trendlines_series(cfg(), "tl_support", bars, 1.0) == [None] * 60
    assert trendlines_series(cfg(), "tl_1", [], 1.0) == []


def test_registered_in_the_series_registry():
    spec = SERIES_INDICATORS["TRENDLINES"]
    c = spec.parse_config([], {})
    assert spec.outputs(c) == ("tl_1", "tl_2", "tl_3", TL_NEAREST)
    assert spec.warmup(c, "tl_1") == TL_ATR_LEN + 10 + 20


def test_resolves_through_the_request_path():
    # The path a real request takes, the same shape test_fvg / test_atr_indicator
    # pin. collectExprInstances always ships extendData, `extend` included.
    # calcParams here is the new-schema default prefix (was the old-schema
    # default prefix before the sideless rewrite), so it resolves to the same
    # config as an empty payload.
    resolved = resolve_instances({
        "TRENDLINES": {
            "type": "TRENDLINES",
            "calcParams": [5, 0, 2, 20, 250, 3, 0.0, 0],
            "extendData": {"extend": "segment"},
        },
    })
    inst = resolved["TRENDLINES"]
    assert inst.type == "TRENDLINES"
    assert inst.config == parse_trendlines_config([], {})  # `extend` changed nothing
    assert inst.spec.outputs(inst.config) == ("tl_1", "tl_2", "tl_3", TL_NEAREST)


# ---------------------------------------------------------------- max distance
# Mirrors "computeTrendlines max distance" in trendlines.test.ts: flat bars
# close at 100 with ATR 1, so 1 ATR is 1% of price here.

def _far_lows() -> list[Candle]:
    bars = flat(60)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    return bars


def _has(lines: list[TrendLine], i1: int, i2: int) -> bool:
    return any(line.i1 == i1 and line.i2 == i2 for line in lines)


def test_max_distance_keeps_a_far_line_live_and_emits_it_only_within_the_cut():
    # The spike bars lift ATR(14) well above 1 for a while, so the ATR case
    # reads its expectation off the ATR series bar by bar (mirrors the TS).
    bars = _far_lows() + flat(20, 60)
    c = cfg(max_dist_atr=0.5)
    points, lines = compute_trendlines(bars, c)
    line = next(l for l in lines if l.i1 == 20 and l.i2 == 40)
    atr = atr_series(bars, TL_ATR_LEN)
    hidden = shown = 0
    for i in range(42, 80):
        within = abs(project_at(line, i) - 100) <= 0.5 * atr[i]
        assert ("tl_1" in points[i]) == within, i
        if within:
            shown += 1
        else:
            hidden += 1
    assert hidden > 0 and shown > 0
    pct, _ = compute_trendlines(_far_lows(), cfg(max_dist_pct=3))
    assert "tl_1" not in pct[52] and "tl_1" in pct[55]


def test_max_distance_cuts_are_separate_and_the_tighter_decides():
    assert "tl_1" in compute_trendlines(_far_lows(), cfg(max_dist_atr=6))[0][42]
    assert "tl_1" not in compute_trendlines(_far_lows(), cfg(max_dist_atr=6, max_dist_pct=3))[0][42]
    assert "tl_1" not in compute_trendlines(_far_lows(), cfg(max_dist_atr=0.5, max_dist_pct=6))[0][42]
    assert "tl_1" in compute_trendlines(_far_lows(), cfg(max_dist_atr=6, max_dist_pct=6))[0][42]
    assert "tl_1" in compute_trendlines(_far_lows(), cfg(max_dist_atr=0, max_dist_pct=0))[0][42]


def _runaway(n: int) -> list[Candle]:
    bars = flat(n)
    bars[20] = bar(20, 99.5, 101)
    bars[40] = bar(40, 99.5, 103)
    return bars


def test_max_distance_stops_emitting_a_line_past_the_cut_without_dropping_it():
    points, lines = compute_trendlines(_runaway(61), cfg(max_dist_atr=4))
    assert "tl_1" in points[44]
    assert "tl_1" not in points[60]
    assert _has(lines, 20, 40)
    assert "tl_1" in compute_trendlines(_runaway(61), cfg())[0][60]




# ---------------------------------------------------------------- signed slope

def _rising() -> list[Candle]:
    bars = flat(80)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[60] = bar(60, 98.5, 100.5)
    return bars


def _falling() -> list[Candle]:
    bars = flat(80)
    bars[20] = bar(20, 99.5, 110)
    bars[40] = bar(40, 99.5, 106)
    bars[60] = bar(60, 99.5, 101.5)
    return bars


def _last(bars, **over):
    return compute_trendlines(bars, cfg(merge_atr=0, **over))[0][79]


def test_signed_slope_range_mirrors_the_ts():
    assert _last(_rising(), min_slope_atr=0.01).get("tl_1") is not None
    assert _last(_falling(), min_slope_atr=0.01).get("tl_1") is None
    assert _last(_falling(), max_slope_atr=-0.01).get("tl_1") is not None
    assert _last(_rising(), max_slope_atr=-0.01).get("tl_1") is None
    assert _last(_rising(), min_slope_atr=-0.5, max_slope_atr=0.5).get("tl_1") is not None
    assert _last(_falling(), min_slope_atr=-0.5, max_slope_atr=0.5).get("tl_1") is not None
    assert _last(_rising(), min_slope_atr=-0.05, max_slope_atr=0.05).get("tl_1") is None
    assert _last(_falling(), min_slope_atr=-0.05, max_slope_atr=0.05).get("tl_1") is None

"""TRENDLINES config parsing, outputs, the geometry gates and the detector.

The cross-product form of the pierce test is the parity contract: validity is a
boolean that gates set membership, so a 1-ULP disagreement with the TS deletes a
line rather than nudging a number.

The `compute_trendlines` cases below are ported from
frontend/src/lib/indicators/trendlines.test.ts (the `computeTrendlines` block),
so both runtimes are pinned by the same behaviours.
"""

import math
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.registry import SERIES_INDICATORS, resolve_instances
from auto_trader.indicators.trendlines import (
    TRENDLINES_OUTPUTS,
    TrendLine,
    _has_swing_reach,
    _is_significant_swing,
    compute_trendlines,
    parse_trendlines_config,
    pierces,
    above_slope,
    within_slope,
    project_at,
    rank_key,
    trendlines_outputs,
    trendlines_series,
    trendlines_warmup,
)


def _res() -> TrendLine:
    return TrendLine(side="resistance", i1=0, p1=100.0, i2=10, p2=90.0,
                     touches=2, last_touch_idx=10, broken_idx=None)


# --------------------------------------------------------------------------
# config parsing
# --------------------------------------------------------------------------

def test_defaults_from_empty_params():
    cfg = parse_trendlines_config([], {})
    assert (cfg.pivot_len, cfg.viol_mult, cfg.touch_mult) == (5, 0.25, 0.75)
    assert (cfg.min_touches, cfg.min_span_bars) == (2, 20)
    assert (cfg.max_proj_bars, cfg.break_hold_bars, cfg.max_lines) == (250, 30, 3)


def test_min_swing_atr_defaults_off_and_keeps_a_zero():
    # Default 0 = off, so every config already in storage keeps emitting exactly
    # what it emitted before. The `>= 0` rule is what makes off REACHABLE once
    # the setting has been raised: on `> 0` a stored 0 would take the default.
    assert parse_trendlines_config([], {}).min_swing_atr == 0.0
    on = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 1.5]
    assert parse_trendlines_config(on, {}).min_swing_atr == 1.5
    assert parse_trendlines_config([*on[:8], 0], {}).min_swing_atr == 0.0


def test_within_slope():
    # Rise 10 over span 10 = 1.0 per bar; at ATR 2 that is 0.5 ATR per bar.
    line = TrendLine(side="support", i1=0, p1=100.0, i2=10, p2=110.0,
                     touches=2, last_touch_idx=10, broken_idx=None)
    assert within_slope(line, 2.0, 0.0) is True  # off
    assert within_slope(line, 2.0, 0.5) is True
    assert within_slope(line, 2.0, 0.49) is False
    # Direction does not matter, only steepness.
    down = replace(line, p2=90.0)
    assert within_slope(down, 2.0, 0.5) is True
    assert within_slope(down, 2.0, 0.49) is False


def test_above_slope():
    line = TrendLine(side="support", i1=0, p1=100.0, i2=10, p2=110.0,
                     touches=2, last_touch_idx=10, broken_idx=None)
    assert above_slope(line, 2.0, 0.0) is True  # off
    assert above_slope(line, 2.0, 0.5) is True
    assert above_slope(line, 2.0, 0.51) is False
    down = replace(line, p2=90.0)
    assert above_slope(down, 2.0, 0.5) is True
    assert above_slope(down, 2.0, 0.51) is False


def test_min_slope_atr_drops_a_flat_line_and_keeps_a_steep_one():
    def bars_for(lo60: float) -> list[Candle]:
        bars = flat(80)
        bars[20] = bar(20, 90, 100.5)
        bars[60] = bar(60, lo60, 100.5)
        return bars

    def pair(bars: list[Candle], c) -> bool:
        _, lines = compute_trendlines(bars, c)
        return any(line.i1 == 20 and line.i2 == 60 for line in lines)

    flat_pair, steep = bars_for(90.2), bars_for(98.0)
    assert pair(flat_pair, cfg()) is True
    assert pair(flat_pair, cfg(min_slope_atr=0.1)) is False
    assert pair(steep, cfg(min_slope_atr=0.1)) is True


def test_max_slope_atr_drops_a_steep_line_and_keeps_a_shallow_one():
    # Two dips 40 bars apart. The steep pair climbs 8 over 40 bars (0.2 per bar,
    # about 0.2 ATR); the shallow pair climbs 1.
    def bars_for(lo60: float) -> list[Candle]:
        bars = flat(80)
        bars[20] = bar(20, 90, 100.5)
        bars[60] = bar(60, lo60, 100.5)
        return bars

    def pair(bars: list[Candle], c) -> bool:
        _, lines = compute_trendlines(bars, c)
        return any(line.i1 == 20 and line.i2 == 60 for line in lines)

    steep, shallow = bars_for(98.0), bars_for(91.0)
    assert pair(steep, cfg()) is True
    assert pair(steep, cfg(max_slope_atr=0.1)) is False
    assert pair(shallow, cfg(max_slope_atr=0.1)) is True


def test_max_span_bars_defaults_off_and_clamps_to_zero():
    assert parse_trendlines_config([], {}).max_span_bars == 0
    base = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0]
    for raw, want in ((40, 40), (40.9, 40), (0, 0), (-2, 0), ("x", 0)):
        assert parse_trendlines_config([*base, raw], {}).max_span_bars == want


def test_max_span_bars_silences_a_long_line():
    bars = flat(80)
    bars[20] = bar(20, 90, 100.5)
    bars[60] = bar(60, 94, 100.5)

    def emits(c) -> bool:
        points, _ = compute_trendlines(bars, c)
        return any(p.get("tl_support") is not None for p in points)

    assert emits(cfg()) is True
    assert emits(cfg(max_span_bars=40)) is True
    assert emits(cfg(max_span_bars=39)) is False
    # Silenced, not deleted.
    _, lines = compute_trendlines(bars, cfg(max_span_bars=39))
    assert any(line.last_touch_idx - line.i1 >= 40 for line in lines)


def test_max_slope_atr_defaults_off_and_takes_zero():
    assert parse_trendlines_config([], {}).max_slope_atr == 0.0
    base = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0, 0]
    for raw, want in ((0.25, 0.25), (0, 0.0), (-1, 0.0), ("x", 0.0)):
        assert parse_trendlines_config([*base, raw], {}).max_slope_atr == want


def test_min_slope_atr_defaults_off_and_takes_zero():
    assert parse_trendlines_config([], {}).min_slope_atr == 0.0
    base = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0, 0, 0]
    for raw, want in ((0.05, 0.05), (0, 0.0), (-1, 0.0), ("x", 0.0)):
        assert parse_trendlines_config([*base, raw], {}).min_slope_atr == want


def test_min_back_bars_defaults_on_and_clamps_to_zero():
    # The ONLY gate whose default is not off: it closes a hole in seeding rather
    # than expressing a taste, so charts saved before it existed move under it.
    # Clamped to 0, not 1, or the off state would be unreachable.
    assert parse_trendlines_config([], {}).min_back_bars == 10
    base = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20, 0, 0, 0, 0]
    # A NEGATIVE falls back to the default rather than to 0, unlike the gates
    # that default to 0 and land there either way: only an explicit 0 is off.
    for raw, want in ((25, 25), (25.9, 25), (0, 0), (-2, 10), ("x", 10)):
        assert parse_trendlines_config([*base, raw], {}).min_back_bars == want


def test_has_back_clearance_reads_only_bars_before_the_first_anchor():
    from auto_trader.indicators.trendlines import _has_back_clearance

    # A flat corridor at 100 with a low at bar 4: a support line anchored there
    # has bars 0..3 sitting well above it, so they cannot pierce it.
    vals = [100.0] * 20
    vals[4] = 90.0
    vals[12] = 95.0
    atr: list[float | None] = [1.0] * 20
    line = TrendLine(side="support", i1=4, p1=90.0, i2=12, p2=95.0,
                     touches=2, last_touch_idx=12, broken_idx=None)
    assert _has_back_clearance(line, vals, atr, 0.25, 0) is True
    assert _has_back_clearance(line, vals, atr, 0.25, 4) is True
    # Only four bars exist to the left, so a fifth cannot be demonstrated:
    # rejected, the way _is_pivot_at and _has_swing_reach reject off the start.
    assert _has_back_clearance(line, vals, atr, 0.25, 5) is False
    # A bar BELOW the line's back-projection pierces it and stops the count.
    pierced = list(vals)
    pierced[2] = 80.0
    assert _has_back_clearance(line, pierced, atr, 0.25, 1) is True
    assert _has_back_clearance(line, pierced, atr, 0.25, 2) is False
    # An unwarmed ATR cannot be tested, so that bar counts as surviving, which
    # is what the forward validation pass does with the same bar.
    cold: list[float | None] = list(atr)
    cold[2] = None
    assert _has_back_clearance(line, pierced, cold, 0.25, 4) is True


def test_min_back_bars_rejects_a_pair_whose_wrong_side_is_in_the_past():
    # A support pair at bars 30 and 50, with bar 20 far BELOW the line's
    # back-projection: valid over (i1, i], and nonsense before it. Bar 20, not
    # bar 10, so ATR(14) has warmed up there: an untestable bar counts as
    # surviving, so a piercing bar inside the warm-up would not stop the count.
    bars = flat(80)
    bars[20] = bar(20, 80, 100.5)
    bars[30] = bar(30, 90, 100.5)
    bars[50] = bar(50, 94, 100.5)

    def seeds(c) -> bool:
        _, lines = compute_trendlines(bars, c)
        return any(line.i1 == 30 and line.i2 == 50 for line in lines)

    assert seeds(cfg()) is True
    assert seeds(cfg(min_back_bars=9)) is True
    assert seeds(cfg(min_back_bars=10)) is False


def test_max_touches_defaults_off_and_clamps_to_zero():
    assert parse_trendlines_config([], {}).max_touches == 0
    base = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0, 20]
    for raw, want in ((5, 5), (5.9, 5), (0, 0), (-2, 0), ("x", 0)):
        assert parse_trendlines_config([*base, raw], {}).max_touches == want


def test_max_touches_silences_a_line_without_destroying_it():
    # Three dips on one rising line: the pair plus a third pivot that touches
    # it, so the line reaches 3 touches.
    bars = flat(80)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 92, 100.5)
    bars[60] = bar(60, 94, 100.5)

    def emits(c) -> bool:
        points, _ = compute_trendlines(bars, c)
        return any(p.get("tl_support") is not None for p in points)

    assert emits(cfg(min_touches=3)) is True
    assert emits(cfg(min_touches=3, max_touches=3)) is True
    assert emits(cfg(min_touches=3, max_touches=2)) is False
    # Silenced, not deleted: it is still in live state doing pierce and touch
    # work for the lines around it.
    _, lines = compute_trendlines(bars, cfg(min_touches=3, max_touches=2))
    assert any(line.touches >= 3 for line in lines)


def test_pair_pivots_defaults_to_the_constant_and_parses():
    from auto_trader.indicators.trendlines import MAX_PAIR_PIVOTS

    assert parse_trendlines_config([], {}).pair_pivots == MAX_PAIR_PIVOTS
    base = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0, 0]
    # int_at: floored, and clamped to at least 1 (a 0-wide window would pair
    # with nothing and no line could ever form).
    for raw, want in ((60, 60), (5.9, 5), (0, MAX_PAIR_PIVOTS), (-3, MAX_PAIR_PIVOTS)):
        assert parse_trendlines_config([*base, raw], {}).pair_pivots == want


def test_pair_pivots_widens_how_far_back_a_line_can_reach():
    # Three lows far apart. With a window of 1, bar 60 only pairs with bar 40,
    # so the 20-to-60 line cannot exist; at 2 it reaches past bar 40 to bar 20.
    bars = flat(80)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 92, 100.5)
    bars[60] = bar(60, 94, 100.5)

    def pair(c) -> bool:
        _, lines = compute_trendlines(bars, c)
        return any(l.side == "support" and l.i1 == 20 and l.i2 == 60 for l in lines)

    assert pair(cfg(pair_pivots=1)) is False
    assert pair(cfg(pair_pivots=2)) is True


def test_min_swing_reach_floors_and_clamps_to_zero_not_one():
    # NOT int_at: its floor of 1 would make the off state unreachable.
    base = [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0]
    assert parse_trendlines_config([], {}).min_swing_reach == 0
    for raw, want in ((12.9, 12), (0, 0), (-4, 0), ("x", 0)):
        assert parse_trendlines_config([*base, raw], {}).min_swing_reach == want


def test_negative_or_junk_min_swing_atr_takes_the_default():
    base = [5, 0.25, 0.75, 2, 20, 250, 30, 3]
    for junk in (-1, "x", None):
        assert parse_trendlines_config([*base, junk], {}).min_swing_atr == 0.0


def test_zero_viol_mult_survives():
    # The STRICTEST setting (exact containment), not a "filter off" switch.
    assert parse_trendlines_config([5, 0], {}).viol_mult == 0.0


def test_false_viol_mult_is_zero_like_the_ts():
    # Number(false) === 0 and float(False) == 0.0, so the runtimes AGREE here.
    # Only None / "" / [] diverge (float() raises where Number() gives 0).
    assert parse_trendlines_config([5, False], {}).viol_mult == 0.0


@pytest.mark.parametrize("junk", [None, "", [], "abc", float("nan"), float("inf")])
def test_junk_viol_mult_falls_back_to_the_default(junk):
    assert parse_trendlines_config([5, junk], {}).viol_mult == 0.25


def test_huge_int_literal_falls_back_instead_of_raising():
    # float(10**400) raises OverflowError, which the guard must catch: an API
    # payload carrying a big integer literal would otherwise 500, where the TS
    # gets Infinity and quietly falls back. Unreachable from the settings modal.
    big = 10**400
    cfg = parse_trendlines_config([big, big, big, big, big, big, big, big], {})
    assert cfg == parse_trendlines_config([], {})


def test_zero_touch_mult_falls_back():
    assert parse_trendlines_config([5, 0.25, 0], {}).touch_mult == 0.75


def test_integer_params_floor_then_clamp_to_one():
    cfg = parse_trendlines_config([2.9, 0.25, 0.75, 2, 7.9, 3.5, 1.2, 0.4], {})
    assert (cfg.pivot_len, cfg.min_span_bars) == (2, 7)
    assert (cfg.max_proj_bars, cfg.break_hold_bars) == (3, 1)
    # 0.4 is not > 0 after flooring... it never reaches the floor: numAt keeps
    # it (0.4 > 0), Math.floor gives 0, and the clamp lifts it to 1.
    assert cfg.max_lines == 1


def test_min_touches_clamps_to_two():
    assert parse_trendlines_config([5, 0.25, 0.75, 1], {}).min_touches == 2
    assert parse_trendlines_config([5, 0.25, 0.75, 4], {}).min_touches == 4


def test_extend_data_is_ignored():
    # `extend` is a DRAWING option; the settings copy promises it cannot alter a
    # strategy, and collectExprInstances ships it here unconditionally.
    a = parse_trendlines_config([5], {})
    for mode in ("ray", "segment", "extended"):
        assert parse_trendlines_config([5], {"extend": mode}) == a


def test_non_list_calc_params_take_the_defaults():
    assert parse_trendlines_config(None, None) == parse_trendlines_config([], {})


# --------------------------------------------------------------------------
# outputs / warmup
# --------------------------------------------------------------------------

def test_outputs_in_pane_order():
    cfg = parse_trendlines_config([], {})
    assert trendlines_outputs(cfg) == (
        "tl_support", "tl_resistance", "tl_broken_support", "tl_broken_resistance",
    )
    assert TRENDLINES_OUTPUTS == trendlines_outputs(cfg)


def test_warmup_floor():
    cfg = parse_trendlines_config([], {})
    assert trendlines_warmup(cfg, "tl_support") == 14 + 10 + 20
    assert trendlines_warmup(cfg, "not_an_output") == 0


def test_warmup_tracks_the_config():
    cfg = parse_trendlines_config([3, 0.25, 0.75, 2, 40], {})
    assert trendlines_warmup(cfg, "tl_resistance") == 14 + 6 + 40


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def test_project_at():
    assert project_at(_res(), 5) == pytest.approx(95.0)
    assert project_at(_res(), 20) == pytest.approx(80.0)


def test_pierce_is_exact_at_the_boundary():
    line = _res()
    assert pierces(line, 5, 96.0, 1.0) is False
    assert pierces(line, 5, math.nextafter(96.0, math.inf), 1.0) is True


def test_pierce_ignores_the_wrong_side():
    assert pierces(_res(), 5, 10.0, 1.0) is False


def test_zero_tolerance_is_exact_containment():
    line = _res()
    assert pierces(line, 5, 95.0, 0.0) is False
    assert pierces(line, 5, math.nextafter(95.0, math.inf), 0.0) is True


def test_rank_key_prefers_more_touches_then_longer_span():
    base = TrendLine(side="support", i1=0, p1=100.0, i2=10, p2=100.0,
                     touches=2, last_touch_idx=10, broken_idx=None)
    strong = replace(base, touches=3)
    assert rank_key(strong) < rank_key(base)
    longer = replace(base, last_touch_idx=40)
    assert rank_key(longer) < rank_key(base)


def test_rank_key_breaks_every_remaining_tie():
    base = TrendLine(side="support", i1=0, p1=100.0, i2=10, p2=100.0,
                     touches=2, last_touch_idx=10, broken_idx=None)
    a = replace(base, last_touch_idx=20)
    b = replace(base, last_touch_idx=10, i1=-10)
    # same touches, same span (20-0 vs 10-(-10)) -> newer last_touch_idx wins
    assert rank_key(a) < rank_key(b)
    assert rank_key(replace(base)) == rank_key(replace(base))


# --------------------------------------------------------------------------
# the detector (ported from trendlines.test.ts)
# --------------------------------------------------------------------------

_T0 = datetime(2020, 1, 1, tzinfo=UTC)


def bar(i: int, low: float, high: float) -> Candle:
    """A bar with a flat 1.0 true range so ATR(14) settles at exactly 1.0."""
    mid = (low + high) / 2
    return Candle(time=_T0 + timedelta(minutes=i), open=mid, high=high,
                  low=low, close=mid, volume=1.0)


def flat(n: int, frm: int = 0) -> list[Candle]:
    return [bar(frm + k, 99.5, 100.5) for k in range(n)]


def cfg(**over):
    # min_back_bars 0, unlike the shipped default of 10: these fixtures are
    # short synthetic corridors whose first anchor sits within a few bars of the
    # series start, where the clearance gate rejects by design. Mirrors the TS
    # cfg() helper in trendlines.test.ts.
    base = replace(
        parse_trendlines_config([], {}),
        pivot_len=2,
        min_span_bars=5,
        min_back_bars=0,
    )
    return replace(base, **over)


def test_returns_one_point_per_bar_and_emits_nothing_before_warmup():
    points, _ = compute_trendlines(flat(30), cfg())
    assert len(points) == 30
    assert points[0] == {}


def test_finds_a_rising_support_line_through_two_swing_lows():
    bars = flat(60)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    _, lines = compute_trendlines(bars, cfg())
    sup = [line for line in lines if line.side == "support"]
    assert any(line.i1 == 20 and line.i2 == 40 for line in sup)


def test_is_significant_swing():
    """Ported from the TS isSignificantSwing block. Min Pivot Size measures the
    LEG: this pivot to the most recent pivot on the OTHER side."""
    #        0     1     2     3    4
    highs = [10.0, 14.0, 10.0, 10.0, 12.0]
    lows = [10.0, 10.0, 10.0, 6.0, 10.0]
    # Off is a short circuit: an empty pool would otherwise reject.
    assert _is_significant_swing([], [], [], 0, "support", 1.0, 0.0) is True
    # Low at 3 against the high pivot at 1: leg = 14 - 6 = 8.
    assert _is_significant_swing(highs, lows, [1], 3, "support", 1.0, 8.0) is True
    assert _is_significant_swing(highs, lows, [1], 3, "support", 1.0, 8.01) is False
    # High at 4 against the low pivot at 3: leg = 12 - 6 = 6.
    assert _is_significant_swing(highs, lows, [3], 4, "resistance", 1.0, 6.0) is True
    assert _is_significant_swing(highs, lows, [3], 4, "resistance", 1.0, 6.01) is False
    # The LAST opposite pivot, not the first.
    assert _is_significant_swing(highs, lows, [0, 1], 3, "support", 1.0, 8.0) is True
    assert _is_significant_swing(highs, lows, [0], 3, "support", 1.0, 8.0) is False
    # Strictly before k: one bar can be both a strict high and a strict low.
    assert _is_significant_swing(highs, lows, [1, 3, 4], 3, "support", 1.0, 8.0) is True
    assert _is_significant_swing(highs, lows, [3, 4], 3, "support", 1.0, 0.1) is False
    # No opposite pivot yet is a REJECT: unmeasurable is not big.
    assert _is_significant_swing(highs, lows, [], 3, "support", 1.0, 0.1) is False
    # ATR scales the threshold.
    assert _is_significant_swing(highs, lows, [1], 3, "support", 2.0, 4.0) is True
    assert _is_significant_swing(highs, lows, [1], 3, "support", 2.0, 4.01) is False


def _wide(n: int) -> list[Candle]:
    """A corridor of range 10, so ATR(14) settles at about 10."""
    return [bar(k, 95, 105) for k in range(n)]


def _legged(lo30: float, lo50: float) -> list[Candle]:
    """Highs above the corridor at 20 and 40, lows below it at 30 and 50.

    The first pivot has to confirm AFTER ATR(14) has warmed: a confirm bar
    inside warm-up is skipped entirely, and the missing turn silently starves
    every later leg.
    """
    bars = _wide(80)
    bars[20] = bar(20, 95, 105.5)
    bars[30] = bar(30, lo30, 105)
    bars[40] = bar(40, 95, 105.5)
    bars[50] = bar(50, lo50, 105)
    return bars


def _has_pair(bars: list[Candle], c) -> bool:
    _, lines = compute_trendlines(bars, c)
    return any(line.side == "support" and line.i1 == 30 and line.i2 == 50 for line in lines)


def test_drops_a_shallow_swing_once_min_swing_atr_is_on():
    bars = _legged(94.5, 94.5)  # legs of 11, about 1.05 ATR
    assert _has_pair(bars, cfg()) is True
    assert _has_pair(bars, cfg(min_swing_atr=1.5)) is False


def test_keeps_a_deep_swing_at_the_same_setting():
    # Legs of 20.5 and 18.5: the gate rejects by SIZE, not everything.
    assert _has_pair(_legged(85, 87), cfg(min_swing_atr=1.5)) is True


def test_min_swing_atr_does_not_move_with_pivot_len():
    # The measure this replaced averaged the fractal window, so widening that
    # window inflated every pivot's size and a STRICTER pivot_len could ADD
    # lines. The leg has no such coupling.
    shallow = _legged(94.5, 94.5)
    deep = _legged(85, 87)
    for pivot_len in (2, 3, 4, 5):
        c = replace(cfg(min_swing_atr=1.5), pivot_len=pivot_len)
        assert _has_pair(shallow, c) is False, f"shallow at {pivot_len}"
        assert _has_pair(deep, c) is True, f"deep at {pivot_len}"


def test_rejects_a_candidate_that_a_bar_between_the_anchors_pierces():
    bars = flat(60)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[30] = bar(30, 80, 100.5)
    _, lines = compute_trendlines(bars, cfg())
    assert not any(line.i1 == 20 and line.i2 == 40 for line in lines)
    # Positive controls: the assertion above passes vacuously on an empty list.
    assert any(line.i1 == 20 and line.i2 == 30 for line in lines)
    assert any(line.i1 == 30 and line.i2 == 40 for line in lines)


def test_marks_a_line_broken_on_an_ordinary_bar_not_only_at_a_confirm_bar():
    bars = flat(80)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[60] = bar(60, 80, 100.5)
    _, lines = compute_trendlines(bars, cfg())
    line = next(line for line in lines if line.i1 == 20 and line.i2 == 40)
    assert line.broken_idx == 60


def test_moves_a_broken_line_from_support_to_broken_support():
    bars = flat(80)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[60] = bar(60, 80, 100.5)
    points, _ = compute_trendlines(bars, cfg(break_hold_bars=10))
    assert "tl_support" in points[59]
    assert "tl_support" not in points[61]
    assert "tl_broken_support" in points[61]
    assert "tl_broken_support" not in points[75]


def test_stops_projecting_past_max_proj_bars():
    bars = flat(120)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    points, _ = compute_trendlines(bars, cfg(max_proj_bars=20))
    assert "tl_support" in points[55]
    assert "tl_support" not in points[100]


def test_holds_a_broken_line_for_the_whole_break_hold_window_past_max_proj_bars():
    # The two clocks are INDEPENDENT: max_proj_bars ages an UNBROKEN line from
    # its last touch, break_hold_bars holds a BROKEN one from its break bar.
    bars = flat(80)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[60] = bar(60, 80, 100.5)
    points, _ = compute_trendlines(bars, cfg(max_proj_bars=20, break_hold_bars=10))
    held = [(i, "tl_broken_support" in points[i]) for i in range(61, 71)]
    assert held == [(i, True) for i in range(61, 71)]
    assert "tl_broken_support" not in points[71]


def test_is_causal_a_prefix_computes_the_same_values_as_the_full_series():
    bars = flat(90)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    bars[62] = bar(62, 96, 100.5)
    bars[70] = bar(70, 88, 100.5)
    full, _ = compute_trendlines(bars, cfg())
    # Non-triviality guard: a prefix/full comparison over an all-empty series
    # would pass while proving nothing.
    assert len([p for p in full if "tl_support" in p]) > 10
    assert any("tl_broken_support" in p for p in full)
    for i in range(len(bars)):
        prefix, _ = compute_trendlines(bars[: i + 1], cfg())
        assert (i, prefix[i]) == (i, full[i])


# --------------------------------------------------------------------------
# series / registry
# --------------------------------------------------------------------------

def test_series_returns_one_value_per_bar_and_none_for_an_unknown_output():
    bars = flat(60)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    c = cfg()
    sup = trendlines_series(c, "tl_support", bars, 1.0)
    assert len(sup) == 60
    assert any(v is not None for v in sup)
    assert trendlines_series(c, "nope", bars, 1.0) == [None] * 60


def test_series_matches_the_points_it_is_read_from():
    bars = flat(60)
    bars[20] = bar(20, 90, 100.5)
    bars[40] = bar(40, 94, 100.5)
    c = cfg()
    points, _ = compute_trendlines(bars, c)
    assert trendlines_series(c, "tl_support", bars, 1.0) == [
        p.get("tl_support") for p in points
    ]


def test_series_on_no_candles():
    assert trendlines_series(cfg(), "tl_support", [], 1.0) == []


def test_registered_in_the_series_registry():
    spec = SERIES_INDICATORS["TRENDLINES"]
    c = spec.parse_config([5], {"extend": "segment"})
    assert spec.outputs(c) == TRENDLINES_OUTPUTS
    assert spec.warmup(c, "tl_support") == 44
    assert spec.timeframe(c) is None  # no pin: the chart's own timeframe
    assert spec.series(c, "tl_support", flat(20), 1.0) == [None] * 20


def test_mtf_timeframe_pin():
    # The settings pin rides extendData.mtf.timeframe (same as SR_LEVELS); the
    # spec exposes it so the evaluator computes on that timeframe's candles and
    # aligns the result onto the base bars. Nothing below the config changes:
    # the detector runs on whatever candles it is handed.
    cfg_ = parse_trendlines_config(None, {"mtf": {"timeframe": "HOUR_4"}})
    assert cfg_.timeframe == "HOUR_4"
    assert SERIES_INDICATORS["TRENDLINES"].timeframe(cfg_) == "HOUR_4"
    # "chart" is the modal's word for "no pin", and so is a missing/garbage mtf.
    assert parse_trendlines_config(None, {"mtf": {"timeframe": "chart"}}).timeframe is None
    assert parse_trendlines_config(None, {"mtf": {"timeframe": None}}).timeframe is None
    assert parse_trendlines_config(None, {"mtf": "junk"}).timeframe is None
    assert parse_trendlines_config(None, {"extend": "segment"}).timeframe is None


def test_resolves_through_the_request_path():
    # The path a real request takes, the same shape test_fvg / test_atr_indicator
    # pin. collectExprInstances always ships extendData, `extend` included.
    resolved = resolve_instances({
        "TRENDLINES": {
            "type": "TRENDLINES",
            "calcParams": [5, 0.25, 0.75, 2, 20, 250, 30, 3],
            "extendData": {"extend": "segment"},
        },
    })
    inst = resolved["TRENDLINES"]
    assert inst.type == "TRENDLINES"
    assert inst.config == parse_trendlines_config([], {})  # `extend` changed nothing
    assert inst.spec.outputs(inst.config) == TRENDLINES_OUTPUTS


def test_resolves_a_fifteen_param_payload():
    """TRENDLINES_TEMPLATE now ships FIFTEEN calcParams, so this is the live shape
    for every chart created from here on. Nothing along the path length-checks
    the list (api/schemas.py types it list[float] | None), and the eight-param
    payload above proves nothing about index 8 because its value is the
    default."""
    resolved = resolve_instances({
        "TRENDLINES": {
            "type": "TRENDLINES",
            "calcParams": [5, 0.25, 0.75, 2, 20, 250, 30, 3, 0.75],
            "extendData": {"extend": "segment"},
        },
    })
    assert resolved["TRENDLINES"].config.min_swing_atr == 0.75

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
    compute_trendlines,
    parse_trendlines_config,
    pierces,
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
    base = replace(parse_trendlines_config([], {}), pivot_len=2, min_span_bars=5)
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
    assert spec.timeframe(c) is None  # v1 has no MTF
    assert spec.series(c, "tl_support", flat(20), 1.0) == [None] * 20


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

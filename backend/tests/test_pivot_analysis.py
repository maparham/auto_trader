"""PIVOT_ANALYSIS backend series (after LuxAlgo's "Pivots High/Low Analysis &
Forecast"): forward-filled fractal-pivot operand values. Mirrors the frontend
suite (frontend/src/lib/indicators/pivotAnalysis.test.ts) — same shape of
expectations — plus config-parsing/registry behavior."""

from datetime import datetime, timezone

from auto_trader.core.models import Candle
from auto_trader.indicators.pivot_analysis import (
    PivotAnalysisConfig,
    parse_pivot_analysis_config,
    pivot_analysis_outputs,
    pivot_analysis_series,
    pivot_analysis_warmup,
)
from auto_trader.indicators.registry import SERIES_INDICATORS


def bar(i: int, low: float, high: float) -> Candle:
    return Candle(
        time=datetime.fromtimestamp(1700000000 + i * 3600, tz=timezone.utc),
        open=low, high=high, low=low, close=high, volume=1,
    )


def flat(n: int, frm: int, low: float = 99.0, high: float = 101.0) -> list[Candle]:
    return [bar(frm + k, low, high) for k in range(n)]


def points(cfg: PivotAnalysisConfig, candles: list[Candle]) -> list[tuple]:
    cols = [pivot_analysis_series(cfg, o, candles, 1.0) for o in pivot_analysis_outputs(cfg)]
    return list(zip(*cols))


def test_first_pivot_has_no_delta():
    cfg = PivotAnalysisConfig(n_high=2, n_low=2)
    bars = [
        bar(0, 99, 100), bar(1, 99, 100.5),
        bar(2, 99, 105),
        bar(3, 99, 100.5), bar(4, 99, 100),
        *flat(3, 5),
    ]
    pts = points(cfg, bars)
    assert pts[3][0] is None  # not yet confirmed
    ph, pl, delta_pct, delta_t = pts[4]
    assert ph == 105
    assert delta_pct is None
    assert delta_t is None


def test_second_pivot_carries_delta_vs_prior_same_type():
    cfg = PivotAnalysisConfig(n_high=2, n_low=2)
    # First high pivot at bar 2 (confirms 4); second higher high pivot at bar 8
    # (confirms 10).
    bars = (
        [bar(0, 99, 100), bar(1, 99, 100.5), bar(2, 99, 105), bar(3, 99, 100.5), bar(4, 99, 100)]
        + [bar(5, 99, 100), bar(6, 99, 100.5), bar(7, 99, 100), bar(8, 99, 110), bar(9, 99, 100.5)]
        + flat(3, 10)
    )
    pts = points(cfg, bars)
    ph, _, delta_pct, delta_t = pts[10]
    assert ph == 110
    assert delta_pct == (110 - 105) / 105 * 100
    assert delta_t == 8 - 2  # bars between the two SWING bars, not confirm bars


def test_deltas_track_whichever_side_confirmed_most_recently():
    cfg = PivotAnalysisConfig(n_high=2, n_low=2)
    # A low pivot confirms strictly after a high pivot; deltaPct/deltaT should
    # switch to the low's own numbers even though pivotHigh stays stale.
    bars = (
        [bar(0, 99, 100), bar(1, 99, 100.5), bar(2, 99, 105), bar(3, 99, 100.5), bar(4, 99, 100)]
        + [bar(5, 98, 100), bar(6, 90, 100), bar(7, 98, 100), bar(8, 99, 100)]
        + flat(3, 9)
    )
    pts = points(cfg, bars)
    # Low pivot at bar 6 confirms at bar 8 -> first low, no delta.
    _, pl, delta_pct, delta_t = pts[8]
    assert pl == 90
    assert delta_pct is None
    assert delta_t is None


def test_independent_high_low_lengths_confirm_on_their_own_lag():
    # High pivot at bar 5 confirms at 5+3=8 (n_high=3); low pivot at bar 6
    # confirms at 6+1=7 (n_low=1). filler(20,...) pattern kept simple: use
    # explicit bars with defaults away from the extremes.
    bars = [
        bar(0, 80, 90), bar(1, 80, 90), bar(2, 80, 90), bar(3, 80, 90), bar(4, 80, 90),
        bar(5, 80, 100),
        bar(6, 70, 90),
        *[bar(7 + k, 80, 90) for k in range(6)],
    ]
    cfg = PivotAnalysisConfig(n_high=3, n_low=1)
    pts = points(cfg, bars)
    assert pts[7][0] is None
    assert pts[8][0] == 100
    assert pts[6][1] is None
    assert pts[7][1] == 70


def test_min_pct_filter_lets_first_pivot_through_regardless_of_threshold():
    bars = [bar(i, 80, 90) for i in range(5)] + [bar(5, 80, 100)] + [bar(6 + k, 80, 90) for k in range(4)]
    cfg = PivotAnalysisConfig(n_high=2, n_low=2, min_pct_high=50, min_pct_low=0)
    pts = points(cfg, bars)
    assert pts[7][0] == 100


def test_min_pct_filter_rejects_small_swing_and_keeps_the_old_baseline():
    # First high 100 (bar 5). Second high 101 (bar 12, +1%) is rejected at a 5%
    # threshold. Third high 110 (bar 19, +10% vs the STILL-LIVE baseline of
    # 100, not vs the rejected 101) is accepted.
    bars = [bar(i, 80, 90) for i in range(24)]
    bars[5] = bar(5, 80, 100)
    bars[12] = bar(12, 80, 101)
    bars[19] = bar(19, 80, 110)
    cfg = PivotAnalysisConfig(n_high=2, n_low=2, min_pct_high=5, min_pct_low=0)
    pts = points(cfg, bars)
    assert pts[14][0] == 100  # 101 never confirmed
    assert pts[21][0] == 110
    assert abs(pts[21][2] - 10.0) < 1e-9  # deltaPct vs 100, not vs the rejected 101
    assert pts[21][3] == 19 - 5


def test_min_pct_filter_accepts_at_the_threshold_exactly():
    bars = [bar(i, 80, 90) for i in range(16)]
    bars[5] = bar(5, 80, 100)
    bars[12] = bar(12, 80, 105)
    cfg = PivotAnalysisConfig(n_high=2, n_low=2, min_pct_high=5, min_pct_low=0)
    pts = points(cfg, bars)
    assert pts[14][0] == 105


def test_min_pct_filter_zero_never_rejects():
    bars = [bar(i, 80, 90) for i in range(16)]
    bars[5] = bar(5, 80, 100)
    bars[12] = bar(12, 80, 100.001)
    cfg = PivotAnalysisConfig(n_high=2, n_low=2)
    pts = points(cfg, bars)
    assert pts[14][0] == 100.001


def test_parse_config_defaults_and_clamping():
    cfg = parse_pivot_analysis_config([], {})
    assert (cfg.n_high, cfg.n_low, cfg.min_pct_high, cfg.min_pct_low) == (50, 50, 0, 0)
    cfg = parse_pivot_analysis_config([34, 21, 2.5, 1.5], {})
    assert (cfg.n_high, cfg.n_low, cfg.min_pct_high, cfg.min_pct_low) == (34, 21, 2.5, 1.5)
    cfg = parse_pivot_analysis_config(["x", "y"], {})
    assert (cfg.n_high, cfg.n_low) == (50, 50)
    cfg = parse_pivot_analysis_config([0, 0], {})
    assert (cfg.n_high, cfg.n_low) == (50, 50)
    # Negative % clamps to 0 (off), same as garbage.
    cfg = parse_pivot_analysis_config([50, 50, -3], {})
    assert cfg.min_pct_high == 0


def test_warmup_is_the_larger_confirm_lag():
    cfg = PivotAnalysisConfig(n_high=34, n_low=21)
    assert pivot_analysis_warmup(cfg, "pivotHigh") == 34
    assert pivot_analysis_warmup(cfg, "deltaT") == 34
    assert pivot_analysis_warmup(cfg, "bogus") == 0
    cfg2 = PivotAnalysisConfig(n_high=21, n_low=34)
    assert pivot_analysis_warmup(cfg2, "pivotLow") == 34


def test_registered_in_series_indicators():
    assert "PIVOT_ANALYSIS" in SERIES_INDICATORS

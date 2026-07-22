import math

from auto_trader.strategy.expr.closeness import avg_abs_gap, ramp, scale_series, signed_gap


def test_signed_gap_orientation():
    # ">": fires when left > right, so gap = left - right
    assert signed_gap(">", 101, 100) == 1
    assert signed_gap(">=", 100, 100) == 0
    # "<": fires when left < right, so gap = right - left
    assert signed_gap("<", 99, 100) == 1
    assert signed_gap("<=", 100, 100) == 0
    # any None -> None
    assert signed_gap(">", None, 100) is None
    assert signed_gap(">", 100, None) is None


def test_ramp_shape():
    # firing (gap >= 0) -> 1
    assert ramp(0.0, 5.0) == 1.0
    assert ramp(2.0, 5.0) == 1.0
    # halfway short -> 0.5
    assert ramp(-2.5, 5.0) == 0.5
    # one full scale short -> 0
    assert ramp(-5.0, 5.0) == 0.0
    # beyond a scale -> clamped to 0
    assert ramp(-6.0, 5.0) == 0.0
    # undefined inputs -> None
    assert ramp(None, 5.0) is None
    assert ramp(-1.0, None) is None
    # non-positive or NaN scale -> None (can't normalize)
    assert ramp(-1.0, 0.0) is None
    assert ramp(-1.0, math.nan) is None


def test_avg_abs_gap_rolling_window_full_only():
    gaps = [-2.0, 1.0, -3.0, 2.0]
    # window 2: first bar has no full window -> None; then mean of |last 2|
    out = avg_abs_gap(gaps, 2)
    assert out[0] is None
    assert out[1] == (2.0 + 1.0) / 2
    assert out[2] == (1.0 + 3.0) / 2
    assert out[3] == (3.0 + 2.0) / 2


def test_avg_abs_gap_none_in_window_poisons():
    gaps = [1.0, None, 2.0, 3.0]
    out = avg_abs_gap(gaps, 2)
    assert out[1] is None  # window [1.0, None]
    assert out[2] is None  # window [None, 2.0]
    assert out[3] == (2.0 + 3.0) / 2


def test_scale_series_volatility_applies_width():
    gaps = [-2.0, 1.0, -3.0, 2.0]
    out = scale_series(gaps, "volatility", width=2.0, window=2, atr=None)
    assert out[0] is None
    assert out[1] == 2.0 * 1.5  # width * avgAbsGap


def test_scale_series_atr_applies_width():
    gaps = [0.0, 0.0, 0.0]
    atr = [None, 4.0, 5.0]
    out = scale_series(gaps, "atr", width=2.0, window=50, atr=atr)
    assert out[0] is None
    assert out[1] == 8.0
    assert out[2] == 10.0

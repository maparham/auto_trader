import math

from auto_trader.strategy.expr.closeness import ramp, signed_gap


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

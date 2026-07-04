from auto_trader.engine.scaling import SpacingSpec, ScalingConfig, spacing_ok


def test_no_spec_or_no_prior_open_always_ok():
    assert spacing_ok(None, 100.0, 101.0, "long", None) is True
    assert spacing_ok(SpacingSpec("pct", value=1.0), None, 101.0, "long", None) is True


def test_pct_spacing_long_needs_favorable_move():
    s = SpacingSpec("pct", value=1.0)  # 1%
    assert spacing_ok(s, 100.0, 100.9, "long", None) is False  # +0.9% < 1%
    assert spacing_ok(s, 100.0, 101.0, "long", None) is True   # +1.0% ok
    assert spacing_ok(s, 100.0, 99.0, "long", None) is False   # moved against


def test_pct_spacing_short_mirror():
    s = SpacingSpec("pct", value=1.0)
    assert spacing_ok(s, 100.0, 99.0, "short", None) is True    # -1% favorable for short
    assert spacing_ok(s, 100.0, 100.5, "short", None) is False


def test_atr_spacing_uses_multiple_and_is_false_when_cold():
    s = SpacingSpec("atr", mult=2.0, length=14)
    assert spacing_ok(s, 100.0, 106.0, "long", 3.0) is True   # +6 >= 2*3
    assert spacing_ok(s, 100.0, 105.0, "long", 3.0) is False  # +5 < 6
    assert spacing_ok(s, 100.0, 106.0, "long", None) is False  # cold ATR: reject (be conservative)


def test_scaling_defaults():
    c = ScalingConfig()
    assert c.max_concurrent == 1 and c.spacing is None

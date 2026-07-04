from __future__ import annotations

import pytest
from auto_trader.engine.risk import (
    StopSpec, TargetSpec, is_trailing, stop_level, target_level,
)


def test_pct_stop_below_entry_for_long_above_for_short():
    s = StopSpec("pct", value=2.0)
    assert stop_level(s, 100.0, "long", None, 100.0) == 98.0
    assert stop_level(s, 100.0, "short", None, 100.0) == 102.0


def test_pct_target_above_entry_for_long_below_for_short():
    t = TargetSpec("pct", value=5.0)
    assert target_level(t, 100.0, "long", None) == 105.0
    assert target_level(t, 100.0, "short", None) == 95.0


def test_atr_stop_uses_multiple_of_atr():
    s = StopSpec("atr", mult=2.0, length=14)
    assert stop_level(s, 100.0, "long", 3.0, 100.0) == 94.0   # 100 - 2*3
    assert stop_level(s, 100.0, "short", 3.0, 100.0) == 106.0


def test_atr_level_is_none_when_atr_cold():
    assert stop_level(StopSpec("atr", mult=2.0, length=14), 100.0, "long", None, 100.0) is None
    assert target_level(TargetSpec("atr", mult=2.0, length=14), 100.0, "long", None) is None


def test_price_kind_returns_absolute_level():
    assert stop_level(StopSpec("price", value=88.0), 100.0, "long", None, 100.0) == 88.0
    assert target_level(TargetSpec("price", value=120.0), 100.0, "long", None) == 120.0


def test_trailing_uses_extreme_not_entry():
    s = StopSpec("trailPct", value=2.0)
    # long extreme ran up to 120 => stop = 120 * 0.98
    assert stop_level(s, 100.0, "long", None, 120.0) == 120.0 * 0.98
    # short extreme ran down to 80 => stop = 80 * 1.02
    assert stop_level(s, 100.0, "short", None, 80.0) == 80.0 * 1.02


def test_none_kind_and_is_trailing():
    assert stop_level(StopSpec("none"), 100.0, "long", None, 100.0) is None
    assert target_level(TargetSpec("none"), 100.0, "long", None) is None
    assert is_trailing(StopSpec("trailAtr", mult=2, length=14)) is True
    assert is_trailing(StopSpec("pct", value=2)) is False


def test_unknown_stop_kind_raises():
    with pytest.raises(ValueError):
        stop_level(StopSpec("bogus"), 100.0, "long", None, 100.0)


def test_unknown_target_kind_raises():
    with pytest.raises(ValueError):
        target_level(TargetSpec("bogus"), 100.0, "long", None)

from datetime import UTC, datetime

from auto_trader.core.models import Candle
from auto_trader.indicators.candle_patterns import (
    CANDLE_PATTERN_DEFS,
    PATTERN_FNS,
    detect_all_patterns,
    pattern_series,
)

T0 = datetime(2026, 1, 1, tzinfo=UTC)


def c(o: float, h: float, lo: float, cl: float, i: int = 0) -> Candle:
    """A bar. `i` only advances `time`; detection never reads it."""
    return Candle(time=T0.replace(minute=i % 60), open=o, high=h, low=lo, close=cl)


def pad(n: int = 20) -> list[Candle]:
    """Warm-up bars so eps is the real ATR-based value, not the fallback."""
    return [c(100, 101, 99, 100, i) for i in range(n)]


def test_registry_has_24_defs_and_26_predicate_names():
    assert len(CANDLE_PATTERN_DEFS) == 24
    assert len(PATTERN_FNS) == 26
    assert PATTERN_FNS["bullEngulfing"] == "bull_engulfing"
    assert PATTERN_FNS["bullPattern"] == "@bull"
    assert PATTERN_FNS["bearPattern"] == "@bear"


def test_bull_engulfing_fires_on_engulfing_bar():
    bars = [*pad(), c(100, 101, 97, 98), c(97, 102, 96, 101)]
    assert "bull_engulfing" in detect_all_patterns(bars)[-1]


def test_bull_engulfing_does_not_fire_when_prev_bar_is_up():
    bars = [*pad(), c(98, 101, 97, 100), c(97, 102, 96, 101)]
    assert "bull_engulfing" not in detect_all_patterns(bars)[-1]


def test_every_matching_pattern_reports_not_just_the_first():
    """Unlike classify_candle, detection is not first-match: a flat bar is both
    a doji and an inside bar."""
    bars = [*pad(), c(100, 105, 95, 100), c(100, 101, 99, 100)]
    hits = detect_all_patterns(bars)[-1]
    assert "doji" in hits
    assert "inside" in hits


def test_pattern_series_is_one_and_zero_floats():
    bars = [*pad(), c(100, 101, 97, 98), c(97, 102, 96, 101)]
    series = pattern_series(bars, "bullEngulfing")
    assert len(series) == len(bars)
    assert series[-1] == 1.0
    assert series[-2] == 0.0


def test_bull_pattern_aggregate_ors_the_bull_polarity_group():
    bars = [*pad(), c(100, 101, 97, 98), c(97, 102, 96, 101)]
    assert pattern_series(bars, "bullPattern")[-1] == 1.0
    assert pattern_series(bars, "bearPattern")[-1] == 0.0


def test_doji_is_in_neither_aggregate():
    bars = [*pad(), c(100, 105, 95, 100)]
    assert "doji" in detect_all_patterns(bars)[-1]
    assert pattern_series(bars, "bullPattern")[-1] == 0.0
    assert pattern_series(bars, "bearPattern")[-1] == 0.0


def test_short_arrays_do_not_crash_and_do_not_over_report():
    bars = [c(100, 101, 99, 100, i) for i in range(3)]
    hits = detect_all_patterns(bars)
    assert len(hits) == 3
    for s in hits:
        assert "morning_star" not in s   # needs 4 bars
        assert "ladder_bottom" not in s  # needs 5 bars


def test_empty_input_returns_empty():
    assert detect_all_patterns([]) == []
    assert pattern_series([], "doji") == []


def test_unknown_fn_raises():
    import pytest
    with pytest.raises(KeyError):
        pattern_series(pad(), "notAPattern")

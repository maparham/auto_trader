from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.slope import (
    SlopeConfig, accel_series, parse_slope_config, slope_outputs,
    slope_series, slope_warmup, slope_with_units, smooth_series,
)


def mk(n):
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=100.0 + i, high=101.0 + i,
               low=99.0 + i, close=100.0 + i, volume=10.0)
        for i in range(n)
    ]


def cfg(**kw):
    base = dict(
        lengths=(3,), ma_type="ema", source="close", slope_period=2,
        units="pctHr", smoothing=None, show_accel=False, accel_period=2,
        accel_smoothing=None, accel_absolute=False, timeframe=None,
    )
    base.update(kw)
    return SlopeConfig(**base)


# --- slope_with_units --------------------------------------------------------

def test_slope_units_price_bar():
    raw = [10.0, 12.0, 14.0, 16.0]
    assert slope_with_units(raw, 2, 1.0, "priceBar") == [None, None, 2.0, 2.0]


def test_slope_units_pct_bar_and_pct_hr_differ_by_bar_hours():
    raw = [10.0, 10.0, 20.0]
    per_bar = slope_with_units(raw, 2, 4.0, "pctBar")
    per_hr = slope_with_units(raw, 2, 4.0, "pctHr")
    assert per_bar[2] == pytest.approx((20.0 - 10.0) / 10.0 / 2 * 100)
    assert per_hr[2] == pytest.approx(per_bar[2] / 4.0)


def test_slope_is_none_on_a_zero_denominator_except_price_bar():
    raw = [0.0, 5.0]
    assert slope_with_units(raw, 1, 1.0, "pctHr")[1] is None
    assert slope_with_units(raw, 1, 1.0, "priceBar")[1] == 5.0


def test_slope_passes_none_inputs_through():
    assert slope_with_units([None, 1.0, 2.0], 1, 1.0, "priceBar") == [None, None, 1.0]


# --- smooth_series -----------------------------------------------------------

def test_smoothing_none_returns_the_input_unchanged():
    v = [1.0, 2.0, None]
    assert smooth_series(v, None) == v
    assert smooth_series(v, ("none", 5)) == v
    assert smooth_series(v, ("sma", 1)) == v   # length <= 1 is a no-op


def test_sma_smoothing_needs_a_full_window_of_defined_values():
    assert smooth_series([1.0, 2.0, 3.0], ("sma", 2)) == [None, 1.5, 2.5]
    assert smooth_series([1.0, None, 3.0], ("sma", 2)) == [None, None, None]


def test_ema_smoothing_is_gappy_none_passes_through_and_does_not_reset():
    out = smooth_series([None, 4.0, 6.0], ("ema", 3))
    assert out[0] is None
    assert out[1] == 4.0
    assert out[2] == pytest.approx(6.0 * 0.5 + 4.0 * 0.5)


# --- accel_series ------------------------------------------------------------

def test_accel_is_an_absolute_difference_not_a_percentage():
    # -1 -> +1 must not blow up the way a /|prev| renormalization would.
    # (1 - (-1)) / (n2=2 * 1) == 1.0, a finite number; the percentage form
    # would divide by |prev| == 1 near a sign flip and diverge as prev -> 0.
    assert accel_series([-1.0, 0.0, 1.0], 2, 1.0, False)[2] == 1.0


def test_accel_divides_by_hours_when_the_slope_is_per_hour():
    assert accel_series([0.0, 0.0, 4.0], 2, 2.0, True)[2] == 1.0


def test_non_positive_accel_period_is_refused_not_lookahead():
    assert accel_series([1.0, 2.0, 3.0], 0, 1.0, False) == [None, None, None]
    assert accel_series([1.0, 2.0, 3.0], -1, 1.0, False) == [None, None, None]


# --- outputs / config --------------------------------------------------------

def test_outputs_track_the_configured_lengths():
    assert slope_outputs(cfg(lengths=(9, 21))) == ("slope0", "slope1")


def test_outputs_include_accel_only_when_enabled():
    assert slope_outputs(cfg(lengths=(9,), show_accel=True)) == ("slope0", "accel0")


def test_outputs_never_include_the_threshold_figure_keys():
    assert "thHi" not in slope_outputs(cfg(show_accel=True))
    assert "thLo" not in slope_outputs(cfg(show_accel=True))


def test_parse_defaults_match_the_pane_defaults():
    c = parse_slope_config([], {})
    assert c.lengths == (9,)          # slopeLengths default
    assert c.ma_type == "ema"
    assert c.source == "close"
    assert c.slope_period == 3
    assert c.units == "pctHr"
    assert c.smoothing is None
    assert c.show_accel is False


def test_parse_caps_lengths_at_five_and_drops_garbage():
    c = parse_slope_config([1, 2, 0, 3, 4, 5, 6, "x"], {})
    assert c.lengths == (1, 2, 3, 4, 5)


def test_parse_coerces_an_unknown_ma_type_to_ema():
    assert parse_slope_config([9], {"maType": "nonsense"}).ma_type == "ema"


# --- series / warmup ---------------------------------------------------------

def test_slope_series_rejects_an_unknown_output():
    with pytest.raises(KeyError):
        slope_series(cfg(), "slope7", mk(20), 1.0)


def test_slope_series_produces_defined_values_after_warmup():
    out = slope_series(cfg(lengths=(3,), slope_period=2), "slope0", mk(20), 1.0)
    assert len(out) == 20
    assert out[-1] is not None


def test_accel_absolute_makes_the_accel_output_non_negative():
    candles = mk(40)
    signed = slope_series(cfg(lengths=(3,), show_accel=True), "accel0", candles, 1.0)
    absolute = slope_series(
        cfg(lengths=(3,), show_accel=True, accel_absolute=True), "accel0", candles, 1.0
    )
    assert all(v is None or v >= 0 for v in absolute)
    assert [None if v is None else abs(v) for v in signed] == absolute


def test_warmup_sums_the_pipeline_lengths():
    assert slope_warmup(cfg(lengths=(9,), slope_period=3), "slope0") == 12
    assert slope_warmup(cfg(lengths=(9,), slope_period=3, smoothing=("sma", 5)), "slope0") == 16
    assert slope_warmup(
        cfg(lengths=(9,), slope_period=3, show_accel=True, accel_period=4), "accel0"
    ) == 16

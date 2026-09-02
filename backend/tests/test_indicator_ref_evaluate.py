from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.mtf import align_htf_to_base, slope_of
from auto_trader.indicators.registry import resolve_instances
from auto_trader.indicators.slope import parse_slope_config, slope_line_series
from auto_trader.strategy.expr.evaluate import series_of
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.warmup import warmup_bars


def mk(n, step_hours: float = 1.0):
    """`step_hours` spaces the bars: a fixture declared HOUR_4 must actually
    BE 4-hourly, since the same-TF bypass now keys on the declared resolution
    and a mislabeled fixture would test a series that cannot occur."""
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i * step_hours), open=100.0 + i, high=101.0 + i,
               low=99.0 + i, close=100.0 + (i % 7), volume=10.0)
        for i in range(n)
    ]


PAYLOAD = {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                     "extendData": {"slopePeriod": 3, "showAccel": True, "accelPeriod": 2}}}
INSTANCES = resolve_instances(PAYLOAD)

# The same pane, but PINNED to 1H in its own settings. The rule text is
# identical — the pin is a setting, not syntax — so `SLOPE.5` here already
# denotes the 1H series.
#
# The frontend writes extendData.mtf.timeframe as a CANONICAL resolution
# ("HOUR"), not the editor's pin alias ("1H") — mtfCoordinator indexes it into
# feed.ts RESOLUTION_SECONDS. Both spellings must resolve, so both are covered.
def _pinned(tf):
    return resolve_instances({"SLOPE": {"type": "SLOPE", "calcParams": [5],
                                        "extendData": {"slopePeriod": 3,
                                                       "mtf": {"timeframe": tf}}}})


PINNED = _pinned("HOUR")
PIN_SPELLINGS = ("HOUR", "1H")


def expr(src):
    return parse(src).left


def test_a_ref_evaluates_to_the_indicator_module_series():
    candles = mk(40)
    got = series_of(expr("SLOPE.5 > 0"), candles, "HOUR", {}, INSTANCES)
    cfg = parse_slope_config([5], {"slopePeriod": 3, "showAccel": True, "accelPeriod": 2})
    want = slope_line_series(candles, cfg, 5, 1.0)
    assert got == want


def test_bar_hours_come_from_the_resolution_not_the_candle_gaps():
    candles = mk(40)
    hourly = series_of(expr("SLOPE.5 > 0"), candles, "HOUR", {}, INSTANCES)
    four_hourly = series_of(expr("SLOPE.5 > 0"), candles, "HOUR_4", {}, INSTANCES)
    # Same candles, different nominal width -> pctHr values scale by 4.
    i = next(i for i, v in enumerate(hourly) if v not in (None, 0.0))
    assert four_hourly[i] == pytest.approx(hourly[i] / 4)


def test_an_offset_shifts_a_ref():
    candles = mk(40)
    plain = series_of(expr("SLOPE.5 > 0"), candles, "HOUR", {}, INSTANCES)
    shifted = series_of(expr("SLOPE.5[-2] > 0"), candles, "HOUR", {}, INSTANCES)
    assert shifted[5] == plain[3]


def test_a_missing_instance_evaluates_to_all_none_rather_than_crashing():
    # validate() is the gate; series_of must still be defensive, like the Tf branch.
    out = series_of(expr("GONE.5 > 0"), mk(10), "HOUR", {}, INSTANCES)
    assert out == [None] * 10


def test_warmup_comes_from_the_instance_config():
    # length 5 + slopePeriod 3
    assert warmup_bars(expr("SLOPE.5 > 0"), "HOUR", INSTANCES) == 8
    # + accelPeriod 2
    assert warmup_bars(expr("SLOPE.accel5 > 0"), "HOUR", INSTANCES) == 10
    # offsets still stack on top
    assert warmup_bars(expr("SLOPE.5[-4] > 0"), "HOUR", INSTANCES) == 12


def test_warmup_of_an_unknown_ref_is_zero():
    assert warmup_bars(expr("GONE.5 > 0"), "HOUR", INSTANCES) == 0


# --- Pinned instances -------------------------------------------------------
# Not in the brief: the brief has no pinned-instance coverage at all, yet a pin
# is exactly where a mistake yields a WRONG NUMBER rather than an error.

@pytest.mark.parametrize("pin", PIN_SPELLINGS)
def test_a_pinned_instance_uses_its_own_timeframes_candles_and_bar_hours(pin):
    """The pin is a SETTING: `SLOPE.5` on a 1H-pinned pane means the 1H
    series, computed on 1H candles with bar_hours=1.0 and aligned down — NOT the
    base series, and NOT the 1H candles with the BASE resolution's bar_hours
    (which would silently scale every pctHr value by 4 here)."""
    base = mk(40, step_hours=4.0)
    tf_candles = mk(40)
    got = series_of(expr("SLOPE.5 > 0"), base, "HOUR_4",
                    {"HOUR": tf_candles}, _pinned(pin))

    cfg = parse_slope_config([5], {"slopePeriod": 3, "mtf": {"timeframe": pin}})
    base_ms = [int(c.time.timestamp() * 1000) for c in base]
    right = align_htf_to_base(
        base_ms, tf_candles, slope_line_series(tf_candles, cfg, 5, 1.0), 3_600_000
    )
    # bar_hours taken from the BASE resolution instead of the pin — the bug.
    wrong = align_htf_to_base(
        base_ms, tf_candles, slope_line_series(tf_candles, cfg, 5, 4.0), 3_600_000
    )
    assert got == right
    assert got != wrong
    # And it is not simply the unpinned base-candle series either.
    assert got != slope_line_series(base, cfg, 5, 4.0)


def test_a_pinned_instance_with_no_htf_candles_degrades_to_all_none():
    assert series_of(expr("SLOPE.5 > 0"), mk(10), "HOUR_4", {}, PINNED) == [None] * 10


def test_a_pinned_instance_costs_zero_base_warmup_bars():
    # Same rule text, same config apart from the pin: unpinned charges the
    # instance's own warm-up, pinned charges 0 because it is warmed from its own
    # HTF history (sourced + sufficiency-checked by the routes), like an @tf pin.
    assert warmup_bars(expr("SLOPE.5 > 0"), "HOUR", INSTANCES) == 8
    assert warmup_bars(expr("SLOPE.5 > 0"), "HOUR", PINNED) == 0
    # Terms OUTSIDE the pin still count in base bars.
    assert warmup_bars(expr("SLOPE.5[-4] > 0"), "HOUR", PINNED) == 4


# --- Instance-map forwarding ------------------------------------------------

def test_the_instance_map_reaches_a_deeply_nested_ref_not_just_a_toplevel_one():
    """Guards against a DROPPED FORWARD: if any recursive series_of call omits
    `instances`, the map becomes None deeper in the tree and a perfectly valid
    reference evaluates to all-None — a wrong backtest number, not a crash. The
    signature-shaped guard in test_expr_instances_threading.py cannot see this.

    `slope(SLOPE.5[-1], 3) @1H` nests the ref under Tf -> Call -> Offset,
    i.e. three separate forwarding hops through four node types."""
    base = mk(40, step_hours=0.25)
    tf_candles = mk(40)
    got = series_of(expr("slope(SLOPE.5[-1], 3) @1H > 0"), base,
                    "MINUTE_15", {"HOUR": tf_candles}, INSTANCES)

    cfg = parse_slope_config([5], {"slopePeriod": 3, "showAccel": True, "accelPeriod": 2})
    inner = slope_line_series(tf_candles, cfg, 5, 1.0)
    shifted = [inner[i - 1] if i >= 1 else None for i in range(len(tf_candles))]
    wrapped = slope_of(shifted, 3, 1.0)
    base_ms = [int(c.time.timestamp() * 1000) for c in base]
    want = align_htf_to_base(base_ms, tf_candles, wrapped, 3_600_000)

    # All-None would mean the map was dropped somewhere on the way down.
    assert any(v is not None for v in got)
    # ...and equality catches a forward that arrives but carries the wrong series.
    assert got == want


ATR_PAYLOAD = {"ATR1": {"type": "ATR", "calcParams": [5],
                        "extendData": {"smoothing": "ema", "pctSource": "hl2"}}}


def test_atr_pct_output_honors_smoothing_and_pct_source():
    from auto_trader.indicators.atr import atr_pane_series, parse_atr_config
    from auto_trader.indicators.core import atr_smoothed_series, price_of
    candles = mk(40)
    cfg = parse_atr_config([5], {"smoothing": "ema", "pctSource": "hl2"})
    assert cfg.pct_source == "hl2"
    got = atr_pane_series(cfg, "5.to%", candles, 1.0)
    base = atr_smoothed_series(candles, 5, "ema")
    for g, a, c in zip(got, base, candles):
        if a is None:
            assert g is None
        else:
            assert g == pytest.approx(a / ((c.high + c.low) / 2) * 100)


def test_atr_pct_source_defaults_to_close_on_garbage():
    from auto_trader.indicators.atr import parse_atr_config
    assert parse_atr_config([5], {"pctSource": "bogus"}).pct_source == "close"
    assert parse_atr_config([5], None).pct_source == "close"


def test_price_of_composite_sources():
    from auto_trader.indicators.core import price_of
    c = Candle(time=datetime(2024, 1, 1, tzinfo=timezone.utc),
               open=10.0, high=20.0, low=8.0, close=14.0, volume=1.0)
    assert price_of(c, "open") == 10.0
    assert price_of(c, "high") == 20.0
    assert price_of(c, "low") == 8.0
    assert price_of(c, "close") == 14.0
    assert price_of(c, "hl2") == 14.0
    assert price_of(c, "hlc3") == pytest.approx((20 + 8 + 14) / 3)
    assert price_of(c, "ohlc4") == pytest.approx((10 + 20 + 8 + 14) / 4)
    assert price_of(c, "hlcc4") == pytest.approx((20 + 8 + 14 + 14) / 4)
    assert price_of(c, "junk") == 14.0


def test_atr_ref_pct_end_to_end_and_warmup():
    from auto_trader.indicators.atr import atr_pane_series, atr_warmup, parse_atr_config
    candles = mk(40)
    instances = resolve_instances(ATR_PAYLOAD)
    got = series_of(expr("ATR1.5.to% > 1"), candles, "HOUR", {}, instances)
    # Bar-for-bar against the indicator module: pins that evaluate's dispatch
    # passes the fused "5.to%" output string through unmangled.
    cfg_hl2 = parse_atr_config([5], {"smoothing": "ema", "pctSource": "hl2"})
    assert got == atr_pane_series(cfg_hl2, "5.to%", candles, 1.0)
    assert any(v is not None for v in got)
    cfg = parse_atr_config([5], {})
    assert atr_warmup(cfg, "5") == 5
    assert atr_warmup(cfg, "5.to%") == 5
    assert atr_warmup(cfg, "bogus") == 0


def test_a_pin_equal_to_the_run_timeframe_equals_no_pin():
    """A pane pinned to the chart's OWN timeframe is the same series as leaving
    it unpinned: align_htf_to_base's same-TF bypass maps bar-for-bar, so the
    pin gains no artificial one-bar lag. Locking this keeps the rule engine
    agreeing with the pane, which draws same-TF pins bar-for-bar too (the
    frontend alignHtfToChart applies the identical bypass)."""
    base = mk(40)
    unpinned = series_of(expr("SLOPE.5 > 0"), base, "HOUR", {}, INSTANCES)
    pinned = series_of(expr("SLOPE.5 > 0"), base, "HOUR", {"HOUR": base},
                       _pinned("HOUR"))

    assert pinned == unpinned


def test_same_tf_pin_survives_an_anomalous_partial_bar():
    """A backtest range routinely holds one sub-interval bar (session-open
    partial, DST-compressed hour). The same-TF bypass must key on the RUN's
    declared resolution, not on gap inference over whatever candles were
    posted — inferred, that one bar reads as a 30m series under an HOUR pin
    and delays every value a bar, disagreeing with the chart pane."""
    from datetime import datetime, timedelta, timezone

    from auto_trader.core.models import Candle

    base = mk(40)
    # One 30-minute partial squeezed between bars 19 and 20.
    partial_t = datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(hours=19, minutes=30)
    base = base[:20] + [
        Candle(time=partial_t, open=119.0, high=120.0, low=118.0, close=119.5, volume=5.0)
    ] + base[20:]
    unpinned = series_of(expr("SLOPE.5 > 0"), base, "HOUR", {}, INSTANCES)
    pinned = series_of(expr("SLOPE.5 > 0"), base, "HOUR", {"HOUR": base},
                       _pinned("HOUR"))
    assert pinned == unpinned

"""align_htf_to_base same-timeframe bypass: a pin equal to the base timeframe
maps bar-for-bar (the value is the bar's own, exactly as an unpinned operand
reads it); a genuinely higher pin keeps the closed-bar gate. Mirrors the
frontend's alignHtfToChart tests (mtf.test.ts)."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.indicators.mtf import align_htf_to_base

H_MS = 3_600_000


def bars(hours: list[int]) -> list[Candle]:
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=h), open=1, high=2, low=0, close=1, volume=1)
        for h in hours
    ]


def times_ms(candles: list[Candle]) -> list[int]:
    return [int(c.time.timestamp() * 1000) for c in candles]


def test_same_tf_pin_maps_bar_for_bar():
    htf = bars([0, 4, 8])
    out = align_htf_to_base(times_ms(htf), htf, [10.0, 20.0, 30.0], 4 * H_MS)
    assert out == [10.0, 20.0, 30.0]


def test_same_tf_detected_across_a_session_hole():
    # One oversized gap (weekend) must not defeat detection: the smallest
    # positive gap is the true bar interval.
    htf = bars([0, 4, 16])
    out = align_htf_to_base(times_ms(htf), htf, [10.0, 20.0, 30.0], 4 * H_MS)
    assert out == [10.0, 20.0, 30.0]


def test_higher_pin_keeps_the_closed_bar_gate():
    base = bars([0, 1, 2, 3, 4, 5])
    htf = bars([0, 4])
    out = align_htf_to_base(times_ms(base), htf, [10.0, 20.0], 4 * H_MS)
    assert out == [None, None, None, None, 10.0, 10.0]


def test_explicit_base_interval_survives_an_anomalous_partial_bar():
    """A backtest range routinely contains one sub-interval bar (session-open
    partial, DST-compressed hour). Inferred via min-positive-gap that single
    bar flips the pin to "higher timeframe" and delays every value one bar —
    while the chart, whose window may lack the bar, draws them undelayed. The
    caller KNOWS the base resolution, so passing it must pin the decision."""
    base = bars([0, 4, 8, 10, 12, 16])  # one 2h partial inside a 4h series
    htf = bars([0, 4, 8, 12, 16])
    vals = [10.0, 20.0, 30.0, 40.0, 50.0]
    out = align_htf_to_base(
        times_ms(base), htf, vals, 4 * H_MS, base_interval_ms=4 * H_MS
    )
    assert out == [10.0, 20.0, 30.0, 30.0, 40.0, 50.0]


def test_explicit_base_interval_below_the_pin_keeps_the_gate():
    base = bars([0, 1, 2, 3, 4, 5])
    htf = bars([0, 4])
    out = align_htf_to_base(
        times_ms(base), htf, [10.0, 20.0], 4 * H_MS, base_interval_ms=H_MS
    )
    assert out == [None, None, None, None, 10.0, 10.0]

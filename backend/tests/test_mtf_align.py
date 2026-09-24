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


# --- short last intraday bucket (parity: mtf.test.ts "alignHtfToChart short
# last intraday bucket") ---------------------------------------------------
# A 7H pin tiles each UTC day 00/07/14/21; the 21:00 bucket is short and
# closes at the 00:00 reset, not at 04:00 the next day.

def test_short_last_bucket_closes_at_midnight_for_a_non_native_intraday_pin():
    htf = bars([0, 7, 14, 21, 24])
    base = bars([20, 21, 22, 23, 24, 25])
    out = align_htf_to_base(
        times_ms(base), htf, [10.0, 20.0, 30.0, 40.0, 50.0], 7 * H_MS,
        base_interval_ms=H_MS, htf_resolution="HOUR_7",
    )
    assert out == [20.0, 30.0, 30.0, 30.0, 40.0, 40.0]


def test_short_last_bucket_accepts_an_alias_pin():
    htf = bars([0, 7, 14, 21, 24])
    base = bars([20, 21, 22, 23, 24, 25])
    out = align_htf_to_base(
        times_ms(base), htf, [10.0, 20.0, 30.0, 40.0, 50.0], 7 * H_MS,
        base_interval_ms=H_MS, htf_resolution="7H",
    )
    assert out == [20.0, 30.0, 30.0, 30.0, 40.0, 40.0]


def test_without_a_resolution_the_close_stays_nominal():
    htf = bars([0, 7, 14, 21, 24])
    base = bars([20, 21, 22, 23, 24, 25])
    out = align_htf_to_base(
        times_ms(base), htf, [10.0, 20.0, 30.0, 40.0, 50.0], 7 * H_MS,
        base_interval_ms=H_MS,
    )
    assert out == [20.0, 30.0, 30.0, 30.0, 30.0, 30.0]


def test_native_and_calendar_pins_keep_the_nominal_close():
    htf = bars([0, 4, 8])
    base = bars([3, 4, 7, 8])
    out = align_htf_to_base(
        times_ms(base), htf, [1.0, 2.0, 3.0], 4 * H_MS,
        base_interval_ms=H_MS, htf_resolution="HOUR_4",
    )
    assert out == [None, 1.0, 1.0, 2.0]


# --- calendar pins close at the TRUE bucket end (parity: mtf.test.ts
# "alignHtfToChart calendar bucket ends") -----------------------------------
# A month group closes at the next group's first day, not open + 30d * N: a
# 31-day October must not be gated closed on Oct 31 (lookahead), and the short
# Nov-Dec tail of a 5M year closes on Jan 1 (not ~Mar 31, months stale).

D_MS = 86_400_000


def _at(y: int, m: int, d: int) -> Candle:
    t = datetime(y, m, d, tzinfo=timezone.utc)
    return Candle(time=t, open=1, high=2, low=0, close=1, volume=1)


def test_one_month_pin_closes_on_the_first_of_the_next_month():
    htf = [_at(2025, 10, 1), _at(2025, 11, 1)]
    base = [_at(2025, 10, 31), _at(2025, 11, 1)]
    out = align_htf_to_base(
        times_ms(base), htf, [1.0, 2.0], 30 * D_MS,
        base_interval_ms=D_MS, htf_resolution="MONTH",
    )
    assert out == [None, 1.0]


def test_five_month_pin_short_year_end_group_closes_on_jan_1():
    htf = [_at(2025, 6, 1), _at(2025, 11, 1), _at(2026, 1, 1)]
    base = [_at(2025, 12, 31), _at(2026, 1, 1), _at(2026, 1, 2)]
    out = align_htf_to_base(
        times_ms(base), htf, [1.0, 2.0, 3.0], 150 * D_MS,
        base_interval_ms=D_MS, htf_resolution="5M",
    )
    assert out == [1.0, 2.0, 2.0]


def test_year_pin_closes_on_the_next_jan_1():
    htf = [_at(2024, 1, 1), _at(2025, 1, 1)]
    base = [_at(2024, 12, 31), _at(2025, 1, 1)]
    out = align_htf_to_base(
        times_ms(base), htf, [1.0, 2.0], 365 * D_MS,
        base_interval_ms=D_MS, htf_resolution="YEAR",
    )
    assert out == [None, 1.0]

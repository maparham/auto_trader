from datetime import datetime, timezone

from auto_trader.core.alert_bars import (
    BarSeries, Roll, Sample, alert_resolution, candle_ms, period_start,
)
from auto_trader.core.models import Candle

H = 3_600_000
M = 60_000


def c(ms, o, h, l, cl, v=0.0):
    return Candle(datetime.fromtimestamp(ms / 1000, tz=timezone.utc), o, h, l, cl, v)


def test_alert_resolution_defaults_and_sub_minute():
    assert alert_resolution(None) == "MINUTE"
    assert alert_resolution("SECOND_5") == "MINUTE"
    assert alert_resolution("garbage") == "MINUTE"
    assert alert_resolution("HOUR") == "HOUR"
    assert alert_resolution("1H") == "HOUR"


def test_period_start_native():
    t = 10 * H + 17 * M + 5_000
    assert period_start(t, "HOUR") == 10 * H
    assert period_start(t, "MINUTE_15") == 10 * H + 15 * M
    assert period_start(t, "DAY") == 0


def test_period_start_derived_folds_like_the_candles_api():
    # 2023-11-14 22:50:20 UTC, hardcoded independently (not restated via
    # period_start/rule_for, which would make this tautological): HOUR_2
    # buckets every even hour, MINUTE_3 every 3 minutes, HOUR_6 resets at
    # 00:00 UTC (buckets at 00/06/12/18).
    t = 1_700_000_000_000 + 37 * M
    assert period_start(t, "HOUR_2") == 1_699_999_200_000    # 2023-11-14 22:00 UTC
    assert period_start(t, "MINUTE_3") == 1_700_002_080_000  # 2023-11-14 22:48 UTC
    assert period_start(t, "HOUR_6") == 1_699_984_800_000    # 2023-11-14 18:00 UTC


def test_keep_closed_is_broker_offset_safe():
    # Some brokers offset their 4H/daily bars from UTC midnight
    # (candle_aggregate.py's HOUR rule_for comment), so a broker bar need not
    # align to our own epoch grid. A bar that opened at 05:00 and runs 4h is
    # still forming at 08:30 even though our epoch-aligned HOUR_4 grid point
    # (08:00) already lies after its open: "closed" must mean a full
    # resolution has elapsed since the bar's OWN open, not "before our grid's
    # current boundary".
    s = BarSeries("HOUR_4", "mid", cap=10)
    bars = [c(1 * H, 1, 1, 1, 1), c(5 * H, 1, 1, 1, 2)]  # opens 01:00, 05:00
    now = 8 * H + 30 * M  # 08:30: the 05:00-09:00 bar has 30 minutes left
    s.seed(bars, now)
    assert [candle_ms(b) for b in s.closed] == [1 * H]


def test_on_sample_builds_forming_then_closes_on_roll():
    s = BarSeries("HOUR", "mid")
    assert s.on_sample(Sample(10 * H + 1_000, 100.0, None, None)) is Roll.NONE
    s.on_sample(Sample(10 * H + 2_000, 103.0, None, None))
    s.on_sample(Sample(10 * H + 3_000, 98.0, None, None))
    f = s.forming
    assert (f.open, f.high, f.low, f.close) == (100.0, 103.0, 98.0, 98.0)
    assert s.on_sample(Sample(11 * H + 1_000, 99.0, None, None)) is Roll.CLOSED
    assert s.forming_open_ms == 11 * H


def test_skipped_period_is_a_gap():
    s = BarSeries("HOUR", "mid")
    s.on_sample(Sample(10 * H, 100.0, None, None))
    assert s.on_sample(Sample(12 * H + 5, 100.0, None, None)) is Roll.GAP


def test_bid_side_shifts_forming_by_half_spread():
    s = BarSeries("HOUR", "bid")
    s.on_sample(Sample(10 * H, 100.0, 99.5, 100.5))
    assert s.forming.close == 99.5


def test_stream_bar_volume_sums_per_minute_not_per_update():
    s = BarSeries("HOUR", "mid")
    s.on_sample(Sample(10 * H + 1, 100.0, None, None, bar=c(10 * H, 100, 101, 99, 100, 5)))
    s.on_sample(Sample(10 * H + 2, 100.0, None, None, bar=c(10 * H, 100, 102, 99, 101, 7)))
    s.on_sample(Sample(10 * H + M, 101.0, None, None, bar=c(10 * H + M, 101, 101, 100, 100, 3)))
    assert s.forming.volume == 10  # 7 (last update of minute 0) + 3
    assert s.forming.high == 102


def test_seed_and_replace_tail_keep_only_closed_bars():
    s = BarSeries("HOUR", "mid", cap=3)
    now = 13 * H + 5
    bars = [c(i * H, 1, 1, 1, i) for i in range(9, 14)]  # 13h is still forming
    s.seed(bars, now)
    assert [candle_ms(b) for b in s.closed] == [10 * H, 11 * H, 12 * H]
    s.replace_tail([c(12 * H, 1, 1, 1, 99), c(13 * H, 1, 1, 1, 5)], now)
    assert s.closed[-1].close == 99 and len(s.closed) == 3


def test_seed_keeps_the_loaders_forming_bar_for_the_current_period():
    # I7: the loader returns the bar still forming as its last element. It is
    # the real partial bar (already on the series' price side, since the
    # loader fetches per side), so the first intrabar value after a seed must
    # use it rather than a forming bar rebuilt from zero live samples.
    s = BarSeries("HOUR", "bid", cap=10)
    now = 13 * H + 20 * M
    bars = [c(i * H, 1, 1, 1, i) for i in range(9, 13)] + [c(13 * H, 1.0, 5.0, 0.5, 2.0, 7.0)]
    s.seed(bars, now)
    assert [candle_ms(b) for b in s.closed] == [9 * H, 10 * H, 11 * H, 12 * H]
    assert s.forming_open_ms == 13 * H
    f = s.forming
    assert (f.open, f.high, f.low, f.close, f.volume) == (1.0, 5.0, 0.5, 2.0, 7.0)
    assert s.with_forming()[-1] is f
    # Live samples in the same period extend it: no roll, the seeded open,
    # range and volume survive.
    assert s.on_sample(Sample(13 * H + 21 * M, 6.25, 6.0, 6.5)) is Roll.NONE
    f = s.forming
    assert (f.open, f.high, f.low, f.close, f.volume) == (1.0, 6.0, 0.5, 6.0, 7.0)


def test_seed_ignores_a_forming_bar_that_is_not_this_periods():
    # A broker bar off our grid (opens 05:00, our HOUR_4 period opens 08:00)
    # is not the bar on_sample will build, so it is not adopted.
    s = BarSeries("HOUR_4", "mid", cap=10)
    s.seed([c(1 * H, 1, 1, 1, 1), c(5 * H, 1, 1, 1, 2)], 8 * H + 30 * M)
    assert s.forming is None and s.forming_open_ms is None


def test_seeded_forming_volume_adds_later_stream_minutes():
    s = BarSeries("HOUR", "mid", cap=10)
    now = 13 * H + 20 * M + 5_000
    s.seed([c(12 * H, 1, 1, 1, 1), c(13 * H, 1, 2, 1, 2, 40.0)], now)
    # The seed's own minute (13:20) is already inside the loader's volume.
    s.on_sample(Sample(13 * H + 20 * M + 9_000, 2.0, None, None, bar=c(13 * H + 20 * M, 2, 2, 2, 2, 3)))
    assert s.forming.volume == 40.0
    s.on_sample(Sample(13 * H + 21 * M + 1_000, 2.0, None, None, bar=c(13 * H + 21 * M, 2, 2, 2, 2, 5)))
    assert s.forming.volume == 45.0

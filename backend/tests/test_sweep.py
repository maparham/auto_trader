"""SWEEP backend series: pivot and previous-day levels, same-bar sweep,
score, confirmation. Mirrors frontend/src/lib/indicators/sweepCompute.test.ts
(same rows, same expectations) per the parity contract in indicators/core.py."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series
from auto_trader.indicators.sweep import (
    SWEEP_OUTPUTS,
    SweepConfig,
    parse_sweep_config,
    sweep_score,
    sweep_series,
    sweep_warmup,
)

T0 = datetime(2024, 1, 1, 20, tzinfo=timezone.utc)


def bars(rows, step=timedelta(hours=1)):
    return [
        Candle(time=T0 + k * step, open=o, high=h, low=l, close=c, volume=1.0)
        for k, (o, h, l, c) in enumerate(rows)
    ]


CFG = SweepConfig(
    pivot_left=1, pivot_right=1, level_max_age=10, min_wick_pct=50.0, atr_len=2,
    min_range_atr=1.0, vol_len=20, vol_z=2.0, min_score=70.0, confirm_bars=2,
    use_prev_day=False, use_volume=False, use_prev_bar=True, tz="UTC",
)


def col(cfg, candles, output):
    return sweep_series(cfg, output, candles, 1.0)


# Pivot high 103 at bar 1 is born at bar 2 (pivot_right=1). Bar 4 trades to
# 106 and closes 101: a full-credit bear sweep (score 100). Bars 5-6 hold
# below 103, so it confirms on bar 6 (confirm_bars=2).
SWEEP_ROWS = [
    (100, 101, 99, 100),
    (100, 103, 99.5, 102),
    (102, 102, 100, 101),
    (101, 102, 100, 101),
    (101, 106, 100.5, 101),
    (101, 102, 100, 101),
    (101, 102, 100.5, 101.5),
]


def test_bear_sweep_flags_and_confirms():
    b = bars(SWEEP_ROWS)
    assert col(CFG, b, "bearSweep") == [0, 0, 0, 0, 1, 0, 0]
    assert col(CFG, b, "bullSweep") == [0] * 7
    assert col(CFG, b, "bearConfirmed") == [0, 0, 0, 0, 0, 0, 1]
    assert col(CFG, b, "score")[4] == 100.0
    assert col(CFG, b, "sweptLevel") == [None] * 4 + [103] * 3
    assert col(CFG, b, "barsSince") == [None] * 4 + [0, 1, 2]


def test_events_are_zero_from_bar_zero():
    b = bars(SWEEP_ROWS[:2])
    for out in ("bearSweep", "bullSweep", "bearConfirmed", "bullConfirmed"):
        assert col(CFG, b, out) == [0, 0]


def test_breakout_kills_level():
    rows = [*SWEEP_ROWS[:4], (101, 106, 100.5, 104), (104, 104.5, 101, 102)]
    assert col(CFG, bars(rows), "bearSweep") == [0] * 6


def test_close_back_through_drops_pending():
    rows = [*SWEEP_ROWS[:5], (101, 104, 100.5, 103.5), (101, 102, 100.5, 101.5)]
    b = bars(rows)
    assert col(CFG, b, "bearSweep")[4] == 1
    assert col(CFG, b, "bearConfirmed") == [0] * 7


def test_highest_crossed_level_wins_and_all_crossed_die():
    rows = [
        (100, 101, 99, 100),
        (100, 104, 99.5, 102),
        (102, 102, 100, 101),
        (101, 103, 100, 101),
        (101, 102, 100, 101),
        (101, 106, 100.5, 101),
        (101, 103.5, 100.5, 101),
    ]
    b = bars(rows)
    assert col(CFG, b, "sweptLevel")[5] == 104
    assert col(CFG, b, "bearSweep") == [0, 0, 0, 0, 0, 1, 0]


def test_outside_bar_tie_flags_neither():
    rows = [
        (100, 101, 99, 100),
        (100, 103, 99.5, 102),
        (102, 102, 97, 99),
        (99, 101, 98, 100),
        (100, 106, 94, 100),
        (100, 104, 96, 100),
    ]
    b = bars(rows)
    assert col(CFG, b, "bearSweep") == [0] * 6
    assert col(CFG, b, "bullSweep") == [0] * 6


def test_level_expires_after_max_age():
    b = bars(SWEEP_ROWS)
    assert col(replace(CFG, level_max_age=2), b, "bearSweep")[4] == 1
    assert col(replace(CFG, level_max_age=1), b, "bearSweep") == [0] * 7


def test_unconfirmed_pivot_is_never_a_level():
    # pivot_right=3 needs bars 2..4 below 103; bar 4's 106 breaks that, so 103
    # never becomes a level and bar 4 sweeps nothing.
    assert col(replace(CFG, pivot_right=3), bars(SWEEP_ROWS), "bearSweep") == [0] * 7


def test_new_flag_replaces_pending():
    rows = [
        (100, 101, 99, 100),
        (100, 103, 99.5, 102),
        (102, 102, 98, 101),
        (101, 102, 99, 101),
        (101, 106, 100.5, 101),
        (101, 101.5, 97, 101.2),
        (101, 102, 100.5, 101.5),
        (101, 102, 100.5, 101.5),
    ]
    b = bars(rows)
    assert col(CFG, b, "bearSweep")[4] == 1
    assert col(CFG, b, "bullSweep")[5] == 1
    assert col(CFG, b, "sweptLevel")[5] == 98
    assert col(CFG, b, "bearConfirmed") == [0] * 8
    assert col(CFG, b, "bullConfirmed") == [0] * 7 + [1]


def test_wick_and_close_without_range_stay_under_min_score():
    b = bars(SWEEP_ROWS)
    cfg = replace(CFG, min_range_atr=1000.0)
    assert col(cfg, b, "bearSweep") == [0] * 7
    assert col(cfg, b, "sweptLevel") == [None] * 7


PREV_DAY_ROWS = [
    (100, 101, 100, 101),
    (101, 102, 101, 102),
    (102, 103, 102, 103),
    (103, 105, 103, 105),
    (104, 107, 103, 104),
]


def test_prev_day_high_is_a_level():
    # Bars 0-3 are 20:00-23:00 UTC on Jan 1 with rising highs (no pivot);
    # bar 4 opens Jan 2 and sweeps Jan 1's high, 105.
    cfg = replace(CFG, use_prev_day=True)
    b = bars(PREV_DAY_ROWS)
    assert col(cfg, b, "bearSweep") == [0, 0, 0, 0, 1]
    assert col(cfg, b, "sweptLevel")[4] == 105


def test_prev_day_follows_tz():
    # In Tokyo (UTC+9) all five bars fall on Jan 2: no previous day yet.
    cfg = replace(CFG, use_prev_day=True, tz="Asia/Tokyo")
    assert col(cfg, bars(PREV_DAY_ROWS), "bearSweep") == [0] * 5


def test_prev_day_blank_on_weekly_bars():
    cfg = replace(CFG, use_prev_day=True)
    b = bars(PREV_DAY_ROWS, step=timedelta(days=7))
    assert col(cfg, b, "bearSweep") == [0] * 5


# --- Previous-candle outside-bar reversal (use_prev_bar) ---

REV_BULL_ROWS = [
    (102, 103, 100, 101),  # bearish prev candle
    (101, 105, 99, 104),   # low below prev low, close above prev high
]

REV_BEAR_ROWS = [
    (100, 103, 99, 102),   # bullish prev candle
    (102, 106, 95, 97),    # high above prev high, close below prev low
]


def test_prev_bar_bull_reversal_flags():
    b = bars(REV_BULL_ROWS)
    assert col(CFG, b, "bullSweep") == [0, 1]
    assert col(CFG, b, "bearSweep") == [0, 0]
    assert col(CFG, b, "sweptLevel")[1] == 100


def test_prev_bar_bear_reversal_flags():
    b = bars(REV_BEAR_ROWS)
    assert col(CFG, b, "bearSweep") == [0, 1]
    assert col(CFG, b, "bullSweep") == [0, 0]
    assert col(CFG, b, "sweptLevel")[1] == 103


def test_prev_bar_wrong_colour_no_reversal():
    # Bullish prev candle (not bearish), same bull geometry as REV_BULL_ROWS.
    rows = [
        (100, 103, 99, 102),
        (101, 105, 97, 104),
    ]
    b = bars(rows)
    assert col(CFG, b, "bullSweep") == [0, 0]
    assert col(CFG, b, "bearSweep") == [0, 0]


def test_prev_bar_close_not_beyond_opposite_extreme_no_flag():
    # Low below prev low (crossing part holds), but close only above prev
    # low, not above prev high: the reversal path never creates a level.
    rows = [
        (103, 104, 100, 101),
        (101, 103, 98, 102),
    ]
    b = bars(rows)
    assert col(CFG, b, "bullSweep") == [0, 0]
    assert col(CFG, b, "bearSweep") == [0, 0]


def test_prev_bar_doji_gives_no_reversal():
    # Doji previous candle (close == open): neither reversal, even with
    # otherwise-valid bull geometry.
    rows = [
        (101, 103, 100, 101),  # doji: close == open
        (101, 105, 99, 104),   # same bull geometry as REV_BULL_ROWS
    ]
    b = bars(rows)
    assert col(CFG, b, "bullSweep") == [0, 0]
    assert col(CFG, b, "bearSweep") == [0, 0]


def test_prev_bar_reversal_yields_to_a_more_extreme_stored_level():
    # A stored low pivot (90, born bar 2) is more extreme than the
    # previous-candle level (91, from bearish bar 3) and is also crossed and
    # reclaimed this bar: the stored level wins the "most extreme" contest.
    rows = [
        (100, 101, 99, 100.5),
        (95, 96, 90, 95.5),    # pivot low at bar 1
        (95, 95.5, 94, 95),    # confirms the pivot; level (90) born here
        (93, 94, 91, 92),      # bearish: candle i-1 for bar 4's bull reversal
        (93, 97, 85, 96),      # crosses both the stored level and prev low
    ]
    b = bars(rows)
    assert col(CFG, b, "bullSweep")[4] == 1
    assert col(CFG, b, "bearSweep")[4] == 0
    assert col(CFG, b, "sweptLevel")[4] == 90.0


def test_prev_bar_always_flags_even_under_gate():
    cfg = replace(CFG, min_score=100.0, min_range_atr=1000.0)
    b = bars(REV_BULL_ROWS)
    assert col(cfg, b, "bullSweep") == [0, 1]
    assert col(cfg, b, "score")[1] < 100.0


def test_prev_bar_toggle_off_no_flag():
    cfg = replace(CFG, use_prev_bar=False)
    b = bars(REV_BULL_ROWS)
    assert col(cfg, b, "bullSweep") == [0, 0]
    assert col(cfg, b, "bullReversal") == [0, 0]


def test_reversal_outputs_mark_only_reversal_bars():
    assert col(CFG, bars(REV_BULL_ROWS), "bullReversal") == [0, 1]
    assert col(CFG, bars(REV_BULL_ROWS), "bearReversal") == [0, 0]
    assert col(CFG, bars(REV_BEAR_ROWS), "bearReversal") == [0, 1]
    assert col(CFG, bars(REV_BEAR_ROWS), "bullReversal") == [0, 0]


def test_stored_level_win_still_marks_the_reversal():
    # The more extreme stored level wins the swept level, but the bar is
    # still a previous-candle reversal.
    rows = [
        (100, 101, 99, 100.5),
        (95, 96, 90, 95.5),
        (95, 95.5, 94, 95),
        (93, 94, 91, 92),
        (93, 97, 85, 96),
    ]
    assert col(CFG, bars(rows), "bullReversal")[4] == 1


def test_prev_bar_reversal_beats_normal_opposite_flag():
    # Bar 1 is a pivot high (110), born as a stored level at bar 2. Bar 4
    # crosses that stored level (a normal, gated bear candidate that would
    # flag on its own) while ALSO satisfying a bull reversal against bearish
    # bar 3: the reversal must win the side resolution regardless.
    rows = [
        (100, 100.5, 99, 99.5),
        (105, 110, 104, 106),   # pivot high at bar 1 (highs[0]<110, highs[2]<110)
        (105, 106, 104, 105),   # confirms the pivot; level (110) born here
        (103, 104, 100, 101),   # bearish: candle i-1 for bar 4's bull reversal
        (105, 112, 95, 107),    # crosses stored 110 AND satisfies bull reversal
    ]
    b = bars(rows)
    assert col(CFG, b, "bullSweep")[4] == 1
    assert col(CFG, b, "bearSweep")[4] == 0
    assert col(CFG, b, "sweptLevel")[4] == 100.0  # the prev-candle (bar 3) low
    # The normal bear candidate (stored level 110) would have passed the
    # gate on its own, proving the bull side won on reversal precedence, not
    # by default.
    atr_prev = atr_series(b, CFG.atr_len)[3]
    s = sweep_score(CFG, True, 105, 112, 95, 107, atr_prev, None)
    assert s >= CFG.min_score


def test_score_range_zero_is_zero():
    assert sweep_score(CFG, True, 1.0, 1.0, 1.0, 1.0, 1.0, None) == 0.0


def test_score_volume_weights_rescale():
    cfg = replace(CFG, use_volume=True)
    # Full wick, close and range credit, no volume reading: 0.3 + 0.15 + 0.3.
    assert sweep_score(cfg, True, 101, 106, 100.5, 101, 1.0, None) == pytest.approx(75.0)
    assert sweep_score(cfg, True, 101, 106, 100.5, 101, 1.0, 4.0) == pytest.approx(100.0)


def test_parse_defaults_and_extend():
    d = parse_sweep_config(None, None)
    assert d == SweepConfig()
    assert (d.pivot_left, d.pivot_right, d.level_max_age, d.min_score) == (5, 5, 150, 70.0)
    assert d.use_prev_day is True and d.use_volume is False and d.use_prev_bar is True and d.tz == "UTC"
    cfg = parse_sweep_config(
        [2, 3, 50, 40, 10, 1.2, 30, 1.5, 60, 4],
        {"usePrevDay": False, "useVolume": True, "usePrevBar": False, "tz": "Europe/London"},
    )
    assert cfg == SweepConfig(2, 3, 50, 40.0, 10, 1.2, 30, 1.5, 60.0, 4, False, True, False, "Europe/London")
    bad = parse_sweep_config(["x", 0, "y", 0, None, -2, 0, 0, -5, 0], {"tz": "Not/AZone"})
    assert bad == SweepConfig()


def test_warmup():
    assert sweep_warmup(SweepConfig(), "bearSweep") == 163
    assert sweep_warmup(replace(SweepConfig(), use_volume=True, vol_len=200), "score") == 201
    assert sweep_warmup(SweepConfig(), "bogus") == 0
    assert sweep_warmup(SweepConfig(), "bullReversal") == 1
    assert set(SWEEP_OUTPUTS) == {
        "bearSweep", "bullSweep", "bearConfirmed", "bullConfirmed", "score", "sweptLevel", "barsSince",
        "bearReversal", "bullReversal",
    }


def test_registry_and_alert_spec():
    from auto_trader.indicators.alert_specs import ALERT_SPECS, EVENT, LEVEL, PRICE
    from auto_trader.indicators.registry import SERIES_INDICATORS

    spec = SERIES_INDICATORS["SWEEP"]
    cfg = spec.parse_config([], {"tz": "UTC"})
    assert spec.outputs(cfg) == SWEEP_OUTPUTS
    assert spec.timeframe(cfg) is None
    alert = ALERT_SPECS["SWEEP"]
    outs = alert.outputs(cfg)
    assert outs["bearSweep"] == EVENT and outs["bullConfirmed"] == EVENT
    assert outs["sweptLevel"] == PRICE and outs["score"] == LEVEL and outs["barsSince"] == LEVEL
    assert outs["bearReversal"] == EVENT and outs["bullReversal"] == EVENT
    assert alert.label(cfg, "bearSweep") == "Stop hunt bear sweep"
    assert alert.heavy and alert.sparse
    assert alert.needs_volume(cfg) is False
    assert alert.needs_volume(spec.parse_config([], {"useVolume": True})) is True

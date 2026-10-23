from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.core.screen_eval import (
    ScreenSpecError, bars_needed, closed_bars, compile_screen, judge,
)
from auto_trader.strategy.expr.warmup import warmup_bars

T0 = datetime(2026, 1, 5, tzinfo=timezone.utc)  # a Monday


def _bars(closes, step_s=3600):
    return [Candle(time=T0 + timedelta(seconds=step_s * k), open=c, high=c + 1, low=c - 1, close=c, volume=1.0)
            for k, c in enumerate(closes)]


def test_match_on_last_bar():
    cs = compile_screen("candle.close > 10", [])
    j = judge(cs, _bars([5, 5, 11]), "HOUR")
    assert j.matched and j.skip_reason is None
    assert j.bar_time_ms == int((T0 + timedelta(hours=2)).timestamp() * 1000)


def test_no_match_when_only_earlier_bar_matched():
    cs = compile_screen("candle.close > 10", [])
    assert not judge(cs, _bars([11, 5]), "HOUR").matched


def test_count_window_catches_recent_fire():
    cs = compile_screen("count(candle.close > 10, 3) >= 1", [])
    assert judge(cs, _bars([5, 5, 5, 11, 5, 5]), "HOUR").matched


def test_short_history_is_skipped():
    cs = compile_screen("candle.close > EMA(20)", [])
    j = judge(cs, _bars([1.0] * 10), "HOUR")
    assert not j.matched and j.skip_reason == "not enough history"


def test_forming_bar_is_dropped():
    bars = _bars([1, 2, 3])  # last bar opens at T0+2h
    now = (T0 + timedelta(hours=2, minutes=30)).timestamp()
    assert [b.close for b in closed_bars(bars, 3600, now)] == [1, 2]
    now_closed = (T0 + timedelta(hours=3)).timestamp()
    assert len(closed_bars(bars, 3600, now_closed)) == 3


def test_columns_evaluated_on_matched_bar():
    cs = compile_screen("candle.close > 0", [{"name": "Dist", "expression": "abs(candle.close - 10)"}])
    j = judge(cs, _bars([3, 7]), "HOUR")
    assert j.columns == {"Dist": 3.0}


def test_column_undefined_is_none():
    cs = compile_screen("candle.close > 0", [{"name": "Ratio", "expression": "candle.close / (candle.close - candle.close)"}])
    j = judge(cs, _bars([3, 7]), "HOUR")
    assert j.matched and j.columns["Ratio"] is None


def test_value_expression_rejected():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("RSI(14)", [])
    assert e.value.field == "expression"


def test_bad_column_names_its_index():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("candle.close > 0", [{"name": "ok", "expression": "1"}, {"name": "bad", "expression": "FOO(1)"}])
    assert (e.value.field, e.value.index) == ("columns", 1)


def test_bars_needed_covers_warmup():
    cs = compile_screen("candle.close > EMA(200)", [{"name": "R", "expression": "RSI(14)"}])
    assert bars_needed(cs) >= 201


def test_bars_needed_gives_recursive_indicators_room_to_converge():
    # EMA(200) on only 221 bars sat visibly off the chart's value.
    assert bars_needed(compile_screen("candle.close > EMA(200)", [])) >= 1000
    assert bars_needed(compile_screen("RSI(14) < 30", [])) == 300
    assert bars_needed(compile_screen("candle.close > 0", [])) == 300


def test_history_between_warmup_and_bars_needed_is_still_judged():
    cs = compile_screen("candle.close > EMA(20)", [])
    n = cs.warmup + 1
    assert n < bars_needed(cs)
    j = judge(cs, _bars([1.0] * (n - 1) + [5.0]), "HOUR")
    assert j.skip_reason is None and j.matched


RSI_PANE = {"RSI": {"type": "RSI", "calcParams": [14], "extendData": {}}}
PINNED_SLOPE = {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                          "extendData": {"slopePeriod": 3, "mtf": {"timeframe": "1H"}}}}


def test_instance_ref_in_condition_compiles_and_judges():
    cs = compile_screen("RSI.value < 101", [], RSI_PANE)
    assert "RSI" in cs.instances
    j = judge(cs, _bars([float(x % 7 + 10) for x in range(80)]), "HOUR")
    assert j.skip_reason is None and j.matched


def test_instance_ref_in_column():
    cs = compile_screen("candle.close > 0", [{"name": "R", "expression": "RSI.value"}], RSI_PANE)
    j = judge(cs, _bars([float(x % 7 + 10) for x in range(80)]), "HOUR")
    assert j.matched and j.columns["R"] is not None


def test_divergence_warmup_sizes_the_fetch():
    cs = compile_screen("count(RSI.bullDiv > 0, 5) >= 1", [], RSI_PANE)
    assert cs.warmup >= 14 + 60 + 5 + 5
    assert bars_needed(cs) == min(2000, cs.warmup * 5)


def test_unknown_instance_uses_screen_wording():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("RSI.value < 30", [])
    assert e.value.err.code == "unknown_indicator_ref"
    assert e.value.err.message == "RSI is not one of this screen's indicators. Add it to a chart and pick it from there."


def test_unknown_instance_in_column_names_the_column():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("candle.close > 0", [{"name": "x", "expression": "ATR.14"}], RSI_PANE)
    assert (e.value.field, e.value.index) == ("columns", 0)
    assert "ATR is not one of this screen's indicators" in e.value.err.message


SLOPE_W = {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                     "extendData": {"slopePeriod": 3, "mtf": {"timeframe": "W"}}}}


def test_coarser_pin_compiles_with_one_need():
    cs = compile_screen("EMA(5)@W > 0", [], resolution="DAY")
    assert [(n.tf, n.res) for n in cs.htf] == [("W", "WEEK")]
    assert cs.htf[0].need == warmup_bars(compile_screen("EMA(5) > 0", []).row) + 1


def test_pinned_term_costs_no_base_bars():
    assert bars_needed(compile_screen("EMA(50)@W > 0", [], resolution="DAY")) == 300


def test_same_timeframe_pin_accepted():
    cs = compile_screen("EMA(5)@D > 0", [], resolution="DAY")
    assert cs.htf[0].res == "DAY"


def test_finer_pin_refused_with_the_token_span():
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("candle.close > EMA(9)@4H", [], resolution="DAY")
    e = ei.value.err
    assert e.code == "screen_tf_lower"
    assert "@4H is a lower timeframe than this screen's 1D" in e.message
    assert "Run the screen on 4H" in e.message
    assert (e.start, e.end) == (15, 24)  # the pinned operand EMA(9)@4H


def test_finer_pin_in_column_names_its_index():
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("candle.close > 0", [{"name": "x", "expression": "EMA(9)@1H"}], resolution="DAY")
    assert ei.value.field == "columns" and ei.value.index == 0


def test_pane_pin_above_base_accepted_below_refused():
    cs = compile_screen("SLOPE.5 > 0", [], SLOPE_W, resolution="DAY")
    assert cs.htf[0].res == "WEEK"
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("SLOPE.5 > 0", [], PINNED_SLOPE, resolution="DAY")
    assert ei.value.err.code == "screen_tf_lower"
    assert "SLOPE is pinned to 1H in its settings, lower than this screen's 1D" in ei.value.err.message


def test_unresolvable_pane_pin_is_422_not_500():
    bad = {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                     "extendData": {"slopePeriod": 3, "mtf": {"timeframe": "SECOND_5"}}}}
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("SLOPE.5 > 0", [], bad, resolution="DAY")
    assert ei.value.err.code == "unsupported_timeframe"


def test_tf_cap_counts_canonical():
    compile_screen("EMA(5)@1H > 0 and EMA(5)@HOUR > 0 and EMA(5)@4H > 0 and EMA(5)@W > 0", [],
                   resolution="MINUTE_15")
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("EMA(5)@1H > 0 and EMA(5)@4H > 0 and EMA(5)@D > 0", [{"name": "w", "expression": "EMA(5)@W"}],
                       resolution="MINUTE_15")
    assert ei.value.err.code == "screen_tf_too_many"
    # The column that adds the fourth timeframe is the one blamed.
    assert (ei.value.field, ei.value.index) == ("columns", 0)
    assert (ei.value.err.start, ei.value.err.end) == (0, len("EMA(5)@W"))


def test_tf_cap_blames_the_condition_when_it_alone_overflows():
    with pytest.raises(ScreenSpecError) as ei:
        compile_screen("EMA(5)@1H > 0 and EMA(5)@4H > 0 and EMA(5)@D > 0 and EMA(5)@W > 0",
                       [{"name": "w", "expression": "EMA(5)@W"}], resolution="MINUTE_15")
    assert (ei.value.field, ei.value.index, ei.value.err.code) == ("expression", 0, "screen_tf_too_many")


def test_judge_reads_the_pinned_series():
    # Daily bars from a Monday; weekly bars closing 100 and 200.
    bars = _bars(list(range(1, 11)), step_s=86400)
    monday = bars[0].time
    weeks = [Candle(time=monday + timedelta(weeks=k), open=v, high=v, low=v, close=v, volume=1)
             for k, v in enumerate([100, 200])]
    cs = compile_screen("candle.close@W > 150", [{"name": "w", "expression": "candle.close@W"}], resolution="DAY")
    # Day 10 (the second Wednesday) reads the week that closed before it: 100.
    assert not judge(cs, bars, "DAY", {"WEEK": weeks}).matched
    # Day 8 (the second Monday) opens as week 1 closes and still reads it.
    assert not judge(cs, bars[:8], "DAY", {"WEEK": weeks}).matched
    # Day 15 (the third Monday): week 2 has closed.
    j = judge(cs, _bars(list(range(1, 16)), step_s=86400), "DAY", {"WEEK": weeks})
    assert j.matched and j.columns == {"w": 200.0}


def _div_closes():
    # A sharp drop to a first low, a rebound, then a slow drop to a lower low
    # with a higher RSI: one bullish divergence, pivots at bars 84 and 112,
    # confirmed at 117 (pivot + lookbackRight 5). 120 bars in all.
    closes = [100 + (i % 7) * 0.3 for i in range(80)]
    p = closes[-1]
    for step, n in ((-3, 5), (2, 8), (-1, 20), (1.5, 7)):
        for _ in range(n):
            p += step
            closes.append(p)
    return closes


_RSI_PANE = {"RSI": {"type": "RSI", "calcParams": [14], "extendData": {"divergence": {"on": True}}}}


def test_a_match_carries_its_latest_divergence_pivot():
    bars = _bars(_div_closes(), step_s=86400)
    cs = compile_screen("count(RSI.bullDiv > 0, 5) >= 1", [], _RSI_PANE, resolution="DAY")
    j = judge(cs, bars, "DAY")
    assert j.matched
    assert j.divergences == [{"ref": "RSI.bullDiv", "pivot": int(bars[112].time.timestamp() * 1000), "barsAgo": 7}]


def test_divergence_pivot_of_a_pinned_ref_counts_pinned_bars():
    days = _bars(_div_closes(), step_s=86400)
    hours = [Candle(time=days[-1].time + timedelta(days=1, hours=k), open=1, high=2, low=0, close=1, volume=1)
             for k in range(3)]
    cs = compile_screen("RSI.bullDiv@D >= 0", [], _RSI_PANE, resolution="HOUR")
    j = judge(cs, hours, "HOUR", {"DAY": days})
    assert j.matched
    assert j.divergences == [{"ref": "RSI.bullDiv@D", "pivot": int(days[112].time.timestamp() * 1000), "barsAgo": 7}]


def test_no_divergence_ref_means_no_pivots():
    cs = compile_screen("candle.close > 0", [], resolution="DAY")
    assert judge(cs, _bars([1, 2, 3], step_s=86400), "DAY").divergences == []


def test_a_forming_ref_reports_the_tentative_pivot():
    from tests.test_rsi_divergence import _close_bars, _forming_closes
    bars = _close_bars(_forming_closes())
    cs = compile_screen("RSI.bullDivForming > 0", [], _RSI_PANE, resolution="HOUR")
    j = judge(cs, bars, "HOUR")
    last = len(bars) - 1
    assert j.matched
    assert j.divergences == [{"ref": "RSI.bullDivForming", "pivot": int(bars[last - 2].time.timestamp() * 1000),
                              "barsAgo": 2}]

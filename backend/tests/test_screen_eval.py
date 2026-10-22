from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.core.screen_eval import (
    ScreenSpecError, bars_needed, closed_bars, compile_screen, judge,
)
from auto_trader.strategy.expr.errors import ExprError

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


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


def test_tf_pin_rejected():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("candle.close > EMA(9)@D", [])
    assert e.value.err.code == "screen_tf_unsupported"


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


def test_pinned_pane_refused_with_its_own_message():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("SLOPE.5 > 0", [], PINNED_SLOPE)
    assert e.value.err.code == "screen_tf_unsupported"
    assert e.value.err.message == (
        "SLOPE is pinned to 1H in its settings. Screens run on one timeframe, so unpin it on the chart.")


def test_text_tf_pin_keeps_its_message():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("candle.close > EMA(9)@D", [], RSI_PANE)
    assert e.value.err.message == "Timeframe pins like @D are not available in screens yet."

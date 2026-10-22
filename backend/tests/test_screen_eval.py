from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.core.screen_eval import (
    ScreenSpecError, bars_needed, closed_bars, compile_screen, judge,
)

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

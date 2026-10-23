from datetime import datetime, timedelta, timezone

import pytest

from auto_trader.core.models import Candle
from auto_trader.strategy.expr.lines import (
    LineSpecError, PickedLine, line_series, parse_lines,
)

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)
H = 3600_000


def _candles(n, start_k=0):
    return [Candle(time=BASE + timedelta(hours=start_k + k), open=1, high=1, low=1, close=1, volume=1.0)
            for k in range(n)]


def _ms(k):
    return int((BASE + timedelta(hours=k)).timestamp() * 1000)


def _line(**kw):
    d = dict(epic="US100", broker="capital", timeframe="HOUR", t1=_ms(2), p1=100.0,
             t2=_ms(5), p2=103.0, slope=1.0, tRef=_ms(8), pRef=106.0)
    d.update(kw)
    return PickedLine(**d)


def test_values_start_at_t2_and_extend_right():
    vals = line_series(_line(), _candles(10))
    assert vals[:5] == [None] * 5
    assert vals[5:] == [103.0, 104.0, 105.0, 106.0, 107.0]


def test_t2_bisect_finds_first_bar_at_or_after_t2():
    # t2 half a bar late (a broker's shifted bar times): anchors on bar 6
    vals = line_series(_line(t2=_ms(5) + H // 2), _candles(10))
    assert vals[5] is None and vals[6] == 103.0


def test_falls_back_to_tref_when_t2_before_candles():
    # candles start at k=7: t2 (k=5) is before them, tRef (k=8) is inside
    vals = line_series(_line(), _candles(4, start_k=7))
    assert vals == [105.0, 106.0, 107.0, 108.0]


def test_range_ending_before_t2_is_all_none():
    assert line_series(_line(), _candles(4)) == [None] * 4


def test_none_line_is_all_none():
    assert line_series(None, _candles(3)) == [None] * 3


def test_parse_lines_round_trip_and_caps():
    raw = {"L1": {"epic": "US100", "broker": "capital", "timeframe": "HOUR", "t1": _ms(2), "p1": 1,
                  "t2": _ms(5), "p2": 2, "slope": 0.5, "tRef": _ms(8), "pRef": 3}}
    assert parse_lines(raw)["L1"].p2 == 2.0
    with pytest.raises(LineSpecError):
        parse_lines({"X1": raw["L1"]})
    with pytest.raises(LineSpecError):
        parse_lines({"L1": {**raw["L1"], "t2": _ms(1)}})          # t2 <= t1
    with pytest.raises(LineSpecError):
        parse_lines({"L1": {**raw["L1"], "slope": float("nan")}})
    with pytest.raises(LineSpecError):
        parse_lines({"L1": {**raw["L1"], "timeframe": "SECOND"}})
    with pytest.raises(LineSpecError):
        parse_lines({f"L{i}": raw["L1"] for i in range(17)})


# --- Task 3: resolving lines into instances + evaluating them -----------------

from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.lines import LineInstance, line_instances, line_key
from auto_trader.strategy.expr.parser import parse


def test_other_symbol_line_is_all_none():
    inst = line_instances({"L1": _line()}, epic="GOLD", broker="capital", resolution="HOUR")
    assert inst[line_key("L1")].active is False
    row = compile_row(parse("candle.close < L1"), _candles(10), "HOUR", {}, inst)
    assert [row.evaluate(i, None) for i in range(10)] == [False] * 10


def test_same_symbol_line_evaluates():
    inst = line_instances({"L1": _line()}, epic="US100", broker="capital", resolution="HOUR")
    row = compile_row(parse("candle.close < L1"), _candles(10), "HOUR", {}, inst)
    assert [row.evaluate(i, None) for i in range(10)] == [False] * 5 + [True] * 5


def test_rule_coarser_than_line_refused():
    with pytest.raises(LineSpecError) as e:
        line_instances({"L1": _line(timeframe="MINUTE_15")}, epic="US100", broker="capital", resolution="HOUR")
    assert e.value.code == "line_tf_finer"


def test_coarser_line_is_aligned_from_htf_candles():
    line = _line(timeframe="HOUR_4", t1=_ms(0), t2=_ms(4), p2=10.0, slope=1.0, tRef=_ms(8), pRef=11.0)
    inst = line_instances({"L1": line}, epic="US100", broker="capital", resolution="HOUR")
    h4 = [Candle(time=BASE + timedelta(hours=4 * k), open=1, high=1, low=1, close=1, volume=1.0) for k in range(4)]
    from auto_trader.strategy.expr.evaluate import series_of
    from auto_trader.strategy.expr import nodes as N
    vals = series_of(N.LineRef("L1", 0, 2), _candles(16), "HOUR", {"HOUR_4": h4}, inst)
    assert vals[0] is None and vals[-1] is not None


def test_same_tf_line_is_not_an_htf_need():
    # Ruling 2: a line picked on the rule's OWN resolution evaluates straight off
    # the base candles (evaluate.py's LineRef branch), so it must never show up
    # as something the HTF layer has to fetch.
    from auto_trader.api.htf_source import htf_needs

    inst = line_instances({"L1": _line(timeframe="HOUR")}, epic="US100", broker="capital", resolution="HOUR")
    needs = htf_needs([parse("candle.close < L1")], inst, resolution="HOUR")
    assert needs == []

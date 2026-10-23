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

from datetime import datetime, timezone

import pytest

from auto_trader.core.alert_kinds import INDICATOR, KINDS, LINE, PRICE_LEVEL, kind_of
from auto_trader.core.models import Candle
from auto_trader.indicators.trendlines import TL_DEFAULT_PARAMS

STREAMS = lambda: True  # noqa: E731
POLLS = lambda: False  # noqa: E731


def ind_params(**kw):
    p = {
        "indicator": "MA", "calcParams": [50], "config": {"maType": "ema"},
        "line": "value", "timeframe": "HOUR", "target": "price", "value": None,
        "condition": "crossing_up", "trigger": "every", "evalOn": "close",
        "link": {"scope": "tab.t1.cell.c2", "instanceId": "EMA"},
    }
    p.update(kw)
    return p


def test_registry_has_both_kinds():
    assert set(KINDS) == {"price_level", "indicator", "line"}
    assert kind_of({"kind": "nope"}) is None
    assert kind_of({}) is PRICE_LEVEL


def test_price_level_resolution_and_resolve():
    p = {"level": 100.0, "condition": "crossing", "trigger": "every"}
    PRICE_LEVEL.validate(p, STREAMS)
    assert PRICE_LEVEL.bar_resolution(p) == "MINUTE"
    assert PRICE_LEVEL.resolve(p, 101.0, None) == (101.0, 100.0)
    assert PRICE_LEVEL.label(p) is None


def test_indicator_validate_canonicalizes():
    p = ind_params(timeframe="1H")
    INDICATOR.validate(p, STREAMS)
    assert p["timeframe"] == "HOUR"
    assert p["config"] == {"maType": "ema", "source": "close"}


@pytest.mark.parametrize("override,msg", [
    ({"timeframe": "HOUR_2"}, "timeframe"),
    ({"timeframe": "SECOND_5"}, "timeframe"),
    ({"evalOn": "sometimes"}, "evalOn"),
    ({"target": "value", "value": None}, "value"),
    ({"target": "value", "value": "70"}, "value"),
    ({"condition": "near"}, "condition"),
    ({"link": {"scope": 3}}, "link"),
])
def test_indicator_validate_rejects(override, msg):
    with pytest.raises(ValueError, match=msg):
        INDICATOR.validate(ind_params(**override), STREAMS)


def test_volume_weighted_intrabar_refused_on_quote_only():
    p = ind_params(config={"maType": "vwma"}, evalOn="intrabar")
    with pytest.raises(ValueError, match="intrabar"):
        INDICATOR.validate(p, POLLS)
    INDICATOR.validate(ind_params(config={"maType": "vwma"}, evalOn="intrabar"), STREAMS)


def test_indicator_resolve_targets():
    price = ind_params()
    assert INDICATOR.resolve(price, 101.0, {"value": 100.0}) == (101.0, 100.0)
    val = ind_params(indicator="RSI", calcParams=[14], config={}, target="value", value=70)
    assert INDICATOR.resolve(val, 101.0, {"value": 72.0}) == (72.0, 70)
    assert INDICATOR.resolve(price, 101.0, {"value": None}) is None


def test_indicator_label_and_sig():
    p = ind_params()
    INDICATOR.validate(p, STREAMS)
    assert INDICATOR.label(p) == "EMA 50 (1H)"
    q = dict(p, calcParams=[100])
    assert INDICATOR.sig(p) != INDICATOR.sig(q)


def bar(close):
    return Candle(datetime(2026, 1, 1, tzinfo=timezone.utc), close, close, close, close, 1.0)


def line_params(**kw):
    p = {"timeframe": "1H", "evalOn": "close", "condition": "crossing", "trigger": "every",
         "tRef": 36_000_000, "pRef": 100.0, "slope": 0.5,
         "anchors": {"t1": 7_200_000, "p1": 96.0, "t2": 21_600_000, "p2": 98.0},
         "link": {"scope": "s", "instanceId": "TRENDLINES", "lineKey": "7200000:21600000"}}
    p.update(kw)
    return p


def test_line_validate_and_resolve():
    p = line_params()
    LINE.validate(p, STREAMS)
    assert p["timeframe"] == "HOUR" and isinstance(p["tRef"], int)
    assert LINE.indicator_key(p).indicator == "LINE"
    assert LINE.resolve(p, 101.0, {"value": 100.5}) == (101.0, 100.5)
    assert LINE.resolve(p, 101.0, {"value": None}) is None
    assert LINE.label(p) == "Trendline (1H)"
    LINE.validate(line_params(link=None), STREAMS)


@pytest.mark.parametrize("override,msg", [
    ({"tRef": "x"}, "tRef"), ({"slope": float("nan")}, "slope"), ({"anchors": {"t1": 1}}, "anchors"),
    ({"timeframe": "HOUR_2"}, "timeframe"), ({"evalOn": "x"}, "evalOn"),
    ({"link": {"scope": "s", "instanceId": "T"}}, "lineKey"),
])
def test_line_validate_rejects(override, msg):
    with pytest.raises(ValueError, match=msg):
        LINE.validate(line_params(**override), STREAMS)


def test_line_sig_ignores_the_rolling_reference():
    p = line_params()
    LINE.validate(p, STREAMS)
    assert LINE.sig(p) == LINE.sig(dict(p, tRef=p["tRef"] + 3_600_000, pRef=101.0))
    assert LINE.sig(p) != LINE.sig(dict(p, condition="greater"))


def tl_params(**kw):
    return ind_params(indicator="TRENDLINES", calcParams=list(TL_DEFAULT_PARAMS), config={},
                      link={"scope": "s", "instanceId": "TRENDLINES"}, **kw)


def test_trendlines_close_pair_uses_the_held_line():
    p = tl_params()
    INDICATOR.validate(p, STREAMS)
    # Old line at 100 (prev bar) / 100.2 (this bar); the new nearest is 99.
    vals = {"value": 99.0, "held": 100.2, "slope": -0.1, "a1": 3.0, "a2": 4.0}
    pvals = {"value": 100.0, "held": 99.9, "slope": 0.2, "a1": 1.0, "a2": 2.0}
    cur, prev = INDICATOR.resolve_close(p, bar(99.5), bar(99.0), vals, pvals)
    assert cur == (99.5, 100.2) and prev == (99.0, 100.0)  # same line both bars: no cross
    assert INDICATOR.level_sig(p, vals) == (3.0, 4.0)
    assert INDICATOR.resolve(p, 99.5, {"value": None}) is None


def test_default_resolve_close_and_level_sig():
    p = ind_params()
    INDICATOR.validate(p, STREAMS)
    cur, prev = INDICATOR.resolve_close(p, bar(101.0), bar(99.0), {"value": 100.0}, {"value": 100.0})
    assert cur == (101.0, 100.0) and prev == (99.0, 100.0)
    assert INDICATOR.level_sig(p, {"value": 1.0}) is None
    assert INDICATOR.resolve_close(p, None, None, None, None) == (None, None)


def test_trendlines_refuses_value_target():
    with pytest.raises(ValueError, match="target"):
        INDICATOR.validate(tl_params(target="value", value=1.0), STREAMS)


def test_trendlines_refuses_one_minute():
    with pytest.raises(ValueError, match="5m or longer"):
        INDICATOR.validate(tl_params(timeframe="MINUTE"), STREAMS)
    INDICATOR.validate(tl_params(timeframe="MINUTE_5"), STREAMS)


def test_no_line_drawn_means_no_level():
    # Sparse TRENDLINES: a ready series may carry None (or a non-finite)
    # level. Every resolve path answers None rather than raising.
    p = tl_params()
    INDICATOR.validate(p, STREAMS)
    none = {"value": None, "held": None, "slope": None, "a1": None, "a2": None}
    assert INDICATOR.resolve_close(p, bar(99.5), bar(99.0), none, none) == (None, None)
    nan = dict(none, value=float("nan"), held=float("inf"))
    assert INDICATOR.resolve_close(p, bar(99.5), bar(99.0), nan, nan) == (None, None)
    assert INDICATOR.resolve(p, 99.5, {"value": float("nan")}) is None
    assert INDICATOR.level_sig(p, none) == (None, None)
    q = line_params()
    LINE.validate(q, STREAMS)
    assert LINE.resolve(q, 101.0, {"value": float("inf")}) is None
    assert LINE.resolve(q, 101.0, None) is None
    assert LINE.resolve_close(q, bar(101.0), bar(99.0), {"value": None}, {"value": None}) == (None, None)

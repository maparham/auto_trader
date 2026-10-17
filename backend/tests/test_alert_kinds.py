import json
from datetime import datetime, timezone

import pytest

from auto_trader.core.alert_kinds import INDICATOR, KINDS, LINE, PRICE_LEVEL, kind_of, upgrade_params
from auto_trader.core.models import Candle
from auto_trader.indicators.alert_series import config_json
from auto_trader.indicators.registry import SERIES_INDICATORS
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
    return upgrade_params(p)


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
    assert (p["type"], p["config"]["ma_type"], p["config"]["source"]) == ("MA", "ema", "close")


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
    q = dict(p, config={**p["config"], "length": 100})
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


def _new(type_="RSI", calc=(14,), ext=None, output="value", **kw):
    p = {
        "instance": {"type": type_, "calcParams": list(calc), "extendData": ext or {}},
        "output": output, "timeframe": "HOUR", "target": "value", "value": 70.0,
        "evalOn": "close", "condition": "crossing", "trigger": "once", "link": None,
    }
    p.update(kw)
    return p


def test_instance_is_parsed_and_dropped():
    p = _new(ext={"source": "hl2", "hideLegendValue": True})
    INDICATOR.validate(p, lambda: True)
    assert "instance" not in p and p["type"] == "RSI"
    cfg = SERIES_INDICATORS["RSI"].parse_config([14], {"source": "hl2"})
    assert p["config"] == json.loads(config_json(cfg))


def test_output_must_exist():
    with pytest.raises(ValueError, match="params.output"):
        INDICATOR.validate(_new("MA", (20,), {}, "smoothingMa", target="price"), lambda: True)


def test_unregistered_type_is_refused():
    with pytest.raises(ValueError, match="not alertable"):
        INDICATOR.validate(_new("BOLL", (20,), {}, "up"), lambda: True)


def test_pin_sets_the_alert_timeframe():
    p = _new("MA", (20,), {"mtf": {"timeframe": "HOUR_4"}}, "ma", target="price")
    INDICATOR.validate(p, lambda: True)
    assert p["timeframe"] == "HOUR_4"


def test_event_output_is_stored_as_a_cross_up():
    p = _new(output="bullDiv", condition="greater", value=3.0)
    INDICATOR.validate(p, lambda: True)
    assert (p["target"], p["value"], p["condition"], p["evalOn"]) == ("value", 0.5, "crossing_up", "close")
    with pytest.raises(ValueError, match="intrabar"):
        INDICATOR.validate(_new(output="bullDiv", evalOn="intrabar"), lambda: True)


def test_price_target_needs_a_price_scale_output():
    with pytest.raises(ValueError, match="target"):
        INDICATOR.validate(_new(target="price"), lambda: True)
    with pytest.raises(ValueError, match="target"):
        INDICATOR.validate(_new("TRENDLINES", (), {}, "tl_nearest", target="value"), lambda: True)


def test_volume_weighted_intrabar_needs_streaming():
    p = _new("MA", (20,), {"maType": "vwma"}, "ma", target="price", evalOn="intrabar")
    with pytest.raises(ValueError, match="live volume"):
        INDICATOR.validate(p, lambda: False)


def test_trendlines_instance_refuses_one_minute():
    with pytest.raises(ValueError, match="5m"):
        INDICATOR.validate(_new("TRENDLINES", (), {}, "tl_nearest", target="price", timeframe="MINUTE"), lambda: True)


def test_sig_ignores_spelling_and_unknown_keys():
    a, b = _new(calc=(14,), ext={"x": 1}), _new(calc=(14.0,))
    INDICATOR.validate(a, lambda: True)
    INDICATOR.validate(b, lambda: True)
    assert INDICATOR.sig(a) == INDICATOR.sig(b)


def test_stored_params_revalidate_without_instance():
    p = _new()
    INDICATOR.validate(p, lambda: True)
    again = dict(p)
    INDICATOR.validate(again, lambda: True)
    assert again == p


@pytest.mark.parametrize("old,type_,output", [
    ({"indicator": "MA", "calcParams": [20], "config": {"maType": "ema", "source": "hl2"}}, "MA", "ma"),
    ({"indicator": "RSI", "calcParams": [14], "config": {"source": "close"}}, "RSI", "value"),
    ({"indicator": "ATR", "calcParams": [14], "config": {"smoothing": "ema"}}, "ATR", "14"),
])
def test_upgrade_params(old, type_, output):
    common = {"line": "value", "timeframe": "HOUR", "target": "value", "value": 1.0, "evalOn": "close",
              "condition": "crossing", "trigger": "once", "link": {"scope": "s", "instanceId": "X"}}
    new = upgrade_params({**old, **common})
    assert new["type"] == type_ and new["output"] == output
    assert not {"indicator", "calcParams", "line"} & set(new)
    assert new["link"] == common["link"] and new["timeframe"] == "HOUR"
    assert upgrade_params(new) == new


def test_upgrade_unknown_legacy_indicator_is_a_value_error():
    with pytest.raises(ValueError, match="not alertable"):
        upgrade_params({"indicator": "BOLL", "calcParams": [20], "config": {}})


def test_step_level_close_cross_is_prev_close_vs_prev_value():
    from datetime import datetime, timezone
    from auto_trader.core.models import Candle
    p = _new("SR_LEVELS", (), {}, "support", target="price", value=None)
    INDICATOR.validate(p, lambda: True)
    t = datetime(2026, 1, 1, tzinfo=timezone.utc)
    before, last = Candle(t, 10, 10, 10, 10.0, 1), Candle(t, 9, 9, 9, 9.0, 1)
    cur, prev = INDICATOR.resolve_close(p, last, before, {"value": 9.5}, {"value": 8.0})
    assert cur == (9.0, 9.5) and prev == (10.0, 8.0)


@pytest.mark.parametrize("calc", [["x"], [None], 5, [float("nan")], [True]])
def test_upgrade_malformed_calc_params_is_a_value_error(calc):
    with pytest.raises(ValueError, match="params.calcParams"):
        upgrade_params({"indicator": "RSI", "calcParams": calc, "config": {}})


def test_upgrade_non_dict_config_is_a_value_error():
    with pytest.raises(ValueError, match="params.config"):
        upgrade_params({"indicator": "MA", "calcParams": [20], "config": ["sma"]})


def test_upgrade_atr_output_follows_the_parsed_length():
    new = upgrade_params({"indicator": "ATR", "calcParams": [14.7], "config": {}, "timeframe": "HOUR"})
    assert new["output"] == str(new["config"]["length"])


def test_refusal_for_flags_an_overlong_warmup():
    cfg = SERIES_INDICATORS["MA"].parse_config([3000], {})
    assert INDICATOR.refusal_for("MA", cfg, "HOUR") == "Alerts need a shorter length"
    short = SERIES_INDICATORS["MA"].parse_config([50], {})
    assert INDICATOR.refusal_for("MA", short, "HOUR") is None
    with pytest.raises(ValueError, match="shorter length"):
        INDICATOR.validate(ind_params(calcParams=[3000]), STREAMS)


def test_negative_ma_offset_is_refused():
    cfg = SERIES_INDICATORS["MA"].parse_config([20], {"offset": -3})
    assert INDICATOR.refusal_for("MA", cfg, "HOUR") == "Alerts need an offset of 0 or more"
    def with_offset(off):
        p = ind_params()
        p.pop("type"), p.pop("config")
        p["instance"] = {"type": "MA", "calcParams": [20], "extendData": {"offset": off}}
        return p
    with pytest.raises(ValueError, match="offset"):
        INDICATOR.validate(with_offset(-3), STREAMS)
    INDICATOR.validate(with_offset(3), STREAMS)

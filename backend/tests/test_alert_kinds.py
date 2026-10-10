import pytest

from auto_trader.core.alert_kinds import INDICATOR, KINDS, PRICE_LEVEL, kind_of

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
    assert set(KINDS) == {"price_level", "indicator"}
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

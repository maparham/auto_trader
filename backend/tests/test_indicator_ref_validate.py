import pytest

from auto_trader.indicators.registry import resolve_instances
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate

INSTANCES = resolve_instances({
    "SLOPE": {
        "type": "SLOPE", "calcParams": [9, 21],
        "extendData": {"showAccel": True, "slopePeriod": 3},
    },
    "SLOPE#p1n": {
        "type": "SLOPE", "calcParams": [50],
        "extendData": {"mtf": {"timeframe": "1H"}},
    },
})


def check(src, instances=INSTANCES):
    validate(parse(src), is_exit=False, instances=instances)


def test_a_valid_ref_passes():
    check("SLOPE.slope0 > 0.5")
    check("SLOPE.slope1 > 0.5")
    check("SLOPE.accel0 > 0")


def test_a_missing_instance_is_its_own_error():
    with pytest.raises(ExprError) as e:
        check("NOPE.slope0 > 0")
    assert e.value.code == "unknown_indicator_ref"
    assert "NOPE" in e.value.message


def test_no_instance_map_at_all_is_the_same_error():
    with pytest.raises(ExprError) as e:
        check("SLOPE.slope0 > 0", instances=None)
    assert e.value.code == "unknown_indicator_ref"


def test_an_output_beyond_the_configured_lengths_is_rejected():
    with pytest.raises(ExprError) as e:
        check("SLOPE.slope2 > 0")     # only two lengths configured
    assert e.value.code == "unknown_indicator_output"
    assert "slope0" in e.value.message   # lists what IS available


def test_accel_is_rejected_when_the_companion_is_off():
    with pytest.raises(ExprError) as e:
        check("SLOPE#p1n.accel0 > 0")   # showAccel not set
    assert e.value.code == "unknown_indicator_output"


def test_the_threshold_figure_keys_are_not_outputs():
    for key in ("thHi", "thLo"):
        with pytest.raises(ExprError) as e:
            check(f"SLOPE.{key} > 0")
        assert e.value.code == "unknown_indicator_output"


def test_a_bare_instance_name_asks_for_an_output():
    with pytest.raises(ExprError) as e:
        check("SLOPE > 0")
    assert e.value.code == "indicator_ref_needs_output"
    assert "SLOPE.slope0" in e.value.message


def test_pinning_an_already_pinned_pane_is_a_nested_pin():
    with pytest.raises(ExprError) as e:
        check("SLOPE#p1n.slope0 @4H > 0")
    assert e.value.code == "nested_tf"


def test_pinning_an_unpinned_pane_is_fine():
    check("SLOPE.slope0 @4H > 0")


def test_a_field_on_a_registered_call_still_reports_field_on_call():
    with pytest.raises(ExprError) as e:
        check("EMA(9).signal > 0")
    assert e.value.code == "field_on_call"

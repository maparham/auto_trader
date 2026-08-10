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
    check("SLOPE.9 > 0.5")
    check("SLOPE.21 > 0.5")
    check("SLOPE.accel9 > 0")


def test_a_missing_instance_is_its_own_error():
    with pytest.raises(ExprError) as e:
        check("NOPE.9 > 0")
    assert e.value.code == "unknown_indicator_ref"
    assert "NOPE" in e.value.message


def test_no_instance_map_at_all_is_the_same_error():
    with pytest.raises(ExprError) as e:
        check("SLOPE.9 > 0", instances=None)
    assert e.value.code == "unknown_indicator_ref"


def test_an_output_beyond_the_configured_lengths_is_rejected():
    with pytest.raises(ExprError) as e:
        check("SLOPE.13 > 0")     # 13 is not one of the configured lengths
    assert e.value.code == "unknown_indicator_output"
    assert "9" in e.value.message   # lists the lengths that ARE available


def test_accel_is_rejected_when_the_companion_is_off():
    with pytest.raises(ExprError) as e:
        check("SLOPE#p1n.accel50 > 0")   # showAccel not set
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
    assert "SLOPE.9" in e.value.message


def test_pinning_an_already_pinned_pane_is_a_nested_pin():
    with pytest.raises(ExprError) as e:
        check("SLOPE#p1n.50 @4H > 0")
    assert e.value.code == "nested_tf"


def test_pinning_an_unpinned_pane_is_fine():
    check("SLOPE.9 @4H > 0")


def test_a_field_on_a_registered_call_still_reports_field_on_call():
    with pytest.raises(ExprError) as e:
        check("EMA(9).signal > 0")
    assert e.value.code == "field_on_call"


def test_an_output_has_no_sub_fields_past_an_offset():
    # Without the guard the stray .foo is silently discarded, which would be a
    # loosening: before indicator refs existed this raised unknown_name.
    with pytest.raises(ExprError) as e:
        check("SLOPE.9[-1].foo > 0")
    assert e.value.code == "field_on_indicator_ref"
    assert "SLOPE.9" in e.value.message


def test_a_dotted_sub_name_fuses_into_an_unknown_output():
    # SLOPE.9.foo fuses to output "9.foo" (the ATR1.14.to% grammar), so the
    # stray .foo now reads as an output this pane does not expose.
    with pytest.raises(ExprError) as e:
        check("SLOPE.9.foo > 0")
    assert e.value.code == "unknown_indicator_output"
    assert "9.foo" in e.value.message


@pytest.mark.parametrize("src", [
    "(SLOPE#p1n.slope0 + 1) @4H > 0",     # Binary
    "highest(SLOPE#p1n.slope0, 5) @4H > 0",   # call argument
])
def test_a_pinned_pane_nested_deeper_is_still_a_nested_pin(src):
    with pytest.raises(ExprError) as e:
        check(src)
    assert e.value.code == "nested_tf"


def test_an_empty_instance_map_behaves_like_no_map():
    with pytest.raises(ExprError) as e:
        check("SLOPE.9 > 0", instances={})
    assert e.value.code == "unknown_indicator_ref"


def test_an_instance_name_called_with_arguments_is_still_unknown():
    with pytest.raises(ExprError) as e:
        check("SLOPE(9) > 0")
    assert e.value.code == "unknown_name"


def test_a_name_that_is_neither_function_nor_instance_is_unknown():
    with pytest.raises(ExprError) as e:
        check("NOPE > 0")
    assert e.value.code == "unknown_name"


def test_an_unknown_timeframe_is_reported_before_the_nested_pin():
    with pytest.raises(ExprError) as e:
        check("SLOPE#p1n.50 @NOPE > 0")
    assert e.value.code == "unknown_tf"

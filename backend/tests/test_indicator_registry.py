import pytest

from auto_trader.indicators.registry import (
    SERIES_INDICATORS, instance_type_of, resolve_instances,
)


def test_slope_is_registered():
    assert "SLOPE" in SERIES_INDICATORS


def test_instance_type_strips_the_uniqueness_suffix():
    assert instance_type_of("SLOPE") == "SLOPE"
    assert instance_type_of("SLOPE#a1b2c3") == "SLOPE"


def test_resolve_parses_each_instance_config():
    resolved = resolve_instances({
        "SLOPE": {"type": "SLOPE", "calcParams": [21], "extendData": {"units": "pctBar"}},
    })
    inst = resolved["SLOPE"]
    assert inst.type == "SLOPE"
    assert inst.config.lengths == (21,)
    assert inst.config.units == "pctBar"
    assert inst.spec.outputs(inst.config) == ("21",)


def test_resolve_infers_the_type_from_the_id_when_absent():
    resolved = resolve_instances({"SLOPE#zz9": {"calcParams": [9], "extendData": {}}})
    assert resolved["SLOPE#zz9"].type == "SLOPE"


def test_resolve_skips_unregistered_types_rather_than_raising():
    # A chart may carry MACD/BOLL panes; only registered ones become referenceable.
    assert resolve_instances({"MACD": {"type": "MACD"}}) == {}

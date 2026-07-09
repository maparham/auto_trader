"""Schema validation for meta["params"] on coded strategies."""

from types import ModuleType

import pytest

from auto_trader.strategy.params import resolve_params, validate_params_schema


def spec(**kw):
    base = {"name": "ema_fast", "type": "int", "default": 9}
    base.update(kw)
    return base


def test_no_meta_or_no_params_is_empty():
    assert validate_params_schema(None) == []
    assert validate_params_schema({}) == []
    assert validate_params_schema({"name": "X"}) == []


def test_valid_schema_normalized():
    out = validate_params_schema({"params": [
        {"name": "ema_fast", "label": "Fast EMA", "type": "int",
         "default": 9, "min": 2, "max": 200, "step": 1},
        {"name": "rsi_max", "type": "float", "default": 70.0},
        {"name": "longs_only", "type": "bool", "default": True},
        {"name": "mode", "type": "choice", "default": "fast", "options": ["fast", "slow"]},
    ]})
    assert [p["name"] for p in out] == ["ema_fast", "rsi_max", "longs_only", "mode"]
    assert out[0]["label"] == "Fast EMA"
    assert out[1]["label"] == "rsi_max"          # label defaults to name
    assert out[1]["default"] == 70.0


def test_rejects_bad_shapes():
    with pytest.raises(ValueError, match="params must be a list"):
        validate_params_schema({"params": {"a": 1}})
    with pytest.raises(ValueError, match="duplicate param name"):
        validate_params_schema({"params": [spec(), spec()]})
    with pytest.raises(ValueError, match="invalid param name"):
        validate_params_schema({"params": [spec(name="not an ident!")]})
    with pytest.raises(ValueError, match="unknown type"):
        validate_params_schema({"params": [spec(type="str")]})
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [{"name": "a", "type": "int"}]})


def test_default_type_checked():
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [spec(default="nine")]})
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [spec(default=9.5)]})       # int param, float default
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [spec(type="bool", default=1)]})  # bool wants bool
    # int default for a float param is fine (coerced to float)
    out = validate_params_schema({"params": [spec(type="float", default=9)]})
    assert out[0]["default"] == 9.0


def test_min_max_bounds():
    with pytest.raises(ValueError, match="min"):
        validate_params_schema({"params": [spec(min=10, max=5)]})
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [spec(default=1, min=2, max=50)]})
    with pytest.raises(ValueError, match="min/max/step"):
        validate_params_schema({"params": [spec(type="bool", default=True, min=0)]})


def test_choice_needs_options():
    with pytest.raises(ValueError, match="options"):
        validate_params_schema({"params": [spec(type="choice", default="a")]})
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [
            spec(type="choice", default="c", options=["a", "b"])]})
    with pytest.raises(ValueError, match="options"):
        validate_params_schema({"params": [spec(options=["a"])]})     # non-choice with options


def module_with(params_meta) -> ModuleType:
    m = ModuleType("m")
    m.meta = {"params": params_meta}
    return m


INT_SPEC = [{"name": "ema_fast", "type": "int", "default": 9, "min": 2, "max": 50}]


def test_resolve_defaults_when_nothing_sent():
    m = module_with(INT_SPEC)
    assert resolve_params(m, None) == {"ema_fast": 9}
    assert resolve_params(m, {}) == {"ema_fast": 9}


def test_resolve_overlays_and_coerces():
    m = module_with(INT_SPEC + [{"name": "r", "type": "float", "default": 70.0}])
    out = resolve_params(m, {"ema_fast": 12.0, "r": 65})
    assert out == {"ema_fast": 12, "r": 65.0}
    assert isinstance(out["ema_fast"], int) and isinstance(out["r"], float)


def test_resolve_ignores_unknown_and_rejects_bad():
    m = module_with(INT_SPEC)
    assert resolve_params(m, {"gone": 1}) == {"ema_fast": 9}   # stale key: dropped
    with pytest.raises(ValueError, match="ema_fast"):
        resolve_params(m, {"ema_fast": "nine"})
    with pytest.raises(ValueError, match="outside"):
        resolve_params(m, {"ema_fast": 999})                   # out of range → 422 at the route

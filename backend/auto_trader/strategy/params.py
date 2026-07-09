"""Schema for meta["params"] on coded strategies: what the panel can tune.

A param spec is a plain dict: {name, label?, type, default, min?, max?, step?,
options?, help?}. `validate_params_schema` normalizes a module's declared list
(raising ValueError on nonsense — surfaced as the file's load error);
`resolve_params` (Task 2) merges panel-sent values over the defaults."""

from __future__ import annotations

TYPES = ("int", "float", "bool", "choice")
_KEYS = {"name", "label", "type", "default", "min", "max", "step", "options", "help"}


def validate_params_schema(meta: dict | None) -> list[dict]:
    """Normalize meta["params"] into a canonical list of spec dicts (every key
    present, label defaulted to name, float defaults coerced). Raises ValueError
    with a param-naming message on any invalid spec."""
    raw = (meta or {}).get("params")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("params must be a list of param dicts")
    out: list[dict] = []
    seen: set[str] = set()
    for i, spec in enumerate(raw):
        if not isinstance(spec, dict):
            raise ValueError(f"params[{i}] must be a dict")
        extra = set(spec) - _KEYS
        if extra:
            raise ValueError(f"params[{i}] has unknown keys {sorted(extra)}")
        name = spec.get("name")
        if not isinstance(name, str) or not name.isidentifier():
            raise ValueError(f"params[{i}]: invalid param name {name!r}")
        if name in seen:
            raise ValueError(f"duplicate param name '{name}'")
        seen.add(name)
        ptype = spec.get("type")
        if ptype not in TYPES:
            raise ValueError(f"param '{name}': unknown type {ptype!r} (want one of {TYPES})")
        if "default" not in spec:
            raise ValueError(f"param '{name}': default is required")
        default = _check_value(name, ptype, spec.get("options"), spec["default"], "default")
        options = spec.get("options")
        if ptype == "choice":
            if (not isinstance(options, list) or not options
                    or not all(isinstance(o, str) for o in options)):
                raise ValueError(f"param '{name}': choice needs a non-empty str list in options")
        elif options is not None:
            raise ValueError(f"param '{name}': options only valid for type 'choice'")
        lo, hi, step = spec.get("min"), spec.get("max"), spec.get("step")
        if ptype in ("bool", "choice") and any(v is not None for v in (lo, hi, step)):
            raise ValueError(f"param '{name}': min/max/step only valid for int/float")
        for label, v in (("min", lo), ("max", hi), ("step", step)):
            if v is not None and not isinstance(v, (int, float)):
                raise ValueError(f"param '{name}': {label} must be a number")
        if lo is not None and hi is not None and lo > hi:
            raise ValueError(f"param '{name}': min {lo} > max {hi}")
        if lo is not None and default < lo or hi is not None and default > hi:
            raise ValueError(f"param '{name}': default {default} outside [min, max]")
        label = spec.get("label")
        if label is not None and not isinstance(label, str):
            raise ValueError(f"param '{name}': label must be a string")
        help_ = spec.get("help")
        if help_ is not None and not isinstance(help_, str):
            raise ValueError(f"param '{name}': help must be a string")
        out.append({
            "name": name, "label": label or name, "type": ptype, "default": default,
            "min": lo, "max": hi, "step": step,
            "options": list(options) if ptype == "choice" else None, "help": help_,
        })
    return out


def resolve_params(module, sent: dict | None) -> dict:
    """Panel values overlaid on the module's declared defaults. Unknown sent
    keys are dropped (file edited between runs — stale keys must not error);
    a value that doesn't fit its spec raises ValueError naming the param."""
    meta = getattr(module, "meta", None)
    schema = validate_params_schema(meta if isinstance(meta, dict) else None)
    out = {p["name"]: p["default"] for p in schema}
    specs = {p["name"]: p for p in schema}
    for name, value in (sent or {}).items():
        spec = specs.get(name)
        if spec is None:
            continue
        v = _check_value(name, spec["type"], spec["options"], value, "value")
        lo, hi = spec["min"], spec["max"]
        if lo is not None and v < lo or hi is not None and v > hi:
            raise ValueError(f"param '{name}': value {v} outside [min, max]")
        out[name] = v
    return out


def _check_value(name: str, ptype: str, options, value, what: str):
    """Type-check (and minimally coerce) one value against a param type.
    Returns the coerced value; raises ValueError naming the param."""
    if ptype == "int":
        # bool is an int subclass — reject it explicitly.
        if isinstance(value, bool) or not isinstance(value, int):
            if isinstance(value, float) and value.is_integer():
                return int(value)
            raise ValueError(f"param '{name}': {what} {value!r} is not an int")
        return value
    if ptype == "float":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"param '{name}': {what} {value!r} is not a number")
        return float(value)
    if ptype == "bool":
        if not isinstance(value, bool):
            raise ValueError(f"param '{name}': {what} {value!r} is not a bool")
        return value
    # choice
    if not isinstance(value, str) or (options is not None and value not in options):
        raise ValueError(f"param '{name}': {what} {value!r} not in options {options}")
    return value
